import { createHash } from "node:crypto";

const DEFAULT_BATCH = 8;
const MAX_EVIDENCE = 12;
const MAX_SUGGESTIONS = 3;

// 规则 → 建议动作的固定映射：降级叙述也不凭空造动作。
const RULE_ACTION = Object.freeze({
  output_concentration: "search",
  goal_gap: "search",
  behavior_gap: "watch_other_source",
  repeat_heavy: "platform_feedback",
  source_concentration: "watch_other_source",
  narrowing: "search",
});

export function createLabeler(options = {}) {
  const store = options.store;
  const ai = options.ai;
  if (!store) throw new TypeError("createLabeler requires store");
  if (!ai) throw new TypeError("createLabeler requires ai");
  const clock = options.clock ?? { now: () => Date.now() };
  const log = typeof options.log === "function" ? options.log : () => {};
  const batchSize = Number.isInteger(options.batchSize) ? options.batchSize : DEFAULT_BATCH;

  // queued 与 inflight 必须分开记：只算 queued 会让"正在标注"看起来和"没有待标注"一样。
  const queued = new Map();
  const inflight = new Map();
  let draining = false;

  // 叙述缓存：同一份数据连续请求不应重复付钱，指纹由数据本身决定。
  const narrativeCache = { key: null, value: null, at: null, lastCached: false };

  function enqueue(items) {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.content_id) continue;
      const status = item.annotation?.status ?? "pending";
      if (status !== "pending") continue;
      if (inflight.has(item.content_id)) continue;
      queued.set(item.content_id, item);
    }
    if (queued.size) void drain();
    return queued.size + inflight.size;
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (queued.size) {
        const batch = [...queued.values()].slice(0, batchSize);
        for (const item of batch) {
          queued.delete(item.content_id);
          inflight.set(item.content_id, item);
        }
        try {
          await applyLabels(batch);
        } finally {
          for (const item of batch) inflight.delete(item.content_id);
        }
      }
    } catch (error) {
      log("[labeler] drain failed:", error?.message ?? error);
    } finally {
      draining = false;
    }
  }

  async function applyLabels(items) {
    if (!items.length) return [];
    let labels;
    try {
      labels = await ai.label(items);
    } catch (error) {
      // 标注失败保持 pending，下一次上报再试；不写半成品标注
      log("[labeler] label failed:", error?.message ?? error);
      return [];
    }
    const byId = new Map((Array.isArray(labels) ? labels : []).map((label) => [label.content_id, label]));
    for (const item of items) {
      const label = byId.get(item.content_id);
      if (!label) continue;
      const fromModel = label.source === "ai" || label.source === "cache";
      try {
        store.upsertItem({
          ...item,
          topics: Array.isArray(label.topics) ? label.topics : item.topics ?? [],
          value_notes: label.value_notes ?? null,
          annotation: {
            status: fromModel ? "ai" : "unknown",
            model: label.model ?? ai.model ?? null,
            at: clock.now(),
          },
        });
      } catch (error) {
        log("[labeler] persist failed:", error?.message ?? error);
      }
    }
    return labels;
  }

  async function labelNow(items) {
    const list = (Array.isArray(items) ? items : []).filter((item) => item && item.content_id);
    for (const item of list) queued.delete(item.content_id);
    return applyLabels(list);
  }

  async function narrative(snapshot, goal) {
    const key = narrativeKey(snapshot, goal);
    if (narrativeCache.key === key && narrativeCache.value) {
      narrativeCache.lastCached = true;
      return { ...narrativeCache.value, narrative_cached: true, narrative_at: narrativeCache.at };
    }
    const evidence = collectEvidence(snapshot);
    const summary = summarise(snapshot, goal);
    let result = null;
    try {
      result = await ai.narrative({ evidence, summary });
    } catch (error) {
      log("[labeler] narrative failed:", error?.message ?? error);
      result = null;
    }
    const modelNarrative = typeof result?.narrative === "string" ? result.narrative : "";
    const suggestions = Array.isArray(result?.suggestions) && result.suggestions.length ? result.suggestions : alertSuggestions(snapshot);
    const value = {
      narrative: modelNarrative || templateNarrative(summary),
      suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
      model: result?.model ?? ai.model ?? null,
      cached: Boolean(result?.cached),
      // 只要叙述不是模型产出的，就明确标降级，界面据此披露
      degraded: Boolean(result?.degraded) || !modelNarrative,
    };
    // 降级/模板叙述不写缓存：等 AI 可用时必须重算，否则用户永远看到模板句
    if (!value.degraded) {
      narrativeCache.key = key;
      narrativeCache.value = value;
      narrativeCache.at = clock.now();
      narrativeCache.lastCached = false;
    }
    return { ...value, narrative_cached: false, narrative_at: narrativeCache.at };
  }

  function annotationCounts() {
    try {
      const counts = typeof store.labelCounts === "function" ? store.labelCounts() : null;
      if (counts) return counts;
    } catch (error) {
      log("[labeler] label counts failed:", error?.message ?? error);
    }
    return { labeled: 0, unlabeled: 0, pending: 0, unknown: 0, manual: 0 };
  }

  function status() {
    const stats = typeof ai.stats === "function" ? ai.stats() : {};
    const counts = annotationCounts();
    const pendingNow = queued.size + inflight.size;
    return {
      mode: ai.mode ?? "off",
      model: ai.model ?? null,
      cached: stats.cache_hits ?? 0,
      cache_hits: stats.cache_hits ?? 0,
      requests: stats.requests ?? 0,
      failures: stats.failures ?? 0,
      // pending 语义修正为"还没标完的条数"= 排队 + 在飞；既有字段名保留
      pending: pendingNow,
      queued: queued.size,
      inflight: inflight.size,
      labeled: counts.labeled ?? 0,
      unlabeled: counts.unlabeled ?? 0,
      narrative_cached: narrativeCache.lastCached,
    };
  }

  return {
    enqueue,
    status,
    labelNow,
    narrative,
    pendingCount: () => queued.size + inflight.size,
    queuedCount: () => queued.size,
    inflightCount: () => inflight.size,
  };
}

// 指纹只取"数据本身"：窗口按天量化，否则每次请求 now 都变、缓存永远不命中。
// 曝光数/内容数/行为数的任何变化都会立刻改变指纹，所以量化不会掩盖真实数据变化。
function narrativeKey(snapshot, goal) {
  const window = snapshot?.window ?? {};
  const bucket = typeof window.days === "number" && window.days > 0 ? window.days * 86400000 : 0;
  const quantise = (value) => (Number.isFinite(value) && bucket ? Math.floor(value / bucket) : value ?? "");
  const alerts = (Array.isArray(snapshot?.alerts) ? snapshot.alerts : []).map((alert) =>
    [
      alert?.rule_id ?? "",
      ...(Array.isArray(alert?.evidence) ? alert.evidence : [])
        .map((entry) => entry?.content_id)
        .filter((id) => typeof id === "string")
        .sort(),
    ].join(">"),
  );
  const topics = (Array.isArray(goal?.goal_topics) ? goal.goal_topics : [])
    .map((topic) => (topic?.t ?? "") + ":" + (topic?.w ?? ""))
    .sort();
  const parts = [
    snapshot?.data_mode ?? "",
    quantise(window.start),
    quantise(window.end),
    window.exposure_count ?? "",
    window.unique_items ?? "",
    window.action_count ?? "",
    alerts.join("|"),
    goal?.version ?? "",
    topics.join(","),
  ];
  return createHash("sha1").update(parts.join("\u0001")).digest("hex");
}

function collectEvidence(snapshot) {
  const out = [];
  const seen = new Set();
  for (const alert of Array.isArray(snapshot?.alerts) ? snapshot.alerts : []) {
    for (const entry of Array.isArray(alert?.evidence) ? alert.evidence : []) {
      if (!entry || typeof entry.content_id !== "string" || seen.has(entry.content_id)) continue;
      seen.add(entry.content_id);
      out.push({ content_id: entry.content_id, title: entry.title ?? "", url: entry.url ?? null, at: entry.at ?? null });
      if (out.length >= MAX_EVIDENCE) return out;
    }
  }
  return out;
}

function summarise(snapshot, goal) {
  const window = snapshot?.window ?? {};
  const exposure = snapshot?.exposure ?? {};
  return {
    window_days: window.days ?? null,
    start: window.start ?? null,
    end: window.end ?? null,
    exposure_count: window.exposure_count ?? null,
    unique_items: window.unique_items ?? null,
    action_count: window.action_count ?? null,
    known_topic_ratio: window.known_topic_ratio ?? null,
    unknown_topic_ratio: window.unknown_topic_ratio ?? null,
    exposure_entropy: exposure.entropy ?? null,
    repeat_rate: exposure.repeat_rate ?? null,
    top_source: exposure.top_source ?? null,
    top_topics: Array.isArray(exposure.topics) ? exposure.topics.slice(0, 5) : [],
    goal: goal ? { text: goal.goal_text, intent_mode: goal.intent_mode, topics: goal.goal_topics } : null,
    alert_rule_ids: (Array.isArray(snapshot?.alerts) ? snapshot.alerts : []).map((alert) => alert.rule_id),
  };
}

function templateNarrative(summary) {
  const parts = [];
  const days = summary.window_days ?? null;
  if (days != null && summary.exposure_count != null) {
    parts.push("近 " + days + " 天共记录 " + summary.exposure_count + " 次推荐曝光、");
    parts.push((summary.unique_items ?? 0) + " 条不同内容");
  } else {
    parts.push("当前窗口内还没有足够的推荐曝光记录");
  }
  if (typeof summary.exposure_entropy === "number") parts.push("，主题熵 " + summary.exposure_entropy.toFixed(2));
  if (typeof summary.repeat_rate === "number") parts.push("，重复曝光率 " + Math.round(summary.repeat_rate * 100) + "%");
  const source = summary.top_source;
  if (source && typeof source.share === "number") parts.push("，最大来源占比 " + Math.round(source.share * 100) + "%");
  const alerted = (summary.alert_rule_ids ?? []).length;
  parts.push(alerted ? "；触发 " + alerted + " 条规则提示。" : "；未触发规则提示。");
  if (!(summary.goal?.text)) parts.push("设置目标后可以看到目标与推荐输出的差距。");
  return parts.join("");
}

function alertSuggestions(snapshot) {
  const out = [];
  for (const alert of Array.isArray(snapshot?.alerts) ? snapshot.alerts : []) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const evidenceIds = (Array.isArray(alert?.evidence) ? alert.evidence : [])
      .map((entry) => entry?.content_id)
      .filter((id) => typeof id === "string");
    if (!evidenceIds.length) continue; // 没有证据就不出建议
    out.push({
      title: clipText(alert.title, 20) ?? "",
      why: clipText(alert.detail ?? alert.suggestion, 60) ?? "",
      action: RULE_ACTION[alert.rule_id] ?? "keep",
      evidence_ids: [...new Set(evidenceIds)].slice(0, 4),
    });
  }
  return out;
}

function clipText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const chars = [...trimmed];
  return chars.length > max ? chars.slice(0, max).join("") : trimmed;
}

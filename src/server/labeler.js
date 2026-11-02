import { createHash } from "node:crypto";
import { TOPICS, TOPIC_LABELS } from "../core/constants.js";

const DEFAULT_BATCH = 8;
const MAX_EVIDENCE = 12;
const MAX_SUGGESTIONS = 3;

// 规则 → 建议动作的固定映射：降级叙述也不凭空造动作。
const SUGGESTION_ACTIONS = new Set(["search", "watch_other_source", "platform_feedback", "keep"]);
const SUGGESTION_BASES = new Set(["topic", "repetition", "none"]);
// B 站搜索页：窗口里没有该主题内容时的落地页，界面上要标明"去搜索"而不是"你看过的"。
const SEARCH_BASE = "https://search.bilibili.com/all?keyword=";

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

  async function narrative(snapshot, goal, candidates = []) {
    const key = narrativeKey(snapshot, goal, candidates);
    if (narrativeCache.key === key && narrativeCache.value) {
      narrativeCache.lastCached = true;
      return { ...narrativeCache.value, narrative_cached: true, narrative_at: narrativeCache.at };
    }
    const evidence = collectEvidence(snapshot);
    const summary = summarise(snapshot, goal);
    let result = null;
    try {
      // 叙述 / 建议 / 推荐理由一次请求产出：候选由确定性排序先给出，AI 只能为它们写理由。
      result = await ai.narrative({ evidence, summary, goal: goal?.text ?? "", candidates });
    } catch (error) {
      log("[labeler] narrative failed:", error?.message ?? error);
      result = null;
    }
    const modelNarrative = typeof result?.narrative === "string" ? result.narrative : "";
    const rawSuggestions = Array.isArray(result?.suggestions) && result.suggestions.length ? result.suggestions : alertSuggestions(snapshot);
    // 模型有可能会给"补充时事类内容"却挂上游戏视频当证据；主题校验一律在服务端做。
    const suggestions = sanitiseSuggestions(rawSuggestions, snapshot);
    const value = {
      narrative: modelNarrative || templateNarrative(summary),
      suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
      reasons: Array.isArray(result?.reasons) ? result.reasons : [],
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

  // 内容 → 主题集合：判断"这条证据是不是该建议讲的那个主题"
  function topicIndex() {
    const map = new Map();
    for (const item of safeList(() => store.getItems())) {
      if (!item?.content_id) continue;
      const set = new Set((Array.isArray(item.topics) ? item.topics : []).map((entry) => entry?.t).filter(Boolean));
      map.set(item.content_id, set);
    }
    return map;
  }

  // 窗口内每条内容被曝光的次数：basis="repetition" 只能引用真的重复出现过的条目
  function repeatCounts(snapshot) {
    const start = Number(snapshot?.window?.start);
    const end = Number(snapshot?.window?.end);
    const counts = new Map();
    for (const exposure of safeList(() => store.getExposures())) {
      const id = exposure?.content_id;
      if (!id) continue;
      const at = Number(exposure.exposed_at);
      if (Number.isFinite(start) && Number.isFinite(end) && !(at >= start && at < end)) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }

  // 窗口内属于该主题、确有曝光的内容，按曝光次数降序 + content_id 升序（确定性）。
  function topicEvidence(topic, topics, repeats, limit) {
    const rows = [];
    for (const [contentId, set] of topics) {
      if (!set.has(topic)) continue;
      const count = repeats.get(contentId) ?? 0;
      if (!count) continue; // 没被曝光过的不算"你看过的内容"
      const item = store.getItem(contentId);
      if (!item?.url) continue;
      rows.push({ content_id: contentId, title: item.title ?? "", url: item.url, count });
    }
    rows.sort((a, b) => b.count - a.count || (a.content_id < b.content_id ? -1 : 1));
    return rows.slice(0, limit);
  }

  // 建议与证据必须同主题；同主题内容不存在时改成搜索链接，而不是拉不相干的条目凑数。
  function sanitiseSuggestions(raw, snapshot) {
    const rows = Array.isArray(raw) ? raw : [];
    if (!rows.length) return [];
    const topics = topicIndex();
    const repeats = repeatCounts(snapshot);
    const out = [];
    for (const row of rows) {
      const title = clipText(row?.title, 20);
      if (!title) continue;
      const topic = TOPICS.includes(row?.topic) ? row.topic : null;
      let ids = Array.isArray(row?.evidence_ids) ? row.evidence_ids.filter((id) => typeof id === "string") : [];
      let basis = SUGGESTION_BASES.has(row?.basis) ? row.basis : null;
      if (!basis) {
        if (topic) basis = "topic";
        else if (ids.length && ids.every((id) => (repeats.get(id) ?? 0) > 1)) basis = "repetition";
        else basis = "none";
      }
      if (basis === "topic") {
        if (!topic) basis = "none";
        else ids = ids.filter((id) => topics.get(id)?.has(topic));
      } else if (basis === "repetition") {
        ids = ids.filter((id) => (repeats.get(id) ?? 0) > 1);
        if (!ids.length) basis = "none";
      } else {
        basis = "none";
      }
      if (basis === "none") continue; // 既说不清主题、也没有重复依据：整条丢弃，不留空壳
      const entry = {
        title,
        why: clipText(row?.why, 60) ?? "",
        action: SUGGESTION_ACTIONS.has(row?.action) ? row.action : "search",
        topic,
        basis,
        evidence_ids: ids.slice(0, 4),
      };
      if (basis === "repetition") {
        // 重复类建议要能看见"重复了几次"，否则用户无从判断这条凭什么是重复。
        entry.evidence = ids.slice(0, 4).map((id) => {
          const item = store.getItem(id);
          return { content_id: id, title: item?.title ?? "", url: item?.url ?? "", count: repeats.get(id) ?? 0 };
        });
      }
      if (basis === "topic" && ids.length === 0) {
        // 窗口里可能确实有该主题的内容，只是没进模型看到的证据池：优先补真内容，找不到才给搜索链接。
        const filled = topicEvidence(topic, topics, repeats, 2);
        if (filled.length) {
          entry.evidence_ids = filled.map((row) => row.content_id);
          entry.evidence = filled;
        } else {
          entry.search = searchFor(topic);
        }
      }
      out.push(entry);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return out;
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
function narrativeKey(snapshot, goal, candidates = []) {
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
    // 候选变了，推荐理由就必须重算——否则会给出与当前候选对不上的解释。
    candidates.map((entry) => entry?.content_id ?? "").join(","),
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

function searchFor(topic) {
  const keyword = TOPIC_LABELS[topic] ?? topic;
  return { keyword, url: SEARCH_BASE + encodeURIComponent(keyword) };
}

function safeList(fn) {
  try {
    const value = fn();
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function topGoalTopic(snapshot) {
  const topics = Array.isArray(snapshot?.goal?.topics) ? snapshot.goal.topics : [];
  return topics.length ? topics[0].t : null;
}

function topExposureTopic(snapshot) {
  const topics = Array.isArray(snapshot?.exposure?.topics) ? snapshot.exposure.topics : [];
  return topics.length ? topics[0].t : null;
}

function topGapTopic(cmp) {
  const rows = Array.isArray(cmp?.by_topic) ? cmp.by_topic : [];
  let best = null;
  for (const row of rows) {
    const diff = Number(row?.diff);
    if (!row?.t || !Number.isFinite(diff) || diff <= 0) continue;
    if (!best || diff > best.diff) best = { t: row.t, diff };
  }
  return best ? best.t : null;
}

// 兜底建议也要能被主题校验：能确定主题就给主题，重复类走向 repetition，都不行就交给 sanitise 丢弃。
function alertSuggestionTopic(alert, snapshot) {
  switch (alert?.rule_id) {
    case "goal_gap":
      return topGoalTopic(snapshot);
    case "behavior_gap":
      return topGapTopic(snapshot?.behavior_cmp) ?? topExposureTopic(snapshot);
    case "source_concentration":
    case "output_concentration":
      return topGoalTopic(snapshot) ?? topExposureTopic(snapshot);
    case "narrowing":
      return topGoalTopic(snapshot);
    default:
      return null;
  }
}

function alertSuggestions(snapshot) {
  const out = [];
  for (const alert of Array.isArray(snapshot?.alerts) ? snapshot.alerts : []) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const evidenceIds = (Array.isArray(alert?.evidence) ? alert.evidence : [])
      .map((entry) => entry?.content_id)
      .filter((id) => typeof id === "string");
    if (!evidenceIds.length) continue; // 没有证据就不出建议
    const repetition = alert.rule_id === "repeat_heavy";
    const topic = repetition ? null : alertSuggestionTopic(alert, snapshot);
    out.push({
      title: clipText(alert.title, 20) ?? "",
      why: clipText(alert.detail ?? alert.suggestion, 60) ?? "",
      action: RULE_ACTION[alert.rule_id] ?? "keep",
      topic,
      basis: repetition ? "repetition" : topic ? "topic" : "none",
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

// 分析核心：buildSnapshot 是纯函数——不读时钟（now 由参数传入）、不读文件、不联网、不打印。
import {
  ALERT_EVIDENCE_LIMIT,
  BEHAVIOR_WEIGHTS,
  COUNTER_PREFIX,
  DAY_MS,
  GOAL_KEYWORD_EXTRA,
  GOAL_KEYWORD_HIT_CAP,
  GOAL_KEYWORD_WEIGHT,
  GOAL_KEYWORDS,
  GOAL_MIN_TOPIC_WEIGHT,
  GOAL_TOPIC_LIMIT,
  INTENT_EXPLORATION,
  INTENT_MODES,
  INTENT_PRIOR_WEIGHT,
  INTENT_PRIORS,
  NEGATIVE_ACTIONS,
  PAGE_CONTEXTS,
  PROFILE_ID,
  RELAX_GROUP,
  RELAX_GROUP_RATIO,
  RELAX_GROUP_WEIGHT,
  RELAX_INTENT_RE,
  RING_CAPACITY,
  SCHEMA_VERSION,
  THRESHOLDS,
  TOPIC_LABELS,
  TOPICS,
  WATCH_RATIO_FALLBACK,
  WINDOW_DAYS,
} from "./constants.js";
import { RingWindow } from "./ring.js";
import { topK } from "./heap.js";
import { distance, entropy, itemTopics, normalizeDist, repeatRate, round, toTopicArray } from "./metrics.js";

const TOPIC_ORDER = new Map(TOPICS.map((t, i) => [t, i]));

// 契约 §10.1：搜索页是用户主动拉取的内容，不进"平台推荐曝光" P，也不进熵/重复率/来源集中度的分母。
// 它仍然入库、仍然计入 window.page_contexts.search 与 window.search_pull_count。
const P_PAGE_CONTEXTS = ["home", "video_related"];

function pct(x) {
  return round(x * 100, 1) + "%";
}

function label(t) {
  return TOPIC_LABELS[t] ?? t;
}

function compareStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// ---------- 曝光记录 ----------

function toRecord(exposure, itemsById) {
  const contentId = exposure.content_id != null ? String(exposure.content_id) : "";
  const item = itemsById.get(contentId) ?? null;
  const exposureOrigin = typeof exposure.origin === "string" ? exposure.origin : null;
  const itemOrigin = item && typeof item.origin === "string" ? item.origin : null;
  return {
    at: Number(exposure.exposed_at),
    exposure_id: exposure.exposure_id != null ? String(exposure.exposure_id) : "",
    content_id: contentId,
    session_id: exposure.session_id != null ? String(exposure.session_id) : "",
    page_context: typeof exposure.page_context === "string" ? exposure.page_context : "",
    observable_rank: Number.isFinite(Number(exposure.observable_rank)) ? Number(exposure.observable_rank) : null,
    // 曝光自身的 origin 优先；缺失时退回内容条目的 origin；两者都缺失按 real（无法证明是合成数据）。
    origin: exposureOrigin ?? itemOrigin ?? "real",
    canonical_key: item && item.canonical_key ? String(item.canonical_key) : contentId,
    source_id: item && item.source_id != null ? String(item.source_id) : "",
    source_name: item && item.source_name != null ? String(item.source_name) : "",
    title: item && typeof item.title === "string" ? item.title : "",
    url: item && typeof item.url === "string" ? item.url : "",
    topics: itemTopics(item),
    tieKey: exposure.exposure_id != null ? String(exposure.exposure_id) : contentId,
  };
}

function exposureKeys(record) {
  const keys = [];
  if (record.source_id) keys.push({ key: COUNTER_PREFIX.source + record.source_id, weight: 1 });
  if (record.topics) {
    for (const [t, w] of record.topics) {
      keys.push({ key: COUNTER_PREFIX.topicWeight + t, weight: w });
      keys.push({ key: COUNTER_PREFIX.topicCount + t, weight: 1 });
    }
  }
  return keys;
}

// 半开区间 [from, to)：at < from 直接跳过（不入窗，避免为历史数据付内存），at >= to 立即停止。
function collectWindow(records, from, to) {
  const win = new RingWindow({ capacity: RING_CAPACITY, timeOf: (r) => r.at, keysOf: exposureKeys });
  for (const record of records) {
    if (record.at < from) continue;
    if (record.at >= to) break;
    win.push(record);
  }
  // 兜底：输入若未严格按时间升序，仍按窗口下界把陈旧记录挤出并扣减计数。
  win.evictBefore(from);
  return win;
}

function summarizeExposure(win) {
  const recs = win.toArray();
  const topicWeight = new Map();
  const topicCount = new Map();
  const sourceCount = new Map();
  const twPrefix = COUNTER_PREFIX.topicWeight;
  const tcPrefix = COUNTER_PREFIX.topicCount;
  const srcPrefix = COUNTER_PREFIX.source;
  for (const [key, value] of win.counts) {
    if (!(value > 0)) continue;
    if (key.startsWith(twPrefix)) topicWeight.set(key.slice(twPrefix.length), value);
    else if (key.startsWith(tcPrefix)) topicCount.set(key.slice(tcPrefix.length), value);
    else if (key.startsWith(srcPrefix)) sourceCount.set(key.slice(srcPrefix.length), value);
  }

  const pMap = normalizeDist(topicWeight);
  const topics = [...pMap.entries()].map(([t, w]) => ({ t, w: round(w), n: Math.round(topicCount.get(t) ?? 0) }));
  topics.sort((a, b) => b.w - a.w || (TOPIC_ORDER.get(a.t) ?? 0) - (TOPIC_ORDER.get(b.t) ?? 0));

  const unknownCount = recs.reduce((acc, r) => acc + (r.topics ? 0 : 1), 0);
  const knownCount = recs.length - unknownCount;
  const knownRatio = recs.length > 0 ? knownCount / recs.length : 0;

  const sourceNames = new Map();
  for (const r of recs) if (r.source_id && !sourceNames.has(r.source_id)) sourceNames.set(r.source_id, r.source_name);

  const sourceEntries = [...sourceCount.entries()]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => ({ content_id: id, n }));
  // 复用堆做选择（同分按来源 id 升序），而不是对来源表排序。
  const topEntry = topK(sourceEntries, 1, (e) => e.n)[0] ?? null;
  let sourceKnownCount = 0;
  for (const [, n] of sourceCount) sourceKnownCount += n;
  const topSource = topEntry
    ? {
        id: topEntry.content_id,
        name: sourceNames.get(topEntry.content_id) ?? "",
        n: Math.round(topEntry.n),
        share: round(sourceKnownCount > 0 ? topEntry.n / sourceKnownCount : 0),
      }
    : null;

  const pageContexts = {};
  for (const c of PAGE_CONTEXTS) pageContexts[c] = 0;
  for (const r of recs) if (Object.prototype.hasOwnProperty.call(pageContexts, r.page_context)) pageContexts[r.page_context] += 1;

  const uniqueItems = new Set(recs.map((r) => r.content_id)).size;

  return {
    recs,
    pMap,
    topics,
    entropy: entropy(pMap),
    repeatRate: repeatRate(recs, null),
    uniqueItems,
    topSource,
    sourceCount: sourceNames.size,
    sourceKnownCount,
    knownCount,
    unknownCount,
    knownRatio,
    pageContexts,
  };
}

// ---------- 行为 ----------

function resolveBehaviorTopics(action, itemsById) {
  const contentId = action.content_id != null ? String(action.content_id) : "";
  if (contentId) return itemTopics(itemsById.get(contentId));
  const topicId = action.topic_id != null ? String(action.topic_id) : "";
  if (TOPICS.includes(topicId)) return new Map([[topicId, 1]]);
  return null;
}

function behaviorWeightOf(action, itemsById) {
  const base = BEHAVIOR_WEIGHTS[action.action_type];
  if (!base) return 0;
  if (action.action_type !== "watch") return base;
  const seconds = Number(action.watch_seconds);
  const contentId = action.content_id != null ? String(action.content_id) : "";
  const item = contentId ? itemsById.get(contentId) : null;
  const duration = item ? Number(item.duration_s) : NaN;
  if (Number.isFinite(seconds) && Number.isFinite(duration) && duration > 0) {
    return Math.min(1, Math.max(0, seconds / duration));
  }
  // 没有可靠时长时不推断完整观看：取中性比例，权重仍限制在 [0,1]。
  return WATCH_RATIO_FALLBACK;
}

function summarizeBehavior(actions, itemsById) {
  const units = new Map();
  let negativeCount = 0;
  for (const action of actions) {
    if (!action) continue;
    if (NEGATIVE_ACTIONS.includes(action.action_type)) {
      negativeCount += 1;
      continue;
    }
    const weight = behaviorWeightOf(action, itemsById);
    if (!(weight > 0)) continue;
    const contentId = action.content_id != null ? String(action.content_id) : "";
    const topicId = action.topic_id != null ? String(action.topic_id) : "";
    const sessionId = action.session_id != null ? String(action.session_id) : "";
    const key = contentId ? sessionId + "|c:" + contentId : sessionId + "|t:" + topicId;
    const topics = resolveBehaviorTopics(action, itemsById);
    const prev = units.get(key);
    // 同一会话同一内容合并为最高权重，一次观看不会被多个埋点累加成强兴趣。
    if (!prev) units.set(key, { weight, topics });
    else if (weight > prev.weight) prev.weight = weight;
  }

  const weighted = new Map();
  const countMap = new Map();
  let knownWeight = 0;
  let knownUnits = 0;
  for (const unit of units.values()) {
    if (!unit.topics) continue;
    knownUnits += 1;
    knownWeight += unit.weight;
    for (const [t, x] of unit.topics) {
      weighted.set(t, (weighted.get(t) ?? 0) + unit.weight * x);
      countMap.set(t, (countMap.get(t) ?? 0) + 1);
    }
  }

  const uMap = normalizeDist(weighted);
  const sampleN = units.size;
  const knownRatio = sampleN > 0 ? knownUnits / sampleN : 0;

  let available = true;
  let reason;
  if (sampleN === 0) {
    available = false;
    reason = negativeCount > 0 ? "仅有 " + negativeCount + " 条负反馈，无有效正向行为" : "窗口内无行为记录";
  } else if (sampleN < THRESHOLDS.minBehavior) {
    available = false;
    reason = "有效正向行为 " + sampleN + " 条，低于门槛 " + THRESHOLDS.minBehavior;
  } else if (knownRatio < THRESHOLDS.minKnownTopicRatio || knownWeight <= 0) {
    available = false;
    reason = "行为主题已知占比 " + round(knownRatio) + "，低于门槛 " + THRESHOLDS.minKnownTopicRatio;
  }

  const topics = [...uMap.entries()].map(([t, w]) => ({ t, w: round(w), n: Math.round(countMap.get(t) ?? 0) }));
  topics.sort((a, b) => b.w - a.w || (TOPIC_ORDER.get(a.t) ?? 0) - (TOPIC_ORDER.get(b.t) ?? 0));

  return { available, topics, sampleN, knownRatio, uMap, negativeCount, reason };
}

function compareTopics(leftKey, leftMap, pMap) {
  const out = [];
  for (const t of TOPICS) {
    const l = leftMap.get(t) ?? 0;
    const p = pMap.get(t) ?? 0;
    if (l === 0 && p === 0) continue;
    const entry = { t };
    entry[leftKey] = round(l);
    entry.p = round(p);
    entry.diff = round(p - l);
    out.push(entry);
  }
  return out;
}

// ---------- 其他 ----------

function dataModeOf(recs) {
  if (recs.length === 0) return "empty";
  const kinds = new Set();
  for (const r of recs) kinds.add(r.origin === "real" || r.origin === "synthetic" ? r.origin : "other");
  if (kinds.size > 1) return "mixed";
  if (kinds.has("real")) return "real";
  if (kinds.has("synthetic")) return "synthetic";
  // origin="reference"（人工参考集）在 data_mode 枚举里没有独立取值，只能归入"非单一真实观察"。
  return "mixed";
}

function buildEvidence(recs, predicate) {
  const picked = topK(recs.filter(predicate), ALERT_EVIDENCE_LIMIT, (r) => r.at);
  return picked.map((r) => ({
    exposure_id: r.exposure_id,
    content_id: r.content_id,
    title: r.title,
    url: r.url,
    at: r.at,
  }));
}

function topGapTopic(byTopic, key) {
  let best = null;
  let bestDiff = Number.NEGATIVE_INFINITY;
  for (const entry of byTopic) {
    if (entry.diff > bestDiff) {
      bestDiff = entry.diff;
      best = entry;
    }
  }
  return best;
}

function percentilePair(topics) {
  return topics.map((x) => label(x.t) + " " + pct(x.w)).join("、");
}

// ---------- 快照 ----------

/**
 * 契约 §3：buildSnapshot(input) -> Snapshot。
 * 纯函数：同样的 input（含 now）逐字节输出同一个 Snapshot。
 */
export function buildSnapshot(input = {}) {
  const items = Array.isArray(input.items) ? input.items.filter(Boolean) : [];
  const rawExposures = Array.isArray(input.exposures) ? input.exposures.filter(Boolean) : [];
  const rawActions = Array.isArray(input.actions) ? input.actions.filter(Boolean) : [];
  const goal = input.goal && typeof input.goal === "object" ? input.goal : null;
  const now = Number(input.now);
  const generatedAt = Number.isFinite(now) ? now : 0;
  const windowDays = Number(input.windowDays);
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : WINDOW_DAYS;
  const wantPrev = input.prevWindow !== false;

  const end = generatedAt;
  const start = end - days * DAY_MS;
  const prevStart = start - days * DAY_MS;

  const itemsById = new Map();
  for (const item of items) if (item.content_id != null) itemsById.set(String(item.content_id), item);

  const records = rawExposures
    .map((e) => toRecord(e, itemsById))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at || compareStr(a.exposure_id, b.exposure_id));

  const actions = rawActions
    .filter((a) => Number.isFinite(Number(a.occurred_at)))
    .map((a) => ({ ...a, occurred_at: Number(a.occurred_at) }))
    .sort((a, b) => a.occurred_at - b.occurred_at || compareStr(String(a.action_id ?? ""), String(b.action_id ?? "")));
  const actionsInWindow = actions.filter((a) => a.occurred_at >= start && a.occurred_at < end);

  const inWindow = records.filter((r) => r.at >= start && r.at < end);
  const win = collectWindow(
    inWindow.filter((r) => P_PAGE_CONTEXTS.includes(r.page_context)),
    start,
    end,
  );
  const exp = summarizeExposure(win);
  const behavior = summarizeBehavior(actionsInWindow, itemsById);
  const pageContextsAll = {};
  for (const c of PAGE_CONTEXTS) pageContextsAll[c] = 0;
  for (const r of inWindow) if (Object.prototype.hasOwnProperty.call(pageContextsAll, r.page_context)) pageContextsAll[r.page_context] += 1;
  const searchPullCount = inWindow.reduce((acc, r) => acc + (r.page_context === "search" ? 1 : 0), 0);

  const exposureReady = exp.recs.length >= THRESHOLDS.minExposure && exp.knownRatio >= THRESHOLDS.minKnownTopicRatio;
  const behaviorReady = behavior.available;

  const goalMap = goal ? normalizeDist(goal.goal_topics) : new Map();
  const goalText = goal && typeof goal.goal_text === "string" ? goal.goal_text : "";
  const goalPresent = Boolean(goal && (goalText.trim().length > 0 || goalMap.size > 0));
  const goalTopics = goalMap.size > 0 ? toTopicArray(goalMap, "w").map((e) => ({ t: e.t, w: round(e.w) })) : [];
  const goalReady = goalPresent && goalMap.size > 0;

  const behaviorCmp =
    exposureReady && behaviorReady
      ? { D: distance(behavior.uMap, exp.pMap), by_topic: compareTopics("u", behavior.uMap, exp.pMap) }
      : null;
  const goalCmp =
    exposureReady && goalReady ? { D: distance(goalMap, exp.pMap), by_topic: compareTopics("g", goalMap, exp.pMap) } : null;

  let trend = null;
  if (wantPrev) {
    const prevWin = collectWindow(
      records.filter((r) => r.at >= prevStart && r.at < start && P_PAGE_CONTEXTS.includes(r.page_context)),
      prevStart,
      start,
    );
    const prev = summarizeExposure(prevWin);
    const prevReady = prev.recs.length >= THRESHOLDS.minExposure && prev.knownRatio >= THRESHOLDS.minKnownTopicRatio;
    if (prevReady) {
      trend = {
        prev_entropy: prev.entropy,
        entropy_delta: round(exp.entropy - prev.entropy),
        prev_top_source_share: prev.topSource ? prev.topSource.share : null,
      };
    }
  }

  const sessionIds = new Set();
  for (const r of inWindow) if (r.session_id) sessionIds.add(r.session_id);
  for (const a of actionsInWindow) if (a.session_id != null && String(a.session_id)) sessionIds.add(String(a.session_id));

  const window = {
    start,
    end,
    days,
    exposure_count: exp.recs.length,
    unique_items: exp.uniqueItems,
    action_count: actionsInWindow.length,
    session_count: sessionIds.size,
    unknown_topic_ratio: exp.recs.length > 0 ? round(exp.unknownCount / exp.recs.length) : 0,
    known_topic_ratio: round(exp.knownRatio),
    // 曝光计数 = 计入 P 的条数（home + video_related）；搜索页拉取单独计数，避免"平台喂你"被自己搜的污染
    search_pull_count: searchPullCount,
    page_contexts: pageContextsAll,
  };

  const goalBlock = {
    present: goalPresent,
    text: goalText,
    intent_mode: goal && typeof goal.intent_mode === "string" ? goal.intent_mode : null,
    topics: goalTopics,
    source: goal && typeof goal.source === "string" ? goal.source : null,
  };

  const exposureBlock = {
    available: exposureReady,
    topics: exp.topics,
    entropy: exp.entropy,
    repeat_rate: exp.repeatRate,
    unique_items: exp.uniqueItems,
    top_source: exp.topSource,
    source_count: exp.sourceCount,
  };

  const behaviorBlock = { available: behavior.available, topics: behavior.topics, sample_n: behavior.sampleN };
  if (behavior.reason) behaviorBlock.reason = behavior.reason;

  const alerts = [];
  const T = THRESHOLDS;

  if (exposureReady && exp.entropy < T.outputConcentrationEntropy) {
    const top2 = exp.topics.slice(0, 2);
    const topicSet = top2.map((x) => x.t);
    alerts.push({
      rule_id: "output_concentration",
      severity: "warn",
      title: "推荐输出集中在少数主题",
      detail:
        "窗口内 " + exp.recs.length + " 次曝光（已知主题 " + exp.knownCount + " 条）的主题熵为 " + exp.entropy +
        "，低于门槛 " + T.outputConcentrationEntropy + "；占比最高：" + percentilePair(top2) + "。",
      evidence: buildEvidence(exp.recs, (r) => Boolean(r.topics) && topicSet.some((t) => r.topics.has(t))),
      suggestion: "主动搜索与当前目标相关的主题，或在推荐流里对不需要的内容使用平台「不感兴趣」，再观察下一个窗口的分布变化。",
      thresholds_used: {
        minExposure: T.minExposure,
        minKnownTopicRatio: T.minKnownTopicRatio,
        outputConcentrationEntropy: T.outputConcentrationEntropy,
      },
    });
  }

  if (goalCmp && goalCmp.D !== null && goalCmp.D > T.gapDistance) {
    const gap = topGapTopic(goalCmp.by_topic, "g");
    // gap 取的是 (p-g) 最大的主题，不管 g 是否为 0：文案必须按 g 的实际权重分档，
    // 否则会在目标里明明写了这个主题时，说成"目标却没提到"。
    const gapG = Number(gap?.g ?? 0);
    const goalTop = goalTopics[0] ?? null;
    let goalShare = 0;
    if (goalTop) for (const entry of goalCmp.by_topic) if (entry.t === goalTop.t) goalShare = entry.p;
    alerts.push({
      rule_id: "goal_gap",
      severity: "warn",
      title: "曝光与你设置的目标有差距",
      detail:
        "目标分布与曝光分布的差异 D=" + goalCmp.D + "，超过门槛 " + T.gapDistance +
        (goalTop ? "；目标最关注 " + label(goalTop.t) + "（" + pct(goalTop.w) + "）" : "") +
        (goalTop ? "，它在窗口曝光里只占 " + pct(goalShare) : "") +
        (gap === null
          ? "。"
          : gapG < GOAL_MIN_TOPIC_WEIGHT
            ? "；曝光占比最高、目标却没提到的是 " + label(gap.t) + " " + pct(gap.p) + "。"
            : "；曝光占比最高、但目标里只占 " + pct(gapG) + " 的是 " + label(gap.t) + "（曝光 " + pct(gap.p) + "）。"),
      evidence: buildEvidence(exp.recs, (r) => Boolean(r.topics) && gap !== null && r.topics.has(gap.t)),
      suggestion: "用目标关键词主动搜索并停留，或把目标描述改成你实际想看的主题；系统只描述已记录的样本差异。",
      thresholds_used: {
        minExposure: T.minExposure,
        minKnownTopicRatio: T.minKnownTopicRatio,
        gapDistance: T.gapDistance,
      },
    });
  }

  if (behaviorCmp && behaviorCmp.D !== null) {
    const gap = topGapTopic(behaviorCmp.by_topic, "u");
    if (behaviorCmp.D > T.gapDistance && gap !== null && gap.diff > T.topDomination) {
      alerts.push({
        rule_id: "behavior_gap",
        severity: "warn",
        title: "某些主题的曝光明显高于你的行为",
        detail:
          "行为分布与曝光分布的差异 D=" + behaviorCmp.D + "（门槛 " + T.gapDistance + "）；" + label(gap.t) +
          " 的曝光占比 " + pct(gap.p) + " 比行为占比 " + pct(gap.u) + " 高 " + pct(gap.diff) +
          "（门槛 " + T.topDomination + "），合并后有效正向行为共 " + behavior.sampleN + " 条。",
        evidence: buildEvidence(exp.recs, (r) => Boolean(r.topics) && r.topics.has(gap.t)),
        suggestion: "对不需要的内容使用明确的负反馈，对想看的主题主动搜索，减少被动曝光带来的偏移。",
        thresholds_used: {
          minExposure: T.minExposure,
          minKnownTopicRatio: T.minKnownTopicRatio,
          minBehavior: T.minBehavior,
          gapDistance: T.gapDistance,
          topDomination: T.topDomination,
        },
      });
    }
  }

  if (exp.recs.length >= T.minExposure && exp.repeatRate > T.repeatRate) {
    const counts = new Map();
    for (const r of exp.recs) counts.set(r.canonical_key, (counts.get(r.canonical_key) ?? 0) + 1);
    const repeated = new Set();
    for (const [key, n] of counts) if (n > 1) repeated.add(key);
    alerts.push({
      rule_id: "repeat_heavy",
      severity: "info",
      title: "重复内容占比偏高",
      detail:
        "重复曝光率 " + exp.repeatRate + "（门槛 " + T.repeatRate + "）：窗口内 " + exp.recs.length +
        " 次曝光只对应 " + exp.uniqueItems + " 条不同内容。",
      evidence: buildEvidence(exp.recs, (r) => repeated.has(r.canonical_key)),
      suggestion: "对重复出现的内容使用「不感兴趣」，或主动搜索尚未覆盖的主题。",
      thresholds_used: { minExposure: T.minExposure, repeatRate: T.repeatRate },
    });
  }

  if (exp.recs.length >= T.minExposure && exp.topSource && exp.topSource.share > T.topSourceShare) {
    const topId = exp.topSource.id;
    alerts.push({
      rule_id: "source_concentration",
      severity: "info",
      title: "曝光的来源比较集中",
      detail:
        "来源「" + (exp.topSource.name || exp.topSource.id) + "」占 " + pct(exp.topSource.share) +
        " 的已知来源曝光（门槛 " + T.topSourceShare + "），共 " + exp.topSource.n + " 次；窗口内已知来源 " +
        exp.sourceCount + " 个。",
      evidence: buildEvidence(exp.recs, (r) => r.source_id === topId),
      suggestion: "在搜索结果里主动选择其他作者，别只依赖单一 UP 主的推荐流。",
      thresholds_used: { minExposure: T.minExposure, topSourceShare: T.topSourceShare },
    });
  }

  if (trend && exposureReady && trend.entropy_delta < -T.narrowingEntropyDrop) {
    const topicSet = exp.topics.slice(0, 2).map((x) => x.t);
    alerts.push({
      rule_id: "narrowing",
      severity: "warn",
      title: "主题范围在收窄",
      detail:
        "主题熵从 " + trend.prev_entropy + " 降到 " + exp.entropy + "（下降 " + Math.abs(trend.entropy_delta) +
        "，门槛 " + T.narrowingEntropyDrop + "）；只能说明本记录的样本范围变窄，不等于平台整体行为。",
      evidence: buildEvidence(exp.recs, (r) => Boolean(r.topics) && topicSet.some((t) => r.topics.has(t))),
      suggestion: "刻意浏览与当前主题不同的内容，观察下一个窗口的熵是否回升。",
      thresholds_used: {
        minExposure: T.minExposure,
        minKnownTopicRatio: T.minKnownTopicRatio,
        narrowingEntropyDrop: T.narrowingEntropyDrop,
      },
    });
  }

  // ---------- notes：门槛不满足时写清缺什么，界面必须原样显示 ----------
  const notes = [];
  const ruleList = "output_concentration、goal_gap、behavior_gap、repeat_heavy、source_concentration、narrowing";
  if (exp.recs.length === 0) {
    notes.push("窗口内没有曝光记录：曝光画像不可用，" + ruleList + " 均不评估。");
  } else if (exp.recs.length < T.minExposure) {
    notes.push(
      "曝光样本 " + exp.recs.length + " 条，低于门槛 " + T.minExposure + "：曝光画像不可用，" + ruleList + " 不评估。",
    );
  } else if (exp.knownRatio < T.minKnownTopicRatio) {
    notes.push(
      "曝光主题未知 " + exp.unknownCount + " 条，已知主题占比 " + round(exp.knownRatio) + " 低于门槛 " +
        T.minKnownTopicRatio + "：主题分布不可用，output_concentration、goal_gap、behavior_gap 不评估。",
    );
  }
  if (!behavior.available) notes.push("行为画像不可用（" + behavior.reason + "）：behavior_gap 不评估。");
  if (!goalPresent) notes.push("未设置目标：goal_cmp 为 null，goal_gap 不评估。");
  else if (!goalReady) notes.push("目标未匹配到已知主题：goal_cmp 为 null，goal_gap 不评估。");
  if (trend === null) {
    notes.push(
      wantPrev
        ? "前一窗口曝光不足或主题未知：trend 为 null，narrowing 不评估。"
        : "未启用前一窗口（prevWindow=false）：trend 为 null，narrowing 不评估。",
    );
  }
  if (searchPullCount > 0) {
    notes.push(
      "有 " + searchPullCount + " 条曝光来自搜索页（你自己主动搜的），按契约 §10.1 不计入曝光画像 P、熵、重复率与来源集中度。",
    );
  }

  notes.push(
    "阈值为演示校准值（minExposure=" + T.minExposure + "、minKnownTopicRatio=" + T.minKnownTopicRatio +
      "、minBehavior=" + T.minBehavior + " 等），结论只覆盖已记录的样本，不构成心理或社会诊断。",
  );

  return {
    schema_version: SCHEMA_VERSION,
    data_mode: dataModeOf(inWindow),
    generated_at: generatedAt,
    window,
    goal: goalBlock,
    exposure: exposureBlock,
    behavior: behaviorBlock,
    behavior_cmp: behaviorCmp,
    goal_cmp: goalCmp,
    trend,
    alerts,
    notes,
  };
}

// ---------- 目标文本兜底解析（无 AI） ----------

const EXCLUSION_SPLIT = /[\s，。；、,.;!?！？]+/;
const GOAL_CLAUSE_SPLIT = EXCLUSION_SPLIT;
const EXCLUSION_MARK = /(?:不想看|不想|不要|不看|排除|讨厌|少推)(.+)/;

function extractExclusions(text) {
  const out = [];
  if (!text) return out;
  for (const segment of text.split(EXCLUSION_SPLIT)) {
    const hit = segment.match(EXCLUSION_MARK);
    if (!hit) continue;
    const value = hit[1].trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

/**
 * 关键词兜底：10 个主题关键词表 + intent_mode 先验，不调用任何模型。
 * @param {string} text
 * @param {string} [intentMode]
 * @param {{profile_id?:string, updated_at?:number, version?:number}} [options] 时间与版本由调用方注入（本函数不读时钟）
 */
/**
 * 「放松」兜底：模型（或关键词）可能把"放松身心"当成噪声整块丢掉。
 * 命中（intent_mode=relax 或文本提到放松类词）时，给 RELAX_GROUP 固定 RELAX_GROUP_WEIGHT 份额，
 * 其余主题按原比例分享剩下的份额；未命中时**原样返回**，不改动用户明说的单一主题。
 * 纯函数：不读时钟、不联网、同输入同输出。
 * @param {Array<{t:string,w:number}>} topics
 * @param {string} intentMode
 * @param {string} text
 */
export function applyRelaxIntent(topics, intentMode, text) {
  const matched = intentMode === "relax" || RELAX_INTENT_RE.test(typeof text === "string" ? text : "");
  if (!matched) return topics;
  const list = Array.isArray(topics) ? topics : [];
  const others = list.filter((entry) => entry && TOPICS.includes(entry.t) && entry.w > 0 && !RELAX_GROUP.includes(entry.t));
  const relaxRaw = RELAX_GROUP.map((t) => ({ t, w: RELAX_GROUP_WEIGHT * (RELAX_GROUP_RATIO[t] ?? 0) }));
  const otherTotal = others.reduce((acc, entry) => acc + entry.w, 0);
  const restBudget = 1 - RELAX_GROUP_WEIGHT;
  const otherRaw = otherTotal > 0 ? others.map((entry) => ({ t: entry.t, w: (entry.w / otherTotal) * restBudget })) : [];

  const merged = [...relaxRaw, ...otherRaw].filter((entry) => entry.w >= GOAL_MIN_TOPIC_WEIGHT);
  if (merged.length === 0) return topics;
  merged.sort((a, b) => b.w - a.w || (TOPIC_ORDER.get(a.t) ?? 0) - (TOPIC_ORDER.get(b.t) ?? 0));
  const kept = merged.slice(0, GOAL_TOPIC_LIMIT);

  // 4 个主题的上限可能砍掉组内成员，但组的总份额不能让给别的主题：
  // 存活成员仍按 RELAX_GROUP_WEIGHT 占比分配，其余主题按原比例分享剩余部分。
  const keptRelax = kept.filter((entry) => RELAX_GROUP.includes(entry.t));
  const keptOther = kept.filter((entry) => !RELAX_GROUP.includes(entry.t));
  const relaxSum = keptRelax.reduce((acc, entry) => acc + entry.w, 0);
  const otherSum = keptOther.reduce((acc, entry) => acc + entry.w, 0);
  const out = [];
  if (keptRelax.length && keptOther.length) {
    for (const entry of keptRelax) out.push({ t: entry.t, w: round((entry.w / relaxSum) * RELAX_GROUP_WEIGHT) });
    for (const entry of keptOther) out.push({ t: entry.t, w: round((entry.w / otherSum) * restBudget) });
  } else {
    const only = keptRelax.length ? keptRelax : keptOther;
    const sum = only.reduce((acc, entry) => acc + entry.w, 0);
    for (const entry of only) out.push({ t: entry.t, w: round(entry.w / sum) });
  }
  out.sort((a, b) => b.w - a.w || (TOPIC_ORDER.get(a.t) ?? 0) - (TOPIC_ORDER.get(b.t) ?? 0));
  const total = out.reduce((acc, entry) => acc + entry.w, 0);
  if (!(total > 0)) return topics;
  return out;
}

export function parseGoalText(text, intentMode, options = {}) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  const intent = INTENT_MODES.includes(intentMode) ? intentMode : "relax";
  const priors = INTENT_PRIORS[intent] ?? {};

  // 按分句打分再等权合并：多意图句子里每个分句各贡献一份分布，
  // 最后出现的那个关键词不再能独吞整句话（旧实现按全句命中计数就会塌陷）。
  const clauseDists = [];
  let keywordHits = 0;
  for (const clause of trimmed.split(GOAL_CLAUSE_SPLIT)) {
    const seg = clause.trim().toLowerCase();
    if (!seg || EXCLUSION_MARK.test(seg)) continue; // 排除项不参与目标主题
    const local = new Map();
    for (const t of TOPICS) {
      let n = 0;
      for (const w of GOAL_KEYWORDS[t] ?? []) if (w && seg.includes(w)) n += 1;
      if (n === 0) continue;
      keywordHits += n;
      const extra = Math.min(n - 1, GOAL_KEYWORD_HIT_CAP - 1) * GOAL_KEYWORD_EXTRA;
      local.set(t, GOAL_KEYWORD_WEIGHT + extra);
    }
    if (local.size === 0) {
      // 分句没有关键词命中时用 intent_mode 先验（先验在这里是"整份分布"，不是陪衬）。
      for (const [t, w] of Object.entries(priors)) {
        if (TOPICS.includes(t) && Number(w) > 0) local.set(t, Number(w) * INTENT_PRIOR_WEIGHT);
      }
    }
    const sum = [...local.values()].reduce((acc, v) => acc + v, 0);
    if (!(sum > 0)) continue;
    clauseDists.push([...local.entries()].map(([t, s]) => [t, s / sum]));
  }

  const scores = new Map();
  if (clauseDists.length === 0) {
    // 整句没有任何可用信号：退回意图先验，source 仍标注 fallback（不冒充"读懂了目标"）。
    for (const [t, w] of Object.entries(priors)) {
      if (TOPICS.includes(t) && Number(w) > 0) scores.set(t, Number(w));
    }
  } else {
    for (const dist of clauseDists) {
      for (const [t, v] of dist) scores.set(t, (scores.get(t) ?? 0) + v / clauseDists.length);
    }
  }

  const total = [...scores.values()].reduce((acc, v) => acc + (v > 0 ? v : 0), 0);
  let goalTopics = [];
  if (total > 0) {
    // GOAL_TOPIC_LIMIT 只收窄"用户真的说了主题"的结果；纯先验兜底保留 intent 的完整预设分布，
    // 收窄它没有信息收益，还会让同类目标的默认值随常量漂移。
    const limit = keywordHits > 0 ? GOAL_TOPIC_LIMIT : TOPICS.length;
    const kept = [...scores.entries()]
      .filter(([t, s]) => TOPICS.includes(t) && s > 0 && s >= GOAL_MIN_TOPIC_WEIGHT)
      .sort((a, b) => b[1] - a[1] || (TOPIC_ORDER.get(a[0]) ?? 0) - (TOPIC_ORDER.get(b[0]) ?? 0))
      .slice(0, limit);
    const keptTotal = kept.reduce((acc, [, s]) => acc + s, 0);
    goalTopics = kept.map(([t, s]) => ({ t, w: round(s / keptTotal) }));
  }

  return {
    profile_id: typeof options.profile_id === "string" ? options.profile_id : PROFILE_ID,
    goal_text: trimmed,
    intent_mode: intent,
    goal_topics: goalTopics,
    exclusions: extractExclusions(trimmed),
    exploration_level: INTENT_EXPLORATION[intent] ?? 0.5,
    updated_at: Number.isFinite(Number(options.updated_at)) ? Number(options.updated_at) : 0,
    version: Number.isFinite(Number(options.version)) ? Number(options.version) : 1,
    source: "fallback",
  };
}

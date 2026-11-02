// 契约 §10.2：推荐候选池 + 确定性排序（AI 只写 why，不许改顺序/增删）。
// 候选只来自"窗口内已经被记录过、但用户从没点开过"的内容：不联网、不猜链接、不新增采集。
import { DAY_MS, WINDOW_DAYS } from "./constants.js";
import { itemTopics, normalizeDist, round } from "./metrics.js";

// 契约 §10.1：搜索页是用户主动拉取，不算"平台推荐曝光"，因此不进 P，也不参与 gap/来源多样性。
const P_PAGE_CONTEXTS = new Set(["home", "video_related"]);
// 只要这个内容被 open/watch 过就算"已看过"，不再推荐（点击本身不是候选）。
const ENGAGED_ACTIONS = new Set(["open", "watch"]);

export const RECO_WEIGHTS = Object.freeze({
  goal_match: 0.4,
  fills_gap: 0.25,
  source_diversity: 0.2,
  novelty: 0.15,
});

// 选中一条之后，同主题/同来源的后续候选按计划书 §6.6 的动态收益降权，避免三条都是同一个 UP 主。
const TOPIC_DISCOUNT = 0.6;
const SOURCE_DISCOUNT = 0.7;
const MAX_LIMIT = 5;

function compareStr(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function exclusionMatcher(goal) {
  const raw = Array.isArray(goal?.exclusions) ? goal.exclusions : [];
  const needles = raw
    .map((entry) => (typeof entry === "string" ? entry.trim().toLowerCase() : ""))
    .filter((entry) => entry.length > 0)
    .slice(0, 20);
  if (needles.length === 0) return () => false;
  // 口径：排除词命中标题子串即排除（简单、可解释、用户可预期）；不做语义推断。
  return (title) => {
    const hay = String(title ?? "").toLowerCase();
    if (!hay) return false;
    return needles.some((needle) => hay.includes(needle));
  };
}

/**
 * 契约 §10.2：rankRecommendations(input, k) -> Recommendation[]
 * 纯函数：不读时钟（now 由参数给）、不联网、同输入逐字节同输出。
 */
export function rankRecommendations(input = {}, k = 3) {
  const items = Array.isArray(input.items) ? input.items.filter(Boolean) : [];
  const exposures = Array.isArray(input.exposures) ? input.exposures.filter(Boolean) : [];
  const actions = Array.isArray(input.actions) ? input.actions.filter(Boolean) : [];
  const goal = input.goal && typeof input.goal === "object" ? input.goal : null;

  const wanted = Math.trunc(Number(k));
  const limit = Number.isFinite(wanted) ? Math.max(0, Math.min(MAX_LIMIT, wanted)) : 3;
  if (limit === 0) return [];

  const now = Number(input.now);
  const end = Number.isFinite(now) ? now : 0;
  const rawDays = Number(input.windowDays);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : WINDOW_DAYS;
  const start = end - days * DAY_MS;

  const byId = new Map();
  for (const item of items) if (item.content_id != null) byId.set(String(item.content_id), item);

  // ---- 窗口内的曝光 ----
  const seen = new Map(); // content_id -> { total, platform, lastAt, lastContext }
  const pTopicWeight = new Map();
  const pSourceCount = new Map();
  let pTotal = 0;

  for (const exposure of exposures) {
    const at = Number(exposure.exposed_at);
    if (!Number.isFinite(at) || at < start || at >= end) continue;
    const contentId = exposure.content_id != null ? String(exposure.content_id) : "";
    if (!contentId) continue;
    const context = typeof exposure.page_context === "string" ? exposure.page_context : "";
    const item = byId.get(contentId) ?? null;

    const prev = seen.get(contentId) ?? { total: 0, platform: 0, lastAt: -Infinity, lastContext: "" };
    prev.total += 1;
    if (P_PAGE_CONTEXTS.has(context)) prev.platform += 1;
    if (at > prev.lastAt || (at === prev.lastAt && compareStr(context, prev.lastContext) > 0)) {
      prev.lastAt = at;
      prev.lastContext = context;
    }
    seen.set(contentId, prev);

    if (!P_PAGE_CONTEXTS.has(context)) continue;
    pTotal += 1;
    const topics = itemTopics(item);
    if (topics) for (const [t, w] of topics) pTopicWeight.set(t, (pTopicWeight.get(t) ?? 0) + w);
    const sourceId = item && item.source_id != null ? String(item.source_id) : "";
    if (sourceId) pSourceCount.set(sourceId, (pSourceCount.get(sourceId) ?? 0) + 1);
  }

  const pTopics = normalizeDist(pTopicWeight);
  const pSourceShare = new Map();
  if (pTotal > 0) for (const [sourceId, n] of pSourceCount) pSourceShare.set(sourceId, n / pTotal);

  // ---- 已看过的内容（open/watch）----
  const engaged = new Set();
  for (const action of actions) {
    const type = typeof action?.action_type === "string" ? action.action_type : "";
    if (!ENGAGED_ACTIONS.has(type)) continue;
    const at = Number(action.occurred_at);
    if (Number.isFinite(at) && (at < start || at >= end)) continue;
    const contentId = action.content_id != null ? String(action.content_id) : "";
    if (contentId) engaged.add(contentId);
  }

  const goalMap = goal ? normalizeDist(goal.goal_topics) : new Map();
  const isExcluded = exclusionMatcher(goal);

  // ---- 候选 ----
  const candidates = [];
  let maxTotal = 0;
  for (const [, stats] of seen) if (stats.total > maxTotal) maxTotal = stats.total;

  for (const [contentId, stats] of seen) {
    if (engaged.has(contentId)) continue;
    const item = byId.get(contentId);
    if (!item) continue;
    const url = typeof item.url === "string" ? item.url : "";
    const title = typeof item.title === "string" ? item.title : "";
    if (!url) continue;
    if (isExcluded(title)) continue;

    const topics = itemTopics(item) ?? new Map();
    const sourceId = item.source_id != null ? String(item.source_id) : "";

    // 目标吻合：两个归一化分布的內积（目标缺失 -> 0，不假装吻合）。
    let goalMatch = 0;
    if (goalMap.size > 0 && topics.size > 0) {
      for (const [t, w] of topics) goalMatch += w * (goalMap.get(t) ?? 0);
    }

    // 补缺口：越是你很少被喂到的主题得分越高（P 里没有 -> 全额 1）。
    let fillsGap = 0;
    if (topics.size > 0) {
      for (const [t, w] of topics) fillsGap += w * (1 - (pTopics.get(t) ?? 0));
    } else {
      fillsGap = 0.5; // 主题未知：不确定就不给满额，也不判零
    }

    // 来源多样性：这个 UP 主在你 P 里占比越低越值得看；没出现过 -> 满额。
    const sourceShare = sourceId ? pSourceShare.get(sourceId) ?? 0 : 0;
    const sourceDiversity = 1 - sourceShare;

    // 新颖度：同一张卡在窗口里被反复刷到的次数越多，越不新鲜。
    const novelty = maxTotal > 0 ? 1 - Math.min(1, stats.total / maxTotal) : 1;

    const basis = {
      goal_match: round(clamp01(goalMatch)),
      fills_gap: round(clamp01(fillsGap)),
      source_diversity: round(clamp01(sourceDiversity)),
      novelty: round(clamp01(novelty)),
    };
    const score =
      RECO_WEIGHTS.goal_match * basis.goal_match +
      RECO_WEIGHTS.fills_gap * basis.fills_gap +
      RECO_WEIGHTS.source_diversity * basis.source_diversity +
      RECO_WEIGHTS.novelty * basis.novelty;

    candidates.push({
      content_id: contentId,
      title,
      url,
      source_name: item.source_name != null ? String(item.source_name) : "",
      source_id: sourceId,
      page_context: stats.lastContext,
      basis,
      effective: score,
      topicKeys: [...topics.keys()].sort(compareStr),
      why: null,
    });
  }

  // ---- 贪心：每轮取生效分最高者，同分按 content_id 升序（确定性）----
  const pool = candidates.slice().sort((a, b) => compareStr(a.content_id, b.content_id));
  const picked = [];
  while (picked.length < limit && pool.length > 0) {
    pool.sort((a, b) => b.effective - a.effective || compareStr(a.content_id, b.content_id));
    const best = pool.shift();
    picked.push(best);
    for (const rest of pool) {
      const shareTopic =
        rest.topicKeys.length > 0 && best.topicKeys.length > 0 && rest.topicKeys.some((t) => best.topicKeys.includes(t));
      if (shareTopic) rest.effective *= TOPIC_DISCOUNT;
      if (rest.source_id && rest.source_id === best.source_id) rest.effective *= SOURCE_DISCOUNT;
    }
  }

  return picked.map((entry) => ({
    content_id: entry.content_id,
    title: entry.title,
    url: entry.url,
    source_name: entry.source_name,
    page_context: entry.page_context,
    score: round(clamp01(entry.effective)),
    basis: entry.basis,
    why: null,
  }));
}

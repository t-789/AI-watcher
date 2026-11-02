// 测试共用的构造器与朴素参考实现（不是测试文件：文件名不匹配 node --test 的发现规则）。
import { DAY_MS } from "../../src/core/constants.js";

export const NOW = Date.UTC(2026, 10, 15, 0, 0, 0);
export const DAY = DAY_MS;
export const HOUR = 3600000;
export const MIN = 60000;

/** 与生成器同族的确定性 PRNG，测试自己持有一份，避免依赖回放模块。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mkItem(id, topics, opts = {}) {
  return {
    content_id: id,
    platform: "bilibili",
    canonical_key: opts.canonicalKey ?? "ck_" + id,
    title: opts.title ?? "内容 " + id,
    url: opts.url ?? "https://example.test/v/" + id,
    source_id: opts.sourceId ?? "src_" + id,
    source_name: opts.sourceName ?? "来源 " + (opts.sourceId ?? id),
    duration_s: opts.durationS ?? 600,
    view_count: 1000,
    danmaku_count: 10,
    published_at: NOW - DAY,
    fetched_at: NOW,
    desc: "",
    comments: [],
    topics,
    facets: [],
    value_notes: null,
    origin: opts.origin ?? "real",
    annotation: { status: "unknown", model: null, at: null },
  };
}

export function mkExposure(id, contentId, at, opts = {}) {
  return {
    exposure_id: id,
    profile_id: "local-default",
    session_id: opts.sessionId ?? "s1",
    content_id: contentId,
    exposed_at: at,
    page_context: opts.pageContext ?? "home",
    observable_rank: opts.rank ?? 1,
    origin: opts.origin ?? "real",
  };
}

export function mkAction(id, contentId, actionType, at, opts = {}) {
  const action = {
    action_id: id,
    profile_id: "local-default",
    session_id: opts.sessionId ?? "s1",
    action_type: actionType,
    occurred_at: at,
    origin: opts.origin ?? "real",
  };
  if (contentId != null) action.content_id = contentId;
  if (opts.exposureId) action.exposure_id = opts.exposureId;
  if (opts.topicId) action.topic_id = opts.topicId;
  if (opts.watchSeconds != null) action.watch_seconds = opts.watchSeconds;
  return action;
}

/** n 条同内容曝光，默认全部落在最近 1 小时内（必然在窗口内）。 */
export function burst(prefix, contentId, count, opts = {}) {
  const out = [];
  const start = opts.start ?? NOW - HOUR;
  const step = opts.step ?? MIN;
  for (let i = 0; i < count; i += 1) {
    out.push(mkExposure(prefix + "_" + i, contentId, start + i * step, opts));
  }
  return out;
}

/** 朴素全量重扫：直接从存活记录重算计数表。 */
export function naiveCounts(records, keysOf) {
  const counts = new Map();
  for (const record of records) {
    for (const entry of keysOf(record) || []) {
      if (!entry || entry.key == null) continue;
      const weight = Number(entry.weight ?? 1);
      if (!Number.isFinite(weight) || weight === 0) continue;
      counts.set(String(entry.key), (counts.get(String(entry.key)) ?? 0) + weight);
    }
  }
  return counts;
}

/** Top-K 的朴素参考：全排序后取前 k（同分按 tieKey、再按原下标）。 */
export function fullSortTop(candidates, k, scoreFn) {
  const limit = Math.floor(Number(k));
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const scored = candidates.map((item, idx) => {
    const raw = Number(scoreFn(item, idx));
    const key =
      item && typeof item === "object"
        ? typeof item.tieKey === "string"
          ? item.tieKey
          : item.content_id != null
            ? String(item.content_id)
            : item.id != null
              ? String(item.id)
              : String(item)
        : String(item);
    return { item, score: Number.isFinite(raw) ? raw : Number.NEGATIVE_INFINITY, key, idx };
  });
  scored.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.idx - b.idx);
  return scored.slice(0, limit).map((entry) => entry.item);
}

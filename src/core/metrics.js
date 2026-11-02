// 主题分布指标（计划书 §6.4/§6.5）：全部纯函数，未知主题先排除、再单独报告未知比例。
import { ROUND_DIGITS, TOPICS } from "./constants.js";

export function round(value, digits = ROUND_DIGITS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
}

// 归一到和为 1，过滤未知主题与非正权重；按 TOPICS 顺序存 Map，保证迭代顺序确定。
function normalizeMap(m) {
  let total = 0;
  for (const w of m.values()) total += w;
  if (!(total > 0)) return new Map();
  const out = new Map();
  for (const t of TOPICS) if (m.has(t)) out.set(t, m.get(t) / total);
  for (const [t, w] of m) if (!out.has(t)) out.set(t, w / total);
  return out;
}

/** [{t,w}] 或 Map<topic, w> -> 归一化 Map（和为 1）。空/全无效 -> 空 Map（= 未知）。 */
export function normalizeDist(dist) {
  const m = new Map();
  if (dist instanceof Map) {
    for (const [t, w] of dist) {
      const n = Number(w);
      if (!TOPICS.includes(t) || !Number.isFinite(n) || n <= 0) continue;
      m.set(t, (m.get(t) ?? 0) + n);
    }
  } else if (Array.isArray(dist)) {
    for (const entry of dist) {
      if (!entry || typeof entry !== "object") continue;
      const n = Number(entry.w);
      if (!TOPICS.includes(entry.t) || !Number.isFinite(n) || n <= 0) continue;
      m.set(entry.t, (m.get(entry.t) ?? 0) + n);
    }
  }
  return normalizeMap(m);
}

/** 内容的主题向量；topics 为空或全为未知主题 -> null（未知，不强行归类）。 */
export function itemTopics(item) {
  if (!item || !Array.isArray(item.topics) || item.topics.length === 0) return null;
  const m = normalizeDist(item.topics);
  return m.size === 0 ? null : m;
}

/** 归一化主题熵 H = -Σ p ln p / ln K，K = 10；空输入 -> 0。 */
export function entropy(dist) {
  const m = normalizeDist(dist);
  if (m.size <= 1) return 0;
  let h = 0;
  for (const w of m.values()) h -= w * Math.log(w);
  const normalized = h / Math.log(TOPICS.length);
  return round(Math.min(1, Math.max(0, normalized)));
}

/** 分布距离 D = 0.5 * Σ|a - b|；任一方未知（无已知主题）-> null。双方先各自归一化。 */
export function distance(a, b) {
  const ma = normalizeDist(a);
  const mb = normalizeDist(b);
  if (ma.size === 0 || mb.size === 0) return null;
  const keys = new Set();
  for (const t of ma.keys()) keys.add(t);
  for (const t of mb.keys()) keys.add(t);
  let sum = 0;
  for (const t of keys) sum += Math.abs((ma.get(t) ?? 0) - (mb.get(t) ?? 0));
  return round(sum / 2);
}

function canonicalKeyOf(exposure, byId) {
  const cid = exposure && exposure.content_id != null ? String(exposure.content_id) : "";
  const item = byId.get(cid);
  if (item && item.canonical_key) return String(item.canonical_key);
  if (exposure && exposure.canonical_key) return String(exposure.canonical_key);
  return cid;
}

/** 重复曝光率 = 1 - 窗口内唯一 canonical_key 数 / 曝光总数；空输入 -> 0。 */
export function repeatRate(exposures, items) {
  const list = Array.isArray(exposures) ? exposures : [];
  if (list.length === 0) return 0;
  const byId = new Map();
  if (items instanceof Map) {
    for (const [k, v] of items) byId.set(String(k), v);
  } else if (Array.isArray(items)) {
    for (const item of items) if (item && item.content_id != null) byId.set(String(item.content_id), item);
  }
  const seen = new Set();
  for (const exposure of list) {
    if (!exposure) continue;
    seen.add(canonicalKeyOf(exposure, byId));
  }
  return round(1 - seen.size / list.length);
}

/** [{t,w}] 数组输出，按 w 降序、同分按 TOPICS 顺序，便于逐字节复现。 */
export function toTopicArray(map, weightKey) {
  const order = new Map(TOPICS.map((t, i) => [t, i]));
  const list = [];
  for (const [t, w] of map) list.push({ t, [weightKey]: w });
  list.sort((a, b) => {
    const diff = b[weightKey] - a[weightKey];
    if (diff !== 0) return diff;
    return (order.get(a.t) ?? 0) - (order.get(b.t) ?? 0);
  });
  return list;
}

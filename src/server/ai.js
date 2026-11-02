import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// src/core/constants.js 归 TASK-CORE。并行开发期它可能还没落地：能用就用，不能用就退回
// docs/CONTRACT.md §1 冻结的取值，避免服务层被上游进度卡住（契约取值本就是冻结的）。
const CONTRACT = Object.freeze({
  PORT: 3789,
  SCHEMA_VERSION: 1,
  PROFILE_ID: "local-default",
  WINDOW_DAYS: 7,
  TOPICS: Object.freeze(["tech", "science", "game", "anime", "film_tv", "music", "study", "life", "sports", "news"]),
});

let coreConstants = null;
try {
  coreConstants = await import("../core/constants.js");
} catch {
  coreConstants = null;
}

export const TOPICS = Object.freeze(Array.isArray(coreConstants?.TOPICS) ? [...coreConstants.TOPICS] : [...CONTRACT.TOPICS]);
export const CONTRACT_VALUES = Object.freeze({ ...CONTRACT, TOPICS });

const BASE_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-chat";
const TIMEOUT_MS = 25_000;
const MAX_BATCH = 8;
const MAX_CONCURRENCY = 2;
const MAX_ATTEMPTS = 2; // 首次 + 1 次重试（仅网络/5xx）

const CONTENT_TYPES = new Set(["评测", "教程", "资讯", "vlog", "娱乐", "观点"]);
const EVIDENCE_LEVELS = new Set(["weak", "medium", "strong"]);
const TIMELINESS = new Set(["recent", "dated", "unknown"]);
const SUGGESTION_ACTIONS = new Set(["search", "watch_other_source", "platform_feedback", "keep"]);

const MAX_EVIDENCE = 12;

// 降级词典：无 key / 请求失败时只用关键词兜底，不伪装成模型判断。
const KEYWORDS = Object.freeze({
  tech: ["ai", "人工智能", "大模型", "显卡", "笔记本", "手机", "数码", "编程", "代码", "芯片", "处理器", "算法", "开源", "软件", "电脑", "python", "装机", "deepseek", "gpt", "评测", "参数"],
  science: ["科学", "物理", "化学", "宇宙", "天文", "生物", "科普", "实验", "数学", "研究", "细胞", "量子"],
  game: ["游戏", "steam", "手游", "主机", "电竞", "原神", "王者荣耀", "攻略", "通关", "联机", "帧数"],
  anime: ["动漫", "动画", "二次元", "番剧", "漫画", "手办", "cos", "声优"],
  film_tv: ["电影", "剧集", "电视剧", "影视", "影评", "纪录片", "综艺", "剧情", "解说", "上映"],
  music: ["音乐", "歌曲", "翻唱", "钢琴", "吉他", "编曲", "乐队", "live", "演唱会"],
  study: ["学习", "考试", "考研", "课程", "教程", "复习", "笔记", "求职", "面试", "四六级", "上岸", "干货"],
  life: ["生活", "美食", "旅行", "做饭", "菜谱", "日常", "vlog", "家居", "减脂", "健康", "探店"],
  sports: ["体育", "健身", "篮球", "足球", "跑步", "nba", "训练", "运动", "比赛"],
  news: ["新闻", "时事", "社会", "财经", "股市", "政策", "国际", "热点", "事件", "通报"],
});

const LABEL_SYSTEM_PROMPT = [
  "你是内容标注器，只输出一个 JSON 对象，不要解释、不要 markdown 代码块。",
  '输入：{"items":[{"i":序号,"title":标题,"desc":简介,"author":作者,"comments":热评,"duration":时长秒}]}',
  '输出：{"results":[{"i":序号,"topics":[{"t":主题,"w":权重}],"content_type":"评测|教程|资讯|vlog|娱乐|观点","clickbait":0到1,"emotionality":0到1,"info_density":0到1,"value_notes":{"evidence":"weak|medium|strong","timeliness":"recent|dated|unknown","note":"不超过40字"},"summary":"不超过40字"}]}',
  "主题 t 只能取其一：" + CONTRACT.TOPICS.join(" "),
  '无法判断主题时输出 "topics":[]，不要瞎猜。同一内容的多个主题权重 w ∈ [0,1] 且和为 1。',
].join("\n");

const NARRATIVE_SYSTEM_PROMPT = [
  "你是推荐内容观察助手，只输出一个 JSON 对象，不要解释、不要 markdown 代码块。",
  '输入：{"summary":统计摘要,"evidence":[{"content_id":证据 id,"title":标题,"at":时间}]}',
  '输出：{"narrative":"不超过200字","suggestions":[{"title":"不超过20字","why":"不超过60字","action":"search|watch_other_source|platform_feedback|keep","evidence_ids":["content_id"]}]}',
  "建议最多 3 条。evidence_ids 只能从输入的 evidence 里选，禁止编造链接、标题或引文。没有证据就不要给建议。",
  "只描述统计现象，不做心理诊断，不夸大平台因果。",
].join("\n");

export function createAI(options = {}) {
  const apiKey = String(options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "").trim();
  const model = options.model ?? DEFAULT_MODEL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const cachePath = options.cachePath ?? null;
  const cache = loadCache(cachePath);
  const counters = { requests: 0, cache_hits: 0, failures: 0, labeled: 0, narratives: 0 };
  const limiter = createLimiter(MAX_CONCURRENCY);
  // key 只影响 mode，绝不出现在任何返回/log 里。
  const mode = apiKey ? "live" : "degraded";

  async function callChat(system, user) {
    if (!apiKey) throw new Error("no api key");
    const body = JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    counters.requests += 1; // 一次逻辑请求只计一次，重试不重复计
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchImpl(BASE_URL, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + apiKey },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.status >= 500) {
          lastError = new Error("upstream " + response.status);
          continue; // 5xx 可重试
        }
        if (!response.ok) {
          lastError = new Error("upstream " + response.status);
          break; // 4xx 重试无意义
        }
        const payload = await response.json();
        const content = payload?.choices?.[0]?.message?.content ?? "";
        return parseJsonObject(content);
      } catch (error) {
        lastError = error; // 网络/超时 → 重试
      }
    }
    counters.failures += 1;
    throw lastError ?? new Error("request failed");
  }

  async function runBatch(batch) {
    const payload = {
      items: batch.map((entry, index) => ({
        i: index,
        title: clipText(entry.item.title, 120) ?? "",
        desc: clipText(entry.item.desc, 300) ?? "",
        author: clipText(entry.item.source_name, 40) ?? "",
        comments: (Array.isArray(entry.item.comments) ? entry.item.comments : []).slice(0, 3).map((c) => clipText(c, 100) ?? ""),
        duration: Number.isFinite(entry.item.duration_s) ? entry.item.duration_s : null,
      })),
    };
    let parsed = null;
    try {
      parsed = await callChat(LABEL_SYSTEM_PROMPT, JSON.stringify(payload));
    } catch {
      parsed = null;
    }
    const byIndex = new Map();
    for (const result of Array.isArray(parsed?.results) ? parsed.results : []) {
      if (result && Number.isInteger(result.i)) byIndex.set(result.i, result);
    }
    return batch.map((entry, index) => {
      const value = validateLabel(byIndex.get(index));
      if (!value) return { item: entry.item, label: settle(entry.item, keywordLabel(entry.item), "keywords", false) };
      cache.set(entry.key, value);
      appendCache(cachePath, entry.key, value, model, now);
      return { item: entry.item, label: settle(entry.item, value, "ai", false) };
    });
  }

  async function label(items) {
    const list = (Array.isArray(items) ? items : []).filter((item) => item && item.content_id);
    const settled = new Map();
    const misses = [];
    for (const item of list) {
      const key = labelCacheKey(item);
      const hit = cache.get(key);
      if (hit) {
        counters.cache_hits += 1;
        settled.set(item.content_id, settle(item, hit, "cache", true));
      } else {
        misses.push({ item, key });
      }
    }
    if (misses.length) {
      if (mode === "degraded") {
        for (const entry of misses) settled.set(entry.item.content_id, settle(entry.item, keywordLabel(entry.item), "keywords", false));
      } else {
        const batches = chunk(misses, MAX_BATCH);
        const done = await Promise.all(batches.map((batch) => limiter(() => runBatch(batch))));
        for (const batch of done) for (const entry of batch) settled.set(entry.item.content_id, entry.label);
      }
    }
    counters.labeled += list.length;
    return list.map((item) => settled.get(item.content_id) ?? settle(item, keywordLabel(item), "keywords", false));
  }

  async function narrative(input) {
    const evidence = (Array.isArray(input?.evidence) ? input.evidence : []).filter((entry) => entry && typeof entry.content_id === "string");
    const allowed = new Set(evidence.map((entry) => entry.content_id));
    if (mode === "degraded") return { narrative: "", suggestions: [], model, cached: false, degraded: true };
    counters.narratives += 1;
    const payload = {
      summary: input?.summary ?? {},
      evidence: evidence.slice(0, MAX_EVIDENCE).map((entry) => ({
        content_id: entry.content_id,
        title: clipText(entry.title, 80) ?? "",
        at: Number.isFinite(entry.at) ? entry.at : null,
      })),
    };
    let parsed = null;
    try {
      parsed = await callChat(NARRATIVE_SYSTEM_PROMPT, JSON.stringify(payload));
    } catch {
      parsed = null;
    }
    if (!parsed) return { narrative: "", suggestions: [], model, cached: false, degraded: true };
    const validated = validateNarrative(parsed, allowed);
    if (!validated.narrative && validated.suggestions.length === 0) {
      return { narrative: "", suggestions: [], model, cached: false, degraded: true };
    }
    return { ...validated, model, cached: false, degraded: false };
  }

  return {
    mode,
    model,
    label,
    narrative,
    stats: () => ({ ...counters }),
    cacheSize: () => cache.size,
  };
}

// 缓存键 = sha1(title|desc|comments[0..2])，契约 §6。
export function labelCacheKey(item) {
  const comments = (Array.isArray(item?.comments) ? item.comments : []).slice(0, 3);
  return sha1([item?.title ?? "", item?.desc ?? "", ...comments].join("|"));
}

// 模型输出必须 w ∈ [0,1]（契约 §6）；用户/兜底输入是相对权重，归一化后即可，故允许 maxWeight=Infinity。
export function normaliseTopics(raw, options = {}) {
  if (!Array.isArray(raw)) return null;
  const maxWeight = options.maxWeight ?? 1;
  const best = new Map();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const topic = typeof entry.t === "string" ? entry.t.trim() : "";
    if (!TOPICS.includes(topic)) continue;
    const weight = toWeight(entry.w, maxWeight);
    if (weight === null || weight === 0) continue;
    best.set(topic, Math.max(best.get(topic) ?? 0, weight));
  }
  return entriesToWeights([...best.entries()].map(([t, w]) => ({ t, w })));
}

// 归一化权重并让和恰好为 1：舍入残差补到最大项，避免浮点尾巴。
export function entriesToWeights(entries) {
  const sum = entries.reduce((acc, entry) => acc + entry.w, 0);
  if (!sum) return [];
  const sorted = entries
    .map((entry) => ({ t: entry.t, w: entry.w / sum }))
    .sort((a, b) => b.w - a.w || (a.t < b.t ? -1 : 1));
  const rounded = sorted.map((entry) => ({ t: entry.t, w: Math.round(entry.w * 1000) / 1000 }));
  const drift = 1 - rounded.reduce((acc, entry) => acc + entry.w, 0);
  rounded[0].w = Math.max(0, Math.round((rounded[0].w + drift) * 1000) / 1000);
  return rounded;
}

export function validateLabel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  const topics = normaliseTopics(raw.topics);
  if (topics) out.topics = topics;
  if (typeof raw.content_type === "string" && CONTENT_TYPES.has(raw.content_type.trim())) out.content_type = raw.content_type.trim();
  for (const field of ["clickbait", "emotionality", "info_density"]) {
    const value = toUnit(raw[field]);
    if (value !== null) out[field] = Math.round(value * 1000) / 1000;
  }
  const notes = raw.value_notes;
  if (notes && typeof notes === "object") {
    const cleaned = {};
    if (typeof notes.evidence === "string" && EVIDENCE_LEVELS.has(notes.evidence.trim())) cleaned.evidence = notes.evidence.trim();
    if (typeof notes.timeliness === "string" && TIMELINESS.has(notes.timeliness.trim())) cleaned.timeliness = notes.timeliness.trim();
    const note = clipText(notes.note, 40);
    if (note) cleaned.note = note;
    if (Object.keys(cleaned).length) out.value_notes = cleaned;
  }
  const summary = clipText(raw.summary, 40);
  if (summary) out.summary = summary;
  return Object.keys(out).length ? out : null;
}

export function keywordLabel(item) {
  const text = [item?.title, item?.desc, ...(Array.isArray(item?.comments) ? item.comments : [])]
    .filter((part) => typeof part === "string" && part)
    .join(" ")
    .toLowerCase();
  const hits = [];
  for (const [topic, words] of Object.entries(KEYWORDS)) {
    let count = 0;
    for (const word of words) if (text.includes(word)) count += 1;
    if (count > 0) hits.push({ t: topic, w: count });
  }
  const out = {};
  const topics = entriesToWeights(hits);
  if (topics.length) out.topics = topics;
  const summary = clipText(item?.title, 40);
  if (summary) out.summary = summary;
  return out;
}

function validateNarrative(raw, allowed) {
  const narrative = clipText(raw?.narrative, 200) ?? "";
  const suggestions = [];
  // 先逐条校验再截断到 3 条：否则前三条里只要有非法的，合法建议就被挤掉了
  for (const entry of (Array.isArray(raw?.suggestions) ? raw.suggestions : []).slice(0, 10)) {
    if (!entry || typeof entry !== "object") continue;
    const title = clipText(entry.title, 20);
    if (!title) continue;
    const action = typeof entry.action === "string" && SUGGESTION_ACTIONS.has(entry.action.trim()) ? entry.action.trim() : null;
    if (!action) continue; // 枚举非法：丢弃该建议而不是替它编一个动作
    const ids = [...new Set((Array.isArray(entry.evidence_ids) ? entry.evidence_ids : []).filter((id) => typeof id === "string" && allowed.has(id)))];
    if (!ids.length) continue; // 没有合法证据的建议不出
    suggestions.push({ title, why: clipText(entry.why, 60) ?? "", action, evidence_ids: ids.slice(0, 4) });
  }
  return { narrative, suggestions: suggestions.slice(0, 3) };
}

function settle(item, value, source, cached) {
  const label = { content_id: item.content_id, source, model: source === "keywords" ? "keywords" : DEFAULT_MODEL, cached };
  if (Array.isArray(value?.topics)) label.topics = value.topics;
  for (const field of ["content_type", "clickbait", "emotionality", "info_density", "value_notes", "summary"]) {
    if (value?.[field] !== undefined) label[field] = value[field];
  }
  return label;
}

function parseJsonObject(text) {
  if (typeof text !== "string") return null;
  const fence = "```";
  let trimmed = text.trim();
  if (trimmed.startsWith(fence)) {
    trimmed = trimmed.slice(fence.length);
    const end = trimmed.lastIndexOf(fence);
    if (end !== -1) trimmed = trimmed.slice(0, end);
    trimmed = trimmed.trim().replace(/^(json|JSON)\s*/, "");
  }
  const start = trimmed.indexOf("{");
  const stop = trimmed.lastIndexOf("}");
  if (start === -1 || stop <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, stop + 1));
  } catch {
    return null;
  }
}

function loadCache(path) {
  const map = new Map();
  if (!path || !existsSync(path)) return map;
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record.k === "string" && record.v && typeof record.v === "object") map.set(record.k, record.v);
    } catch {
      // 坏行跳过：缓存是可重建派生物，不能让一行脏数据挡住启动
    }
  }
  return map;
}

function appendCache(path, key, value, model, now) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ k: key, v: value, model, at: now() }) + "\n");
  } catch {
    // 缓存写失败只影响命中率，不影响正确性
  }
}

function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= max || !waiting.length) return;
    active += 1;
    const job = waiting.shift();
    job.task().then(job.resolve, job.reject).finally(() => {
      active -= 1;
      next();
    });
  };
  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
}

function chunk(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

function toWeight(value, maxWeight) {
  const num = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  if (num < 0 || num > maxWeight) return null;
  return num;
}

function toUnit(value) {
  const num = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  if (num < 0 || num > 1) return null;
  return num;
}

export function clipText(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const chars = [...trimmed];
  return chars.length > max ? chars.slice(0, max).join("") : trimmed;
}

function sha1(text) {
  return createHash("sha1").update(String(text)).digest("hex");
}

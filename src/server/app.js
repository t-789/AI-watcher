import { createHash } from "node:crypto";
// TOPICS 是契约 §1 冻结的表（数据，不是行为模块）；store / labeler / analyze / clock 全部走 deps 注入。
import { TOPICS, CONTRACT_VALUES, normaliseTopics } from "./ai.js";

const PLATFORM = "bilibili";
const PAGE_CONTEXTS = new Set(["home", "search", "video_related"]);
const ACTION_TYPES = new Set(["open", "watch", "like", "coin", "favorite", "search", "scroll_past"]);
const INTENT_MODES = new Set(["relax", "learn_event", "skill", "exam", "cure"]);
const BODY_LIMIT = 1024 * 1024;
const MAX_DESC_CHARS = 800;
const MAX_COMMENTS = 8;
const MAX_EXCLUSIONS = 20;
const MAX_WINDOW_DAYS = 30;

// 追踪参数一律抹掉：同一视频从首页/搜索/分享/移动端进来必须归并到同一个 canonical_key。
const TRACKING_PARAM = /^(spm|spm_id_from|spm_id_from_.*|vd_source|from|from_source|from_spmid|from_.*|share_source|share_medium|share_plat|share_session_id|share_tag|share_times|share_from|unique_k|bbid|buvid|buvid3|seid|msource|csource|launch_id|timestamp|ts|t|utm_.*|pvid|broadcast_type|is_avoided_params)$/i;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApp(deps = {}) {
  const store = deps.store;
  if (!store) throw new TypeError("createApp requires deps.store");
  const labeler = deps.labeler ?? nullLabeler();
  const analyze = typeof deps.analyze === "function" ? deps.analyze : null;
  const clock = deps.clock ?? { now: () => Date.now() };
  const parseGoal = typeof deps.parseGoal === "function" ? deps.parseGoal : null;
  const port = deps.port ?? CONTRACT_VALUES.PORT;
  const version = deps.version ?? CONTRACT_VALUES.SCHEMA_VERSION;
  const profileId = deps.profileId ?? CONTRACT_VALUES.PROFILE_ID;
  const windowDays = deps.windowDays ?? CONTRACT_VALUES.WINDOW_DAYS;

  // visit 计数器只用于区分"同一页面会话内重复上报"和"重新加载/换页"：
  // 同一 session+page_context+url 视为同一次访问，曝光 id 因此稳定 → 重复上报自动去重。
  const visits = new Map();
  const state = { paused: readPaused(store) };

  function visitSeqFor(sessionId, pageContext, rawUrl, explicit) {
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const key = sessionId + "|" + pageContext;
    const canonical = canonicalizeUrl(rawUrl);
    const entry = visits.get(key);
    if (!entry) {
      visits.set(key, { seq: 1, url: canonical });
      evictVisits();
      return 1;
    }
    if (canonical && entry.url && canonical !== entry.url) {
      entry.seq += 1;
      entry.url = canonical;
    } else if (canonical && !entry.url) {
      entry.url = canonical;
    }
    return entry.seq;
  }

  function evictVisits() {
    while (visits.size > 2000) {
      const oldest = visits.keys().next().value;
      visits.delete(oldest);
    }
  }

  async function handleStatus(req, res) {
    const summary = safeStats(store);
    const ai = safeLabelerStatus(labeler);
    const now = clock.now();
    sendJSON(res, 200, {
      ok: true,
      version,
      port,
      data_mode: summary.data_mode ?? "empty",
      window: { days: windowDays, start: now - windowDays * 86400000, end: now },
      counts: {
        items: summary.counts?.items ?? 0,
        exposures: summary.counts?.exposures ?? 0,
        actions: summary.counts?.actions ?? 0,
      },
      ai: {
        mode: ai.mode ?? "off",
        cached: ai.cached ?? 0,
        cache_hits: ai.cache_hits ?? ai.cached ?? 0,
        requests: ai.requests ?? 0,
        // pending = 排队 + 在飞（既有字段名保留，语义修正为"还没标完的条数"）
        pending: ai.pending ?? 0,
        queued: ai.queued ?? 0,
        inflight: ai.inflight ?? 0,
        labeled: ai.labeled ?? 0,
        unlabeled: ai.unlabeled ?? 0,
        narrative_cached: Boolean(ai.narrative_cached),
        model: ai.model ?? null,
      },
      paused: state.paused,
    });
  }

  async function handleIngest(req, res) {
    const body = await readJSON(req);
    const sessionId = requireString(body.session_id, "session_id");
    const pageContext = String(body.page_context ?? "");
    if (!PAGE_CONTEXTS.has(pageContext)) throw new HttpError(400, "BAD_REQUEST", "page_context 必须是 home|search|video_related");
    const observedAt = Number.isFinite(body.observed_at) ? body.observed_at : clock.now();
    const origin = asOrigin(body.origin);
    const visitSeq = visitSeqFor(sessionId, pageContext, body.url, body.visit_seq);

    const accepted = { exposures: 0, actions: 0 };
    const deduped = { exposures: 0, actions: 0 };
    const fresh = [];
    let newItemCount = 0;

    const cards = Array.isArray(body.cards) ? body.cards : [];
    cards.forEach((card, index) => {
      const observation = observationFor(card, { origin, at: observedAt });
      if (!observation) return;
      const { content_id, created } = store.ensureItemForObservation(observation);
      if (created) {
        newItemCount += 1;
        fresh.push(observation);
      }
      const exposure = {
        exposure_id: exposureIdFor(sessionId, content_id, pageContext, visitSeq),
        profile_id: profileId,
        session_id: sessionId,
        content_id,
        exposed_at: observedAt,
        page_context: pageContext,
        observable_rank: Number.isFinite(card?.rank) ? card.rank : index + 1,
        origin,
      };
      if (store.addExposure(exposure)) accepted.exposures += 1;
      else deduped.exposures += 1;
    });

    // page 只是内容元信息补全（简介/热评用于打标），不计曝光：曝光口径是"推荐输出里被刷到"。
    if (body.page && typeof body.page === "object") {
      const observation = observationFor(body.page, { origin, at: observedAt });
      if (observation) {
        const { created } = store.ensureItemForObservation(observation);
        if (created) {
          newItemCount += 1;
          fresh.push(observation);
        }
      }
    }

    for (const rawAction of Array.isArray(body.actions) ? body.actions : []) {
      if (!rawAction || typeof rawAction !== "object") continue;
      const actionType = String(rawAction.action_type ?? "");
      if (!ACTION_TYPES.has(actionType)) continue;
      const at = Number.isFinite(rawAction.at) ? rawAction.at : observedAt;
      let contentId = null;
      let canonicalKey = null;
      if (typeof rawAction.url === "string" && rawAction.url.trim()) {
        canonicalKey = canonicalizeUrl(rawAction.url);
        const observation = observationFor({ title: rawAction.title, url: rawAction.url }, { origin, at });
        if (observation) {
          const { created } = store.ensureItemForObservation(observation);
          if (created) {
            newItemCount += 1;
            fresh.push(observation);
          }
          contentId = observation.content_id;
        }
      }
      const action = {
        action_id: sha1([sessionId, actionType, at, canonicalKey ?? rawAction.title ?? ""].join("|")),
        profile_id: profileId,
        session_id: sessionId,
        exposure_id: null,
        content_id: contentId,
        topic_id: null,
        action_type: actionType,
        occurred_at: at,
        watch_seconds: Number.isFinite(rawAction.watch_seconds) ? rawAction.watch_seconds : null,
        origin,
      };
      if (store.addAction(action)) accepted.actions += 1;
      else deduped.actions += 1;
    }

    let aiPending = safeLabelerStatus(labeler).pending ?? 0;
    if (!state.paused && fresh.length) {
      const result = labeler.enqueue(fresh);
      aiPending = typeof result === "number" ? result : safeLabelerStatus(labeler).pending ?? 0;
    }

    sendJSON(res, 200, {
      ok: true,
      accepted,
      deduped,
      new_items: newItemCount,
      ai_pending: aiPending,
    });
  }

  async function handleProfile(req, res, url) {
    const days = clampInt(url.searchParams.get("days"), 1, MAX_WINDOW_DAYS, windowDays);
    const now = clock.now();
    const items = store.getItems();
    const exposures = store.getExposures();
    const actions = store.getActions();
    const goal = store.getGoal();

    if (!analyze) return sendCoreUnavailable(res);

    let snapshot;
    try {
      snapshot = analyze({ items, exposures, actions, goal, now, windowDays: days });
    } catch (error) {
      return sendCoreUnavailable(res, error);
    }
    if (!snapshot || typeof snapshot !== "object") return sendCoreUnavailable(res, new Error("empty snapshot"));

    let ai = {
      narrative: "",
      suggestions: [],
      model: null,
      cached: false,
      degraded: true,
      narrative_cached: false,
      narrative_at: null,
    };
    try {
      const result = await labeler.narrative(snapshot, goal);
      if (result && typeof result === "object") {
        ai = {
          narrative: typeof result.narrative === "string" ? result.narrative : "",
          suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
          model: result.model ?? null,
          cached: Boolean(result.cached),
          degraded: Boolean(result.degraded),
          narrative_cached: Boolean(result.narrative_cached),
          narrative_at: result.narrative_at ?? null,
        };
      }
    } catch {
      // 叙述失败不影响统计主体：保持降级 ai 字段照常返回
    }
    // 标注进度必须随画像一起返回，界面才能区分"AI 正在标注"和"AI 标不出来"
    const progress = safeLabelerStatus(labeler);
    sendJSON(res, 200, {
      ...snapshot,
      ai: {
        ...ai,
        queued: progress.queued ?? 0,
        inflight: progress.inflight ?? 0,
        pending: progress.pending ?? 0,
        labeled: progress.labeled ?? 0,
        unlabeled: progress.unlabeled ?? 0,
      },
    });
  }

  async function handleGoal(req, res) {
    const body = await readJSON(req);
    const goalText = requireString(body.goal_text, "goal_text");
    const intentMode = INTENT_MODES.has(body.intent_mode) ? body.intent_mode : "relax";
    const previous = store.getGoal();
    let goalTopics = normaliseTopics(body.goal_topics, { maxWeight: Infinity }) ?? [];
    if (parseGoal) {
      try {
        const parsed = parseGoal(goalText, intentMode);
        const fromParser = normaliseTopics(parsed?.goal_topics, { maxWeight: Infinity });
        if (fromParser && fromParser.length) goalTopics = fromParser;
      } catch {
        // 关键词兜底失败就保留空主题表：宁可"未知"，也不编造目标主题
      }
    }
    const goal = {
      profile_id: profileId,
      goal_text: goalText,
      intent_mode: intentMode,
      goal_topics: goalTopics,
      exclusions: (Array.isArray(body.exclusions) ? body.exclusions : [])
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
        .slice(0, MAX_EXCLUSIONS),
      exploration_level: clampUnit(body.exploration_level, 0.5),
      updated_at: clock.now(),
      version: (previous?.version ?? 0) + 1,
      source: "user",
    };
    store.setGoal(goal);
    sendJSON(res, 200, goal);
  }

  async function handleFeedback(req, res) {
    const body = await readJSON(req);
    const contentId = requireString(body.content_id, "content_id");
    const correction = String(body.correction ?? "");
    if (correction !== "topic" && correction !== "unknown") {
      throw new HttpError(400, "BAD_REQUEST", "correction 必须是 topic 或 unknown");
    }
    const item = store.getItem(contentId);
    if (!item) throw new HttpError(404, "NOT_FOUND", "content_id 不存在");
    const topics = correction === "unknown" ? [] : normaliseTopics(body.topics, { maxWeight: Infinity }) ?? [];
    if (correction === "topic" && topics.length === 0) {
      throw new HttpError(400, "BAD_REQUEST", "correction=topic 需要非空且合法的 topics");
    }
    store.patchItem(contentId, {
      topics,
      annotation: { status: "manual", model: null, at: clock.now() },
    });
    sendJSON(res, 200, { ok: true });
  }

  async function handlePause(req, res) {
    const body = await readJSON(req);
    if (typeof body.paused !== "boolean") throw new HttpError(400, "BAD_REQUEST", "paused 必须是布尔值");
    state.paused = body.paused;
    persistPaused(store, state.paused);
    sendJSON(res, 200, { ok: true, paused: state.paused });
  }

  async function handleExport(req, res) {
    const text = store.exportJSONL?.() ?? "";
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(text);
  }

  async function handleReset(req, res) {
    const body = await readJSON(req);
    if (body.confirm !== true) throw new HttpError(400, "CONFIRM_REQUIRED", "需要 {confirm:true} 才清空数据");
    const cleared = store.reset();
    state.paused = false;
    visits.clear();
    sendJSON(res, 200, { ok: true, cleared });
  }

  const routes = new Map();
  const add = (method, path, handler) => {
    if (!routes.has(path)) routes.set(path, new Map());
    routes.get(path).set(method, handler);
  };
  add("GET", "/api/status", handleStatus);
  add("POST", "/api/ingest", handleIngest);
  add("GET", "/api/profile", handleProfile);
  add("POST", "/api/goal", handleGoal);
  add("POST", "/api/feedback", handleFeedback);
  add("POST", "/api/pause", handlePause);
  add("GET", "/api/export", handleExport);
  add("POST", "/api/reset", handleReset);

  async function dispatch(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    const method = String(req.method ?? "GET").toUpperCase();
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ai-watcher local service\n");
      return;
    }
    const byMethod = routes.get(path);
    if (!byMethod) throw new HttpError(404, "NOT_FOUND", "未知路径 " + path);
    const handler = byMethod.get(method);
    if (!handler) throw new HttpError(405, "METHOD_NOT_ALLOWED", "不支持的方法 " + method);
    await handler(req, res, url);
  }

  return function handler(req, res) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-max-age", "600");
    dispatch(req, res).catch((error) => fail(res, error));
  };
}

export function canonicalizeUrl(rawUrl) {
  if (typeof rawUrl !== "string") return "";
  const text = rawUrl.trim();
  if (!text) return "";
  let url;
  try {
    url = new URL(text, "https://bilibili.com");
  } catch {
    return text.toLowerCase();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return text.toLowerCase();
  const host = normalizeHost(url.hostname);
  const videoId = bilibiliVideoId(url, host);
  if (videoId) return host + "/video/" + videoId;
  const path = normalizePath(url.pathname);
  const query = filteredQuery(url.searchParams);
  return query ? host + path + "?" + query : host + path;
}

export function contentIdFor(platform, canonicalKey) {
  return sha1(String(platform) + String(canonicalKey));
}

export function exposureIdFor(sessionId, contentId, pageContext, visitSeq) {
  return sha1([sessionId, contentId, pageContext, visitSeq].join("|"));
}

export function observationFor(raw, meta) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const canonicalKey = canonicalizeUrl(url);
  if (!canonicalKey) return null;
  const author = clip(raw.author, 80);
  const authorId = raw.author_id == null ? null : String(raw.author_id);
  return {
    content_id: contentIdFor(PLATFORM, canonicalKey),
    platform: PLATFORM,
    canonical_key: canonicalKey,
    title: clip(raw.title, 200) ?? "",
    url,
    source_id: authorId ?? (author ? sha1("up|" + author) : null),
    source_name: author,
    duration_s: finiteOrNull(raw.duration_s),
    view_count: finiteOrNull(raw.view_count),
    danmaku_count: finiteOrNull(raw.danmaku_count),
    published_at: finiteOrNull(raw.published_at),
    fetched_at: meta.at,
    desc: clip(raw.desc, MAX_DESC_CHARS) ?? "",
    comments: (Array.isArray(raw.comments) ? raw.comments : [])
      .map((comment) => clip(comment, 200))
      .filter(Boolean)
      .slice(0, MAX_COMMENTS),
    topics: [],
    facets: [],
    value_notes: null,
    origin: meta.origin,
    annotation: { status: "pending", model: null, at: null },
  };
}

function normalizeHost(hostname) {
  const host = String(hostname ?? "").toLowerCase();
  return host.replace(/^(www|m|mobile|mbd)\./, "");
}

function normalizePath(pathname) {
  let path = String(pathname ?? "/");
  try {
    path = decodeURI(path);
  } catch {
    // 非法百分号编码保留原样
  }
  path = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return path === "" ? "" : path;
}

function bilibiliVideoId(url, host) {
  if (!host.endsWith("bilibili.com")) return null;
  const fromPath = String(url.pathname ?? "").match(/\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i);
  if (fromPath) return normalizeVideoId(fromPath[1]);
  const fromQuery = url.searchParams.get("bvid") ?? url.searchParams.get("bvid_") ?? url.searchParams.get("aid");
  if (fromQuery && /^(BV[0-9A-Za-z]{10}|av\d+|\d+)$/i.test(fromQuery.trim())) {
    return normalizeVideoId(fromQuery.trim());
  }
  return null;
}

function normalizeVideoId(value) {
  if (/^av\d+$/i.test(value)) return "av" + value.slice(2);
  if (/^\d+$/.test(value)) return "av" + value;
  return "BV" + value.slice(2);
}

function filteredQuery(params) {
  const pairs = [];
  for (const [key, value] of params) {
    if (!value) continue;
    if (TRACKING_PARAM.test(key)) continue;
    pairs.push([key, value]);
  }
  // 排序让同一内容的不同参数顺序归并到同一 canonical_key
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([key, value]) => key + "=" + value).join("&");
}

function safeStats(store) {
  try {
    const stats = store.stats();
    return {
      counts: { items: 0, exposures: 0, actions: 0, ...(stats?.counts ?? {}) },
      data_mode: stats?.data_mode ?? "empty",
    };
  } catch {
    // 统计失败不该让 /api/status 挂掉
    return { counts: { items: 0, exposures: 0, actions: 0 }, data_mode: "empty" };
  }
}

function safeLabelerStatus(labeler) {
  try {
    const status = typeof labeler.status === "function" ? labeler.status() : null;
    return status && typeof status === "object" ? status : {};
  } catch {
    return {};
  }
}

function readPaused(store) {
  try {
    return typeof store.getConfig === "function" ? store.getConfig("paused") === "true" : false;
  } catch {
    return false;
  }
}

function persistPaused(store, paused) {
  try {
    if (typeof store.setConfig === "function") store.setConfig("paused", paused ? "true" : "false");
  } catch {
    // 暂停状态落盘失败不影响本次会话
  }
}

function nullLabeler() {
  return {
    enqueue: () => 0,
    status: () => ({ mode: "off", cached: 0, pending: 0, queued: 0, inflight: 0, labeled: 0, unlabeled: 0, narrative_cached: false, model: null }),
    labelNow: async () => [],
    narrative: async () => ({ narrative: "", suggestions: [], model: null, cached: false, degraded: true }),
  };
}

function sendCoreUnavailable(res, error) {
  const detail = error?.message ? "：" + String(error.message).slice(0, 200) : "";
  sendJSON(res, 503, {
    ok: false,
    error: { code: "CORE_UNAVAILABLE", message: "分析核心不可用" + detail },
  });
}

function sendJSON(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

function fail(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof HttpError) {
    sendJSON(res, error.status, { ok: false, error: { code: error.code, message: error.message } });
    return;
  }
  sendJSON(res, 500, { ok: false, error: { code: "INTERNAL", message: "服务内部错误" } });
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "请求体超过 " + limit + " 字节"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (error) => reject(error));
  });
}

async function readJSON(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "BAD_REQUEST", "请求体必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_JSON", "请求体不是合法 JSON");
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "BAD_REQUEST", field + " 必须是非空字符串");
  }
  return value.trim();
}

function asOrigin(value) {
  return value === "synthetic" || value === "reference" ? value : "real";
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(num)));
}

function clampUnit(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function finiteOrNull(value) {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : null;
}

function clip(value, max) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const chars = [...trimmed];
  return chars.length > max ? chars.slice(0, max).join("") : trimmed;
}

function sha1(text) {
  return createHash("sha1").update(String(text)).digest("hex");
}

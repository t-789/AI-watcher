import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PROFILE_ID = "local-default";
const JSON_FIELDS = ["comments", "topics", "facets", "value_notes", "annotation"];

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS items (",
  "  content_id TEXT PRIMARY KEY, platform TEXT NOT NULL, canonical_key TEXT NOT NULL,",
  "  title TEXT, url TEXT, source_id TEXT, source_name TEXT,",
  "  duration_s REAL, view_count INTEGER, danmaku_count INTEGER,",
  "  published_at INTEGER, fetched_at INTEGER,",
  "  desc_text TEXT, comments TEXT, topics TEXT, facets TEXT,",
  "  value_notes TEXT, origin TEXT, annotation TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_items_canonical ON items (platform, canonical_key);",
  "CREATE TABLE IF NOT EXISTS exposures (",
  "  exposure_id TEXT PRIMARY KEY, profile_id TEXT, session_id TEXT, content_id TEXT,",
  "  exposed_at INTEGER, page_context TEXT, observable_rank INTEGER, origin TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_exposures_at ON exposures (exposed_at);",
  "CREATE TABLE IF NOT EXISTS actions (",
  "  action_id TEXT PRIMARY KEY, profile_id TEXT, session_id TEXT, exposure_id TEXT,",
  "  content_id TEXT, topic_id TEXT, action_type TEXT, occurred_at INTEGER,",
  "  watch_seconds REAL, origin TEXT",
  ");",
  "CREATE INDEX IF NOT EXISTS idx_actions_at ON actions (occurred_at);",
  "CREATE TABLE IF NOT EXISTS goal (",
  "  profile_id TEXT PRIMARY KEY, goal_text TEXT, intent_mode TEXT, goal_topics TEXT,",
  "  exclusions TEXT, exploration_level REAL, updated_at INTEGER, version INTEGER, source TEXT",
  ");",
  "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);",
].join("\n");

const ITEM_COLUMNS = [
  "content_id", "platform", "canonical_key", "title", "url", "source_id", "source_name",
  "duration_s", "view_count", "danmaku_count", "published_at", "fetched_at",
  "desc_text", "comments", "topics", "facets", "value_notes", "origin", "annotation",
];

export function createStore(options = {}) {
  const file = options.file ?? ":memory:";
  const profileId = options.profileId ?? DEFAULT_PROFILE_ID;
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 2000");
  db.exec(SCHEMA);

  const stmts = {
    insertItem: db.prepare(
      "INSERT INTO items (" + ITEM_COLUMNS.join(",") + ") VALUES (" + ITEM_COLUMNS.map(() => "?").join(",") + ")" +
      " ON CONFLICT(content_id) DO UPDATE SET " +
      ITEM_COLUMNS.filter((column) => column !== "content_id").map((column) => column + "=excluded." + column).join(", "),
    ),
    getItem: db.prepare("SELECT * FROM items WHERE content_id = ?"),
    allItems: db.prepare("SELECT * FROM items ORDER BY fetched_at ASC, content_id ASC"),
    insertExposure: db.prepare(
      "INSERT OR IGNORE INTO exposures (exposure_id,profile_id,session_id,content_id,exposed_at,page_context,observable_rank,origin) VALUES (?,?,?,?,?,?,?,?)",
    ),
    allExposures: db.prepare("SELECT * FROM exposures ORDER BY exposed_at ASC, exposure_id ASC"),
    insertAction: db.prepare(
      "INSERT OR IGNORE INTO actions (action_id,profile_id,session_id,exposure_id,content_id,topic_id,action_type,occurred_at,watch_seconds,origin) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ),
    allActions: db.prepare("SELECT * FROM actions ORDER BY occurred_at ASC, action_id ASC"),
    getGoal: db.prepare("SELECT * FROM goal WHERE profile_id = ?"),
    setGoal: db.prepare(
      "INSERT INTO goal (profile_id,goal_text,intent_mode,goal_topics,exclusions,exploration_level,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?)" +
      " ON CONFLICT(profile_id) DO UPDATE SET goal_text=excluded.goal_text, intent_mode=excluded.intent_mode," +
      " goal_topics=excluded.goal_topics, exclusions=excluded.exclusions, exploration_level=excluded.exploration_level," +
      " updated_at=excluded.updated_at, version=excluded.version, source=excluded.source",
    ),
    countItems: db.prepare("SELECT COUNT(*) AS n FROM items"),
    countExposures: db.prepare("SELECT COUNT(*) AS n FROM exposures"),
    countActions: db.prepare("SELECT COUNT(*) AS n FROM actions"),
    origins: db.prepare("SELECT DISTINCT origin FROM items UNION SELECT DISTINCT origin FROM exposures"),
    allAnnotations: db.prepare("SELECT annotation FROM items"),
    clearItems: db.prepare("DELETE FROM items"),
    clearExposures: db.prepare("DELETE FROM exposures"),
    clearActions: db.prepare("DELETE FROM actions"),
    clearGoal: db.prepare("DELETE FROM goal"),
    clearConfig: db.prepare("DELETE FROM config"),
    getConfig: db.prepare("SELECT value FROM config WHERE key = ?"),
    setConfig: db.prepare("INSERT INTO config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"),
  };

  function upsertItem(item) {
    if (!item || !item.content_id) throw new TypeError("item.content_id is required");
    const existing = getItem(item.content_id);
    const merged = existing ? mergeItem(existing, item) : withDefaults(item);
    stmts.insertItem.run(...ITEM_COLUMNS.map((column) => columnValue(merged, column)));
    return getItem(item.content_id);
  }

  function getItem(contentId) {
    const row = stmts.getItem.get(contentId);
    return row ? rowToItem(row) : null;
  }

  function ensureItemForObservation(observation) {
    if (!observation || !observation.content_id) throw new TypeError("observation.content_id is required");
    const existing = getItem(observation.content_id);
    upsertItem({ ...observation, annotation: { status: "pending", model: null, at: null } });
    return { content_id: observation.content_id, created: !existing };
  }

  function addExposure(exposure) {
    if (!exposure || !exposure.exposure_id) throw new TypeError("exposure.exposure_id is required");
    const result = stmts.insertExposure.run(
      exposure.exposure_id,
      exposure.profile_id ?? profileId,
      textOrNull(exposure.session_id),
      textOrNull(exposure.content_id),
      numOrNull(exposure.exposed_at),
      textOrNull(exposure.page_context),
      numOrNull(exposure.observable_rank),
      textOrNull(exposure.origin),
    );
    return result.changes > 0;
  }

  function addAction(action) {
    if (!action || !action.action_id) throw new TypeError("action.action_id is required");
    const result = stmts.insertAction.run(
      action.action_id,
      action.profile_id ?? profileId,
      textOrNull(action.session_id),
      textOrNull(action.exposure_id),
      textOrNull(action.content_id),
      textOrNull(action.topic_id),
      textOrNull(action.action_type),
      numOrNull(action.occurred_at),
      numOrNull(action.watch_seconds),
      textOrNull(action.origin),
    );
    return result.changes > 0;
  }

  function setGoal(goal) {
    if (!goal || !goal.profile_id) throw new TypeError("goal.profile_id is required");
    stmts.setGoal.run(
      goal.profile_id,
      textOrNull(goal.goal_text),
      textOrNull(goal.intent_mode),
      JSON.stringify(Array.isArray(goal.goal_topics) ? goal.goal_topics : []),
      JSON.stringify(Array.isArray(goal.exclusions) ? goal.exclusions : []),
      numOrNull(goal.exploration_level),
      numOrNull(goal.updated_at),
      numOrNull(goal.version),
      textOrNull(goal.source),
    );
    return getGoal(goal.profile_id);
  }

  function getGoal(id = profileId) {
    const row = stmts.getGoal.get(id);
    if (!row) return null;
    return {
      profile_id: row.profile_id,
      goal_text: row.goal_text ?? "",
      intent_mode: row.intent_mode ?? "relax",
      goal_topics: parseJson(row.goal_topics, []),
      exclusions: parseJson(row.exclusions, []),
      exploration_level: row.exploration_level ?? 0.5,
      updated_at: row.updated_at ?? 0,
      version: row.version ?? 0,
      source: row.source ?? "user",
    };
  }

  function patchItem(contentId, patch) {
    const existing = getItem(contentId);
    if (!existing) return null;
    return upsertItem({ ...existing, ...patch });
  }

  function reset() {
    const cleared = counts();
    db.exec("BEGIN");
    try {
      stmts.clearItems.run();
      stmts.clearExposures.run();
      stmts.clearActions.run();
      stmts.clearGoal.run();
      stmts.clearConfig.run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return cleared;
  }

  function counts() {
    return {
      items: stmts.countItems.get().n,
      exposures: stmts.countExposures.get().n,
      actions: stmts.countActions.get().n,
    };
  }

  function dataMode() {
    const origins = new Set(stmts.origins.all().map((row) => row.origin).filter(Boolean));
    if (!origins.size) return "empty";
    const hasReal = origins.has("real");
    // reference（人工参考资料）不是观察得到的真实曝光，与 synthetic 同属非实时数据
    const hasNonReal = [...origins].some((origin) => origin !== "real");
    if (hasReal && hasNonReal) return "mixed";
    return hasReal ? "real" : "synthetic";
  }

  // 标注进度：unknown（关键词兜底/未标）与 pending（还没跑）都算未标，界面据此说"AI 标注中"。
  function labelCounts() {
    const tally = { labeled: 0, pending: 0, unknown: 0, manual: 0, unlabeled: 0 };
    for (const row of stmts.allAnnotations.all()) {
      const status = parseJson(row.annotation, {})?.status ?? "pending";
      if (status === "ai") tally.labeled += 1;
      else if (status === "manual") tally.manual += 1;
      else if (status === "unknown") tally.unknown += 1;
      else tally.pending += 1;
    }
    tally.unlabeled = tally.pending + tally.unknown;
    return tally;
  }

  function stats() {
    const base = counts();
    const goal = getGoal();
    return { counts: base, data_mode: dataMode(), goal_present: Boolean(goal) };
  }

  function exportJSONL() {
    const lines = [];
    for (const item of getItems()) lines.push(JSON.stringify({ type: "item", ...item }));
    for (const exposure of getExposures()) lines.push(JSON.stringify({ type: "exposure", ...exposure }));
    for (const action of getActions()) lines.push(JSON.stringify({ type: "action", ...action }));
    const goal = getGoal();
    if (goal) lines.push(JSON.stringify({ type: "goal", ...goal }));
    return lines.length ? lines.join("\n") + "\n" : "";
  }

  function getItems() {
    return stmts.allItems.all().map(rowToItem);
  }

  function getExposures() {
    return stmts.allExposures.all().map((row) => ({
      exposure_id: row.exposure_id,
      profile_id: row.profile_id,
      session_id: row.session_id,
      content_id: row.content_id,
      exposed_at: row.exposed_at,
      page_context: row.page_context,
      observable_rank: row.observable_rank,
      origin: row.origin,
    }));
  }

  function getActions() {
    return stmts.allActions.all().map((row) => ({
      action_id: row.action_id,
      profile_id: row.profile_id,
      session_id: row.session_id,
      exposure_id: row.exposure_id,
      content_id: row.content_id,
      topic_id: row.topic_id,
      action_type: row.action_type,
      occurred_at: row.occurred_at,
      watch_seconds: row.watch_seconds,
      origin: row.origin,
    }));
  }

  return {
    file,
    getItems,
    getItem,
    getExposures,
    getActions,
    getGoal,
    upsertItem,
    patchItem,
    addExposure,
    addAction,
    setGoal,
    ensureItemForObservation,
    stats,
    counts,
    labelCounts,
    dataMode,
    exportJSONL,
    reset,
    getConfig: (key) => stmts.getConfig.get(key)?.value ?? null,
    setConfig: (key, value) => stmts.setConfig.run(key, String(value)),
    close: () => db.close(),
  };
}

function rowToItem(row) {
  return {
    content_id: row.content_id,
    platform: row.platform,
    canonical_key: row.canonical_key,
    title: row.title ?? "",
    url: row.url ?? "",
    source_id: row.source_id,
    source_name: row.source_name,
    duration_s: row.duration_s,
    view_count: row.view_count,
    danmaku_count: row.danmaku_count,
    published_at: row.published_at,
    fetched_at: row.fetched_at,
    desc: row.desc_text ?? "",
    comments: parseJson(row.comments, []),
    topics: parseJson(row.topics, []),
    facets: parseJson(row.facets, []),
    value_notes: parseJson(row.value_notes, null),
    origin: row.origin ?? "real",
    annotation: parseJson(row.annotation, { status: "pending", model: null, at: null }),
  };
}

function withDefaults(item) {
  return {
    content_id: item.content_id,
    platform: item.platform ?? "bilibili",
    canonical_key: item.canonical_key ?? item.content_id,
    title: item.title ?? "",
    url: item.url ?? "",
    source_id: item.source_id ?? null,
    source_name: item.source_name ?? null,
    duration_s: item.duration_s ?? null,
    view_count: item.view_count ?? null,
    danmaku_count: item.danmaku_count ?? null,
    published_at: item.published_at ?? null,
    fetched_at: item.fetched_at ?? null,
    desc: item.desc ?? "",
    comments: Array.isArray(item.comments) ? item.comments : [],
    topics: Array.isArray(item.topics) ? item.topics : [],
    facets: Array.isArray(item.facets) ? item.facets : [],
    value_notes: item.value_notes ?? null,
    origin: item.origin ?? "real",
    annotation: item.annotation ?? { status: "pending", model: null, at: null },
  };
}

// 观测会反复到达（滚动上报），只允许把"更全/更新的数据"补进来；
// 已有的人工更正（annotation=manual）和模型标注不被 pending 观测覆盖。
function mergeItem(existing, incoming) {
  const manual = existing.annotation?.status === "manual";
  const incomingAnnotation = incoming.annotation;
  const annotation = manual
    ? existing.annotation
    : incomingAnnotation && incomingAnnotation.status && incomingAnnotation.status !== "pending"
      ? incomingAnnotation
      : existing.annotation;
  return {
    content_id: existing.content_id,
    platform: exists(existing.platform) ?? "bilibili",
    canonical_key: exists(existing.canonical_key) ?? existing.content_id,
    title: nonEmpty(incoming.title) ?? existing.title,
    url: nonEmpty(incoming.url) ?? existing.url,
    source_id: incoming.source_id ?? existing.source_id,
    source_name: nonEmpty(incoming.source_name) ?? existing.source_name,
    duration_s: incoming.duration_s ?? existing.duration_s,
    view_count: incoming.view_count ?? existing.view_count,
    danmaku_count: incoming.danmaku_count ?? existing.danmaku_count,
    published_at: incoming.published_at ?? existing.published_at,
    fetched_at: incoming.fetched_at ?? existing.fetched_at,
    desc: nonEmpty(incoming.desc) ?? existing.desc,
    comments: Array.isArray(incoming.comments) && incoming.comments.length ? incoming.comments : existing.comments,
    topics: manual ? existing.topics : Array.isArray(incoming.topics) && incoming.topics.length ? incoming.topics : existing.topics,
    facets: Array.isArray(incoming.facets) && incoming.facets.length ? incoming.facets : existing.facets,
    value_notes: manual ? existing.value_notes : incoming.value_notes ?? existing.value_notes,
    origin: existing.origin ?? incoming.origin ?? "real",
    annotation,
  };
}

function columnValue(item, column) {
  switch (column) {
    case "desc_text":
      return textOrNull(item.desc);
    case "comments":
      return JSON.stringify(Array.isArray(item.comments) ? item.comments : []);
    case "topics":
      return JSON.stringify(Array.isArray(item.topics) ? item.topics : []);
    case "facets":
      return JSON.stringify(Array.isArray(item.facets) ? item.facets : []);
    case "value_notes":
      return item.value_notes == null ? null : JSON.stringify(item.value_notes);
    case "annotation":
      return JSON.stringify(item.annotation ?? { status: "pending", model: null, at: null });
    default:
      return item[column] ?? null;
  }
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function textOrNull(value) {
  return typeof value === "string" && value ? value : value == null ? null : String(value);
}

function numOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function exists(value) {
  return value == null ? null : value;
}

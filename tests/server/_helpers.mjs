import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMP_ROOT = join(HERE, "..", "..", "ignore", "temp", "server-tests");

export function tempDir(tag) {
  const dir = join(TEMP_ROOT, tag + "-" + Math.random().toString(36).slice(2, 8));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言
  }
}

export async function startServer(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: "http://127.0.0.1:" + port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function callHttp(base, method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(base + path, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

// 内存版 store：形状对齐契约 §4，绝不 import 真 store。
export function createFakeStore() {
  const items = new Map();
  const exposures = new Map();
  const actions = new Map();
  const goals = new Map();
  const configs = new Map();

  const api = {
    getItems: () => [...items.values()].map((item) => ({ ...item })),
    getItem: (id) => (items.has(id) ? { ...items.get(id) } : null),
    getExposures: () => [...exposures.values()].map((entry) => ({ ...entry })),
    getActions: () => [...actions.values()].map((entry) => ({ ...entry })),
    getGoal: (id = "local-default") => (goals.has(id) ? { ...goals.get(id) } : null),
    upsertItem(item) {
      const existing = items.get(item.content_id);
      items.set(item.content_id, normalizeItem(existing ? { ...existing, ...prune(item) } : item));
      return api.getItem(item.content_id);
    },
    patchItem(id, patch) {
      const existing = items.get(id);
      if (!existing) return null;
      items.set(id, { ...existing, ...patch });
      return api.getItem(id);
    },
    ensureItemForObservation(observation) {
      const existing = items.get(observation.content_id);
      if (!existing) {
        items.set(observation.content_id, normalizeItem(observation));
        return { content_id: observation.content_id, created: true };
      }
      // 与真 store 同口径：观测只允许补充更全的数据，空值不得把已有简介/热评抹掉
      const merged = { ...existing };
      for (const [key, value] of Object.entries(prune(observation))) {
        if (value === "" || value == null || (Array.isArray(value) && value.length === 0)) continue;
        merged[key] = value;
      }
      merged.annotation = existing.annotation?.status !== "pending" ? existing.annotation : observation.annotation ?? existing.annotation;
      items.set(observation.content_id, merged);
      return { content_id: observation.content_id, created: false };
    },
    addExposure(exposure) {
      if (exposures.has(exposure.exposure_id)) return false;
      exposures.set(exposure.exposure_id, { ...exposure });
      return true;
    },
    addAction(action) {
      if (actions.has(action.action_id)) return false;
      actions.set(action.action_id, { ...action });
      return true;
    },
    setGoal(goal) {
      goals.set(goal.profile_id, { ...goal });
      return api.getGoal(goal.profile_id);
    },
    labelCounts() {
      const tally = { labeled: 0, pending: 0, unknown: 0, manual: 0, unlabeled: 0 };
      for (const item of items.values()) {
        const status = item?.annotation?.status ?? "pending";
        if (status === "ai") tally.labeled += 1;
        else if (status === "manual") tally.manual += 1;
        else if (status === "unknown") tally.unknown += 1;
        else tally.pending += 1;
      }
      tally.unlabeled = tally.pending + tally.unknown;
      return tally;
    },
    stats() {
      const origins = new Set([...items.values(), ...exposures.values()].map((entry) => entry.origin).filter(Boolean));
      const dataMode = origins.size === 0 ? "empty" : origins.has("real") && origins.size > 1 ? "mixed" : origins.has("real") ? "real" : "synthetic";
      return { counts: { items: items.size, exposures: exposures.size, actions: actions.size }, data_mode: dataMode };
    },
    exportJSONL() {
      const lines = [
        ...[...items.values()].map((entry) => JSON.stringify({ type: "item", ...entry })),
        ...[...exposures.values()].map((entry) => JSON.stringify({ type: "exposure", ...entry })),
        ...[...actions.values()].map((entry) => JSON.stringify({ type: "action", ...entry })),
        ...[...goals.values()].map((entry) => JSON.stringify({ type: "goal", ...entry })),
      ];
      return lines.length ? lines.join("\n") + "\n" : "";
    },
    getConfig: (key) => (configs.has(key) ? configs.get(key) : null),
    setConfig: (key, value) => configs.set(key, String(value)),
    reset() {
      const cleared = { items: items.size, exposures: exposures.size, actions: actions.size };
      items.clear();
      exposures.clear();
      actions.clear();
      goals.clear();
      configs.clear();
      return cleared;
    },
  };
  return api;
}

export function createFakeLabeler(options = {}) {
  const state = { enqueued: [], pending: 0, mode: options.mode ?? "degraded", cached: 0, requests: 0, model: options.model ?? "fake-model" };
  return {
    state,
    enqueue(items) {
      for (const item of items) state.enqueued.push(item.content_id);
      state.pending = state.enqueued.length;
      return state.pending;
    },
    status: () => ({ mode: state.mode, cached: state.cached, pending: state.pending, model: state.model, requests: state.requests, cache_hits: state.cached }),
    labelNow: async (items) => items,
    narrative: async () =>
      options.narrative ?? { narrative: "假叙述", suggestions: [{ title: "换来源看看", why: "测试", action: "search", evidence_ids: [] }], model: state.model, cached: false, degraded: false },
  };
}

export function fakeSnapshot(input) {
  return {
    schema_version: 1,
    data_mode: input.items.length ? "real" : "empty",
    generated_at: input.now,
    window: {
      start: input.now - input.windowDays * 86400000,
      end: input.now,
      days: input.windowDays,
      exposure_count: input.exposures.length,
      unique_items: new Set(input.exposures.map((entry) => entry.content_id)).size,
      action_count: input.actions.length,
      unknown_topic_ratio: 0,
      known_topic_ratio: 1,
      page_contexts: { home: input.exposures.length, search: 0, video_related: 0 },
    },
    goal: { present: Boolean(input.goal), text: input.goal?.goal_text ?? "", intent_mode: input.goal?.intent_mode ?? null, topics: input.goal?.goal_topics ?? [], source: input.goal?.source ?? null },
    exposure: { available: true, topics: [], entropy: 0, repeat_rate: 0, unique_items: 0, top_source: null, source_count: 0 },
    behavior: { available: false, topics: [], sample_n: 0, reason: "测试" },
    behavior_cmp: null,
    goal_cmp: null,
    trend: null,
    alerts: [],
    notes: [],
  };
}

export function biliCard(index) {
  return {
    title: "AI 显卡评测 " + index,
    url: "https://www.bilibili.com/video/BV1GJ411x7h" + index + "/?spm_id_from=333.337",
    author: "数码UP" + index,
    author_id: String(1000 + index),
    duration_s: 600 + index,
    view_count: 100000 + index,
    danmaku_count: 200 + index,
  };
}

function prune(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeItem(item) {
  return {
    platform: "bilibili",
    title: "",
    url: "",
    source_id: null,
    source_name: null,
    duration_s: null,
    view_count: null,
    danmaku_count: null,
    published_at: null,
    fetched_at: null,
    desc: "",
    comments: [],
    topics: [],
    facets: [],
    value_notes: null,
    origin: "real",
    annotation: { status: "pending", model: null, at: null },
    ...prune(item),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server/app.js";
import { createLabeler } from "../../src/server/labeler.js";
import { createFakeLabeler, createFakeStore, fakeSnapshot, biliCard, startServer, callHttp } from "./_helpers.mjs";

const NOW = 1700000000000;

function fakeAI(options = {}) {
  const state = { labelCalls: 0, narrativeCalls: 0, mode: options.mode ?? "live" };
  return {
    state,
    mode: state.mode,
    model: "fake-live-model",
    async label(items) {
      state.labelCalls += 1;
      return items.map((item) => ({ content_id: item.content_id, source: "ai", model: "fake-live-model", topics: [{ t: "tech", w: 1 }] }));
    },
    async narrative() {
      state.narrativeCalls += 1;
      return { narrative: "模型叙述 v" + state.narrativeCalls, suggestions: [], model: "fake-live-model", cached: false, degraded: false };
    },
    stats: () => ({ requests: state.narrativeCalls, cache_hits: 0, failures: 0 }),
  };
}

function snapshotWith(overrides = {}) {
  const input = { items: [biliCard(1)], exposures: [{ content_id: "a" }, { content_id: "b" }], actions: [], goal: null, now: NOW, windowDays: 7 };
  return { ...fakeSnapshot(input), ...overrides };
}

test("同一份数据第二次请求叙述直接命中缓存，不再调用模型", async () => {
  const ai = fakeAI();
  const labeler = createLabeler({ store: createFakeStore(), ai, clock: { now: () => NOW } });
  const snap = snapshotWith();

  const first = await labeler.narrative(snap, null);
  const second = await labeler.narrative(snap, null);

  assert.equal(ai.state.narrativeCalls, 1, "第二次不应产生请求");
  assert.equal(first.narrative_cached, false);
  assert.equal(second.narrative_cached, true);
  assert.equal(second.narrative, first.narrative);
  assert.equal(typeof second.narrative_at, "number");
});

test("数据指纹变化后重新生成叙述", async () => {
  const ai = fakeAI();
  const labeler = createLabeler({ store: createFakeStore(), ai, clock: { now: () => NOW } });
  await labeler.narrative(snapshotWith(), null);
  const changed = await labeler.narrative(snapshotWith({ window: { ...snapshotWith().window, exposure_count: 99 } }), null);
  assert.equal(ai.state.narrativeCalls, 2);
  assert.equal(changed.narrative_cached, false);
});

test("目标版本变化会让叙述失效（目标主题变了，结论也会变）", async () => {
  const ai = fakeAI();
  const labeler = createLabeler({ store: createFakeStore(), ai, clock: { now: () => NOW } });
  await labeler.narrative(snapshotWith(), { version: 1, goal_topics: [{ t: "study", w: 1 }] });
  const again = await labeler.narrative(snapshotWith(), { version: 2, goal_topics: [{ t: "study", w: 1 }] });
  assert.equal(ai.state.narrativeCalls, 2);
  assert.equal(again.narrative_cached, false);
});

test("窗口时间推进但数据未变，仍命中缓存（否则每次请求都会重新付钱）", async () => {
  const ai = fakeAI();
  const labeler = createLabeler({ store: createFakeStore(), ai, clock: { now: () => NOW } });
  const base = snapshotWith();
  await labeler.narrative(base, null);
  const later = await labeler.narrative(
    { ...base, window: { ...base.window, start: base.window.start + 3 * 3600 * 1000, end: base.window.end + 3 * 3600 * 1000 } },
    null,
  );
  assert.equal(ai.state.narrativeCalls, 1, "时钟推进不应造成请求");
  assert.equal(later.narrative_cached, true);
});

test("降级态（无 key）走模板句，且不写缓存", async () => {
  const ai = fakeAI({ mode: "degraded" });
  ai.narrative = async () => {
    ai.state.narrativeCalls += 1;
    return { narrative: "", suggestions: [], model: "fake-live-model", cached: false, degraded: true };
  };
  const labeler = createLabeler({ store: createFakeStore(), ai, clock: { now: () => NOW } });
  const first = await labeler.narrative(snapshotWith(), null);
  const second = await labeler.narrative(snapshotWith(), null);

  assert.equal(ai.state.narrativeCalls, 2, "降级叙述不得进缓存，否则 AI 恢复后仍是模板句");
  assert.equal(first.degraded, true);
  assert.ok(first.narrative.length > 0, "降级仍要给出模板句，不能空白");
  assert.equal(second.narrative_cached, false);
});

test("pending = queued + inflight：在飞请求期间不会显示为 0", async () => {
  const store = createFakeStore();
  const gates = [];
  const ai = {
    mode: "live",
    model: "fake",
    label: (items) => new Promise((resolve) => gates.push(() => resolve(items.map((item) => ({ content_id: item.content_id, source: "ai", topics: [{ t: "tech", w: 1 }] }))))),
    narrative: async () => ({ narrative: "x", suggestions: [], model: "fake", cached: false, degraded: false }),
    stats: () => ({ requests: 0, cache_hits: 0, failures: 0 }),
  };
  const labeler = createLabeler({ store, ai, batchSize: 8 });
  const items = [1, 2, 3].map((i) => ({ content_id: "c" + i, title: "t" + i, annotation: { status: "pending" } }));

  labeler.enqueue(items);
  await new Promise((resolve) => setImmediate(resolve));
  const status = labeler.status();
  assert.equal(status.inflight, 3, "在飞请求必须计入 inflight");
  assert.equal(status.queued, 0);
  assert.equal(status.pending, 3);
  assert.equal(status.pending, status.queued + status.inflight);

  for (const gate of gates) gate();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(labeler.status().pending, 0);
});

test("排队中与在飞的批次数分开统计", async () => {
  const store = createFakeStore();
  const gates = [];
  const ai = {
    mode: "live",
    model: "fake",
    label: (items) => new Promise((resolve) => gates.push(() => resolve(items.map((item) => ({ content_id: item.content_id, source: "ai", topics: [{ t: "tech", w: 1 }] }))))),
    narrative: async () => ({ narrative: "x", suggestions: [], model: "fake", cached: false, degraded: false }),
    stats: () => ({ requests: 0, cache_hits: 0, failures: 0 }),
  };
  const labeler = createLabeler({ store, ai, batchSize: 2 });
  labeler.enqueue([1, 2, 3, 4, 5].map((i) => ({ content_id: "q" + i, title: "t" + i, annotation: { status: "pending" } })));
  await new Promise((resolve) => setImmediate(resolve));
  const status = labeler.status();
  assert.equal(status.inflight, 2);
  assert.equal(status.queued, 3);
  assert.equal(status.pending, 5);
  for (const gate of gates) gate();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

async function httpHarness() {
  const store = createFakeStore();
  const ai = fakeAI();
  const labeler = createLabeler({ store, ai, clock: { now: () => NOW } });
  const analyze = (input) => fakeSnapshot(input);
  const app = createApp({ store, labeler, analyze, clock: { now: () => NOW }, port: 3789, version: 1 });
  const server = await startServer(app);
  return { ...server, store, labeler, ai, close: server.close };
}

async function seed(base) {
  await callHttp(base, "POST", "/api/ingest", {
    session_id: "s1",
    page_context: "home",
    url: "https://www.bilibili.com/",
    observed_at: NOW,
    cards: [biliCard(1), biliCard(2)],
    actions: [],
  });
}

test("HTTP：连续两次 GET /api/profile，第二次 narrative_cached=true 且 requests 不增", async (t) => {
  const app = await httpHarness();
  t.after(() => app.close());
  await seed(app.url);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const first = await callHttp(app.url, "GET", "/api/profile?days=7");
  const afterFirst = (await callHttp(app.url, "GET", "/api/status")).json.ai.requests;
  const second = await callHttp(app.url, "GET", "/api/profile?days=7");
  const afterSecond = (await callHttp(app.url, "GET", "/api/status")).json.ai.requests;

  assert.equal(first.json.ai.narrative_cached, false);
  assert.equal(second.json.ai.narrative_cached, true, "同一份数据第二次必须命中叙述缓存");
  assert.equal(afterSecond, afterFirst, "第二次不得增加模型请求数");
  assert.equal(second.json.ai.narrative, first.json.ai.narrative);
  assert.equal(typeof second.json.ai.narrative_at, "number");

  // 原有字段一个不少
  for (const key of ["narrative", "suggestions", "model", "cached", "degraded"]) {
    assert.ok(key in second.json.ai, "profile.ai 缺少原有字段 " + key);
  }
  for (const key of ["narrative", "suggestions", "model", "cached", "degraded", "queued", "inflight", "pending", "labeled", "unlabeled", "narrative_cached", "narrative_at"]) {
    assert.ok(key in second.json.ai, "profile.ai 缺少进度字段 " + key);
  }
});

test("HTTP：/api/status 的 labeled/unlabeled 反映真实标注结果", async (t) => {
  const app = await httpHarness();
  t.after(() => app.close());
  await seed(app.url);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const status = await callHttp(app.url, "GET", "/api/status");
  const ai = status.json.ai;
  assert.equal(ai.labeled, 2, "两条都被标成 ai");
  assert.equal(ai.unlabeled, 0);
  assert.equal(ai.pending, 0);
  assert.equal(ai.pending, ai.queued + ai.inflight);
  assert.equal(status.json.counts.items, 2);
});

test("HTTP：/api/status 在标注未完成时 pending>0（不再是恒为 0）", async (t) => {
  const store = createFakeStore();
  const gates = [];
  const ai = {
    mode: "live",
    model: "fake",
    label: (items) => new Promise((resolve) => gates.push(() => resolve(items.map((item) => ({ content_id: item.content_id, source: "ai", topics: [{ t: "tech", w: 1 }] }))))),
    narrative: async () => ({ narrative: "x", suggestions: [], model: "fake", cached: false, degraded: false }),
    stats: () => ({ requests: 0, cache_hits: 0, failures: 0 }),
  };
  const labeler = createLabeler({ store, ai, batchSize: 8 });
  const app = createApp({ store, labeler, analyze: (input) => fakeSnapshot(input), clock: { now: () => NOW }, port: 3789, version: 1 });
  const server = await startServer(app);
  t.after(() => server.close());

  await callHttp(server.url, "POST", "/api/ingest", {
    session_id: "s1",
    page_context: "home",
    url: "https://www.bilibili.com/",
    observed_at: NOW,
    cards: [biliCard(1), biliCard(2), biliCard(3)],
    actions: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  const status = await callHttp(server.url, "GET", "/api/status");
  assert.equal(status.json.ai.inflight, 3);
  assert.equal(status.json.ai.pending, 3);
  assert.equal(status.json.ai.unlabeled, 3, "未标条数应与在飞数量一致");
  for (const gate of gates) gate();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

import test from "node:test";
import assert from "node:assert/strict";
import { createApp, canonicalizeUrl, contentIdFor } from "../../src/server/app.js";
import { createFakeLabeler, createFakeStore, fakeSnapshot, biliCard, startServer, callHttp } from "./_helpers.mjs";

const NOW = 1700000000000;

async function harness(options = {}) {
  const store = createFakeStore();
  const app = createApp({
    store,
    labeler: options.labeler ?? createFakeLabeler(),
    analyze: (input) => fakeSnapshot(input),
    clock: { now: () => NOW },
  });
  const server = await startServer(app);
  return { ...server, store };
}

async function seed(url) {
  return callHttp(url, "POST", "/api/ingest", {
    session_id: "s1",
    page_context: "home",
    url: "https://www.bilibili.com/",
    observed_at: NOW,
    cards: [biliCard(1), biliCard(2)],
    actions: [{ action_type: "open", url: biliCard(1).url, at: NOW }],
  });
}

test("POST /api/pause 切换 paused，status 同步且 pause 期间不再入队打标", async (t) => {
  const labeler = createFakeLabeler();
  const app = await harness({ labeler });
  t.after(() => app.close());

  const paused = await callHttp(app.url, "POST", "/api/pause", { paused: true });
  assert.equal(paused.status, 200);
  assert.deepEqual(paused.json, { ok: true, paused: true });
  assert.equal((await callHttp(app.url, "GET", "/api/status")).json.paused, true);

  const ingest = await callHttp(app.url, "POST", "/api/ingest", {
    session_id: "s1",
    page_context: "home",
    url: "https://www.bilibili.com/",
    observed_at: NOW,
    cards: [biliCard(1)],
    actions: [],
  });
  assert.equal(ingest.json.ok, true, "暂停只停 AI，不丢观测数据");
  assert.equal(labeler.state.enqueued.length, 0);

  await callHttp(app.url, "POST", "/api/pause", { paused: false });
  assert.equal((await callHttp(app.url, "GET", "/api/status")).json.paused, false);

  const bad = await callHttp(app.url, "POST", "/api/pause", { paused: "yes" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "BAD_REQUEST");
});

test("paused 落在 config 表：换一个 app 实例（重启）仍然生效", async (t) => {
  const store = createFakeStore();
  const make = () =>
    startServer(
      createApp({ store, labeler: createFakeLabeler(), analyze: (input) => fakeSnapshot(input), clock: { now: () => NOW } }),
    );
  const first = await make();
  await callHttp(first.url, "POST", "/api/pause", { paused: true });
  await first.close();
  assert.equal(store.getConfig("paused"), "true");

  const second = await make();
  t.after(() => second.close());
  assert.equal((await callHttp(second.url, "GET", "/api/status")).json.paused, true);

  await callHttp(second.url, "POST", "/api/reset", { confirm: true });
  assert.equal(store.getConfig("paused"), null, "reset 一并清掉 config");
});

test("GET /api/export 输出 JSONL（items/exposures/actions/goal 各带 type）", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  await seed(app.url);
  await callHttp(app.url, "POST", "/api/goal", { goal_text: "学 AI", intent_mode: "skill" });

  const response = await callHttp(app.url, "GET", "/api/export");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/plain/);
  const lines = response.text.trim().split("\n").map((line) => JSON.parse(line));
  const types = lines.map((line) => line.type);
  assert.deepEqual(types.filter((type) => type === "item").length, 2);
  assert.deepEqual(types.filter((type) => type === "exposure").length, 2);
  assert.deepEqual(types.filter((type) => type === "action").length, 1);
  assert.deepEqual(types.filter((type) => type === "goal").length, 1);

  const item = lines.find((line) => line.type === "item");
  assert.equal(item.content_id, contentIdFor("bilibili", canonicalizeUrl(biliCard(1).url)));
  assert.ok(Array.isArray(item.comments));
  const goal = lines.find((line) => line.type === "goal");
  assert.equal(goal.goal_text, "学 AI");
});

test("POST /api/reset 需要 confirm:true，清空后计数归零", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  await seed(app.url);
  await callHttp(app.url, "POST", "/api/pause", { paused: true });

  const refused = await callHttp(app.url, "POST", "/api/reset", { confirm: false });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.error.code, "CONFIRM_REQUIRED");
  assert.equal(app.store.stats().counts.items, 2, "未确认时不清空");

  const cleared = await callHttp(app.url, "POST", "/api/reset", { confirm: true });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.json, { ok: true, cleared: { items: 2, exposures: 2, actions: 1 } });
  assert.deepEqual((await callHttp(app.url, "GET", "/api/status")).json.counts, { items: 0, exposures: 0, actions: 0 });
  assert.equal((await callHttp(app.url, "GET", "/api/export")).text, "");
  assert.equal((await callHttp(app.url, "GET", "/api/status")).json.paused, false, "reset 解除暂停");
});

test("POST /api/feedback 人工更正标记 annotation=manual", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await seed(app.url);
  const contentId = contentIdFor("bilibili", canonicalizeUrl(biliCard(1).url));

  const topic = await callHttp(app.url, "POST", "/api/feedback", { content_id: contentId, correction: "topic", topics: [{ t: "study", w: 3 }] });
  assert.deepEqual(topic.json, { ok: true });
  const item = app.store.getItem(contentId);
  assert.deepEqual(item.annotation, { status: "manual", model: null, at: NOW });
  assert.deepEqual(item.topics, [{ t: "study", w: 1 }], "权重归一化到 1");

  const unknown = await callHttp(app.url, "POST", "/api/feedback", { content_id: contentId, correction: "unknown" });
  assert.deepEqual(unknown.json, { ok: true });
  assert.deepEqual(app.store.getItem(contentId).topics, [], "更正为未知要清空主题");

  const missing = await callHttp(app.url, "POST", "/api/feedback", { content_id: "nope", correction: "unknown" });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, "NOT_FOUND");

  const badCorrection = await callHttp(app.url, "POST", "/api/feedback", { content_id: contentId, correction: "banana" });
  assert.equal(badCorrection.status, 400);

  const badTopic = await callHttp(app.url, "POST", "/api/feedback", { content_id: contentId, correction: "topic", topics: [{ t: "bogus", w: 1 }] });
  assert.equal(badTopic.status, 400, "非法主题不能写成人工标签");
});

test("匿名观测重新上报不会覆盖人工更正（annotation=manual 保持）", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await seed(app.url);
  const contentId = contentIdFor("bilibili", canonicalizeUrl(biliCard(1).url));
  await callHttp(app.url, "POST", "/api/feedback", { content_id: contentId, correction: "topic", topics: [{ t: "study", w: 1 }] });

  await callHttp(app.url, "POST", "/api/ingest", {
    session_id: "s2",
    page_context: "home",
    url: "https://www.bilibili.com/",
    observed_at: NOW + 1000,
    cards: [biliCard(1)],
    actions: [],
  });
  const item = app.store.getItem(contentId);
  assert.equal(item.annotation.status, "manual");
  assert.deepEqual(item.topics, [{ t: "study", w: 1 }]);
});

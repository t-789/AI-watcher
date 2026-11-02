import test from "node:test";
import assert from "node:assert/strict";
import { createApp, canonicalizeUrl, contentIdFor, exposureIdFor } from "../../src/server/app.js";
import { createFakeLabeler, createFakeStore, biliCard, startServer, callHttp } from "./_helpers.mjs";

const NOW = 1700000000000;

async function harness(options = {}) {
  const store = options.store ?? createFakeStore();
  const labeler = options.labeler ?? createFakeLabeler();
  const app = createApp({ store, labeler, analyze: options.analyze ?? null, clock: { now: () => NOW }, port: 3789, windowDays: 7 });
  const server = await startServer(app);
  return { ...server, store, labeler };
}

function ingestBody(overrides = {}) {
  return {
    session_id: "session-1",
    page_context: "home",
    url: "https://www.bilibili.com/?spm_id_from=333.1007",
    observed_at: NOW,
    cards: [biliCard(1), biliCard(2)],
    actions: [],
    page: null,
    ...overrides,
  };
}

test("POST /api/ingest 归一化并落库：content_id / exposure_id 照契约公式", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const response = await callHttp(app.url, "POST", "/api/ingest", ingestBody());
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.accepted, { exposures: 2, actions: 0 });
  assert.deepEqual(response.json.deduped, { exposures: 0, actions: 0 });
  assert.equal(response.json.new_items, 2);
  assert.equal(response.json.ok, true);

  const items = app.store.getItems();
  assert.equal(items.length, 2);
  const expectedKey = canonicalizeUrl(biliCard(1).url);
  const expectedId = contentIdFor("bilibili", expectedKey);
  const item = app.store.getItem(expectedId);
  assert.ok(item, "content_id 应为 sha1(bilibili+canonical_key)");
  assert.equal(item.canonical_key, expectedKey);
  assert.equal(app.store.getExposures()[0].exposure_id, exposureIdFor("session-1", expectedId, "home", 1));
  assert.equal(app.store.getExposures()[0].page_context, "home");
  assert.equal(app.store.getExposures()[0].origin, "real");
});

test("同一 session+page 内同一内容重复上报只计一次曝光，新的 url/会话再增加", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  await callHttp(app.url, "POST", "/api/ingest", ingestBody());
  const second = await callHttp(app.url, "POST", "/api/ingest", ingestBody({ observed_at: NOW + 5000 }));
  assert.deepEqual(second.json.accepted, { exposures: 0, actions: 0 });
  assert.deepEqual(second.json.deduped, { exposures: 2, actions: 0 }, "滚动重复上报必须去重");
  assert.equal(app.store.getExposures().length, 2);

  // 同一 session 换页（url 变化）→ 新一次访问 → 新曝光
  const third = await callHttp(app.url, "POST", "/api/ingest", ingestBody({ url: "https://www.bilibili.com/?spm_id_from=333.1007&page=2" }));
  assert.deepEqual(third.json.accepted, { exposures: 2, actions: 0 });
  assert.equal(app.store.getExposures().length, 4);

  // 新会话 → 必然是新的曝光
  const fourth = await callHttp(app.url, "POST", "/api/ingest", ingestBody({ session_id: "session-2" }));
  assert.deepEqual(fourth.json.accepted, { exposures: 2, actions: 0 });
  assert.equal(app.store.getExposures().length, 6);
});

test("同一视频不同入口（?spm_id_from / 移动端 / #reply）同一个 session 内只算一次曝光", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const card = { title: "同一个视频", url: "https://www.bilibili.com/video/BV1GJ411x7h7" };
  await callHttp(app.url, "POST", "/api/ingest", ingestBody({ cards: [card] }));
  const again = await callHttp(
    app.url,
    "POST",
    "/api/ingest",
    ingestBody({ cards: [{ title: "同一个视频", url: "https://m.bilibili.com/video/BV1GJ411x7h7/?vd_source=x#reply" }] }),
  );
  assert.deepEqual(again.json.deduped, { exposures: 1, actions: 0 });
  assert.equal(app.store.getExposures().length, 1);
  assert.equal(app.store.getItems().length, 1);
});

test("page 只补全内容元信息、不计曝光；actions 落库并去重", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const body = ingestBody({
    page_context: "video_related",
    cards: [],
    page: { title: "详情页视频", url: "https://www.bilibili.com/video/BV1GJ411x7h9", author: "UP", desc: "简介".repeat(500), comments: ["热评1", "热评2"] },
    actions: [
      { action_type: "open", url: "https://www.bilibili.com/video/BV1GJ411x7h9?spm_id_from=1", title: "详情页视频", at: NOW },
      { action_type: "like", url: "https://www.bilibili.com/video/BV1GJ411x7h9", at: NOW + 1 },
      { action_type: "不存在的动作", url: "https://www.bilibili.com/video/BV1GJ411x7h9", at: NOW + 2 },
    ],
  });
  const response = await callHttp(app.url, "POST", "/api/ingest", body);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.accepted.actions, 2, "非法 action_type 被丢弃");
  assert.equal(app.store.getExposures().length, 0, "page 不计曝光");

  const item = app.store.getItem(contentIdFor("bilibili", canonicalizeUrl("https://www.bilibili.com/video/BV1GJ411x7h9")));
  assert.equal([...item.desc].length, 800);
  assert.deepEqual(item.comments, ["热评1", "热评2"]);

  const repeat = await callHttp(app.url, "POST", "/api/ingest", { ...body, observed_at: NOW + 10 });
  assert.deepEqual(repeat.json.deduped.actions, 2, "相同 action 重复上报要去重");
  assert.equal(app.store.getActions().length, 2);
});

test("POST /api/ingest 参数非法返回 400 与统一错误形状", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const missingSession = await callHttp(app.url, "POST", "/api/ingest", { page_context: "home", cards: [] });
  assert.equal(missingSession.status, 400);
  assert.equal(missingSession.json.ok, false);
  assert.equal(missingSession.json.error.code, "BAD_REQUEST");

  const badContext = await callHttp(app.url, "POST", "/api/ingest", { session_id: "s", page_context: "watch_later", cards: [] });
  assert.equal(badContext.status, 400);

  const badJson = await fetch(app.url + "/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error.code, "INVALID_JSON");

  const unknown = await callHttp(app.url, "GET", "/api/nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, "NOT_FOUND");

  const wrongMethod = await callHttp(app.url, "GET", "/api/ingest");
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.json.error.code, "METHOD_NOT_ALLOWED");
});

test("ingest 之后 labeler 收到 pending 条目，/api/status 的 counts 与 ai.pending 同步", async (t) => {
  const labeler = createFakeLabeler();
  const app = await harness({ labeler });
  t.after(() => app.close());

  const response = await callHttp(app.url, "POST", "/api/ingest", ingestBody());
  assert.equal(response.json.ai_pending, 2);
  assert.deepEqual(labeler.state.enqueued, app.store.getItems().map((item) => item.content_id));

  const status = await callHttp(app.url, "GET", "/api/status");
  assert.equal(status.json.ok, true);
  assert.deepEqual(status.json.counts, { items: 2, exposures: 2, actions: 0 });
  assert.equal(status.json.ai.pending, 2);
  assert.equal(status.json.ai.mode, "degraded");
});

test("OPTIONS 预检回 204 + CORS *", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  const response = await fetch(app.url + "/api/ingest", { method: "OPTIONS" });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

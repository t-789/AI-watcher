import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server/app.js";
import { createFakeLabeler, createFakeStore, fakeSnapshot, biliCard, startServer, callHttp } from "./_helpers.mjs";

const NOW = 1700000000000;

async function harness(options = {}) {
  const store = options.store ?? createFakeStore();
  const labeler = options.labeler ?? createFakeLabeler();
  const seen = [];
  const analyze =
    options.analyze === undefined
      ? (input) => {
          seen.push(input);
          return fakeSnapshot(input);
        }
      : options.analyze;
  const app = createApp({ store, labeler, analyze, clock: { now: () => NOW }, port: 3789, version: 1 });
  const server = await startServer(app);
  return { ...server, store, labeler, seen };
}

async function seed(app) {
  await callHttp(app.url, "POST", "/api/ingest", {
    session_id: "s1",
    page_context: "home",
    url: "https://www.bilibili.com/",
    observed_at: NOW,
    cards: [biliCard(1), biliCard(2)],
    actions: [],
  });
}

test("GET /api/profile 正常返回 Snapshot + ai 字段", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await seed(app);

  const response = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, undefined, "body 就是 Snapshot 本体，不带 ok 包裹");
  assert.equal(response.json.schema_version, 1);
  assert.equal(response.json.window.exposure_count, 2);
  assert.equal(response.json.ai.narrative, "假叙述");
  assert.equal(response.json.ai.degraded, false);
  assert.equal(response.json.ai.model, "fake-model");
  assert.ok(Array.isArray(response.json.ai.suggestions));
  assert.deepEqual(app.seen.at(-1).items.length, 2);
  assert.equal(app.seen.at(-1).windowDays, 7);
  assert.ok(app.seen.at(-1).now === NOW);
});

test("days 参数被夹到 [1,30] 并传给 analyze", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  await callHttp(app.url, "GET", "/api/profile?days=999");
  assert.equal(app.seen.at(-1).windowDays, 30);
  await callHttp(app.url, "GET", "/api/profile?days=abc");
  assert.equal(app.seen.at(-1).windowDays, 7, "非法值回落到 WINDOW_DAYS");
});

test("analyze 抛错 → 503 CORE_UNAVAILABLE，而 /api/status 与 /api/ingest 照常工作", async (t) => {
  const app = await harness({
    analyze: () => {
      throw new Error("buildSnapshot 尚未实现");
    },
  });
  t.after(() => app.close());

  const ingest = await callHttp(app.url, "POST", "/api/ingest", {
    session_id: "s1",
    page_context: "home",
    url: "https://www.bilibili.com/",
    observed_at: NOW,
    cards: [biliCard(1)],
    actions: [{ action_type: "open", url: biliCard(1).url, at: NOW }],
  });
  assert.equal(ingest.status, 200);
  assert.equal(ingest.json.ok, true);

  const status = await callHttp(app.url, "GET", "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.deepEqual(status.json.counts, { items: 1, exposures: 1, actions: 1 });

  const profile = await callHttp(app.url, "GET", "/api/profile");
  assert.equal(profile.status, 503);
  assert.deepEqual(profile.json.ok, false);
  assert.equal(profile.json.error.code, "CORE_UNAVAILABLE");
  assert.ok(profile.json.error.message.length > 0);
});

test("analyze 未注入（core 存根没有 buildSnapshot）→ 同样 503 CORE_UNAVAILABLE", async (t) => {
  const app = await harness({ analyze: null });
  t.after(() => app.close());
  const profile = await callHttp(app.url, "GET", "/api/profile");
  assert.equal(profile.status, 503);
  assert.equal(profile.json.error.code, "CORE_UNAVAILABLE");
});

test("labeler.narrative 抛错时 profile 仍返回 200，ai 降级不 500", async (t) => {
  const labeler = createFakeLabeler();
  labeler.narrative = async () => {
    throw new Error("narrative boom");
  };
  const app = await harness({ labeler });
  t.after(() => app.close());
  const response = await callHttp(app.url, "GET", "/api/profile");
  assert.equal(response.status, 200);
  assert.equal(response.json.ai.degraded, true);
  assert.deepEqual(response.json.ai.suggestions, []);
  assert.equal(response.json.ai.narrative, "");
});

test("GET /api/status 形状照契约（含 ai.mode / port / window / counts）", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  const status = await callHttp(app.url, "GET", "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.ok, true);
  assert.equal(status.json.version, 1);
  assert.equal(status.json.port, 3789);
  assert.equal(status.json.data_mode, "empty");
  assert.equal(status.json.window.days, 7);
  assert.equal(status.json.paused, false);
  assert.deepEqual(status.json.counts, { items: 0, exposures: 0, actions: 0 });
  assert.equal(status.json.ai.mode, "degraded");
  assert.equal(status.json.ai.model, "fake-model");
  assert.equal(typeof status.json.ai.cached, "number");
  assert.equal(typeof status.json.ai.pending, "number");
  for (const key of ["key", "api_key", "token"]) assert.equal(status.json.ai[key], undefined);
});

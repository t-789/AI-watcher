import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server/app.js";
import { createFakeLabeler, createFakeStore, fakeSnapshot, startServer, callHttp } from "./_helpers.mjs";

const NOW = 1700000000000;

async function harness(options = {}) {
  const store = createFakeStore();
  const app = createApp({
    store,
    labeler: createFakeLabeler(),
    analyze: (input) => fakeSnapshot(input),
    clock: { now: () => NOW },
    parseGoal: options.parseGoal ?? null,
  });
  const server = await startServer(app);
  return { ...server, store };
}

test("POST /api/goal 写入 GoalProfile 并可读回（version 递增）", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const first = await callHttp(app.url, "POST", "/api/goal", { goal_text: "想学 AI 基础", intent_mode: "skill" });
  assert.equal(first.status, 200);
  assert.equal(first.json.profile_id, "local-default");
  assert.equal(first.json.goal_text, "想学 AI 基础");
  assert.equal(first.json.intent_mode, "skill");
  assert.equal(first.json.version, 1);
  assert.equal(first.json.source, "user");
  assert.equal(first.json.updated_at, NOW);
  assert.deepEqual(first.json.exclusions, []);
  assert.deepEqual(first.json.goal_topics, []);
  assert.ok(first.json.exploration_level >= 0 && first.json.exploration_level <= 1);

  const second = await callHttp(app.url, "POST", "/api/goal", { goal_text: "备考四六级", intent_mode: "exam", exclusions: ["带货", 42, ""] });
  assert.equal(second.json.version, 2);
  assert.deepEqual(second.json.exclusions, ["带货"]);
  assert.deepEqual(app.store.getGoal(), second.json, "存储层读回应与响应一致");
});

test("非法 intent_mode 回落到 relax；goal_text 缺失 → 400", async (t) => {
  const app = await harness();
  t.after(() => app.close());

  const response = await callHttp(app.url, "POST", "/api/goal", { goal_text: "随便看看", intent_mode: "unknown-mode" });
  assert.equal(response.json.intent_mode, "relax");

  const bad = await callHttp(app.url, "POST", "/api/goal", { intent_mode: "skill" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "BAD_REQUEST");
});

test("注入的 parseGoal 提供 goal_topics 并归一化", async (t) => {
  const app = await harness({
    parseGoal: () => ({ goal_topics: [{ t: "tech", w: 2 }, { t: "study", w: 2 }, { t: "bogus", w: 1 }] }),
  });
  t.after(() => app.close());

  const response = await callHttp(app.url, "POST", "/api/goal", { goal_text: "学 AI", intent_mode: "skill" });
  assert.deepEqual(response.json.goal_topics.map((entry) => entry.t).sort(), ["study", "tech"], "非法主题被丢弃");
  const sum = response.json.goal_topics.reduce((acc, entry) => acc + entry.w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, "目标主题权重归一化到 1");
});

test("goal 进入 /api/profile 的 analyze 输入", async (t) => {
  const seen = [];
  const store = createFakeStore();
  const app = createApp({
    store,
    labeler: createFakeLabeler(),
    analyze: (input) => {
      seen.push(input);
      return fakeSnapshot(input);
    },
    clock: { now: () => NOW },
  });
  const server = await startServer(app);
  t.after(() => server.close());

  await callHttp(server.url, "POST", "/api/goal", { goal_text: "学 AI", intent_mode: "skill" });
  await callHttp(server.url, "GET", "/api/profile");
  assert.equal(seen.at(-1).goal.goal_text, "学 AI");
  assert.equal(seen.at(-1).goal.intent_mode, "skill");
});

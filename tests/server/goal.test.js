import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server/app.js";
import { applyRelaxIntent } from "../../src/core/index.js";
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
    structureGoal: options.structureGoal ?? null,
    applyRelaxIntent: options.applyRelaxIntent ?? null,
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
  // source 语义变更为"主题表从哪来"：客户端没给主题、也没有解析器 → fallback（原来一律写 user）。
  assert.equal(first.json.source, "fallback");
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

test("目标结构化优先走模型：source=ai 且主题按权重降序归一", async (t) => {
  const app = await harness({
    structureGoal: async () => ({ topics: [{ t: "game", w: 0.2 }, { t: "news", w: 0.2 }, { t: "bogus", w: 0.9 }], model: "deepseek-chat", degraded: false }),
    parseGoal: () => ({ goal_topics: [{ t: "study", w: 1 }] }),
  });
  t.after(() => app.close());

  const response = await callHttp(app.url, "POST", "/api/goal", { goal_text: "放松身心，了解一下时事", intent_mode: "relax" });
  assert.equal(response.status, 200);
  assert.equal(response.json.source, "ai", "模型给出了主题就不该被关键词覆盖");
  assert.deepEqual(response.json.goal_topics.map((x) => x.t), ["game", "news"], "非法主题必须被丢弃");
  const sum = response.json.goal_topics.reduce((acc, x) => acc + x.w, 0);
  assert.ok(Math.abs(sum - 1) <= 1e-3, "权重和应为 1，实际 " + sum);
});

test("模型失败/返回空主题 → 退回关键词兜底：source=keyword，不 500", async (t) => {
  const cases = [
    { name: "抛错", structureGoal: async () => { throw new Error("boom"); } },
    { name: "空主题", structureGoal: async () => ({ topics: [], model: "deepseek-chat", degraded: true }) },
    { name: "全非法", structureGoal: async () => ({ topics: [{ t: "bogus", w: 1 }], model: "deepseek-chat", degraded: false }) },
  ];
  for (const item of cases) {
    const app = await harness({ structureGoal: item.structureGoal, parseGoal: () => ({ goal_topics: [{ t: "study", w: 0.6 }, { t: "science", w: 0.4 }] }) });
    t.after(() => app.close());
    const response = await callHttp(app.url, "POST", "/api/goal", { goal_text: "备考", intent_mode: "exam" });
    assert.equal(response.status, 200, item.name + " 不应 500");
    assert.equal(response.json.source, "keyword", item.name + " 应退回关键词兜底");
    assert.deepEqual(response.json.goal_topics.map((x) => x.t), ["study", "science"]);
  }
});

test("整数 0 与 negative 权重被丢弃；body 显式 goal_topics 且无解析来源时 source=user", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  const response = await callHttp(app.url, "POST", "/api/goal", {
    goal_text: "看数码",
    intent_mode: "skill",
    goal_topics: [{ t: "tech", w: 1 }, { t: "game", w: 0 }],
  });
  assert.equal(response.json.source, "user");
  assert.deepEqual(response.json.goal_topics.map((x) => x.t), ["tech"]);
});

test("「放松」兜底：AI 与关键词两条路径都会补上放松组，source 语义不变", async (t) => {
  const cases = [
    ["ai", { structureGoal: async () => ({ topics: [{ t: "news", w: 0.4 }, { t: "science", w: 0.35 }, { t: "tech", w: 0.25 }], model: "deepseek-chat", degraded: false }) }],
    ["keyword", { parseGoal: () => ({ goal_topics: [{ t: "news", w: 0.5 }, { t: "science", w: 0.5 }] }) }],
  ];
  for (const [name, deps] of cases) {
    const app = await harness({ ...deps, applyRelaxIntent });
    t.after(() => app.close());
    const response = await callHttp(app.url, "POST", "/api/goal", {
      goal_text: "在课余时间放松身心，顺便学一些有用的小知识，了解一些时事",
      intent_mode: "relax",
    });
    assert.equal(response.json.source, name, name + " 路径的 source 不应被兜底改动");
    const relax = response.json.goal_topics.filter((x) => ["game", "anime", "film_tv"].includes(x.t));
    const relaxSum = relax.reduce((acc, x) => acc + x.w, 0);
    assert.ok(Math.abs(relaxSum - 0.4) <= 0.01, name + " 路径放松组合计应为 0.4，实际 " + relaxSum.toFixed(4));
    const total = response.json.goal_topics.reduce((acc, x) => acc + x.w, 0);
    assert.ok(Math.abs(total - 1) <= 1e-2, name + " 路径权重和应为 1，实际 " + total);
  }
});

test("「放松」兜底不误伤：intent=exam 且文本无放松词时主题表保持原样", async (t) => {
  const app = await harness({
    parseGoal: () => ({ goal_topics: [{ t: "study", w: 0.7 }, { t: "science", w: 0.3 }] }),
    applyRelaxIntent,
  });
  t.after(() => app.close());
  const response = await callHttp(app.url, "POST", "/api/goal", { goal_text: "准备期末考试", intent_mode: "exam" });
  assert.deepEqual(response.json.goal_topics.map((x) => x.t), ["study", "science"]);
});

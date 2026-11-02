import test from "node:test";
import assert from "node:assert/strict";
import { createAI } from "../../src/server/ai.js";

const okResponse = (payload) => ({
  status: 200,
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
});

function harness(reply, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return typeof reply === "function" ? reply(calls.length) : okResponse(reply);
  };
  const ai = createAI({ apiKey: options.apiKey ?? "test-key", fetchImpl, now: () => 1700000000000 });
  return { ai, calls };
}

test("structureGoal：合法输出按权重归一化并降序，模型名随结果带出", async () => {
  const { ai } = harness({ topics: [{ t: "game", w: 0.2 }, { t: "news", w: 0.6 }] });
  const result = await ai.structureGoal({ text: "放松一下，顺便了解时事", intentMode: "relax" });
  assert.equal(result.degraded, false);
  assert.deepEqual(result.topics.map((x) => x.t), ["news", "game"]);
  assert.ok(Math.abs(result.topics.reduce((acc, x) => acc + x.w, 0) - 1) <= 1e-3);
});

test("structureGoal：主题不在表内 / 权重 0 / 权重 >1 全部丢弃，全丢则返回 null", async () => {
  const bad = harness({ topics: [{ t: "bogus", w: 0.5 }, { t: "game", w: 0 }, { t: "news", w: 1.5 }] });
  assert.equal((await bad.ai.structureGoal({ text: "随便看看", intentMode: "relax" })).topics, null);

  const mixed = harness({ topics: [{ t: "bogus", w: 0.5 }, { t: "game", w: 0.3 }] });
  const partial = await mixed.ai.structureGoal({ text: "想打游戏", intentMode: "relax" });
  assert.deepEqual(partial.topics, [{ t: "game", w: 1 }], "非法项丢弃后归一化");
});

test("structureGoal：主题数超过上限时截断到 4 个并归一化", async () => {
  const { ai } = harness({ topics: ["tech", "game", "news", "science", "music"].map((t, i) => ({ t, w: 0.5 - i * 0.05 })) });
  const result = await ai.structureGoal({ text: "什么都想看一点", intentMode: "learn_event" });
  assert.equal(result.topics.length, 4);
  assert.deepEqual(result.topics.map((x) => x.t), ["tech", "game", "news", "science"]);
  assert.ok(Math.abs(result.topics.reduce((acc, x) => acc + x.w, 0) - 1) <= 1e-3);
});

test("structureGoal：空 topics 数组 → null（不让空结果冒充成目标）", async () => {
  const { ai } = harness({ topics: [] });
  assert.equal((await ai.structureGoal({ text: "不知道想看啥", intentMode: "relax" })).topics, null);
});

test("structureGoal：上游报错/超时 → topics null 且 degraded，不抛异常", async () => {
  const { ai } = harness(() => { throw new Error("network down"); });
  const result = await ai.structureGoal({ text: "想学点东西", intentMode: "skill" });
  assert.equal(result.topics, null);
  assert.equal(result.degraded, true);
});

test("structureGoal：无 key 时直接 degraded，且一次请求都不发", async () => {
  const calls = [];
  const ai = createAI({ apiKey: "", fetchImpl: async () => { calls.push(1); throw new Error("should not call"); } });
  const result = await ai.structureGoal({ text: "想学点东西", intentMode: "skill" });
  assert.equal(result.topics, null);
  assert.equal(result.degraded, true);
  assert.equal(calls.length, 0, "degraded 模式不得发请求");
});

test("structureGoal：只把目标原文、意图模式与主题标签发给模型，不带任何浏览数据", async () => {
  const { ai, calls } = harness({ topics: [{ t: "tech", w: 1 }] });
  await ai.structureGoal({ text: "想搞懂大模型怎么本地跑", intentMode: "skill" });
  assert.equal(calls.length, 1);
  const sent = calls[0].body.messages.find((m) => m.role === "user").content;
  const payload = JSON.parse(sent);
  assert.deepEqual(Object.keys(payload).sort(), ["goal_text", "intent_mode", "topics"]);
  assert.equal(payload.goal_text, "想搞懂大模型怎么本地跑");
  assert.equal(payload.intent_mode, "skill");
  assert.ok(payload.topics.every((entry) => entry.t && typeof entry.label === "string"));
});

test("structureGoal：空文本直接返回 null，不发请求", async () => {
  const { ai, calls } = harness({ topics: [{ t: "tech", w: 1 }] });
  assert.equal((await ai.structureGoal({ text: "   ", intentMode: "skill" })).topics, null);
  assert.equal(calls.length, 0);
});

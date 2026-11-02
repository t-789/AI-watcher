import test from "node:test";
import assert from "node:assert/strict";
import { parseGoalText } from "../../src/core/index.js";
import { INTENT_MODES, TOPICS } from "../../src/core/constants.js";

const sumW = (topics) => topics.reduce((acc, t) => acc + t.w, 0);

test("关键词兜底：命中的主题进入 goal_topics，权重和为 1", () => {
  const goal = parseGoalText("想学 AI 和编程，顺便准备考研", "skill");
  assert.equal(goal.source, "fallback");
  assert.equal(goal.intent_mode, "skill");
  const ids = goal.goal_topics.map((t) => t.t);
  assert.ok(ids.includes("tech"));
  assert.ok(ids.includes("study"));
  assert.ok(Math.abs(sumW(goal.goal_topics) - 1) <= 1e-3);
  for (const entry of goal.goal_topics) {
    assert.ok(TOPICS.includes(entry.t));
    assert.ok(entry.w > 0 && entry.w <= 1);
  }
  // 权重降序
  const weights = goal.goal_topics.map((t) => t.w);
  assert.deepEqual(weights, weights.slice().sort((a, b) => b - a));
});

test("无关键词命中时退回 intent_mode 先验，并标注 fallback", () => {
  const relax = parseGoalText("随便看看", "relax");
  assert.deepEqual(relax.goal_topics.map((t) => t.t).sort(), ["anime", "film_tv", "game", "life", "music"]);
  assert.equal(relax.source, "fallback");
  const exam = parseGoalText("", "exam");
  assert.deepEqual(exam.goal_topics.map((t) => t.t).sort(), ["science", "study"]);
  assert.equal(exam.goal_text, "");
});

test("未知或缺失 intent_mode 退回 relax，不抛异常", () => {
  assert.equal(parseGoalText("想看游戏", "nonsense").intent_mode, "relax");
  assert.equal(parseGoalText("想看游戏").intent_mode, "relax");
  assert.equal(parseGoalText(null, null).intent_mode, "relax");
  assert.deepEqual(parseGoalText(undefined).goal_topics.length > 0, true);
  for (const mode of INTENT_MODES) assert.equal(parseGoalText("测试", mode).intent_mode, mode);
});

test("排除项：只从文本里抽关键词，不做 AI 推断", () => {
  const goal = parseGoalText("想学编程，不想看鬼畜，不要手游", "skill");
  assert.deepEqual(goal.exclusions, ["鬼畜", "手游"]);
});

test("探索程度按 intent 给出默认值", () => {
  assert.equal(parseGoalText("学习", "exam").exploration_level, 0.3);
  assert.equal(parseGoalText("学习", "learn_event").exploration_level, 0.7);
});

test("纯函数：同一输入两次输出完全一致；时间与版本由调用方注入", () => {
  const first = JSON.stringify(parseGoalText("备考数学", "exam"));
  const second = JSON.stringify(parseGoalText("备考数学", "exam"));
  assert.equal(first, second);
  const stamped = parseGoalText("备考数学", "exam", { updated_at: 1234567890, version: 7, profile_id: "p-test" });
  assert.equal(stamped.updated_at, 1234567890);
  assert.equal(stamped.version, 7);
  assert.equal(stamped.profile_id, "p-test");
  assert.equal(parseGoalText("备考数学", "exam").updated_at, 0, "不能自己读时钟");
});

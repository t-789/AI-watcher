import test from "node:test";
import assert from "node:assert/strict";
import { parseGoalText } from "../../src/core/index.js";
import { GOAL_TOPIC_LIMIT, INTENT_PRIORS, TOPICS } from "../../src/core/constants.js";

const USER_SENTENCE = "在课余时间放松身心，顺便学一些有用的小知识，了解一些时事";
const byTopic = (goal) => Object.fromEntries(goal.goal_topics.map((x) => [x.t, x.w]));
const sum = (goal) => goal.goal_topics.reduce((acc, x) => acc + x.w, 0);
const RELAX_FAMILY = ["game", "anime", "film_tv", "music", "life"];

test("多意图句子不塌陷：三个分句的主题都保留，没有任何主题独占", () => {
  const goal = parseGoalText(USER_SENTENCE, "relax");
  const w = byTopic(goal);
  assert.ok(goal.goal_topics.length >= 3, "主题数应 ≥3，实际 " + goal.goal_topics.length);
  assert.ok((w.science ?? 0) > 0.2, "「小知识」应落在 science，实际 " + w.science);
  assert.ok((w.news ?? 0) > 0.2, "「时事」应落在 news，实际 " + w.news);
  const relax = RELAX_FAMILY.reduce((acc, t) => acc + (w[t] ?? 0), 0);
  assert.ok(relax >= 0.15, "「放松身心」应由 relax 先验表达，实际 " + relax.toFixed(3));
  for (const [t, v] of Object.entries(w)) assert.ok(v < 0.5, t + " 权重过高（" + v + "）说明仍在塌陷");
  assert.ok(Math.abs(sum(goal) - 1) <= 1e-3);
});

test("边界：用户只明说一个主题时，就该只返回那一个（不能为防塌陷去稀释明确意图）", () => {
  const goal = parseGoalText("了解一些时事", "relax");
  assert.deepEqual(goal.goal_topics, [{ t: "news", w: 1 }], "单分句单主题是正确结果，不是塌陷");
  // 塌陷的判定标准是"多分句被最后一个关键词吃掉"，见上一条用例。
  const multi = parseGoalText("想放松 看看游戏，也关心一下时事", "relax");
  assert.ok((byTopic(multi).news ?? 0) < 0.9, "多分句时不得被 news 独占，实际 " + JSON.stringify(multi.goal_topics));
});

test("意图先验真正生效：分句没有关键词时使用 intent_mode 分布", () => {
  const relax = parseGoalText("想放松一下", "relax");
  const exam = parseGoalText("想放松一下", "exam");
  assert.deepEqual(relax.goal_topics.map((x) => x.t), Object.keys(INTENT_PRIORS.relax).sort((a, b) => (INTENT_PRIORS.relax[b] - INTENT_PRIORS.relax[a])));
  assert.ok(exam.goal_topics.some((x) => x.t === "study"), "exam 先验应包含 study，实际 " + JSON.stringify(exam.goal_topics));
  assert.notDeepEqual(relax.goal_topics, exam.goal_topics, "同一句话换意图必须得到不同目标");
});

test("同主题近义词封顶：命中越多不会线性放大", () => {
  const one = parseGoalText("小知识", "relax");
  const many = parseGoalText("小知识 知识 科学", "relax");
  const oneW = byTopic(one).science ?? 0;
  const manyW = byTopic(many).science ?? 0;
  assert.ok(manyW <= 1 && oneW <= 1);
  assert.equal(Object.keys(byTopic(many)).length, 1, "只有 science 命中时不应冒出别的主题");
  assert.ok(Math.abs(oneW - manyW) < 1e-6, "同一分句内近义词命中数不应改变单主题结果");
});

test("主题数上限只作用于关键词解析结果；纯先验兜底保留完整分布", () => {
  const keyword = parseGoalText("游戏 动漫 电影 音乐 时事 科普", "relax");
  assert.ok(keyword.goal_topics.length <= GOAL_TOPIC_LIMIT, "关键词结果应受 " + GOAL_TOPIC_LIMIT + " 收窄，实际 " + keyword.goal_topics.length);
  const prior = parseGoalText("随便看看", "relax");
  assert.deepEqual(prior.goal_topics.map((x) => x.t).sort(), Object.keys(INTENT_PRIORS.relax).sort());
});

test("排除项不参与主题：'不想看鬼畜' 不进目标，但会写进 exclusions", () => {
  const goal = parseGoalText("想学编程，不想看鬼畜", "skill");
  assert.deepEqual(goal.exclusions, ["鬼畜"]);
  assert.ok(goal.goal_topics.every((x) => TOPICS.includes(x.t)));
});

test("确定性：同一输入两次逐字节相同，且不受分句顺序外的状态影响", () => {
  const a = JSON.stringify(parseGoalText(USER_SENTENCE, "relax"));
  const b = JSON.stringify(parseGoalText(USER_SENTENCE, "relax"));
  assert.equal(a, b);
});

test("空文本 / 纯排除项：退回意图先验，不抛异常", () => {
  for (const text of ["", "   ", null, undefined, "不想看鬼畜"]) {
    const goal = parseGoalText(text, "exam");
    assert.ok(goal.goal_topics.length > 0);
    assert.ok(Math.abs(sum(goal) - 1) <= 1e-3);
    assert.equal(goal.intent_mode, "exam");
  }
});

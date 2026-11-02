import test from "node:test";
import assert from "node:assert/strict";
import { applyRelaxIntent } from "../../src/core/index.js";
import { GOAL_TOPIC_LIMIT, RELAX_GROUP, RELAX_GROUP_RATIO, RELAX_GROUP_WEIGHT, TOPICS } from "../../src/core/constants.js";

const USER_SENTENCE = "在课余时间放松身心，顺便学一些有用的小知识，了解一些时事";
const AI_LIKE = [{ t: "news", w: 0.3 }, { t: "science", w: 0.25 }, { t: "tech", w: 0.25 }, { t: "life", w: 0.2 }];
const KEYWORD_LIKE = [{ t: "news", w: 0.392 }, { t: "science", w: 0.392 }, { t: "game", w: 0.118 }, { t: "anime", w: 0.098 }];
const sum = (list) => list.reduce((acc, entry) => acc + entry.w, 0);
const relaxSum = (list) => list.filter((e) => RELAX_GROUP.includes(e.t)).reduce((acc, e) => acc + e.w, 0);
const byTopic = (list) => Object.fromEntries(list.map((e) => [e.t, e.w]));

test("命中 relax 意图：放松组合计 = 0.4，其余主题按原比例分享 0.6", () => {
  const out = applyRelaxIntent(AI_LIKE, "relax", USER_SENTENCE);
  assert.ok(Math.abs(relaxSum(out) - RELAX_GROUP_WEIGHT) <= 0.01, "放松组合计应为 0.4，实际 " + relaxSum(out).toFixed(4));
  assert.ok(Math.abs(sum(out) - 1) <= 1e-3, "权重和应为 1，实际 " + sum(out));
  assert.ok(out.some((e) => e.t === "game"), "game 必须出现");
  assert.ok(out.some((e) => e.t === "news"), "用户明说的 news 不能被丢掉");
  assert.ok(out.length <= GOAL_TOPIC_LIMIT);
  const weights = out.map((e) => e.w);
  assert.deepEqual(weights, weights.slice().sort((a, b) => b - a), "必须降序");
});

test("组内比例：0.5 / 0.3 / 0.2（有其它主题时按 0.4 分，只有放松时占满 1.0）", () => {
  const mixed = applyRelaxIntent([{ t: "news", w: 1 }], "relax", "");
  const mw = byTopic(mixed);
  assert.deepEqual(mixed.map((e) => e.t).sort(), ["anime", "film_tv", "game", "news"]);
  assert.ok(Math.abs(mw.game - RELAX_GROUP_WEIGHT * RELAX_GROUP_RATIO.game) <= 0.01, "game 应为 0.4×0.5=0.2，实际 " + mw.game);
  assert.ok(Math.abs(mw.anime - RELAX_GROUP_WEIGHT * RELAX_GROUP_RATIO.anime) <= 0.01);
  assert.ok(Math.abs(mw.film_tv - RELAX_GROUP_WEIGHT * RELAX_GROUP_RATIO.film_tv) <= 0.01);
  assert.ok(Math.abs(mw.news - 0.6) <= 0.01);
  assert.ok(Math.abs(sum(mixed) - 1) <= 1e-3);

  // 只有放松诉求时，放松组占满 1.0，组内比例保持不变（0.5/0.3/0.2）。
  const only = applyRelaxIntent([], "relax", "");
  assert.deepEqual(only.map((e) => e.t), ["game", "anime", "film_tv"]);
  const ow = byTopic(only);
  assert.ok(Math.abs(ow.game - RELAX_GROUP_RATIO.game) <= 0.01);
  assert.ok(Math.abs(ow.anime - RELAX_GROUP_RATIO.anime) <= 0.01);
  assert.ok(Math.abs(ow.film_tv - RELAX_GROUP_RATIO.film_tv) <= 0.01);
  assert.ok(Math.abs(sum(only) - 1) <= 1e-3);
});

test("意图不是 relax，但文本提到放松类词也命中", () => {
  const out = applyRelaxIntent([{ t: "study", w: 1 }], "skill", "想轻松一下，顺便学点东西");
  assert.ok(Math.abs(relaxSum(out) - RELAX_GROUP_WEIGHT) <= 0.01, "文本命中同样注入 0.4，实际 " + relaxSum(out).toFixed(4));
  assert.ok(out.some((e) => e.t === "study"));
});

test("未命中时原样返回：不改动「单句只明说一个主题」的行为", () => {
  const input = [{ t: "news", w: 1 }];
  const out = applyRelaxIntent(input, "exam", "了解一些时事");
  assert.equal(out, input, "必须返回同一个对象，不得重建");
  assert.deepEqual(out, [{ t: "news", w: 1 }]);
  const skill = applyRelaxIntent([{ t: "tech", w: 0.6 }, { t: "study", w: 0.4 }], "skill", "想提升编程能力");
  assert.deepEqual(skill.map((e) => e.t), ["tech", "study"]);
});

test("已有 relax 成员不会被叠加放大，非 relax 主题不丢", () => {
  const out = applyRelaxIntent(KEYWORD_LIKE, "relax", USER_SENTENCE);
  assert.ok(Math.abs(relaxSum(out) - RELAX_GROUP_WEIGHT) <= 0.01, "输入里已有的 game/anime 应被替换而不是累加");
  assert.ok(out.some((e) => e.t === "news") && out.some((e) => e.t === "science"));
  for (const entry of out) assert.ok(entry.w > 0 && entry.w <= 1 && TOPICS.includes(entry.t));
});

test("纯函数：两次调用结果相同，且不修改入参", () => {
  const input = AI_LIKE.map((e) => ({ ...e }));
  const snapshot = JSON.stringify(input);
  const a = JSON.stringify(applyRelaxIntent(input, "relax", USER_SENTENCE));
  const b = JSON.stringify(applyRelaxIntent(input, "relax", USER_SENTENCE));
  assert.equal(a, b);
  assert.equal(JSON.stringify(input), snapshot, "不得就地修改入参");
});

test("空主题 + relax：退化为放松组本身，权重和仍为 1", () => {
  const out = applyRelaxIntent([], "relax", "想放松");
  assert.deepEqual(out.map((e) => e.t), ["game", "anime", "film_tv"]);
  assert.ok(Math.abs(sum(out) - 1) <= 1e-3);
});

test("主题数上限：非 relax 主题过多时只保留权重最高的若干个，放松组份额不缩水", () => {
  const many = ["tech", "science", "study", "news", "life"].map((t, i) => ({ t, w: 0.2 - i * 0.01 }));
  const out = applyRelaxIntent(many, "relax", "想放松");
  assert.ok(out.length <= GOAL_TOPIC_LIMIT, "主题数应 ≤ " + GOAL_TOPIC_LIMIT + "，实际 " + out.length);
  assert.ok(Math.abs(relaxSum(out) - RELAX_GROUP_WEIGHT) <= 0.01, "被上限砍掉组内成员后，存活成员仍占 0.4");
  assert.ok(Math.abs(sum(out) - 1) <= 1e-3);
});

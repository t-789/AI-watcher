import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../../src/core/index.js";
import { THRESHOLDS, TOPICS } from "../../src/core/constants.js";
import { DAY, HOUR, MIN, NOW, mkAction, mkExposure, mkItem } from "./helpers.js";

const T = THRESHOLDS;

function snap(parts) {
  return buildSnapshot({ now: NOW, items: [], exposures: [], actions: [], goal: null, ...parts });
}

const rulesOf = (s) => s.alerts.map((a) => a.rule_id);
const alertOf = (s, ruleId) => s.alerts.find((a) => a.rule_id === ruleId);

function itemsOnePer(topicList) {
  return topicList.map((t) => mkItem("i_" + t, [{ t, w: 1 }], { sourceId: "s_" + t }));
}

/** plan: [[contentId, count]] -> 曝光，放在窗口内，时间递增 */
function planExposures(plan, startAt = NOW - 3 * HOUR) {
  const out = [];
  let seq = 0;
  plan.forEach(([contentId, count], group) => {
    for (let i = 0; i < count; i += 1) {
      out.push(mkExposure("e" + group + "_" + i, contentId, startAt + seq * MIN, { sessionId: "s" + group }));
      seq += 1;
    }
  });
  return out;
}

test("output_concentration：熵低于门槛触发，熵高于门槛不触发（门槛两侧各一例）", () => {
  const items = itemsOnePer(["tech", "game", "news", "music"]);
  const below = snap({ items, exposures: planExposures([["i_tech", 13], ["i_game", 3], ["i_news", 2], ["i_music", 2]]) });
  assert.ok(below.exposure.entropy < T.outputConcentrationEntropy, "实际 " + below.exposure.entropy);
  assert.ok(rulesOf(below).includes("output_concentration"));

  const above = snap({ items, exposures: planExposures([["i_tech", 12], ["i_game", 4], ["i_news", 2], ["i_music", 2]]) });
  assert.ok(above.exposure.entropy > T.outputConcentrationEntropy, "实际 " + above.exposure.entropy);
  assert.ok(!rulesOf(above).includes("output_concentration"));

  // 反例二：10 主题均匀 -> 熵 1，绝不该提示"集中"
  const uniform = snap({ items: itemsOnePer(TOPICS), exposures: planExposures(TOPICS.map((t) => ["i_" + t, 3])) });
  assert.equal(uniform.exposure.entropy, 1);
  assert.ok(!rulesOf(uniform).includes("output_concentration"));
});

test("goal_gap：目标分布与输出分布差异超过门槛才触发", () => {
  const items = itemsOnePer(["tech", "study"]);
  const exposures = planExposures([["i_tech", 30]]);
  const goalStudy = { goal_text: "备考", intent_mode: "exam", goal_topics: [{ t: "study", w: 1 }], source: "fallback" };
  const positive = snap({ items, exposures, goal: goalStudy });
  assert.equal(positive.goal_cmp.D, 1);
  const alert = alertOf(positive, "goal_gap");
  assert.ok(alert);
  assert.equal(alert.severity, "warn");
  assert.ok(alert.detail.includes("学习·考试·求职"));
  assert.ok(alert.evidence.length > 0);

  // 反例：目标与输出一致 -> D = 0
  const goalTech = { goal_text: "看数码", intent_mode: "skill", goal_topics: [{ t: "tech", w: 1 }], source: "fallback" };
  const negative = snap({ items, exposures, goal: goalTech });
  assert.equal(negative.goal_cmp.D, 0);
  assert.ok(!rulesOf(negative).includes("goal_gap"));

  // 反例：目标存在但曝光明细不足 -> 不比较、不触发，并在 notes 说明
  const tiny = snap({ items, exposures: planExposures([["i_tech", 5]]), goal: goalStudy });
  assert.equal(tiny.goal_cmp, null);
  assert.ok(!rulesOf(tiny).includes("goal_gap"));
  assert.ok(tiny.notes.some((n) => n.includes("曝光样本 5 条")));
});

test("behavior_gap：既要 D 过门槛，也要某主题输出占比高出行为 0.20", () => {
  const topics = ["tech", "game", "news", "music", "life"];
  const items = itemsOnePer(TOPICS);
  const exposures = planExposures([["i_tech", 30]]);
  const actions = [];
  for (let i = 0; i < 12; i += 1) {
    actions.push(mkAction("a" + i, "i_game", "open", NOW - 2 * HOUR + i * MIN, { sessionId: "s" + i }));
  }
  const positive = snap({ items, exposures, actions });
  assert.equal(positive.behavior.available, true);
  const alert = alertOf(positive, "behavior_gap");
  assert.ok(alert);
  // 触发点取"曝光占比高于行为占比"最多的主题（这里是 tech），而不是行为侧的主题。
  assert.ok(alert.detail.includes("科技·AI·数码"), alert.detail);
  assert.equal(alert.thresholds_used.topDomination, T.topDomination);

  // 反例一：行为与输出一致 -> D ≈ 0
  const mirrored = [];
  for (let i = 0; i < 12; i += 1) {
    mirrored.push(mkAction("m" + i, "i_tech", "open", NOW - 2 * HOUR + i * MIN, { sessionId: "m" + i }));
  }
  const negA = snap({ items, exposures, actions: mirrored });
  assert.ok(negA.behavior_cmp.D <= T.gapDistance);
  assert.ok(!rulesOf(negA).includes("behavior_gap"));

  // 反例二：D = 0.5 过门槛，但最大正差只有 0.10 < topDomination -> 不触发
  const uniformExposures = planExposures(TOPICS.map((t) => ["i_" + t, 3]));
  const spread = [];
  for (let i = 0; i < 10; i += 1) {
    spread.push(mkAction("b" + i, "i_" + topics[i % topics.length], "open", NOW - 2 * HOUR + i * MIN, { sessionId: "b" + i }));
  }
  const negB = snap({ items, exposures: uniformExposures, actions: spread });
  assert.equal(negB.behavior.available, true);
  assert.ok(Math.abs(negB.behavior_cmp.D - 0.5) <= 1e-3, "实际 D=" + negB.behavior_cmp.D);
  assert.ok(!rulesOf(negB).includes("behavior_gap"), "缺少主题压制条件时不应触发");
});

test("repeat_heavy：重复曝光率过门槛触发，全部不重复不触发", () => {
  const items = [0, 1, 2, 3].map((i) => mkItem("i" + i, [{ t: "tech", w: 1 }], { sourceId: "s" + i }));
  const repeats = snap({ items, exposures: planExposures([["i0", 5], ["i1", 5], ["i2", 5], ["i3", 5]]) });
  assert.ok(repeats.exposure.repeat_rate > T.repeatRate);
  assert.ok(rulesOf(repeats).includes("repeat_heavy"));

  const uniqueItems = [];
  const uniqueExposures = [];
  for (let i = 0; i < 20; i += 1) {
    uniqueItems.push(mkItem("u" + i, [{ t: "tech", w: 1 }], { sourceId: "src_" + i }));
    uniqueExposures.push(mkExposure("ue" + i, "u" + i, NOW - HOUR + i * MIN, { sessionId: "x" + i }));
  }
  const unique = snap({ items: uniqueItems, exposures: uniqueExposures });
  assert.equal(unique.exposure.repeat_rate, 0);
  assert.ok(!rulesOf(unique).includes("repeat_heavy"));
});

test("source_concentration：单一来源占比过门槛触发，来源分散不触发", () => {
  const items = [mkItem("a", [{ t: "tech", w: 1 }], { sourceId: "src_A", sourceName: "A" }), mkItem("b", [{ t: "tech", w: 1 }], { sourceId: "src_B", sourceName: "B" })];
  const concentrated = snap({ items, exposures: planExposures([["a", 16], ["b", 4]]) });
  assert.ok(concentrated.exposure.top_source.share > T.topSourceShare);
  const alert = alertOf(concentrated, "source_concentration");
  assert.ok(alert);
  assert.ok(alert.detail.includes("来源「A」"), alert.detail);
  assert.ok(alert.detail.includes("80%"), alert.detail);

  const spreadItems = ["A", "B", "C", "D", "E"].map((x) => mkItem("i" + x, [{ t: "tech", w: 1 }], { sourceId: "src_" + x, sourceName: x }));
  const spread = snap({ items: spreadItems, exposures: planExposures(spreadItems.map((it) => [it.content_id, 4])) });
  assert.ok(spread.exposure.top_source.share < T.topSourceShare);
  assert.ok(!rulesOf(spread).includes("source_concentration"));
});

test("narrowing：相邻窗口熵下降过门槛触发；持平或前窗不足都不触发", () => {
  const items = itemsOnePer(TOPICS);
  const prevUniform = [];
  TOPICS.forEach((t, gi) => {
    for (let i = 0; i < 3; i += 1) {
      prevUniform.push(mkExposure("p" + gi + "_" + i, "i_" + t, NOW - 8 * DAY + (gi * 3 + i) * MIN, { sessionId: "p" + gi }));
    }
  });
  const currentNarrow = planExposures([["i_tech", 20]]);
  const positive = snap({ items, exposures: [...prevUniform, ...currentNarrow] });
  assert.ok(positive.trend.entropy_delta < -T.narrowingEntropyDrop);
  assert.ok(rulesOf(positive).includes("narrowing"));

  const currentUniform = planExposures(TOPICS.map((t) => ["i_" + t, 3]));
  const negative = snap({ items, exposures: [...prevUniform, ...currentUniform] });
  assert.equal(negative.trend.entropy_delta, 0);
  assert.ok(!rulesOf(negative).includes("narrowing"));

  const tinyPrev = snap({ items, exposures: [...prevUniform.slice(0, 5), ...currentNarrow] });
  assert.equal(tinyPrev.trend, null);
  assert.ok(!rulesOf(tinyPrev).includes("narrowing"));
  assert.ok(tinyPrev.notes.some((n) => n.includes("narrowing")));
});

test("alerts 结构：字段齐全、证据可回溯、阈值原样披露", () => {
  const items = itemsOnePer(TOPICS);
  const exposures = planExposures([["i_tech", 30]]);
  const actions = [];
  for (let i = 0; i < 12; i += 1) actions.push(mkAction("g" + i, "i_game", "open", NOW - 2 * HOUR + i * MIN, { sessionId: "g" + i }));
  const s = snap({ items, exposures, actions, goal: { goal_text: "备考", intent_mode: "exam", goal_topics: [{ t: "study", w: 1 }] } });
  assert.ok(s.alerts.length >= 4, "该数据集应触发多条规则，实际 " + s.alerts.length);
  const exposureIds = new Set(exposures.map((e) => e.exposure_id));
  for (const alert of s.alerts) {
    assert.ok(typeof alert.rule_id === "string" && alert.rule_id.length > 0);
    assert.ok(alert.severity === "info" || alert.severity === "warn");
    for (const key of ["title", "detail", "suggestion"]) {
      assert.equal(typeof alert[key], "string");
      assert.ok(alert[key].length > 0, key + " 不应为空");
    }
    assert.ok(Array.isArray(alert.evidence) && alert.evidence.length > 0);
    assert.ok(alert.evidence.length <= 5, "证据条数应受 ALERT_EVIDENCE_LIMIT 限制");
    let lastAt = Number.POSITIVE_INFINITY;
    for (const ev of alert.evidence) {
      assert.deepEqual(Object.keys(ev).sort(), ["at", "content_id", "exposure_id", "title", "url"]);
      assert.ok(exposureIds.has(ev.exposure_id), "证据必须指回真实曝光记录");
      assert.ok(ev.at < NOW && ev.at >= NOW - 7 * DAY);
      assert.ok(ev.at <= lastAt, "证据按时间倒序");
      lastAt = ev.at;
    }
    for (const [key, value] of Object.entries(alert.thresholds_used)) {
      assert.equal(value, T[key], "thresholds_used." + key + " 必须来自 constants.THRESHOLDS");
    }
    assert.ok(Object.keys(alert.thresholds_used).length > 0);
  }
});

test("门槛不满足时六条规则都不触发，并在 notes 里逐条写清缺什么", () => {
  const items = itemsOnePer(["tech"]);
  const s = snap({ items, exposures: planExposures([["i_tech", 5]]) });
  assert.deepEqual(s.alerts, []);
  const joined = s.notes.join("\n");
  for (const rule of ["output_concentration", "goal_gap", "behavior_gap", "repeat_heavy", "source_concentration", "narrowing"]) {
    assert.ok(joined.includes(rule), "notes 应说明 " + rule + " 为何不评估");
  }
  assert.ok(joined.includes("曝光样本 5 条"));
});

test("goal_gap 文案：gap 主题在目标里约等于 0 → 「目标却没提到」", () => {
  const items = itemsOnePer(["tech", "study"]);
  const goalStudy = { goal_text: "备考", intent_mode: "exam", goal_topics: [{ t: "study", w: 1 }], source: "fallback" };
  const s = snap({ items, exposures: planExposures([["i_tech", 30]]), goal: goalStudy });
  const alert = alertOf(s, "goal_gap");
  assert.ok(alert);
  assert.ok(alert.detail.includes("目标却没提到的是 科技·AI·数码"), "实际文案：" + alert.detail);
  assert.ok(!alert.detail.includes("目标里只占"), "g≈0 时不该出现「目标里只占」的措辞");
});

test("goal_gap 文案：gap 主题目标里已占 25% → 点明「只占 25%」，不得说成「没提到」", () => {
  const items = itemsOnePer(["game", "news", "science"]);
  const exposures = planExposures([["i_game", 18], ["i_news", 2]]);
  const goal = { goal_text: "放松一点，顺便学点科学", intent_mode: "relax", goal_topics: [{ t: "science", w: 0.75 }, { t: "game", w: 0.25 }], source: "ai" };
  const s = snap({ items, exposures, goal });
  assert.ok(s.goal_cmp.D > T.gapDistance, "D 应过门槛，实际 " + s.goal_cmp.D);
  const gapEntry = s.goal_cmp.by_topic.find((e) => e.t === "game");
  assert.equal(gapEntry.g, 0.25, "该用例必须落在「目标里有这个主题」的分支");
  const alert = alertOf(s, "goal_gap");
  assert.ok(alert.detail.includes("目标里只占 25%"), "实际文案：" + alert.detail);
  assert.ok(alert.detail.includes("游戏"), "实际文案：" + alert.detail);
  assert.ok(!alert.detail.includes("目标却没提到"), "目标里明确有 game 25%，不得说成没提到：" + alert.detail);
  // 文案不得与 goal.topics 冲突：凡是写了"目标却没提到"的主题，其 g 必须 ≈ 0。
  const mentioned = /目标却没提到的是 ([^ ]+)/.exec(alert.detail);
  if (mentioned) {
    const hit = s.goal_cmp.by_topic.find((e) => e.g > 0 && mentioned[1].includes(e.t));
    assert.equal(hit, undefined);
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot } from "../../src/core/index.js";
import { DAY_MS, PAGE_CONTEXTS, THRESHOLDS } from "../../src/core/constants.js";
import { DAY, HOUR, MIN, NOW, burst, mkAction, mkExposure, mkItem } from "./helpers.js";

const techItems = () => [mkItem("i_tech", [{ t: "tech", w: 1 }], { sourceId: "s_tech" })];
const techExposures = (n = 30) => burst("t", "i_tech", n);

function snap(parts) {
  return buildSnapshot({ now: NOW, items: [], exposures: [], actions: [], goal: null, ...parts });
}

test("空输入：data_mode=empty、各 available=false、alerts=[]、不抛异常", () => {
  for (const input of [{ now: NOW }, {}, { items: [], exposures: [], actions: [], goal: null, now: NOW }]) {
    const s = buildSnapshot(input);
    assert.equal(s.schema_version, 1);
    assert.equal(s.data_mode, "empty");
    assert.equal(s.window.exposure_count, 0);
    assert.equal(s.exposure.available, false);
    assert.equal(s.behavior.available, false);
    assert.deepEqual(s.exposure.topics, []);
    assert.deepEqual(s.behavior.topics, []);
    assert.deepEqual(s.alerts, []);
    assert.equal(s.behavior_cmp, null);
    assert.equal(s.goal_cmp, null);
    assert.equal(s.trend, null);
    assert.equal(s.exposure.top_source, null);
    assert.equal(s.exposure.entropy, 0);
    assert.deepEqual(s.window.page_contexts, { home: 0, video_related: 0, search: 0 });
    assert.ok(s.notes.length > 0);
  }
  assert.equal(buildSnapshot({}).generated_at, 0);
  assert.equal(buildSnapshot({ now: 0 }).generated_at, 0);
});

test("时间只来自 now：generated_at 与窗口区间都是传入值", () => {
  const s = snap({ items: techItems(), exposures: techExposures(20) });
  assert.equal(s.generated_at, NOW);
  assert.equal(s.window.end, NOW);
  assert.equal(s.window.start, NOW - 7 * DAY_MS);
  assert.equal(s.window.days, 7);
  const oneDay = snap({ items: techItems(), exposures: techExposures(20), windowDays: 1 });
  assert.equal(oneDay.window.days, 1);
  assert.equal(oneDay.window.start, NOW - DAY_MS);
});

test("窗口是半开区间 [start, end)", () => {
  const items = techItems();
  const start = NOW - 7 * DAY_MS;
  const exposures = [
    mkExposure("before", "i_tech", start - 1),
    mkExposure("at_start", "i_tech", start),
    mkExposure("inside", "i_tech", start + 1),
    mkExposure("last", "i_tech", NOW - 1),
    mkExposure("at_end", "i_tech", NOW),
  ];
  const s = snap({ items, exposures });
  assert.equal(s.window.exposure_count, 3);
  assert.equal(s.exposure.unique_items, 1);
});

test("多主题内容：权重和为 1，曝光分布按权重累加", () => {
  const items = [
    mkItem("i_mix", [{ t: "tech", w: 0.7 }, { t: "game", w: 0.3 }], { sourceId: "s1" }),
    mkItem("i_pure", [{ t: "tech", w: 1 }], { sourceId: "s2" }),
  ];
  const exposures = [...burst("m", "i_mix", 10), ...burst("p", "i_pure", 10, { sessionId: "s2" })];
  const s = snap({ items, exposures });
  const total = s.exposure.topics.reduce((acc, x) => acc + x.w, 0);
  assert.ok(Math.abs(total - 1) <= 1e-3, "主题权重和应为 1，实际 " + total);
  const tech = s.exposure.topics.find((x) => x.t === "tech");
  const game = s.exposure.topics.find((x) => x.t === "game");
  assert.ok(Math.abs(tech.w - 0.85) <= 1e-3);
  assert.ok(Math.abs(game.w - 0.15) <= 1e-3);
  assert.equal(tech.n, 20);
  assert.equal(game.n, 10);
});

test("未知主题：单独报告未知比例，不强行归类", () => {
  const items = [mkItem("i_unknown", [])];
  const s = snap({ items, exposures: burst("u", "i_unknown", 30) });
  assert.equal(s.window.unknown_topic_ratio, 1);
  assert.equal(s.window.known_topic_ratio, 0);
  assert.deepEqual(s.exposure.topics, []);
  assert.equal(s.exposure.available, false);
  assert.ok(s.notes.some((n) => n.includes("已知主题占比")));
  // 内容条目缺失同样按未知处理，不抛异常
  const missing = snap({ items: [], exposures: burst("m", "nope", 30) });
  assert.equal(missing.window.known_topic_ratio, 0);
});

test("门槛：样本量不足与未知比例过高都不出结论，notes 写清缺什么", () => {
  const few = snap({ items: techItems(), exposures: techExposures(5) });
  assert.equal(few.exposure.available, false);
  assert.deepEqual(few.alerts, []);
  assert.ok(few.notes.some((n) => n.includes("曝光样本 5 条，低于门槛 " + THRESHOLDS.minExposure)));

  const items = [
    mkItem("known", [{ t: "tech", w: 1 }]),
    mkItem("unknown", []),
  ];
  const exposures = [...burst("k", "known", 12), ...burst("u", "unknown", 18, { start: NOW - 2 * HOUR })];
  const s = snap({ items, exposures });
  assert.equal(s.window.known_topic_ratio, 0.4);
  assert.equal(s.exposure.available, false);
  // 主题相关规则不触发；只依赖曝光/来源计数的 repeat_heavy、source_concentration 仍可触发。
  const fired = s.alerts.map((a) => a.rule_id);
  for (const rule of ["output_concentration", "goal_gap", "behavior_gap", "narrowing"]) {
    assert.ok(!fired.includes(rule), rule + " 不应在主题不可用时触发");
  }
  assert.ok(s.notes.some((n) => n.includes("已知主题占比 0.4 低于门槛 " + THRESHOLDS.minKnownTopicRatio)));
});

test("无 goal：goal_cmp 为 null，且 notes 说明不评估 goal_gap", () => {
  const s = snap({ items: techItems(), exposures: techExposures(30) });
  assert.equal(s.goal.present, false);
  assert.equal(s.goal_cmp, null);
  assert.ok(s.notes.some((n) => n.includes("未设置目标") && n.includes("goal_gap")));
  // 有 goal_text 但目标主题为空（关键词一个都没命中且 intent 先验为空）同样不评估
  const emptyGoal = snap({
    items: techItems(),
    exposures: techExposures(30),
    goal: { goal_text: "随便看看", intent_mode: "relax", goal_topics: [], source: "fallback" },
  });
  assert.equal(emptyGoal.goal.present, true);
  assert.equal(emptyGoal.goal_cmp, null);
  assert.ok(emptyGoal.notes.some((n) => n.includes("目标未匹配到已知主题")));
});

test("无行为：behavior.available=false 且写明原因", () => {
  const s = snap({ items: techItems(), exposures: techExposures(30) });
  assert.equal(s.behavior.available, false);
  assert.equal(s.behavior.sample_n, 0);
  assert.equal(s.behavior.reason, "窗口内无行为记录");
  assert.equal(s.behavior_cmp, null);
  assert.ok(s.notes.some((n) => n.includes("behavior_gap") && n.includes("无行为记录")));
});

test("仅负反馈：不把负权重混进分布，行为画像仍判为不可用", () => {
  const actions = [];
  for (let i = 0; i < 6; i += 1) actions.push(mkAction("a" + i, "i_tech", "scroll_past", NOW - HOUR + i * MIN));
  const s = snap({ items: techItems(), exposures: techExposures(30), actions });
  assert.equal(s.behavior.available, false);
  assert.equal(s.behavior.sample_n, 0);
  assert.deepEqual(s.behavior.topics, []);
  assert.ok(s.behavior.reason.includes("负反馈"));
  assert.ok(s.notes.some((n) => n.includes("behavior_gap")));
});

test("行为不足与行为未知比例过高：分别给出对应原因", () => {
  const actions = [];
  for (let i = 0; i < 4; i += 1) actions.push(mkAction("a" + i, "i_tech", "open", NOW - HOUR + i * MIN, { sessionId: "s" + i }));
  const few = snap({ items: techItems(), exposures: techExposures(30), actions });
  assert.equal(few.behavior.available, false);
  assert.ok(few.behavior.reason.includes("低于门槛 " + THRESHOLDS.minBehavior));

  const items = [mkItem("i_tech", [{ t: "tech", w: 1 }]), mkItem("i_unknown", [])];
  const mixed = [];
  for (let i = 0; i < 10; i += 1) {
    mixed.push(mkAction("k" + i, "i_tech", "open", NOW - HOUR + i * MIN, { sessionId: "s" + i }));
    mixed.push(mkAction("u" + i, "i_unknown", "open", NOW - HOUR + i * MIN, { sessionId: "u" + i }));
  }
  const s = snap({ items, exposures: techExposures(30), actions: mixed });
  assert.equal(s.behavior.available, false);
  assert.ok(s.behavior.reason.includes("已知占比"));
});

test("同一会话同一内容合并为最高权重；不同会话分别计数", () => {
  const actions = [
    mkAction("a1", "i_tech", "open", NOW - HOUR),
    mkAction("a2", "i_tech", "like", NOW - HOUR + MIN),
    mkAction("a3", "i_tech", "favorite", NOW - HOUR + 2 * MIN),
  ];
  const merged = snap({ items: techItems(), exposures: techExposures(30), actions });
  assert.equal(merged.behavior.sample_n, 1, "同会话同内容只算一条合并行为");

  const split = snap({
    items: techItems(),
    exposures: techExposures(30),
    actions: [
      mkAction("b1", "i_tech", "open", NOW - HOUR, { sessionId: "s1" }),
      mkAction("b2", "i_tech", "like", NOW - HOUR + MIN, { sessionId: "s2" }),
    ],
  });
  assert.equal(split.behavior.sample_n, 2);
});

test("观看比例信号限制在 [0,1]，缺时长用中性比例", () => {
  const items = [mkItem("i_tech", [{ t: "tech", w: 1 }], { durationS: 600 }), mkItem("i_game", [{ t: "game", w: 1 }])];
  const exposures = [...burst("t", "i_tech", 20), ...burst("g", "i_game", 20, { start: NOW - 3 * HOUR })];
  const actions = [];
  for (let i = 0; i < 5; i += 1) {
    actions.push(mkAction("w" + i, "i_tech", "watch", NOW - HOUR + i * MIN, { sessionId: "w" + i, watchSeconds: 150 }));
  }
  for (let i = 0; i < 5; i += 1) {
    actions.push(mkAction("o" + i, "i_game", "open", NOW - HOUR + i * MIN, { sessionId: "o" + i }));
  }
  const s = snap({ items, exposures, actions });
  assert.equal(s.behavior.available, true);
  assert.equal(s.behavior.sample_n, 10);
  const tech = s.behavior.topics.find((x) => x.t === "tech");
  const game = s.behavior.topics.find((x) => x.t === "game");
  // 5 * 0.25 = 1.25 vs 5 * 1 = 5 -> tech 0.2 / game 0.8
  assert.ok(Math.abs(tech.w - 0.2) <= 1e-3, "实际 " + tech.w);
  assert.ok(Math.abs(game.w - 0.8) <= 1e-3, "实际 " + game.w);
});

test("窗口统计：page_contexts / session_count / action_count / unique_items", () => {
  const items = [mkItem("i1", [{ t: "tech", w: 1 }]), mkItem("i2", [{ t: "game", w: 1 }])];
  const exposures = [
    mkExposure("e1", "i1", NOW - HOUR, { sessionId: "s1", pageContext: "home" }),
    mkExposure("e2", "i2", NOW - HOUR + MIN, { sessionId: "s1", pageContext: "search" }),
    mkExposure("e3", "i1", NOW - HOUR + 2 * MIN, { sessionId: "s2", pageContext: "video_related" }),
    mkExposure("e4", "i1", NOW - HOUR + 3 * MIN, { sessionId: "s2", pageContext: "home" }),
  ];
  const actions = [
    mkAction("a1", "i1", "open", NOW - HOUR, { sessionId: "s3" }),
    mkAction("a2", "i1", "open", NOW - HOUR + MIN, { sessionId: "s3" }),
    mkAction("a3", "i1", "open", NOW - 9 * DAY, { sessionId: "s_old" }),
  ];
  const s = snap({ items, exposures, actions });
  // 观察条件按全部曝光统计（含搜索页）
  assert.deepEqual(s.window.page_contexts, { home: 2, video_related: 1, search: 1 });
  assert.equal(s.window.action_count, 2);
  assert.equal(s.window.session_count, 3);
  // 契约 §10.1：曝光画像 P 只算 home / video_related，搜索页单独计数
  assert.equal(s.window.exposure_count, 3);
  assert.equal(s.window.search_pull_count, 1);
  assert.equal(s.exposure.unique_items, 1);
  assert.equal(s.window.unique_items, 1);
});

test("来源集中：top_source 同分按来源 id 升序，share 的分母是已知来源曝光数", () => {
  const items = [
    mkItem("a1", [{ t: "tech", w: 1 }], { sourceId: "src_b", sourceName: "B" }),
    mkItem("a2", [{ t: "tech", w: 1 }], { sourceId: "src_a", sourceName: "A" }),
    mkItem("a3", [{ t: "game", w: 1 }], { sourceId: "src_c", sourceName: "C" }),
  ];
  const exposures = [
    ...burst("b", "a1", 10),
    ...burst("a", "a2", 10, { start: NOW - 2 * HOUR }),
    ...burst("c", "a3", 10, { start: NOW - 3 * HOUR }),
  ];
  const s = snap({ items, exposures });
  assert.equal(s.exposure.top_source.id, "src_a");
  assert.equal(s.exposure.top_source.name, "A");
  assert.equal(s.exposure.top_source.n, 10);
  assert.ok(Math.abs(s.exposure.top_source.share - 1 / 3) <= 1e-3);
  assert.equal(s.exposure.source_count, 3);
});

test("data_mode 由 origin 推导：real / synthetic / mixed / empty", () => {
  const items = techItems();
  assert.equal(snap({ items, exposures: burst("r", "i_tech", 20) }).data_mode, "real");
  assert.equal(snap({ items, exposures: burst("s", "i_tech", 20, { origin: "synthetic" }) }).data_mode, "synthetic");
  assert.equal(
    snap({ items, exposures: [...burst("r", "i_tech", 10), ...burst("s", "i_tech", 10, { start: NOW - 2 * HOUR, origin: "synthetic" })] }).data_mode,
    "mixed",
  );
  assert.equal(buildSnapshot({ now: NOW }).data_mode, "empty");
  // 曝光缺失 origin 时退回内容条目的 origin
  const synthItem = mkItem("i_tech", [{ t: "tech", w: 1 }], { origin: "synthetic" });
  const noOrigin = burst("n", "i_tech", 20).map((e) => ({ ...e, origin: undefined }));
  assert.equal(snap({ items: [synthItem], exposures: noOrigin }).data_mode, "synthetic");
});

test("趋势：前一窗口有足够样本才计算，prevWindow=false 时不计算", () => {
  const items = [
    mkItem("i_tech", [{ t: "tech", w: 1 }]),
    mkItem("i_game", [{ t: "game", w: 1 }]),
  ];
  const prev = [...burst("p1", "i_tech", 10, { start: NOW - 8 * DAY }), ...burst("p2", "i_game", 10, { start: NOW - 8 * DAY + HOUR })];
  const current = [...burst("c1", "i_tech", 10), ...burst("c2", "i_game", 10, { start: NOW - 2 * HOUR })];
  const s = snap({ items, exposures: [...prev, ...current] });
  assert.ok(s.trend);
  assert.ok(Math.abs(s.trend.prev_entropy - 0.301) <= 0.01);
  assert.ok(Math.abs(s.trend.entropy_delta - 0.0) <= 0.01);
  assert.ok(s.trend.prev_top_source_share !== null);

  const off = snap({ items, exposures: [...prev, ...current], prevWindow: false });
  assert.equal(off.trend, null);
  assert.ok(off.notes.some((n) => n.includes("prevWindow=false")));
});

test("非法记录被忽略而不是抛异常", () => {
  const s = buildSnapshot({
    now: NOW,
    items: [null, undefined, { content_id: null }],
    exposures: [null, { exposure_id: "no_time" }, { exposure_id: "no_content", exposed_at: NOW - MIN }],
    actions: [null, { action_id: "x" }],
    goal: null,
  });
  // 缺 content_id 且缺 page_context 的曝光无法归属，按契约 §10.1 不进曝光画像 P（但也不抛异常）
  assert.equal(s.window.exposure_count, 0);
  assert.equal(s.window.search_pull_count, 0);
  assert.equal(s.exposure.available, false);
  assert.deepEqual(s.alerts, []);
});

test("双跑同一输入逐字节一致（确定性）", () => {
  const input = {
    now: NOW,
    items: [mkItem("i1", [{ t: "tech", w: 0.6 }, { t: "game", w: 0.4 }]), mkItem("i2", [{ t: "study", w: 1 }])],
    exposures: [...burst("a", "i1", 15), ...burst("b", "i2", 15, { start: NOW - 2 * HOUR })],
    actions: [mkAction("x1", "i2", "open", NOW - HOUR), mkAction("x2", "i2", "like", NOW - 2 * HOUR)],
    goal: { goal_text: "备考", intent_mode: "exam", goal_topics: [{ t: "study", w: 1 }], source: "fallback" },
  };
  assert.equal(JSON.stringify(buildSnapshot(input)), JSON.stringify(buildSnapshot(input)));
  // 输入对象本身不被修改
  const before = JSON.stringify(input);
  buildSnapshot(input);
  assert.equal(JSON.stringify(input), before);
});

test("PAGE_CONTEXTS 之外的上下文：不成为统计键，也不计入曝光画像 P", () => {
  const exposures = burst("x", "i_tech", 20).map((e, i) => (i === 0 ? { ...e, page_context: "unknown_ctx" } : e));
  const s = snap({ items: techItems(), exposures });
  // 20 条里有 1 条上下文未知：它既不是已知上下文，也不属于 home/video_related，因此不进 P
  assert.equal(s.window.exposure_count, 19);
  assert.equal(s.window.page_contexts.home, 19);
  assert.equal(Object.keys(s.window.page_contexts).length, PAGE_CONTEXTS.length);
});

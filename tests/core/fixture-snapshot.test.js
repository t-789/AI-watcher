import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSnapshot } from "../../src/core/index.js";
import { DAY_MS, THRESHOLDS } from "../../src/core/constants.js";
import { fixturePath, parseReplay } from "../../src/adapters/replay/generate.js";

function replaySnapshot() {
  const input = parseReplay(readFileSync(fixturePath(), "utf8"));
  return { input, snapshot: buildSnapshot(input) };
}

test("14 日回放快照：曝光/行为画像可用，目标对照可算，至少触发一条提醒", () => {
  const { snapshot } = replaySnapshot();
  assert.equal(snapshot.data_mode, "synthetic");
  assert.equal(snapshot.exposure.available, true, "exposure.available 应为 true");
  assert.equal(snapshot.behavior.available, true, "behavior.available 应为 true");
  assert.ok(snapshot.goal.present);
  assert.ok(snapshot.goal_cmp, "goal_cmp 不应为 null");
  assert.notEqual(snapshot.goal_cmp.D, null, "goal_cmp.D 不应为 null");
  assert.ok(snapshot.behavior_cmp && typeof snapshot.behavior_cmp.D === "number");
  assert.ok(snapshot.alerts.length >= 1, "至少一条提醒");
  assert.ok(snapshot.trend, "14 天数据应能算出前一个可比窗口");
  assert.ok(snapshot.window.exposure_count >= THRESHOLDS.minExposure);
  assert.ok(snapshot.window.known_topic_ratio >= THRESHOLDS.minKnownTopicRatio);

  // 快照只覆盖窗口内的曝光
  const start = snapshot.window.start;
  const end = snapshot.window.end;
  const inWindow = parseReplay(readFileSync(fixturePath(), "utf8")).exposures.filter((e) => e.exposed_at >= start && e.exposed_at < end);
  // 契约 §10.1：曝光计数只算 home / video_related；搜索页拉取单独计入 search_pull_count
  const pInWindow = inWindow.filter((e) => e.page_context === "home" || e.page_context === "video_related");
  assert.equal(snapshot.window.exposure_count, pInWindow.length, "曝光计数应为 P 口径（不含搜索页）");
  assert.equal(snapshot.window.search_pull_count, inWindow.length - pInWindow.length, "搜索页拉取必须单独计数");
  assert.ok(snapshot.window.page_contexts.search > 0, "fixtures 里应该有搜索页曝光，否则这条口径没被覆盖");

  // 每条提醒都带来可回溯证据
  for (const alert of snapshot.alerts) {
    assert.ok(alert.evidence.length > 0, alert.rule_id + " 缺少证据");
  }
});

test("14 日回放快照：规则集合稳定（回归基线）", () => {
  const { snapshot } = replaySnapshot();
  assert.deepEqual(
    snapshot.alerts.map((a) => a.rule_id),
    ["output_concentration", "goal_gap", "repeat_heavy", "source_concentration", "narrowing"],
  );
  assert.equal(snapshot.exposure.entropy < THRESHOLDS.outputConcentrationEntropy, true);
  assert.equal(snapshot.exposure.repeat_rate > THRESHOLDS.repeatRate, true);
  assert.equal(snapshot.exposure.top_source.share > THRESHOLDS.topSourceShare, true);
  assert.equal(snapshot.trend.entropy_delta < -THRESHOLDS.narrowingEntropyDrop, true);
  // behavior_gap 在这里正确地不触发：行为与曝光的差异很小（同步集中，不是"行为落后于输出"）
  assert.ok(snapshot.behavior_cmp.D <= THRESHOLDS.gapDistance, "behavior_cmp.D=" + snapshot.behavior_cmp.D);
  assert.equal(snapshot.alerts.some((a) => a.rule_id === "behavior_gap"), false);
});

test("空输入：data_mode=empty、available 全 false、alerts=[]（验收 6）", () => {
  const empty = buildSnapshot({ items: [], exposures: [], actions: [], goal: null, now: 1794729600000 });
  assert.equal(empty.data_mode, "empty");
  assert.equal(empty.exposure.available, false);
  assert.equal(empty.behavior.available, false);
  assert.deepEqual(empty.alerts, []);
  assert.equal(empty.goal_cmp, null);
  assert.equal(empty.window.start, 1794729600000 - 7 * DAY_MS);
});

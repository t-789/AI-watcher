import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DAY_MS } from "../../src/core/constants.js";
import {
  FIXTURE_NOW,
  REPLAY_DAYS,
  REPLAY_SEED,
  REPLAY_START_MS,
  SCENARIOS,
  buildRecords,
  fixturePath,
  generateJSONL,
  mulberry32,
  parseReplay,
  toJSONL,
} from "../../src/adapters/replay/generate.js";

const text = readFileSync(fixturePath(), "utf8");
const lines = text.split("\n").filter((line) => line.trim());
const input = parseReplay(text);

test("回放日志：14 个虚拟日、≥600 条曝光，行类型只有契约里的四种", () => {
  assert.ok(lines.length > input.exposures.length, "每行一条记录");
  assert.ok(input.exposures.length >= 600, "曝光条数 " + input.exposures.length);
  const types = new Set(lines.map((line) => JSON.parse(line).type));
  assert.deepEqual([...types].sort(), ["action", "exposure", "goal", "item"]);
  const days = new Set(input.exposures.map((e) => Math.floor((e.exposed_at - REPLAY_START_MS) / DAY_MS)));
  assert.equal(days.size, REPLAY_DAYS);
  assert.equal(Math.min(...days), 0);
  assert.equal(Math.max(...days), REPLAY_DAYS - 1);
});

test("回放日志：全部标记 origin=synthetic，绝不冒充真实观察", () => {
  for (const record of [...input.items, ...input.exposures, ...input.actions]) {
    assert.equal(record.origin, "synthetic", record.content_id + " / " + record.exposure_id);
  }
  assert.equal(input.items.every((item) => item.platform === "bilibili"), true);
});

test("回放日志：≥4 个场景（正常 / 重复加重 / 同步集中 / 目标改变后输出未变 / 收窄）", () => {
  const tags = new Set(input.exposures.map((e) => String(e.exposure_id).split("_")[1]));
  assert.ok(tags.size >= 4, "场景标签 " + [...tags].join(","));
  for (const [scenario, tag] of [["normal", "norm"], ["repeat_heavy", "rep"], ["sync_concentration", "sync"], ["goal_shift_output_unchanged", "goal"], ["narrowing", "narrow"]]) {
    assert.ok(SCENARIOS.includes(scenario));
    assert.ok(tags.has(tag), "缺少场景 " + scenario);
  }
});

test("回放日志：时间单调递增、落在虚拟时钟上，goal 有三版且取最新一版", () => {
  let last = Number.NEGATIVE_INFINITY;
  for (const record of lines) {
    const parsed = JSON.parse(record);
    if (parsed.type !== "exposure") continue;
    assert.ok(parsed.exposed_at >= last, "曝光时间应单调递增");
    assert.ok(parsed.exposed_at < FIXTURE_NOW, "曝光必须早于 now");
    assert.ok(parsed.exposed_at >= REPLAY_START_MS);
    last = parsed.exposed_at;
  }
  assert.ok(input.goal);
  assert.equal(input.goal.version, 3);
  assert.equal(input.goal.intent_mode, "exam");
  const goalLines = lines.map((l) => JSON.parse(l)).filter((r) => r.type === "goal");
  assert.equal(goalLines.length, 3);
  assert.deepEqual(goalLines.map((g) => g.version), [1, 2, 3]);
});

test("回放日志：内容条目结构完整，多主题权重和为 1，含未知主题条目", () => {
  let multi = 0;
  let unknown = 0;
  for (const item of input.items) {
    for (const key of ["content_id", "canonical_key", "title", "url", "source_id", "source_name", "topics", "origin"]) {
      assert.ok(key in item, "缺少字段 " + key);
    }
    if (item.topics.length === 0) {
      unknown += 1;
      continue;
    }
    if (item.topics.length > 1) multi += 1;
    const total = item.topics.reduce((acc, t) => acc + t.w, 0);
    assert.ok(Math.abs(total - 1) <= 1e-9, item.content_id + " 主题权重和 " + total);
  }
  assert.ok(multi > 0, "应包含多主题内容");
  assert.ok(unknown > 0, "应包含未知主题内容");
});

test("回放日志：行为能指回真实曝光与内容", () => {
  const exposureIds = new Set(input.exposures.map((e) => e.exposure_id));
  const contentIds = new Set(input.items.map((i) => i.content_id));
  const types = new Set(["open", "watch", "like", "coin", "favorite", "search", "scroll_past"]);
  for (const action of input.actions) {
    assert.ok(types.has(action.action_type), action.action_type);
    if (action.content_id) assert.ok(contentIds.has(action.content_id));
    if (action.exposure_id) assert.ok(exposureIds.has(action.exposure_id));
    if (action.action_type === "search") assert.ok(action.topic_id && !action.content_id);
  }
});

test("固定种子：同一 seed 逐字节相同，不同 seed 不同", () => {
  const a = generateJSONL();
  const b = generateJSONL();
  assert.equal(a, b);
  assert.equal(a, toJSONL(buildRecords().records));
  assert.equal(a, text);
  const other = generateJSONL({ seed: REPLAY_SEED + 1 });
  assert.notEqual(other, a);
});

test("mulberry32：确定性且值域在 [0,1)", () => {
  const first = mulberry32(123);
  const second = mulberry32(123);
  for (let i = 0; i < 100; i += 1) {
    const value = first();
    assert.equal(value, second());
    assert.ok(value >= 0 && value < 1);
  }
  const third = mulberry32(124);
  assert.notEqual(mulberry32(123)(), third());
});

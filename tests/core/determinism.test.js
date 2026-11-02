import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSnapshot } from "../../src/core/index.js";
import { generateJSONL, parseReplay, fixturePath, FIXTURE_NOW } from "../../src/adapters/replay/generate.js";
import { DAY, HOUR, MIN, NOW, burst, mkAction, mkItem, mulberry32 } from "./helpers.js";

function smallInput() {
  return {
    now: NOW,
    items: [
      mkItem("i1", [{ t: "tech", w: 0.7 }, { t: "game", w: 0.3 }], { sourceId: "s1" }),
      mkItem("i2", [{ t: "study", w: 1 }], { sourceId: "s2" }),
      mkItem("i3", [], { sourceId: "s3" }),
    ],
    exposures: [...burst("a", "i1", 12), ...burst("b", "i2", 10, { start: NOW - 2 * HOUR }), ...burst("c", "i3", 3, { start: NOW - 3 * HOUR })],
    actions: [
      mkAction("x1", "i2", "open", NOW - HOUR, { sessionId: "s9" }),
      mkAction("x2", "i2", "like", NOW - HOUR + MIN, { sessionId: "s9" }),
      mkAction("x3", "i1", "watch", NOW - 2 * HOUR, { sessionId: "s8", watchSeconds: 120 }),
      mkAction("x4", "i1", "scroll_past", NOW - 3 * HOUR, { sessionId: "s7" }),
    ],
    goal: { goal_text: "备考", intent_mode: "exam", goal_topics: [{ t: "study", w: 0.8 }, { t: "science", w: 0.2 }], source: "fallback" },
  };
}

test("同一输入跑两次：JSON 逐字节相同", () => {
  const input = smallInput();
  const first = JSON.stringify(buildSnapshot(input));
  const second = JSON.stringify(buildSnapshot(input));
  assert.equal(first, second);
  assert.ok(first.length > 100);
});

test("不读系统时钟：把 Date.now 改成任意值，输出不变", () => {
  const input = smallInput();
  const realNow = Date.now;
  let a = "";
  let b = "";
  try {
    Date.now = () => 0;
    a = JSON.stringify(buildSnapshot(input));
    Date.now = () => 4102444800000;
    b = JSON.stringify(buildSnapshot(input));
  } finally {
    Date.now = realNow;
  }
  assert.equal(a, b);
  assert.equal(buildSnapshot(input).generated_at, input.now);
});

test("与输入顺序无关：打乱 items/exposures/actions 顺序后仍逐字节相同", () => {
  const input = smallInput();
  const baseline = JSON.stringify(buildSnapshot(input));
  const rng = mulberry32(42);
  const shuffle = (list) => {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy;
  };
  const shuffled = {
    ...input,
    items: shuffle(input.items),
    exposures: shuffle(input.exposures),
    actions: shuffle(input.actions),
  };
  assert.equal(JSON.stringify(buildSnapshot(shuffled)), baseline);
});

test("14 日回放：两次 buildSnapshot 逐字节相同", () => {
  const text = readFileSync(fixturePath(), "utf8");
  const first = JSON.stringify(buildSnapshot(parseReplay(text)));
  const second = JSON.stringify(buildSnapshot(parseReplay(text)));
  assert.equal(first, second);
  assert.equal(parseReplay(text).now, FIXTURE_NOW);
});

test("同一 seed 重新生成回放日志：与仓库里的 fixtures 文件逐字节相同", () => {
  const committed = readFileSync(fixturePath(), "utf8");
  assert.equal(generateJSONL(), committed);
  assert.equal(generateJSONL(), generateJSONL());
});

test("窗口参数变化时仍然确定（近 1 天视图）", () => {
  const text = readFileSync(fixturePath(), "utf8");
  const input = { ...parseReplay(text), windowDays: 1 };
  assert.equal(JSON.stringify(buildSnapshot(input)), JSON.stringify(buildSnapshot(input)));
});

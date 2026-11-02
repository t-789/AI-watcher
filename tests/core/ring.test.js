import test from "node:test";
import assert from "node:assert/strict";
import { RingWindow } from "../../src/core/ring.js";
import { mulberry32, naiveCounts } from "./helpers.js";

const keysOf = (record) => record.keys;
const makeWindow = (capacity) => new RingWindow({ capacity, timeOf: (r) => r.at, keysOf });

function assertCountsMatch(actual, expected, label) {
  const keys = new Set([...actual.keys(), ...expected.keys()]);
  for (const key of keys) {
    const a = actual.get(key) ?? 0;
    const b = expected.get(key) ?? 0;
    assert.ok(a >= 0, label + "：计数不得为负 key=" + key + " 值=" + a);
    assert.ok(Math.abs(a - b) <= 1e-9, label + "：key=" + key + " 期望 " + b + " 实际 " + a);
  }
  for (const [key, value] of actual) assert.ok(value > 0, label + "：零/负计数应被删除 key=" + key);
}

test("空队列：任何查询都不抛异常且返回中性值", () => {
  const win = makeWindow(4);
  assert.equal(win.size, 0);
  assert.equal(win.capacity, 4);
  assert.equal(win.first(), undefined);
  assert.equal(win.last(), undefined);
  assert.equal(win.at(0), undefined);
  assert.deepEqual(win.toArray(), []);
  assert.equal(win.countOf("a"), 0);
  assert.equal(win.totalWeight(), 0);
  assert.equal(win.evictBefore(1000), 0);
  assert.equal(win.clear(), 0);
  assert.deepEqual(win.toCountObject(), {});
});

test("绕回与扩容：容量 4 塞入 11 条，顺序与计数都正确", () => {
  const win = makeWindow(4);
  for (let i = 1; i <= 11; i += 1) {
    win.push({ at: i, keys: [{ key: "a", weight: 1 }, { key: "t" + (i % 3), weight: 0.5 }] });
  }
  assert.equal(win.size, 11);
  assert.ok(win.capacity >= 11);
  assert.deepEqual(win.toArray().map((r) => r.at), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(win.countOf("a"), 11);
  assert.equal(win.countOf("t0"), 1.5);
  assertCountsMatch(win.counts, naiveCounts(win.toArray(), keysOf), "扩容后");
});

test("同时间戳：按 at 而非序号判断过期", () => {
  const win = makeWindow(3);
  for (let i = 0; i < 5; i += 1) win.push({ at: 1000, keys: [{ key: "a", weight: 1 }] });
  assert.equal(win.countOf("a"), 5);
  assert.equal(win.evictBefore(1000), 0);
  assert.equal(win.evictBefore(1001), 5);
  assert.equal(win.size, 0);
  assert.equal(win.counts.has("a"), false);
});

test("窗口边界是半开区间 [start, end)：at == start 保留，at == end 由收集侧排除", () => {
  const win = makeWindow(4);
  const recs = [900, 1000, 1099, 1100].map((at) => ({ at, keys: [{ key: "k" + at, weight: 1 }] }));
  for (const record of recs) win.push(record);
  assert.equal(win.evictBefore(1000), 1);
  assert.deepEqual(win.toArray().map((r) => r.at), [1000, 1099, 1100]);
  assert.equal(win.evictBefore(1100), 2);
  assert.deepEqual(win.toArray().map((r) => r.at), [1100]);
  assert.equal(win.countOf("k900"), 0);
  assert.equal(win.countOf("k1000"), 0);
  assert.equal(win.countOf("k1100"), 1);
});

test("批量过期：一次移出 60 条，计数按条扣减", () => {
  const win = makeWindow(8);
  for (let i = 0; i < 100; i += 1) win.push({ at: i * 10, keys: [{ key: "even", weight: i % 2 === 0 ? 1 : 0 }] });
  assert.equal(win.countOf("even"), 50);
  assert.equal(win.evictBefore(600), 60);
  assert.equal(win.size, 40);
  assert.equal(win.countOf("even"), 20);
  assertCountsMatch(win.counts, naiveCounts(win.toArray(), keysOf), "批量过期后");
});

test("小数权重：反复入窗出窗后计数不为负、也不留零值键", () => {
  const win = makeWindow(2);
  for (let round = 0; round < 50; round += 1) {
    win.push({ at: round * 100, keys: [{ key: "w", weight: 0.1 }, { key: "w", weight: 0.2 }] });
    win.push({ at: round * 100 + 1, keys: [{ key: "w", weight: 0.7 }] });
    win.evictBefore(round * 100 + 1);
  }
  for (const [, value] of win.counts) assert.ok(value > 0, "不能留下零或负计数");
  assert.ok(Math.abs(win.countOf("w") - 0.7) < 1e-9);
  win.evictBefore(Number.MAX_SAFE_INTEGER);
  assert.equal(win.counts.size, 0);
});

test("10^4 条随机操作：环形队列与朴素全量重扫逐步一致", () => {
  const rng = mulberry32(20261102);
  const win = makeWindow(3);
  let alive = [];
  let now = 0;
  const keySpace = ["a", "b", "c", "d", "e"];

  for (let step = 0; step < 10000; step += 1) {
    const roll = rng();
    if (roll < 0.6) {
      now += Math.floor(rng() * 3) * 5; // 会重复出现相同时间戳
      const keys = [];
      const keyCount = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < keyCount; i += 1) {
        const key = keySpace[Math.floor(rng() * keySpace.length)];
        const weight = rng() < 0.5 ? 1 : Math.round(rng() * 1000) / 1000;
        keys.push({ key, weight });
      }
      const record = { at: now, keys };
      win.push(record);
      alive.push(record);
    } else if (roll < 0.85) {
      const start = now - Math.floor(rng() * 40);
      const before = alive.length;
      const removed = win.evictBefore(start);
      alive = alive.filter((r) => r.at >= start);
      assert.equal(removed, before - alive.length, "第 " + step + " 步：过期条数应与朴素过滤一致");
    } else {
      assert.equal(win.size, alive.length, "第 " + step + " 步：size 与朴素存活数一致");
    }
    assert.equal(win.size, alive.length, "第 " + step + " 步：size");
    assertCountsMatch(win.counts, naiveCounts(alive, keysOf), "第 " + step + " 步");
  }
  assert.ok(alive.length > 0);
});

import test from "node:test";
import assert from "node:assert/strict";
import { topK } from "../../src/core/heap.js";
import { mulberry32, fullSortTop } from "./helpers.js";

const ids = (list) => list.map((x) => (x && typeof x === "object" ? x.content_id : x));

test("k = 0 与空集合：返回空数组", () => {
  const cands = [{ content_id: "a", s: 3 }];
  assert.deepEqual(topK(cands, 0, (x) => x.s), []);
  assert.deepEqual(topK([], 3, (x) => x.s), []);
  assert.deepEqual(topK(null, 3, (x) => x.s), []);
  assert.deepEqual(topK(cands, -2, (x) => x.s), []);
  assert.deepEqual(topK(cands, Number.NaN, (x) => x.s), []);
});

test("候选少于 k：全部返回且按分数降序", () => {
  const cands = [
    { content_id: "a", s: 1 },
    { content_id: "b", s: 5 },
    { content_id: "c", s: 3 },
  ];
  assert.deepEqual(ids(topK(cands, 10, (x) => x.s)), ["b", "c", "a"]);
});

test("同分按稳定键升序，与候选顺序无关", () => {
  const cands = [
    { content_id: "c", s: 1 },
    { content_id: "a", s: 1 },
    { content_id: "b", s: 1 },
  ];
  assert.deepEqual(ids(topK(cands, 3, (x) => x.s)), ["a", "b", "c"]);
  assert.deepEqual(ids(topK(cands.slice().reverse(), 3, (x) => x.s)), ["a", "b", "c"]);
});

test("tieKey 优先于 content_id，用于更细的稳定次序", () => {
  const cands = [
    { content_id: "x", tieKey: "002", s: 1 },
    { content_id: "x", tieKey: "001", s: 1 },
  ];
  assert.deepEqual(topK(cands, 2, (x) => x.s).map((x) => x.tieKey), ["001", "002"]);
});

test("负数与 NaN 分数：NaN 视为最小，不抛异常", () => {
  const cands = [
    { content_id: "a", s: -5 },
    { content_id: "b", s: Number.NaN },
    { content_id: "c", s: -1 },
  ];
  assert.deepEqual(ids(topK(cands, 2, (x) => x.s)), ["c", "a"]);
});

test("不修改输入数组", () => {
  const cands = [
    { content_id: "a", s: 2 },
    { content_id: "b", s: 1 },
    { content_id: "c", s: 3 },
  ];
  const snapshot = JSON.stringify(cands);
  topK(cands, 2, (x) => x.s);
  assert.equal(JSON.stringify(cands), snapshot);
});

test("10^3 组随机用例：与全排序前 k 完全一致（含 k=0、k>C、同分）", () => {
  const rng = mulberry32(987654321);
  for (let round = 0; round < 1000; round += 1) {
    const size = 1 + Math.floor(rng() * 60);
    const k = Math.floor(rng() * (size + 4));
    const cands = [];
    for (let i = 0; i < size; i += 1) {
      cands.push({ content_id: "c" + String(i).padStart(3, "0"), s: Math.floor(rng() * 8) });
    }
    const scoreFn = (item) => item.s;
    assert.deepEqual(ids(topK(cands, k, scoreFn)), ids(fullSortTop(cands, k, scoreFn)), "第 " + round + " 组 size=" + size + " k=" + k);
  }
});

test("10^4 候选、k=3：堆结果与全排序一致", () => {
  const rng = mulberry32(7);
  const cands = [];
  for (let i = 0; i < 10000; i += 1) cands.push({ content_id: "c" + i, s: Math.floor(rng() * 1000) });
  const scoreFn = (item) => item.s;
  const fast = ids(topK(cands, 3, scoreFn));
  const slow = ids(fullSortTop(cands, 3, scoreFn));
  assert.deepEqual(fast, slow);
});

import test from "node:test";
import assert from "node:assert/strict";
import { distance, entropy, repeatRate, toTopicArray, normalizeDist, itemTopics } from "../../src/core/metrics.js";
import { TOPICS } from "../../src/core/constants.js";
import { mkItem } from "./helpers.js";

test("entropy：空输入与单主题都是 0", () => {
  assert.equal(entropy([]), 0);
  assert.equal(entropy(undefined), 0);
  assert.equal(entropy([{ t: "tech", w: 1 }]), 0);
  assert.equal(entropy([{ t: "tech", w: 0 }, { t: "game", w: 0 }]), 0);
});

test("entropy：10 主题均匀 -> 1，2 主题均匀 -> ln2/ln10", () => {
  const uniform = TOPICS.map((t) => ({ t, w: 1 }));
  assert.equal(entropy(uniform), 1);
  const two = [{ t: "tech", w: 0.5 }, { t: "game", w: 0.5 }];
  assert.ok(Math.abs(entropy(two) - 0.301) < 0.001);
});

test("entropy：未归一化输入会先归一化，未知主题与负权重被忽略", () => {
  const raw = [{ t: "tech", w: 7 }, { t: "game", w: 3 }, { t: "unknown_topic", w: 5 }, { t: "music", w: -1 }];
  const normalized = [{ t: "tech", w: 0.7 }, { t: "game", w: 0.3 }];
  assert.equal(entropy(raw), entropy(normalized));
});

test("distance：同分布为 0，完全不相交为 1，范围恒在 [0,1]", () => {
  const a = [{ t: "tech", w: 1 }];
  assert.equal(distance(a, a), 0);
  assert.equal(distance(a, [{ t: "game", w: 1 }]), 1);
  assert.equal(distance([{ t: "tech", w: 0.5 }, { t: "game", w: 0.5 }], [{ t: "tech", w: 1 }]), 0.5);
  const d = distance([{ t: "tech", w: 0.7 }, { t: "news", w: 0.3 }], [{ t: "game", w: 0.6 }, { t: "news", w: 0.4 }]);
  assert.ok(d > 0 && d <= 1);
});

test("distance：任一方未知（无已知主题）-> null，而不是 0 或 1", () => {
  assert.equal(distance([], [{ t: "tech", w: 1 }]), null);
  assert.equal(distance([{ t: "tech", w: 1 }], []), null);
  assert.equal(distance([], []), null);
  assert.equal(distance(null, undefined), null);
  assert.equal(distance([{ t: "unknown_topic", w: 1 }], [{ t: "tech", w: 1 }]), null);
});

test("repeatRate：空输入 0，全不重复 0，全同 1-1/n，canonical_key 相同视为重复", () => {
  assert.equal(repeatRate([], []), 0);
  const items = [
    mkItem("a", [{ t: "tech", w: 1 }], { canonicalKey: "ck_a" }),
    mkItem("b", [{ t: "tech", w: 1 }], { canonicalKey: "ck_b" }),
  ];
  const exposures = [
    { exposure_id: "e1", content_id: "a" },
    { exposure_id: "e2", content_id: "b" },
  ];
  assert.equal(repeatRate(exposures, items), 0);
  assert.equal(repeatRate([{ content_id: "a" }, { content_id: "a" }, { content_id: "a" }, { content_id: "a" }], items), 0.75);
  // 同内容不同链接变体：canonical_key 相同，重复率仍能识别
  const variants = [
    mkItem("v1", [{ t: "tech", w: 1 }], { canonicalKey: "same" }),
    mkItem("v2", [{ t: "tech", w: 1 }], { canonicalKey: "same" }),
  ];
  assert.equal(repeatRate([{ content_id: "v1" }, { content_id: "v2" }], variants), 0.5);
  // 内容条目缺失时退回 content_id
  assert.equal(repeatRate([{ content_id: "zzz" }, { content_id: "zzz" }], items), 0.5);
});

test("normalizeDist / itemTopics：空 topics 视为未知", () => {
  assert.equal(normalizeDist([]).size, 0);
  assert.equal(itemTopics({ topics: [] }), null);
  assert.equal(itemTopics({}), null);
  assert.equal(itemTopics(null), null);
  const multi = itemTopics({ topics: [{ t: "tech", w: 2 }, { t: "game", w: 2 }] });
  assert.equal(multi.size, 2);
  assert.equal(multi.get("tech"), 0.5);
});

test("toTopicArray：按权重降序、同分按主题表顺序", () => {
  const out = toTopicArray(new Map([["game", 0.5], ["tech", 0.3], ["news", 0.2]]), "w");
  assert.deepEqual(out.map((x) => x.t), ["game", "tech", "news"]);
  const tie = toTopicArray(new Map([["news", 0.5], ["tech", 0.5]]), "w");
  assert.deepEqual(tie.map((x) => x.t), ["tech", "news"]);
});

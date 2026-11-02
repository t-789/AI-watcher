import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalizeUrl, contentIdFor, exposureIdFor, observationFor } from "../../src/server/app.js";

const sha1 = (text) => createHash("sha1").update(text).digest("hex");

test("canonicalizeUrl 把 B 站同一视频的不同入口归并成一个 canonical_key", () => {
  const variants = [
    "https://www.bilibili.com/video/BV1GJ411x7h7",
    "https://www.bilibili.com/video/BV1GJ411x7h7/",
    "https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.337.search-card.all.click",
    "https://www.bilibili.com/video/BV1GJ411x7h7?vd_source=abc123&from_source=webtop_search&spm_id_from=333.788",
    "https://m.bilibili.com/video/BV1GJ411x7h7",
    "https://www.bilibili.com/video/BV1GJ411x7h7/#reply",
    "https://www.bilibili.com/video/BV1GJ411x7h7?p=2&share_source=copy_web",
    "https://www.bilibili.com/video/BV1GJ411x7h7?t=42",
  ];
  const keys = new Set(variants.map(canonicalizeUrl));
  assert.equal(keys.size, 1, "变体应归并为一个 key，实得 " + JSON.stringify([...keys]));
  assert.equal([...keys][0], "bilibili.com/video/BV1GJ411x7h7");
});

test("canonicalizeUrl 保留区分内容的参数并抹掉追踪参数", () => {
  assert.equal(canonicalizeUrl("https://www.bilibili.com/video/av170001"), "bilibili.com/video/av170001");
  assert.notEqual(canonicalizeUrl("https://www.bilibili.com/video/BV1GJ411x7h7"), canonicalizeUrl("https://www.bilibili.com/video/BV1GJ411x7h8"));
  assert.notEqual(canonicalizeUrl("https://search.bilibili.com/all?keyword=AI"), canonicalizeUrl("https://search.bilibili.com/all?keyword=%E6%B8%B8%E6%88%8F"));
  assert.equal(canonicalizeUrl("https://search.bilibili.com/all?keyword=AI&spm_id_from=333.1007&vd_source=x"), "search.bilibili.com/all?keyword=AI");
  assert.equal(canonicalizeUrl(""), "");
  assert.equal(canonicalizeUrl(undefined), "");
});

test("参数顺序不影响 canonical_key", () => {
  const a = canonicalizeUrl("https://space.bilibili.com/1?x=1&y=2");
  const b = canonicalizeUrl("https://space.bilibili.com/1?y=2&x=1");
  assert.equal(a, b);
});

test("content_id = sha1(platform + canonical_key)", () => {
  assert.equal(contentIdFor("bilibili", "bilibili.com/video/BV1GJ411x7h7"), sha1("bilibili" + "bilibili.com/video/BV1GJ411x7h7"));
});

test("exposure_id = sha1(session_id|content_id|page_context|visit_seq)", () => {
  assert.equal(exposureIdFor("s1", "c1", "home", 1), sha1("s1|c1|home|1"));
  assert.notEqual(exposureIdFor("s1", "c1", "home", 1), exposureIdFor("s1", "c1", "home", 2));
  assert.notEqual(exposureIdFor("s1", "c1", "home", 1), exposureIdFor("s2", "c1", "home", 1));
  assert.notEqual(exposureIdFor("s1", "c1", "home", 1), exposureIdFor("s1", "c1", "search", 1));
});

test("observationFor 截断 desc/comments 并落 annotation=pending", () => {
  const observation = observationFor(
    {
      title: "  标题  ",
      url: "https://www.bilibili.com/video/BV1GJ411x7h7",
      author: "UP",
      author_id: 42,
      desc: "x".repeat(2000),
      comments: Array.from({ length: 12 }, (_, index) => "comment-" + index),
    },
    { origin: "real", at: 1700000000000 },
  );
  assert.equal(observation.title, "标题");
  assert.equal([...observation.desc].length, 800);
  assert.equal(observation.comments.length, 8);
  assert.deepEqual(observation.annotation, { status: "pending", model: null, at: null });
  assert.equal(observation.platform, "bilibili");
  assert.equal(observation.source_id, "42");
  assert.equal(observation.fetched_at, 1700000000000);
  assert.deepEqual(observation.topics, []);
});

test("observationFor 没有 url 时返回 null（无法算 canonical_key 就不落库）", () => {
  assert.equal(observationFor({ title: "没有链接" }, { origin: "real", at: 1 }), null);
});

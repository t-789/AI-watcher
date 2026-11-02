import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeUrl,
  extractHomeFeed,
  extractSearch,
  extractVideoPage,
  parseCount,
  parseDuration,
} from "../../src/adapters/bilibili/extract.js";

test("canonicalizeUrl 把同一内容的不同链接变体收敛成同一个键", () => {
  const want = "https://www.bilibili.com/video/BV1wcxi6zEsG/";
  assert.equal(canonicalizeUrl("//www.bilibili.com/video/BV1wcxi6zEsG/?spm_id_from=333.788&vd_source=abc"), want);
  assert.equal(canonicalizeUrl("https://www.bilibili.com/video/BV1wcxi6zEsG"), want);
  assert.equal(canonicalizeUrl("https://m.bilibili.com/video/BV1wcxi6zEsG?p=1"), want);
  assert.equal(canonicalizeUrl("/video/BV1wcxi6zEsG/"), want);
  assert.equal(canonicalizeUrl("https://www.bilibili.com/festival/S16?bvid=BV1wcxi6zEsG"), want);
});

test("canonicalizeUrl 对无法解析的输入返回空串而不是抛错", () => {
  assert.equal(canonicalizeUrl(""), "");
  assert.equal(canonicalizeUrl(null), "");
  assert.equal(canonicalizeUrl("not a url"), "");
  assert.equal(canonicalizeUrl("https://example.com/a/?b=1"), "https://example.com/a");
});

test("parseCount 解析中文计数，无法解析时返回 null（不猜 0）", () => {
  assert.equal(parseCount("44.8万"), 448000);
  assert.equal(parseCount("1.2亿"), 120000000);
  assert.equal(parseCount("3,456"), 3456);
  assert.equal(parseCount("10万+"), 100000);
  assert.equal(parseCount("651"), 651);
  assert.equal(parseCount("-"), null);
  assert.equal(parseCount("暂无"), null);
  assert.equal(parseCount(null), null);
});

test("parseDuration 解析时长", () => {
  assert.equal(parseDuration("01:37"), 97);
  assert.equal(parseDuration("1:02:03"), 3723);
  assert.equal(parseDuration("28:26"), 1706);
  assert.equal(parseDuration("3分20秒"), 200);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("直播"), null);
});

test("extract* 对缺失 / 非 DOM 输入返回空结构", () => {
  assert.deepEqual(extractHomeFeed(undefined), []);
  assert.deepEqual(extractSearch(undefined), []);
  const page = extractVideoPage(undefined);
  assert.deepEqual(page.comments, []);
  assert.deepEqual(page.related, []);
  assert.equal(page.title, "");
});

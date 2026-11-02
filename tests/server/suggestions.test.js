import test from "node:test";
import assert from "node:assert/strict";
import { createLabeler } from "../../src/server/labeler.js";
import { createFakeStore, fakeSnapshot } from "./_helpers.mjs";

const NOW = 1700000000000;

function item(id, topics, extra = {}) {
  return {
    content_id: id,
    platform: "bilibili",
    canonical_key: id,
    title: "标题-" + id,
    url: "https://www.bilibili.com/video/" + id,
    source_id: "up-" + id,
    source_name: "UP-" + id,
    topics: topics.map((t) => ({ t, w: 1 })),
    annotation: { status: "ai" },
    origin: "real",
    ...extra,
  };
}

function exposure(contentId, at = NOW - 1000) {
  return {
    exposure_id: "exp-" + contentId + "-" + at,
    content_id: contentId,
    exposed_at: at,
    session_id: "s1",
    page_context: "home",
    origin: "real",
  };
}

function build({ items = [], exposures = [], suggestions = [], snapshot = {} }) {
  const store = createFakeStore();
  for (const entry of items) store.upsertItem(entry);
  for (const entry of exposures) store.addExposure(entry);
  const ai = {
    mode: "live",
    model: "fake-model",
    async label(list) {
      return list.map((entry) => ({ content_id: entry.content_id, source: "ai", topics: entry.topics }));
    },
    async narrative() {
      return { narrative: "模型叙述", suggestions, model: "fake-model", cached: false, degraded: false };
    },
    stats: () => ({ requests: 1, cache_hits: 0, failures: 0 }),
  };
  const labeler = createLabeler({ store, ai, clock: { now: () => NOW } });
  const snap = {
    ...fakeSnapshot({ items, exposures, actions: [], goal: null, now: NOW, windowDays: 7 }),
    ...snapshot,
  };
  return { labeler, snap, store };
}

test("建议说'补充时事'但证据全是游戏 → 证据被清空并补搜索链接", async () => {
  const { labeler, snap } = build({
    items: [item("a", ["game"]), item("b", ["tech"])],
    exposures: [exposure("a"), exposure("b")],
    suggestions: [{ title: "补充新闻与科学类内容", why: "aiming", action: "search", topic: "news", basis: "topic", evidence_ids: ["a", "b"] }],
  });
  const out = await labeler.narrative(snap, null);
  const sug = out.suggestions[0];
  assert.deepEqual(sug.evidence_ids, [], "游戏/科技内容不能当时事建议的证据");
  assert.equal(sug.topic, "news");
  assert.equal(sug.basis, "topic");
  assert.equal(sug.search.keyword, "时事·社会·财经");
  assert.match(sug.search.url, /^https:\/\/search\.bilibili\.com\/all\?keyword=/);
  assert.ok(sug.search.url.includes(encodeURIComponent("时事·社会·财经")));
});

test("同主题内容存在时保留证据、不加搜索链接", async () => {
  const { labeler, snap } = build({
    items: [item("a", ["news"]), item("b", ["game"])],
    exposures: [exposure("a"), exposure("b")],
    suggestions: [{ title: "补充时事类内容", action: "search", topic: "news", basis: "topic", evidence_ids: ["a", "b"] }],
  });
  const sug = (await labeler.narrative(snap, null)).suggestions[0];
  assert.deepEqual(sug.evidence_ids, ["a"], "只保留同主题的那条");
  assert.equal(sug.search, undefined);
});

test("topic 不在主题表内 → 整条建议丢弃", async () => {
  const { labeler, snap } = build({
    items: [item("a", ["game"])],
    exposures: [exposure("a")],
    suggestions: [{ title: "随便看看", action: "search", topic: "not-a-topic", basis: "topic", evidence_ids: ["a"] }],
  });
  assert.equal((await labeler.narrative(snap, null)).suggestions.length, 0);
});

test("basis=none（无主题也无重复依据）→ 整条丢弃，不留空壳", async () => {
  const { labeler, snap } = build({
    items: [item("a", ["game"])],
    exposures: [exposure("a")],
    suggestions: [{ title: "多看点别的", action: "keep", basis: "none", evidence_ids: ["a"] }],
  });
  assert.equal((await labeler.narrative(snap, null)).suggestions.length, 0);
});

test("basis=repetition 豁免主题校验，但只出现一次的条目不算重复 → 丢弃", async () => {
  const { labeler, snap } = build({
    items: [item("a", ["game"])],
    exposures: [exposure("a")],
    suggestions: [{ title: "减少重复内容", action: "platform_feedback", basis: "repetition", evidence_ids: ["a"] }],
  });
  assert.equal((await labeler.narrative(snap, null)).suggestions.length, 0);
});

test("basis=repetition：真的重复曝光两次才保留", async () => {
  const { labeler, snap } = build({
    items: [item("a", ["game"])],
    exposures: [exposure("a", NOW - 2000), exposure("a", NOW - 1000)],
    suggestions: [{ title: "减少重复内容", action: "platform_feedback", basis: "repetition", evidence_ids: ["a"] }],
  });
  const sug = (await labeler.narrative(snap, null)).suggestions[0];
  assert.deepEqual(sug.evidence_ids, ["a"]);
  assert.equal(sug.basis, "repetition");
  assert.equal(sug.topic, null);
  assert.equal(sug.search, undefined);
});

test("模型不可用时，兜底建议沿目标主题生成搜索链接（不拿不相干证据凑数）", async () => {
  const { labeler } = build({
    items: [item("a", ["game"]), item("b", ["game"])],
    exposures: [exposure("a"), exposure("b")],
    suggestions: [], // 模型没给建议 → 走 alertSuggestions
  });
  const snap = {
    ...fakeSnapshot({ items: [], exposures: [], actions: [], goal: null, now: NOW, windowDays: 7 }),
    goal: { present: true, text: "想了解时事", intent_mode: "learn_event", topics: [{ t: "news", w: 0.6 }, { t: "science", w: 0.4 }], source: "ai" },
    alerts: [
      {
        rule_id: "goal_gap",
        severity: "warn",
        title: "曝光与你设置的目标有差距",
        detail: "目标最关注时事",
        evidence: [{ exposure_id: "e1", content_id: "a", title: "游戏A", url: "https://www.bilibili.com/video/a" }],
      },
    ],
  };
  const sug = (await labeler.narrative(snap, snap.goal)).suggestions[0];
  assert.equal(sug.topic, "news", "兜底建议取目标里权重最高的主题");
  assert.deepEqual(sug.evidence_ids, [], "游戏视频不是时事建议的证据");
  assert.equal(sug.search.keyword, "时事·社会·财经");
});

test("同一输入两次运行结果完全一致（确定性）", async () => {
  const make = () => build({
    items: [item("a", ["game"]), item("b", ["news"])],
    exposures: [exposure("a"), exposure("b")],
    suggestions: [{ title: "补充时事", action: "search", topic: "news", basis: "topic", evidence_ids: ["b", "a"] }],
  });
  const a = await make();
  const b = await make();
  const one = await a.labeler.narrative(a.snap, null);
  const two = await b.labeler.narrative(b.snap, null);
  assert.equal(JSON.stringify(one.suggestions), JSON.stringify(two.suggestions));
});

import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../../src/server/app.js";
import { createFakeLabeler, createFakeStore, fakeSnapshot, startServer, callHttp } from "./_helpers.mjs";

const NOW = 1794729600000;
const MIN = 60 * 1000;

function seedStore(store) {
  store.upsertItem({
    content_id: "i_tech",
    title: "本地跑大模型的显存实测",
    url: "https://www.bilibili.com/video/i_tech",
    source_id: "s1",
    source_name: "硬核老王",
    topics: [{ t: "tech", w: 1 }],
    origin: "real",
  });
  store.upsertItem({
    content_id: "i_game",
    title: "王者荣耀上分攻略",
    url: "https://www.bilibili.com/video/i_game",
    source_id: "s2",
    source_name: "游戏小明",
    topics: [{ t: "game", w: 1 }],
    origin: "real",
  });
  store.upsertItem({
    content_id: "i_seen",
    title: "已经点开过的视频",
    url: "https://www.bilibili.com/video/i_seen",
    source_id: "s2",
    source_name: "游戏小明",
    topics: [{ t: "game", w: 1 }],
    origin: "real",
  });
  const add = (id, contentId, context = "home") =>
    store.addExposure({ exposure_id: "e_" + id, content_id: contentId, exposed_at: NOW - MIN, page_context: context, session_id: "s1", origin: "real" });
  add("t", "i_tech");
  add("g1", "i_game");
  add("g2", "i_game");
  add("s", "i_seen");
  store.addAction({ action_id: "a1", content_id: "i_seen", action_type: "open", occurred_at: NOW - MIN, session_id: "s1", origin: "real" });
}

async function harness(options = {}) {
  const store = options.store ?? createFakeStore();
  if (options.seed !== false) seedStore(store);
  const app = createApp({
    store,
    labeler: options.labeler ?? createFakeLabeler(),
    analyze: (input) => fakeSnapshot(input),
    clock: { now: () => NOW },
    rankRecommendations: options.rankRecommendations,
    recommendWhy: options.recommendWhy,
  });
  const server = await startServer(app);
  return { ...server, store };
}

function fakeRank(list) {
  return () => list;
}

const FAKE_RECOS = [
  { content_id: "i_tech", title: "本地跑大模型的显存实测", url: "https://a/1", source_name: "硬核老王", page_context: "home", score: 0.62, basis: { goal_match: 1, fills_gap: 0.5, source_diversity: 0.5, novelty: 0.5 }, why: null },
  { content_id: "i_game", title: "王者荣耀上分攻略", url: "https://a/2", source_name: "游戏小明", page_context: "home", score: 0.31, basis: { goal_match: 0, fills_gap: 0.5, source_diversity: 0.5, novelty: 0 }, why: null },
];

test("GET /api/profile 带 recommendations，且排序/条目/url 由确定性实现决定", async (t) => {
  const app = await harness({ rankRecommendations: fakeRank(FAKE_RECOS) });
  t.after(() => app.close());
  const res = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.recommendations));
  assert.deepEqual(res.json.recommendations.map((entry) => entry.content_id), ["i_tech", "i_game"]);
  assert.equal(res.json.recommendations[0].url, "https://a/1");
  assert.deepEqual(res.json.recommendations[0].basis, FAKE_RECOS[0].basis);
  // 无 key 的测试环境里 why 必须为 null，不允许假装有 AI 结论
  assert.equal(res.json.recommendations[0].why, null);
});

test("AI 只写 why：不增删条目、不改顺序、不改 url", async (t) => {
  const observed = {};
  const recommendWhy = async ({ recommendations }) => {
    observed.ids = recommendations.map((entry) => entry.content_id);
    return { reasons: [
      { content_id: "i_game", why: "这个 UP 主你很少看" },
      { content_id: "i_tech", why: "更接近你想学的方向" },
    ] };
  };
  const app = await harness({ rankRecommendations: fakeRank(FAKE_RECOS), recommendWhy });
  t.after(() => app.close());
  const res = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.deepEqual(observed.ids, ["i_tech", "i_game"], "交给 AI 的必须已经是定序结果");
  assert.deepEqual(res.json.recommendations.map((entry) => entry.content_id), ["i_tech", "i_game"], "顺序不得被 AI 改动");
  assert.equal(res.json.recommendations[0].why, "更接近你想学的方向");
  assert.equal(res.json.recommendations[1].why, "这个 UP 主你很少看");
  assert.equal(res.json.recommendations[0].url, "https://a/1", "url 不得被 AI 改动");
});

test("AI 失败 / 返回垃圾：why 全为 null，接口仍 200，顺序不变", async (t) => {
  const app = await harness({
    rankRecommendations: fakeRank(FAKE_RECOS),
    recommendWhy: async () => {
      throw new Error("upstream 500");
    },
  });
  t.after(() => app.close());
  const res = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.recommendations.map((entry) => entry.content_id), ["i_tech", "i_game"]);
  assert.equal(res.json.recommendations[0].why, null);
  assert.equal(res.json.recommendations[1].why, null);
});

test("AI 编造不存在的 id 被丢弃，超长 why 被裁剪到 40 字", async (t) => {
  const long = "这".repeat(120);
  const app = await harness({
    rankRecommendations: fakeRank(FAKE_RECOS),
    recommendWhy: async () => ({
      reasons: [
        { content_id: "not_a_real_id", why: "编造的理由" },
        { content_id: "i_tech", why: long },
      ],
    }),
  });
  t.after(() => app.close());
  const res = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.equal(res.json.recommendations.length, 2, "不许因为 AI 返回而增删条目");
  assert.equal(res.json.recommendations[0].why.length, 40);
  assert.equal(res.json.recommendations[1].why, null);
  assert.equal(res.json.recommendations.some((entry) => entry.content_id === "not_a_real_id"), false);
});

test("没注入排序实现时回退到 src/core/recommend.js（真实现）", async (t) => {
  const app = await harness();
  t.after(() => app.close());
  const res = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.equal(res.status, 200);
  const ids = res.json.recommendations.map((entry) => entry.content_id);
  assert.equal(ids.includes("i_seen"), false, "已经 open 过的内容不该被推荐");
  assert.deepEqual(ids.slice().sort(), ["i_game", "i_tech"]);
  for (const entry of res.json.recommendations) {
    assert.equal(typeof entry.title, "string");
    assert.ok(entry.title.length > 0, "每条推荐都必须带标题，界面不能只显示裸链接");
    assert.ok(entry.url.startsWith("https://"));
    assert.equal(typeof entry.score, "number");
    assert.ok(entry.basis && typeof entry.basis.goal_match === "number");
  }
});

test("排序实现抛错：recommendations 退化为空数组，画像与 ai 字段照常返回", async (t) => {
  const app = await harness({
    rankRecommendations: () => {
      throw new Error("boom");
    },
  });
  t.after(() => app.close());
  const res = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.recommendations, []);
  assert.equal(typeof res.json.ai.narrative, "string");
});

test("排序结果里缺 url 的条目被丢弃（界面不渲染裸链接）", async (t) => {
  const app = await harness({
    rankRecommendations: fakeRank([{ ...FAKE_RECOS[0], url: "" }]),
  });
  t.after(() => app.close());
  const res = await callHttp(app.url, "GET", "/api/profile?days=7");
  assert.deepEqual(res.json.recommendations, []);
});

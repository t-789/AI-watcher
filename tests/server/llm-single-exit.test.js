import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAI } from "../../src/server/ai.js";
import { createLabeler } from "../../src/server/labeler.js";
import { createApp } from "../../src/server/app.js";
import { createFakeStore, createFakeLabeler, fakeSnapshot, startServer, callHttp, tempDir, cleanup } from "./_helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const NOW = 1794729600000;

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  };
}

function recordingFetch(responses) {
  const calls = [];
  let index = 0;
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next();
  };
  fn.calls = calls;
  return fn;
}

const CANDIDATES = [
  { content_id: "i_tech", title: "显存实测", page_context: "home", basis: { goal_match: 1, fills_gap: 0.4, source_diversity: 0.5, novelty: 0.6 } },
  { content_id: "i_game", title: "上分攻略", page_context: "video_related", basis: { goal_match: 0, fills_gap: 0.9, source_diversity: 0.8, novelty: 0.2 } },
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// 1) 唯一出口：只有 ai.js 允许出现 chat/completions
test("LLM 唯一出口：全仓库只有 src/server/ai.js 出现 chat/completions", () => {
  const hits = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    if (text.includes("chat/completions")) hits.push(file.replace(SRC + "/", ""));
  }
  assert.deepEqual(hits, ["server/ai.js"], "只允许 ai.js 一处出口，实际：" + hits.join(","));
  // app.js 不得再自带 base_url / 超时 / 提示词
  const appSrc = readFileSync(join(SRC, "server", "app.js"), "utf8");
  for (const banned of ["WHY_BASE_URL", "WHY_SYSTEM_PROMPT", "WHY_TIMEOUT_MS", "api.deepseek.com"]) {
    assert.equal(appSrc.includes(banned), false, "app.js 不应再出现 " + banned);
  }
});

// 2) 一次请求同时拿到叙述 / 建议 / 理由
test("合并请求：一次调用同时产出 narrative + suggestions + reasons", async (t) => {
  const dir = tempDir("llm-merge");
  t.after(() => cleanup(dir));
  const fetchImpl = recordingFetch([
    () => okResponse({
      narrative: "近 7 天推荐集中在数码评测。",
      suggestions: [{ title: "换来源看", why: "同一 UP 占比过高", action: "watch_other_source", topic: "tech", basis: "topic", evidence_ids: ["c1"] }],
      reasons: [
        { content_id: "i_tech", why: "和你想搞懂的方向最接近" },
        { content_id: "i_game", why: "这个 UP 主你很少看" },
      ],
    }),
  ]);
  const ai = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "n.jsonl"), fetchImpl });
  const result = await ai.narrative({ evidence: [{ content_id: "c1", title: "显卡评测" }], summary: { exposure_count: 10 }, goal: "想搞懂本地跑模型", candidates: CANDIDATES });

  assert.equal(result.degraded, false);
  assert.ok(result.narrative.length > 0);
  assert.equal(result.suggestions.length, 1);
  assert.deepEqual(result.reasons.map((r) => r.content_id), ["i_tech", "i_game"]);
  assert.equal(result.reasons[0].why, "和你想搞懂的方向最接近");
  assert.equal(fetchImpl.calls.length, 1, "三个结果只能花一次请求");
  const sent = fetchImpl.calls[0].body;
  assert.ok(Array.isArray(JSON.parse(sent.messages[1].content).candidates), "候选必须随请求一起发出去");
  assert.equal(sent.response_format.type, "json_object");
  assert.ok(!JSON.stringify(sent).includes("sk-test-not-a-real-key"), "key 不得出现在请求体里");
});

// 3) 三项互相独立：reasons 非法不影响 narrative
test("三项独立校验：reasons 全非法时 narrative 与建议仍返回", async (t) => {
  const dir = tempDir("llm-partial");
  t.after(() => cleanup(dir));
  const fetchImpl = recordingFetch([
    () => okResponse({
      narrative: "分布较集中。",
      suggestions: [],
      reasons: [{ content_id: "not-a-candidate", why: "编造的" }, { content_id: "i_tech", why: "" }],
    }),
  ]);
  const ai = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "n.jsonl"), fetchImpl });
  const result = await ai.narrative({ evidence: [], summary: {}, candidates: CANDIDATES });
  assert.equal(result.narrative, "分布较集中。");
  assert.deepEqual(result.reasons, [], "候选外 / 空 why 的理由必须被丢弃");
  assert.equal(result.degraded, false);
});

// 4) 非法 content_id、超长 why、重复 id 的清洗
test("reasons 清洗：丢弃候选外的 id、裁到 40 字、同 id 去重", async (t) => {
  const dir = tempDir("llm-reasons");
  t.after(() => cleanup(dir));
  const longWhy = "这".repeat(60);
  const fetchImpl = recordingFetch([
    () => okResponse({
      narrative: "n",
      suggestions: [],
      reasons: [
        { content_id: "i_tech", why: longWhy },
        { content_id: "i_tech", why: "重复" },
        { content_id: "fake", why: "候选外" },
        { content_id: "i_game", why: "很小众的 UP 主" },
      ],
    }),
  ]);
  const ai = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "n.jsonl"), fetchImpl });
  const result = await ai.narrative({ evidence: [], summary: {}, candidates: CANDIDATES });
  assert.deepEqual(result.reasons.map((r) => r.content_id), ["i_tech", "i_game"]);
  assert.equal([...result.reasons[0].why].length, 40);
});

// 5) 缓存：同一数据指纹 + 同一候选 → 不重复请求，三样一起复用
test("labeler 缓存：同一指纹命中时 narrative/suggestions/reasons 一起复用且不再请求", async (t) => {
  const dir = tempDir("llm-cache");
  t.after(() => cleanup(dir));
  const store = createFakeStore();
  const fetchImpl = recordingFetch([
    () => okResponse({ narrative: "命中缓存的叙述", suggestions: [], reasons: [{ content_id: "i_tech", why: "贴近目标" }] }),
  ]);
  const ai = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "n.jsonl"), fetchImpl });
  const labeler = createLabeler({ store, ai, clock: { now: () => NOW } });
  const snapshot = fakeSnapshot({ items: [], exposures: [], actions: [], goal: null, now: NOW, windowDays: 7 });

  const first = await labeler.narrative(snapshot, null, CANDIDATES);
  const second = await labeler.narrative(snapshot, null, CANDIDATES);
  assert.equal(fetchImpl.calls.length, 1, "第二次必须命中缓存");
  assert.equal(second.narrative_cached, true);
  assert.equal(second.narrative, first.narrative);
  assert.deepEqual(second.reasons, first.reasons);
  // 候选换了就必须重算——否则理由会和当前候选对不上
  await labeler.narrative(snapshot, null, [CANDIDATES[0]]);
  assert.equal(fetchImpl.calls.length, 2);
});

// 6) 降级：无 key 不请求，reasons 为空，且不写缓存
test("降级：无 key 时 reasons 为空且不写缓存（第二次仍会重算）", async (t) => {
  const dir = tempDir("llm-degraded");
  t.after(() => cleanup(dir));
  const store = createFakeStore();
  let asked = 0;
  const ai = {
    model: "deepseek-chat",
    narrative: async () => {
      asked += 1;
      return { narrative: "", suggestions: [], reasons: [], model: "deepseek-chat", cached: false, degraded: true };
    },
  };
  const labeler = createLabeler({ store, ai, clock: { now: () => NOW } });
  const snapshot = fakeSnapshot({ items: [], exposures: [], actions: [], goal: null, now: NOW, windowDays: 7 });
  const first = await labeler.narrative(snapshot, null, CANDIDATES);
  const second = await labeler.narrative(snapshot, null, CANDIDATES);
  assert.deepEqual(first.reasons, []);
  assert.equal(asked, 2, "降级结果不许写缓存");
  assert.equal(second.narrative_cached, false);
});

// 7) 服务层：一次 profile 只触发一次 labeler.narrative，理由直接贴回候选
test("服务层：/api/profile 只调用一次 labeler.narrative，why 来自同一次请求", async (t) => {
  const store = createFakeStore();
  store.upsertItem({ content_id: "i_tech", title: "显存实测", url: "https://a/1", source_id: "s1", source_name: "硬核老王", topics: [{ t: "tech", w: 1 }], origin: "real" });
  let narrativeCalls = 0;
  let seenCandidates = null;
  const labeler = createFakeLabeler({
    narrative: {
      narrative: "假叙述",
      suggestions: [],
      reasons: [{ content_id: "i_tech", why: "贴合你的目标" }],
      model: "fake-model",
      cached: false,
      degraded: false,
    },
  });
  const original = labeler.narrative;
  labeler.narrative = async (snapshot, goal, candidates) => {
    narrativeCalls += 1;
    seenCandidates = candidates;
    return original(snapshot, goal, candidates);
  };
  const app = createApp({
    store,
    labeler,
    analyze: (input) => fakeSnapshot(input),
    clock: { now: () => NOW },
    rankRecommendations: () => [{ content_id: "i_tech", title: "显存实测", url: "https://a/1", source_name: "硬核老王", page_context: "home", score: 0.6, basis: { goal_match: 1, fills_gap: 0.2, source_diversity: 0.5, novelty: 0.4 }, why: null }],
  });
  const server = await startServer(app);
  t.after(() => server.close());
  const res = await callHttp(server.url, "GET", "/api/profile?days=7");
  assert.equal(res.status, 200);
  assert.equal(narrativeCalls, 1, "一次画像只能有一次叙述请求");
  assert.deepEqual(seenCandidates.map((c) => c.content_id), ["i_tech"], "候选必须先由确定性排序定下来再交给 AI");
  assert.equal(res.json.recommendations[0].content_id, "i_tech");
  assert.equal(res.json.recommendations[0].why, "贴合你的目标", "why 必须来自同一次请求");
});

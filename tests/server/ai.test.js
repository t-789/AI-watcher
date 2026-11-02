import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createAI, labelCacheKey, validateLabel, keywordLabel, TOPICS } from "../../src/server/ai.js";
import { createLabeler } from "../../src/server/labeler.js";
import { createFakeStore, tempDir, cleanup } from "./_helpers.mjs";

const ITEMS = [
  { content_id: "c1", title: "4090 显卡 AI 推理评测", desc: "这张显卡跑大模型的参数实测", source_name: "数码UP", comments: ["up 主专业"], duration_s: 600, url: "https://www.bilibili.com/video/BV1GJ411x7h1" },
  { content_id: "c2", title: "考研数学复习方法", desc: "上岸笔记", source_name: "学习号", comments: ["有用"], duration_s: 300, url: "https://www.bilibili.com/video/BV1GJ411x7h2" },
];

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  };
}

function recordingFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next();
  };
  fn.calls = calls;
  return fn;
}

test("无 key → ai.mode=degraded，关键词兜底打标，不发任何请求、永不 500", async (t) => {
  const dir = tempDir("ai-degraded");
  t.after(() => cleanup(dir));
  let calls = 0;
  const ai = createAI({ apiKey: "", cachePath: join(dir, "ai-cache.jsonl"), fetchImpl: async () => { calls += 1; throw new Error("不该发请求"); } });

  assert.equal(ai.mode, "degraded");
  assert.equal(ai.model, "deepseek-chat");
  const labels = await ai.label(ITEMS);
  assert.equal(calls, 0);
  assert.equal(ai.stats().requests, 0);
  assert.equal(labels.length, 2);
  for (const label of labels) {
    assert.equal(label.source, "keywords");
    assert.equal(label.cached, false);
    assert.ok(Array.isArray(label.topics));
    for (const entry of label.topics) assert.ok(TOPICS.includes(entry.t), "兜底主题必须来自 TOPICS");
    const sum = label.topics.reduce((acc, entry) => acc + entry.w, 0);
    if (label.topics.length) assert.ok(Math.abs(sum - 1) < 1e-6);
  }
  assert.deepEqual(labels[0].topics.map((entry) => entry.t), ["tech"]);
  assert.ok(labels[1].topics.some((entry) => entry.t === "study"));
  assert.equal(labels[0].summary, "4090 显卡 AI 推理评测");
});

test("关键词兜底：无命中 → topics 为空数组（未知），不硬归类", () => {
  const label = keywordLabel({ title: "zzz qqq", desc: "" });
  assert.deepEqual(label.topics, undefined);
});

test("打标请求参数照契约 §6：model/temperature/response_format，且只发 title/desc/author/comments/duration", async (t) => {
  const dir = tempDir("ai-req");
  t.after(() => cleanup(dir));
  const fetchImpl = recordingFetch([() => okResponse({ results: [
    { i: 0, topics: [{ t: "tech", w: 0.8 }, { t: "study", w: 0.2 }], content_type: "评测", clickbait: 0.1, emotionality: 0.2, info_density: 0.7, value_notes: { evidence: "strong", timeliness: "recent", note: "有实测数据" }, summary: "显卡跑大模型实测" },
    { i: 1, topics: [], summary: "复习方法" },
  ] })]);
  const ai = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "ai-cache.jsonl"), fetchImpl });

  const labels = await ai.label(ITEMS);
  assert.equal(fetchImpl.calls.length, 1, "两条内容应合成一次批量请求");
  const call = fetchImpl.calls[0];
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.body.model, "deepseek-chat");
  assert.equal(call.body.temperature, 0);
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.equal(call.init.method, "POST");

  const sent = call.body.messages[1].content;
  assert.ok(sent.includes("4090 显卡"), "标题必须发送");
  assert.ok(sent.includes("这张显卡"), "desc 前 300 字必须发送");
  assert.ok(sent.includes("up 主专业"), "热评必须发送");
  assert.ok(!sent.includes("BV1GJ411x7h1"), "禁止发送页面其它内容（url）");
  assert.ok(!JSON.stringify(call.body).includes("sk-test-not-a-real-key"), "key 不能出现在 body 里");

  assert.equal(ai.stats().requests, 1);
  assert.equal(labels[0].source, "ai");
  assert.deepEqual(labels[0].topics, [{ t: "tech", w: 0.8 }, { t: "study", w: 0.2 }]);
  assert.deepEqual(labels[1].topics, [], "模型说未知就是未知");
  assert.equal(labels[0].content_type, "评测");
  assert.deepEqual(labels[0].value_notes, { evidence: "strong", timeliness: "recent", note: "有实测数据" });
});

test("缓存命中零请求：同内容第二次打标 requests 不增，cache_hits 增加，跨实例命中 jsonl", async (t) => {
  const dir = tempDir("ai-cache");
  t.after(() => cleanup(dir));
  const cachePath = join(dir, "ai-cache.jsonl");
  const payload = { results: [{ i: 0, topics: [{ t: "tech", w: 1 }], summary: "缓存内容" }, { i: 1, topics: [{ t: "study", w: 1 }] }] };
  const fetchImpl = recordingFetch([() => okResponse(payload)]);
  const ai = createAI({ apiKey: "sk-test-not-a-real-key", cachePath, fetchImpl });

  await ai.label(ITEMS);
  assert.deepEqual({ requests: ai.stats().requests, hits: ai.stats().cache_hits }, { requests: 1, hits: 0 });

  const second = await ai.label(ITEMS);
  assert.equal(fetchImpl.calls.length, 1, "第二次必须零请求");
  assert.equal(ai.stats().requests, 1, "requests 不增");
  assert.equal(ai.stats().cache_hits, 2);
  assert.equal(second[0].source, "cache");
  assert.equal(second[0].cached, true);

  const revived = createAI({ apiKey: "sk-test-not-a-real-key", cachePath, fetchImpl: async () => { throw new Error("不该发请求"); } });
  const third = await revived.label(ITEMS);
  assert.equal(revived.stats().requests, 0, "落盘缓存跨进程仍然命中");
  assert.equal(revived.stats().cache_hits, 2);
  assert.equal(third[0].source, "cache");
  const key = labelCacheKey(ITEMS[0]);
  assert.equal(key.length, 40);
});

test("模型输出逐字段校验：非法主题/枚举/权重被丢弃，权重归一化", () => {
  const label = validateLabel({
    topics: [{ t: "tech", w: 0.6 }, { t: "bogus", w: 0.5 }, { t: "study", w: 0.4 }, { t: "game", w: -1 }, { t: "music", w: "x" }, { t: "anime", w: 1.5 }],
    content_type: "影评",
    clickbait: 5,
    emotionality: 0.25,
    info_density: "0.5",
    value_notes: { evidence: "excellent", timeliness: "recent", note: "备注".repeat(40) },
    summary: "总结".repeat(40),
    made_up_field: "不该保留",
  });
  assert.deepEqual(label.topics.map((entry) => entry.t), ["tech", "study"]);
  const sum = label.topics.reduce((acc, entry) => acc + entry.w, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, "归一化后和为 1");
  assert.equal(label.content_type, undefined, "非法枚举丢弃该字段");
  assert.equal(label.clickbait, undefined, "越界数值丢弃该字段");
  assert.equal(label.emotionality, 0.25);
  assert.equal(label.info_density, 0.5, "数字字符串可解析为合法数值");
  assert.deepEqual(label.value_notes, { timeliness: "recent", note: "备注".repeat(20) }, "非法 evidence 丢弃，note 截断 40 字");
  assert.equal([...label.summary].length, 40, "summary 截断 40 字");
  assert.equal(label.made_up_field, undefined, "不认识的字段绝不透传");
  assert.equal(validateLabel({}), null, "全空输出视为无效标注");
  assert.equal(validateLabel(null), null);
});

test("5xx 重试 1 次（requests 只计 1 次）；4xx 不重试；都失败则降级关键词", async (t) => {
  const dir = tempDir("ai-retry");
  t.after(() => cleanup(dir));

  const retryFetch = recordingFetch([
    () => ({ ok: false, status: 503, json: async () => ({}) }),
    () => okResponse({ results: [{ i: 0, topics: [{ t: "tech", w: 1 }] }, { i: 1, topics: [{ t: "study", w: 1 }] }] }),
  ]);
  const retryAI = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "a.jsonl"), fetchImpl: retryFetch });
  const retried = await retryAI.label(ITEMS);
  assert.equal(retryFetch.calls.length, 2, "5xx 后重试一次");
  assert.equal(retryAI.stats().requests, 1);
  assert.equal(retried[0].source, "ai");

  const badFetch = recordingFetch([() => ({ ok: false, status: 400, json: async () => ({ error: "bad" }) })]);
  const badAI = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "b.jsonl"), fetchImpl: badFetch });
  const fellBack = await badAI.label(ITEMS);
  assert.equal(badFetch.calls.length, 1, "4xx 不重试");
  assert.equal(badAI.stats().requests, 1);
  assert.equal(badAI.stats().failures, 1);
  assert.equal(fellBack[0].source, "keywords", "请求失败 → 关键词兜底，不抛错");

  const deadFetch = recordingFetch([() => { throw new Error("ECONNRESET"); }]);
  const deadAI = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "c.jsonl"), fetchImpl: deadFetch });
  const dead = await deadAI.label(ITEMS);
  assert.equal(deadFetch.calls.length, 2, "网络错误重试一次");
  assert.equal(deadAI.stats().requests, 1);
  assert.equal(dead[0].source, "keywords");
});

test("叙述输出校验：evidence_ids 只能来自传入证据，非法枚举/凭空 id 的建议被丢弃，最多 3 条", async (t) => {
  const dir = tempDir("ai-narrative");
  t.after(() => cleanup(dir));
  const fetchImpl = recordingFetch([() => okResponse({
    narrative: "近 7 天推荐集中在数码评测，重复曝光偏高。",
    suggestions: [
      { title: "换来源看", why: "同一 UP 占比过高", action: "watch_other_source", evidence_ids: ["c1"] },
      { title: "凭空建议", why: "编造", action: "keep", evidence_ids: ["fake-id"] },
      { title: "动作非法", why: "枚举不在表里", action: "nuke", evidence_ids: ["c2"] },
      { title: "主动搜索", why: "补目标主题", action: "search", evidence_ids: ["c1", "c2", "fake-id"] },
      { title: "第四条", why: "超出上限", action: "keep", evidence_ids: ["c2"] },
    ],
  })]);
  const ai = createAI({ apiKey: "sk-test-not-a-real-key", cachePath: join(dir, "n.jsonl"), fetchImpl });

  const evidence = [{ content_id: "c1", title: "显卡评测", at: 1 }, { content_id: "c2", title: "考研笔记", at: 2 }, { content_id: "c3" }];
  const result = await ai.narrative({ evidence, summary: { exposure_count: 10, repeat_rate: 0.4 } });

  assert.equal(result.degraded, false);
  assert.equal(result.cached, false);
  assert.equal(result.model, "deepseek-chat");
  assert.ok(result.narrative.length > 0);
  assert.ok(result.suggestions.length <= 3);
  const allowed = new Set(evidence.map((entry) => entry.content_id));
  for (const suggestion of result.suggestions) {
    for (const id of suggestion.evidence_ids) assert.ok(allowed.has(id), "evidence_ids 必须来自传入证据");
    assert.ok(["search", "watch_other_source", "platform_feedback", "keep"].includes(suggestion.action));
    assert.deepEqual(suggestion.evidence_ids, [...new Set(suggestion.evidence_ids)]);
  }
  assert.deepEqual(result.suggestions.map((entry) => entry.title), ["换来源看", "主动搜索", "第四条"]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.temperature, 0);
  assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: "json_object" });
  assert.ok(!JSON.stringify(fetchImpl.calls[0].body).includes("sk-test-not-a-real-key"));
});

test("无 key 时叙述降级：不请求、narrative 为空、degraded=true", async (t) => {
  const dir = tempDir("ai-narrative-degraded");
  t.after(() => cleanup(dir));
  const ai = createAI({ apiKey: "", cachePath: join(dir, "n.jsonl"), fetchImpl: async () => { throw new Error("不该发请求"); } });
  const result = await ai.narrative({ evidence: [{ content_id: "c1" }], summary: {} });
  assert.deepEqual(result, { narrative: "", suggestions: [], model: "deepseek-chat", cached: false, degraded: true });
});

test("labeler：enqueue → labelNow 写回 items（topics + annotation），status 报 cache_hits/requests", async (t) => {
  const dir = tempDir("labeler");
  t.after(() => cleanup(dir));
  const store = createFakeStore();
  const ai = createAI({ apiKey: "", cachePath: join(dir, "n.jsonl") });
  const labeler = createLabeler({ store, ai, clock: { now: () => 1234 } });

  for (const item of ITEMS) store.ensureItemForObservation({ ...item, canonical_key: "k-" + item.content_id, annotation: { status: "pending", model: null, at: null } });
  const labels = await labeler.labelNow(store.getItems());
  assert.equal(labels.length, 2);
  const item = store.getItem("c1");
  assert.deepEqual(item.topics.map((entry) => entry.t), ["tech"]);
  assert.equal(item.annotation.status, "unknown", "关键词兜底不是模型结论，标 unknown 而不是 ai");
  assert.equal(item.annotation.model, "keywords");
  assert.equal(item.annotation.at, 1234);

  const status = labeler.status();
  assert.equal(status.mode, "degraded");
  assert.equal(typeof status.cache_hits, "number");
  assert.equal(typeof status.requests, "number");
  assert.equal(status.pending, 0);
});

test("labeler 降级叙述：模板句 + 只用 alerts 的 evidence_ids", async (t) => {
  const dir = tempDir("labeler-narrative");
  t.after(() => cleanup(dir));
  const store = createFakeStore();
  const ai = createAI({ apiKey: "", cachePath: join(dir, "n.jsonl") });
  const labeler = createLabeler({ store, ai });
  const snapshot = {
    window: { start: 0, end: 86400000 * 7, days: 7, exposure_count: 120, unique_items: 80, action_count: 12, known_topic_ratio: 0.9, unknown_topic_ratio: 0.1 },
    exposure: { available: true, topics: [{ t: "tech", w: 0.7, n: 80 }], entropy: 0.42, repeat_rate: 0.33, unique_items: 80, top_source: { id: "1", name: "数码UP", n: 40, share: 0.5 }, source_count: 6 },
    alerts: [
      { rule_id: "source_concentration", severity: "warn", title: "来源集中", detail: "单一来源占 50%", evidence: [{ content_id: "c1", title: "显卡评测", url: "u", at: 1 }, { content_id: "c2" }] },
      { rule_id: "narrowing", severity: "info", title: "范围收窄", detail: "熵下降", evidence: [] },
    ],
  };
  const result = await labeler.narrative(snapshot, { goal_text: "学 AI" });
  assert.equal(result.degraded, true);
  assert.ok(result.narrative.includes("120"), "模板句只用已有统计数字");
  assert.equal(result.suggestions.length, 1, "没有 evidence 的 alert 不出建议");
  assert.deepEqual(result.suggestions[0].evidence_ids, ["c1", "c2"]);
  assert.equal(result.suggestions[0].action, "watch_other_source");
  assert.ok([...result.suggestions[0].title].length <= 20);
});

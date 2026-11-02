import test from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, rankRecommendations, RECO_WEIGHTS } from "../../src/core/index.js";
import { DAY_MS } from "../../src/core/constants.js";

const NOW = 1794729600000;
const MIN = 60 * 1000;

function item(id, topics, extra = {}) {
  return {
    content_id: id,
    title: extra.title ?? "视频 " + id,
    url: extra.url ?? "https://www.bilibili.com/video/" + id,
    source_id: extra.sourceId ?? "src_" + id,
    source_name: extra.sourceName ?? "UP " + id,
    topics: topics.map(([t, w]) => ({ t, w })),
  };
}

function exposure(id, contentId, at, context = "home", extra = {}) {
  return {
    exposure_id: "e_" + id,
    content_id: contentId,
    exposed_at: at,
    page_context: context,
    session_id: extra.sessionId ?? "s1",
    origin: extra.origin ?? "synthetic",
  };
}

function action(id, contentId, type, at, extra = {}) {
  return { action_id: "a_" + id, content_id: contentId, action_type: type, occurred_at: at, session_id: extra.sessionId ?? "s1", origin: "synthetic" };
}

function run(input, k = 3) {
  return rankRecommendations({ now: NOW, windowDays: 7, ...input }, k);
}

test("候选为空：窗口内没有任何曝光", () => {
  assert.deepEqual(run({ items: [], exposures: [], actions: [], goal: null }), []);
});

test("全部内容都被 open/watch 过 -> 没有候选", () => {
  const items = [item("i1", [["tech", 1]]), item("i2", [["game", 1]])];
  const exposures = [exposure("1", "i1", NOW - 3 * MIN), exposure("2", "i2", NOW - 2 * MIN)];
  const actions = [action("1", "i1", "open", NOW - 3 * MIN), action("2", "i2", "watch", NOW - 2 * MIN)];
  assert.deepEqual(run({ items, exposures, actions, goal: null }), []);
});

test("没被点开的内容才是候选；只被 like 过不算看过（契约只认 open/watch）", () => {
  const items = [item("i1", [["tech", 1]]), item("i2", [["game", 1]])];
  const exposures = [exposure("1", "i1", NOW - 3 * MIN), exposure("2", "i2", NOW - 2 * MIN)];
  const actions = [action("1", "i2", "like", NOW - 2 * MIN)];
  const out = run({ items, exposures, actions, goal: null });
  assert.deepEqual(out.map((entry) => entry.content_id), ["i1", "i2"]);
});

test("每一层 basis 都在 [0,1]，score 是加权和（贪心降权后）", () => {
  const items = [item("i1", [["tech", 1]]), item("i2", [["study", 1]])];
  const exposures = [exposure("1", "i1", NOW - 3 * MIN), exposure("2", "i2", NOW - 2 * MIN)];
  const out = run({ items, exposures, actions: [], goal: { goal_text: "备考", goal_topics: [{ t: "study", w: 1 }] } });
  for (const entry of out) {
    for (const key of ["goal_match", "fills_gap", "source_diversity", "novelty"]) {
      assert.ok(entry.basis[key] >= 0 && entry.basis[key] <= 1, key + " 越界: " + entry.basis[key]);
      assert.equal(typeof entry.score, "number");
    }
    const weighted =
      RECO_WEIGHTS.goal_match * entry.basis.goal_match +
      RECO_WEIGHTS.fills_gap * entry.basis.fills_gap +
      RECO_WEIGHTS.source_diversity * entry.basis.source_diversity +
      RECO_WEIGHTS.novelty * entry.basis.novelty;
    assert.ok(entry.score <= weighted + 1e-6, "生效分不应超过原始加权分（降权只会更低）");
    assert.equal(entry.why, null, "why 必须由 AI 层填，core 永远给 null");
  }
});

test("目标相关的内容排在前面（goal_match 主导）", () => {
  const items = [item("i_tech", [["tech", 1]]), item("i_study", [["study", 1]])];
  const exposures = [exposure("1", "i_tech", NOW - 5 * MIN), exposure("2", "i_study", NOW - 4 * MIN)];
  const out = run({ items, exposures, actions: [], goal: { goal_text: "备考", goal_topics: [{ t: "study", w: 1 }] } });
  assert.equal(out[0].content_id, "i_study");
  assert.ok(out[0].basis.goal_match > out[1].basis.goal_match);
});

test("贪心降权：同主题 ×0.6、同来源再 ×0.7，顺序因此改变", () => {
  // 全部 tech：P 里只有 tech -> fills_gap 全 0；来源 s1 出现 3 次、s3 出现 1 次
  const items = [
    item("i_a", [["tech", 1]], { sourceId: "s1" }),
    item("i_b", [["tech", 1]], { sourceId: "s1" }),
    item("i_c", [["tech", 1]], { sourceId: "s3" }),
  ];
  const exposures = [
    exposure("a1", "i_a", NOW - 5 * MIN),
    exposure("b1", "i_b", NOW - 4 * MIN),
    exposure("b2", "i_b", NOW - 3 * MIN),
    exposure("c1", "i_c", NOW - 2 * MIN),
  ];
  const goal = { goal_text: "想看 AI", goal_topics: [{ t: "tech", w: 1 }] };
  const out = run({ items, exposures, actions: [], goal });
  // 原始加权分：C .625 > A .525 > B .45；选完 C（同主题全体 ×0.6）后 A .315 > B .27；
  // 选完 A 之后 B 再吃一次同主题 ×0.6 与同来源 ×0.7
  assert.deepEqual(out.map((entry) => entry.content_id), ["i_c", "i_a", "i_b"]);
  assert.ok(Math.abs(out[0].score - 0.625) < 1e-3, "i_c=" + out[0].score);
  assert.ok(Math.abs(out[1].score - 0.315) < 1e-3, "i_a=" + out[1].score);
  assert.ok(Math.abs(out[2].score - 0.1134) < 1e-3, "i_b=" + out[2].score);
});

test("搜索页结果可以进候选，但不计入曝光画像 P", () => {
  const items = [item("i_home", [["tech", 1]]), item("i_search", [["game", 1]])];
  const exposures = [
    exposure("h1", "i_home", NOW - 5 * MIN, "home"),
    exposure("h2", "i_home", NOW - 4 * MIN, "home"),
    exposure("s1", "i_search", NOW - 3 * MIN, "search"),
  ];
  const out = run({ items, exposures, actions: [], goal: null });
  assert.deepEqual(out.map((entry) => entry.content_id).sort(), ["i_home", "i_search"]);
  assert.equal(out.find((entry) => entry.content_id === "i_search").page_context, "search");

  const snapshot = buildSnapshot({ items, exposures, actions: [], goal: null, now: NOW, windowDays: 7 });
  assert.equal(snapshot.window.exposure_count, 2, "搜索页曝光不进 P");
  assert.equal(snapshot.window.search_pull_count, 1);
  assert.equal(snapshot.window.page_contexts.search, 1);
  assert.ok(snapshot.notes.some((note) => note.includes("搜索页")), "notes 必须披露这条口径");
});

test("goal.exclusions 命中的标题被排除", () => {
  const items = [item("i1", [["game", 1]], { title: "王者荣耀上分攻略" }), item("i2", [["study", 1]], { title: "考研数学复习" })];
  const exposures = [exposure("1", "i1", NOW - 5 * MIN), exposure("2", "i2", NOW - 4 * MIN)];
  const out = run({ items, exposures, actions: [], goal: { goal_text: "备考", goal_topics: [{ t: "study", w: 1 }], exclusions: ["王者荣耀"] } });
  assert.deepEqual(out.map((entry) => entry.content_id), ["i2"]);
});

test("窗口外的曝光不参与候选；缺 url 的条目被跳过", () => {
  const items = [item("i_old", [["tech", 1]]), item("i_nourl", [["game", 1]], { url: "" })];
  const exposures = [
    exposure("old", "i_old", NOW - 9 * DAY_MS),
    exposure("nourl", "i_nourl", NOW - 3 * MIN),
  ];
  assert.deepEqual(run({ items, exposures, actions: [], goal: null }), []);
});

test("k=0 返回空数组，k 超上限被夹住", () => {
  const items = [item("i1", [["tech", 1]])];
  const exposures = [exposure("1", "i1", NOW - MIN)];
  assert.deepEqual(run({ items, exposures, actions: [], goal: null }, 0), []);
  const many = run({ items, exposures, actions: [], goal: null }, 99);
  assert.ok(many.length <= 5);
});

test("主题未知时 fills_gap 取中性值，不判零也不给满额", () => {
  const items = [item("i_unknown", [])];
  const exposures = [exposure("1", "i_unknown", NOW - MIN)];
  const out = run({ items, exposures, actions: [], goal: null });
  assert.equal(out[0].basis.fills_gap, 0.5);
});

test("确定性：同输入两次逐字节相同，打乱输入顺序也相同", () => {
  const items = [item("i1", [["tech", 1]]), item("i2", [["game", 0.6], ["tech", 0.4]]), item("i3", [["study", 1]])];
  const exposures = [
    exposure("1", "i1", NOW - 5 * MIN),
    exposure("2", "i2", NOW - 4 * MIN),
    exposure("3", "i3", NOW - 3 * MIN),
    exposure("4", "i2", NOW - 2 * MIN),
  ];
  const goal = { goal_text: "想学点东西", goal_topics: [{ t: "study", w: 0.6 }, { t: "tech", w: 0.4 }] };
  const a = JSON.stringify(run({ items, exposures, actions: [], goal }));
  const b = JSON.stringify(run({ items, exposures, actions: [], goal }));
  const shuffled = JSON.stringify(
    run({
      items: [...items].reverse(),
      exposures: [...exposures].reverse(),
      actions: [],
      goal: { ...goal, goal_topics: [...goal.goal_topics].reverse() },
    }),
  );
  assert.equal(a, b);
  assert.equal(a, shuffled);
});

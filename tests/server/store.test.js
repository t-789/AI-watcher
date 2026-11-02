import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../../src/server/store.js";
import { tempDir, cleanup } from "./_helpers.mjs";

function openStore(t) {
  const dir = tempDir("store");
  t.after(() => cleanup(dir));
  const dbFile = join(dir, "aiwatcher.db");
  const created = createStore({ file: dbFile });
  t.after(() => created.close());
  return { store: created, dbFile };
}

function observation(overrides = {}) {
  return {
    content_id: "cid-1",
    platform: "bilibili",
    canonical_key: "bilibili.com/video/BV1GJ411x7h7",
    title: "显卡评测",
    url: "https://www.bilibili.com/video/BV1GJ411x7h7",
    source_id: "42",
    source_name: "数码UP",
    duration_s: 600,
    view_count: 1000,
    danmaku_count: 20,
    published_at: 1690000000000,
    fetched_at: 1700000000000,
    desc: "简介",
    comments: ["热评1", "热评2"],
    topics: [],
    facets: [],
    value_notes: null,
    origin: "real",
    annotation: { status: "pending", model: null, at: null },
    ...overrides,
  };
}

test("SQLite 文件落盘 + WAL 模式 + 五张表就位", async (t) => {
  const { store, dbFile } = openStore(t);
  assert.ok(existsSync(dbFile));
  const raw = new DatabaseSync(dbFile);
  const mode = raw.prepare("PRAGMA journal_mode").get().journal_mode;
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
  raw.close();
  assert.equal(mode, "wal");
  assert.deepEqual(tables, ["actions", "config", "exposures", "goal", "items"]);
  assert.deepEqual(store.counts(), { items: 0, exposures: 0, actions: 0 });
  assert.equal(store.dataMode(), "empty");
});

test("item 往返：JSON 字段与 desc 不被破坏，重复观测只补全不覆盖", async (t) => {
  const { store } = openStore(t);
  const created = store.ensureItemForObservation(observation());
  assert.deepEqual(created, { content_id: "cid-1", created: true });

  const again = store.ensureItemForObservation(observation({ desc: "", comments: [], view_count: 5000 }));
  assert.equal(again.created, false);
  const item = store.getItem("cid-1");
  assert.equal(item.desc, "简介", "空 desc 不能抹掉已有简介");
  assert.deepEqual(item.comments, ["热评1", "热评2"]);
  assert.equal(item.view_count, 5000, "更新的数值要写进去");
  assert.deepEqual(item.annotation, { status: "pending", model: null, at: null });

  store.upsertItem({ ...item, topics: [{ t: "tech", w: 1 }], value_notes: { evidence: "strong" }, annotation: { status: "ai", model: "deepseek-chat", at: 1 } });
  const labelled = store.getItem("cid-1");
  assert.deepEqual(labelled.topics, [{ t: "tech", w: 1 }]);
  assert.deepEqual(labelled.value_notes, { evidence: "strong" });
  assert.equal(labelled.annotation.status, "ai");
  assert.deepEqual(labelled.facets, []);

  store.patchItem("cid-1", { topics: [{ t: "study", w: 1 }], annotation: { status: "manual", model: null, at: 2 } });
  store.ensureItemForObservation(observation({ title: "改过的标题" }));
  const manual = store.getItem("cid-1");
  assert.equal(manual.annotation.status, "manual", "人工更正不被观测覆盖");
  assert.deepEqual(manual.topics, [{ t: "study", w: 1 }]);
  assert.equal(manual.title, "改过的标题");
  assert.equal(store.patchItem("missing", {}), null);
});

test("addExposure/addAction 幂等：相同 id 第二次返回 false", async (t) => {
  const { store } = openStore(t);
  const exposure = { exposure_id: "e1", session_id: "s1", content_id: "cid-1", exposed_at: 1700000000000, page_context: "home", observable_rank: 1, origin: "real" };
  assert.equal(store.addExposure(exposure), true);
  assert.equal(store.addExposure({ ...exposure, observable_rank: 9 }), false, "重复曝光被跳过且不改写首见 rank");
  assert.equal(store.getExposures()[0].observable_rank, 1);
  assert.equal(store.getExposures()[0].profile_id, "local-default");

  const action = { action_id: "a1", session_id: "s1", content_id: "cid-1", action_type: "open", occurred_at: 1700000000000, origin: "real" };
  assert.equal(store.addAction(action), true);
  assert.equal(store.addAction(action), false);
  assert.equal(store.getActions().length, 1);
});

test("goal 往返 + version 覆盖写", async (t) => {
  const { store } = openStore(t);
  assert.equal(store.getGoal(), null);
  store.setGoal({
    profile_id: "local-default",
    goal_text: "学 AI",
    intent_mode: "skill",
    goal_topics: [{ t: "tech", w: 1 }],
    exclusions: ["带货"],
    exploration_level: 0.5,
    updated_at: 1700000000000,
    version: 1,
    source: "user",
  });
  const first = store.getGoal();
  assert.equal(first.goal_text, "学 AI");
  assert.deepEqual(first.goal_topics, [{ t: "tech", w: 1 }]);
  assert.deepEqual(first.exclusions, ["带货"]);
  store.setGoal({ ...first, goal_text: "改主意了", version: 2 });
  const second = store.getGoal();
  assert.equal(second.goal_text, "改主意了");
  assert.equal(second.version, 2);
  const rows = store.getItems().length;
  assert.equal(rows, 0);
});

test("exportJSONL 三类记录 + goal 各一行且带 type 字段", async (t) => {
  const { store } = openStore(t);
  store.ensureItemForObservation(observation());
  store.addExposure({ exposure_id: "e1", session_id: "s1", content_id: "cid-1", exposed_at: 1, page_context: "home", observable_rank: 1, origin: "real" });
  store.addAction({ action_id: "a1", session_id: "s1", content_id: "cid-1", action_type: "open", occurred_at: 2, origin: "real" });
  store.setGoal({ profile_id: "local-default", goal_text: "学 AI", intent_mode: "skill", goal_topics: [], exclusions: [], exploration_level: 0.5, updated_at: 3, version: 1, source: "user" });

  const text = store.exportJSONL();
  assert.ok(text.endsWith("\n"));
  const records = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), ["item", "exposure", "action", "goal"]);
  assert.equal(records[0].content_id, "cid-1");
  assert.deepEqual(records[0].comments, ["热评1", "热评2"]);
  assert.equal(records[3].goal_text, "学 AI");
});

test("reset 清空并返回计数；data_mode 随 origin 变化", async (t) => {
  const { store } = openStore(t);
  store.ensureItemForObservation(observation());
  store.addExposure({ exposure_id: "e1", session_id: "s1", content_id: "cid-1", exposed_at: 1, page_context: "home", observable_rank: 1, origin: "real" });
  assert.equal(store.dataMode(), "real");
  assert.equal(store.stats().data_mode, "real");

  store.ensureItemForObservation(observation({ content_id: "cid-2", origin: "synthetic", canonical_key: "k2" }));
  assert.equal(store.dataMode(), "mixed");

  const cleared = store.reset();
  assert.deepEqual(cleared, { items: 2, exposures: 1, actions: 0 });
  assert.deepEqual(store.stats().counts, { items: 0, exposures: 0, actions: 0 });
  assert.equal(store.exportJSONL(), "");
  assert.equal(store.dataMode(), "empty");
});

test("重开同一个 db 文件数据仍在（服务重启不丢观测）", async (t) => {
  const dir = tempDir("store-reopen");
  t.after(() => cleanup(dir));
  const file = join(dir, "aiwatcher.db");
  const first = createStore({ file });
  first.ensureItemForObservation(observation());
  first.addExposure({ exposure_id: "e1", session_id: "s1", content_id: "cid-1", exposed_at: 1, page_context: "home", observable_rank: 1, origin: "real" });
  first.close();

  const second = createStore({ file });
  t.after(() => second.close());
  assert.equal(second.getItems().length, 1);
  assert.equal(second.getExposures().length, 1);
});

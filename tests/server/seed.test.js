import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createStore } from "../../src/server/store.js";
import { tempDir, cleanup } from "./_helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const MAIN = join(ROOT, "src", "server", "main.js");
const FIXTURES = join(ROOT, "fixtures", "replay-14d.jsonl");

const FIXTURE_COUNTS = (() => {
  const counts = { items: 0, exposures: 0, actions: 0 };
  for (const line of readFileSync(FIXTURES, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.type === "item") counts.items += 1;
    else if (record.type === "exposure") counts.exposures += 1;
    else if (record.type === "action") counts.actions += 1;
  }
  return counts;
})();

const TOTAL_FIXTURE = FIXTURE_COUNTS.items + FIXTURE_COUNTS.exposures + FIXTURE_COUNTS.actions;

// 子进程环境：明确去掉 key，保证测试不触网、不受开发机 key 影响。
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "DEEPSEEK_API_KEY") continue;
    env[key] = value;
  }
  return env;
}

function runCli(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [MAIN, ...args], { cwd: ROOT, env: childEnv() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function openStore(dir) {
  return createStore({ file: join(dir, "aiwatcher.db"), profileId: "local-default" });
}

function seedRealRecords(dir) {
  const store = openStore(dir);
  store.upsertItem({
    content_id: "real_1", platform: "bilibili", canonical_key: "real_1", title: "真实浏览记录",
    url: "https://www.bilibili.com/video/BVreal", source_id: "mid_real", source_name: "真UP",
    origin: "real", topics: [{ t: "tech", w: 1 }], fetched_at: 1_700_000_000_000,
  });
  store.addExposure({
    exposure_id: "real_exp_1", content_id: "real_1", exposed_at: 1_700_000_000_000,
    page_context: "home", observable_rank: 1, origin: "real",
  });
  store.setGoal({
    profile_id: "local-default", goal_text: "我自己的真实目标", intent_mode: "skill",
    goal_topics: [{ t: "study", w: 1 }], exclusions: [], version: 9, updated_at: 1_700_000_000_000,
  });
  store.close();
}

test("--seed 把 fixtures 灌进服务同款 aiwatcher.db，数量与 fixture 一致", async () => {
  const dir = tempDir("seed-fresh");
  try {
    const result = await runCli(["--replay", "--seed", "--data-dir", dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[seed\] 已清空 0 条既有真实记录并替换为合成回放数据/);
    assert.ok(existsSync(join(dir, "aiwatcher.db")), "应创建 aiwatcher.db");
    assert.ok(!existsSync(join(dir, "replay.db")), "--seed 时不应创建 replay.db");

    const store = openStore(dir);
    const counts = store.stats().counts;
    assert.deepEqual(counts, FIXTURE_COUNTS);
    assert.equal(store.stats().data_mode, "synthetic");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("重复 --seed 不翻倍：先清空再灌，数量稳定且 origin 保持 synthetic", async () => {
  const dir = tempDir("seed-twice");
  try {
    await runCli(["--replay", "--seed", "--data-dir", dir]);
    const second = await runCli(["--replay", "--seed", "--data-dir", dir]);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, new RegExp("已清空 " + TOTAL_FIXTURE + " 条既有真实记录"));

    const store = openStore(dir);
    assert.deepEqual(store.stats().counts, FIXTURE_COUNTS);
    const origins = new Set(store.getItems().map((item) => item.origin));
    assert.deepEqual([...origins], ["synthetic"]);
    const exposureOrigins = new Set(store.getExposures().map((entry) => entry.origin));
    assert.deepEqual([...exposureOrigins], ["synthetic"]);
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("--seed 默认清空既有真实记录，并如实报告清了多少条", async () => {
  const dir = tempDir("seed-clears");
  try {
    seedRealRecords(dir);
    const result = await runCli(["--replay", "--seed", "--data-dir", dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[seed\] 已清空 2 条既有真实记录并替换为合成回放数据（items=1 exposures=1 actions=0 goal=yes）/);

    const store = openStore(dir);
    assert.deepEqual(store.stats().counts, FIXTURE_COUNTS);
    assert.equal(store.stats().data_mode, "synthetic");
    assert.equal(store.getItem("real_1"), null, "既有真实内容应被清掉");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("--append 不清空：既有真实记录与目标都保留，data_mode 如实变 mixed", async () => {
  const dir = tempDir("seed-append");
  try {
    seedRealRecords(dir);
    const result = await runCli(["--replay", "--seed", "--append", "--data-dir", dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[seed\] 追加模式：保留既有 2 条记录/);
    assert.match(result.stdout, /库里已有目标，保留原目标未覆盖/);
    assert.doesNotMatch(result.stdout, /已清空/);

    const store = openStore(dir);
    const counts = store.stats().counts;
    assert.equal(counts.items, FIXTURE_COUNTS.items + 1);
    assert.equal(counts.exposures, FIXTURE_COUNTS.exposures + 1);
    assert.equal(counts.actions, FIXTURE_COUNTS.actions);
    assert.equal(store.stats().data_mode, "mixed");
    assert.equal(store.getGoal().goal_text, "我自己的真实目标");
    store.close();
  } finally {
    cleanup(dir);
  }
});

test("不带 --seed 的老用法不变：只写 replay.db，不创建 aiwatcher.db", async () => {
  const dir = tempDir("seed-legacy");
  try {
    const result = await runCli(["--replay", "--data-dir", dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /db: .*replay\.db/);
    assert.ok(existsSync(join(dir, "replay.db")));
    assert.ok(!existsSync(join(dir, "aiwatcher.db")));
  } finally {
    cleanup(dir);
  }
});

test("参数校验：--append 或 --seed 单独使用直接拒绝", async () => {
  const appendAlone = await runCli(["--replay", "--append", "--data-dir", tempDir("seed-badappend")]);
  assert.equal(appendAlone.code, 1);
  assert.match(appendAlone.stderr, /--append 只能与 --seed 一起使用/);

  const seedAlone = await runCli(["--seed"]);
  assert.equal(seedAlone.code, 1);
  assert.match(seedAlone.stderr, /--seed 只能与 --replay 一起使用/);
});

test("灌完后服务能直接读到演示画像（窗口锚在数据末尾，不是真实当天）", async () => {
  const dir = tempDir("seed-serve");
  try {
    await runCli(["--replay", "--seed", "--data-dir", dir]);
    const child = spawn(process.execPath, [MAIN, "--port", "0", "--data-dir", dir], { cwd: ROOT, env: childEnv() });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    let port = null;
    for (let i = 0; i < 80 && !port; i += 1) {
      const match = /port: (\d+)/.exec(stdout);
      if (match) port = Number(match[1]);
      else await sleep(100);
    }
    assert.ok(port, "服务应打印端口: " + stdout);
    try {
      const profile = await fetch("http://127.0.0.1:" + port + "/api/profile?days=7").then((r) => r.json());
      assert.equal(profile.data_mode, "synthetic");
      assert.ok(profile.window.exposure_count > 280, "演示窗口应有完整曝光量，实际 " + profile.window.exposure_count);
      assert.ok(profile.window.end > Date.now(), "窗口应锚在数据末尾（合成数据晚于真实时钟）");
      assert.ok(Array.isArray(profile.alerts) && profile.alerts.length >= 3);
      assert.ok(typeof profile.ai?.narrative === "string" && profile.ai.narrative.length > 0);
    } finally {
      child.kill("SIGTERM");
    }
  } finally {
    cleanup(dir);
  }
});

// 读到启动日志满 5 行就收手，避免测试等端口超时。
async function readStartupLog(args) {
  const child = spawn(process.execPath, [MAIN, ...args], { cwd: ROOT, env: childEnv() });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  try {
    for (let i = 0; i < 120; i += 1) {
      if (out.split("\n").filter((line) => line.trim()).length >= 5) break;
      await sleep(100);
    }
  } finally {
    child.kill("SIGTERM");
  }
  return out;
}

test("启动日志第 5 行标注虚拟时钟（数据时间戳晚于本机时钟）", async () => {
  const dir = tempDir("clock-virtual");
  try {
    await runCli(["--replay", "--seed", "--data-dir", dir]);
    const log = await readStartupLog(["--port", "0", "--data-dir", dir]);
    const lines = log.split("\n").filter((line) => line.trim());
    assert.equal(lines.length, 5, "启动日志应正好 5 行：" + JSON.stringify(lines));
    assert.match(lines[4], /^now: \d{4}-\d{2}-\d{2}T[\d:.]+Z \(virtual, \+\d+\.\dd\)$/, "第 5 行：" + lines[4]);
    assert.doesNotMatch(log, /sk-|authorization|api_key/i, "启动日志不得含 key");
  } finally {
    cleanup(dir);
  }
});

test("启动日志第 5 行标注真实时钟（空库）", async () => {
  const dir = tempDir("clock-real");
  try {
    const log = await readStartupLog(["--port", "0", "--data-dir", dir]);
    const lines = log.split("\n").filter((line) => line.trim());
    assert.equal(lines.length, 5, "启动日志应正好 5 行：" + JSON.stringify(lines));
    assert.match(lines[4], /^now: \d{4}-\d{2}-\d{2}T[\d:.]+Z \(real\)$/, "第 5 行：" + lines[4]);
    assert.doesNotMatch(log, /sk-|authorization|api_key/i, "启动日志不得含 key");
  } finally {
    cleanup(dir);
  }
});

test("--seed 在合成数据晚于本机时钟时打印虚拟时钟提示", async () => {
  const dir = tempDir("seed-hint");
  try {
    const result = await runCli(["--replay", "--seed", "--data-dir", dir]);
    assert.equal(result.code, 0, result.stderr);
    const hint = result.stdout.split("\n").find((line) => line.startsWith("提示："));
    assert.ok(hint, "应打印虚拟时钟提示：" + result.stdout.slice(0, 200));
    assert.match(hint, /^提示：合成数据比本机时钟晚 \d+\.\d 天，服务将以虚拟时钟运行；演示请用独立 --data-dir，避免与真实观察混在一个库里$/);
    // 提示必须在报告之后
    assert.ok(result.stdout.indexOf("提示：") > result.stdout.indexOf("=== AI Watcher replay report ==="));
  } finally {
    cleanup(dir);
  }
});

test("数据早于本机时钟时不打印提示，且服务用真实时钟", async () => {
  const dir = tempDir("seed-old");
  try {
    const fixtures = join(dir, "old.jsonl");
    const old = 1_600_000_000_000; // 2020-09，肯定早于本机时钟
    writeFileSync(
      fixtures,
      [
        JSON.stringify({ type: "item", content_id: "old_1", platform: "bilibili", canonical_key: "old_1", title: "旧数据", url: "https://x/old", source_id: "mid_old", source_name: "旧UP", origin: "synthetic", topics: [{ t: "tech", w: 1 }], fetched_at: old }),
        JSON.stringify({ type: "exposure", exposure_id: "old_exp_1", content_id: "old_1", exposed_at: old, page_context: "home", observable_rank: 1, origin: "synthetic" }),
        JSON.stringify({ type: "action", action_id: "old_act_1", content_id: "old_1", action_type: "open", occurred_at: old, origin: "synthetic" }),
      ].join("\n") + "\n",
    );
    const result = await runCli(["--replay", "--seed", "--fixtures", fixtures, "--data-dir", dir]);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /提示：合成数据比本机时钟晚/);

    const log = await readStartupLog(["--port", "0", "--data-dir", dir]);
    const lines = log.split("\n").filter((line) => line.trim());
    assert.match(lines[4], /\(real\)$/, "第 5 行：" + lines[4]);
  } finally {
    cleanup(dir);
  }
});


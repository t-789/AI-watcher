import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createStore } from "./store.js";
import { createAI, CONTRACT_VALUES, TOPICS } from "./ai.js";
import { createLabeler } from "./labeler.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const DEFAULT_DATA_DIR = join(ROOT, "data");
const DEFAULT_FIXTURES = join(ROOT, "fixtures", "replay-14d.jsonl");

const USAGE = [
  "用法: node src/server/main.js [选项]",
  "  --port <n>        监听端口（默认 3789）",
  "  --data-dir <path> 数据目录（默认 <repo>/data）",
  "  --replay          读 fixtures/replay-14d.jsonl 灌入独立 replay.db 并打印文本报告",
  "  --seed            与 --replay 合用：灌进服务同款 aiwatcher.db（悬浮窗可直接读），默认先清空既有记录",
  "  --append          与 --seed 合用：保留既有记录并追加，不清空",
  "  --fixtures <path> 覆盖 replay 使用的 JSONL 路径",
].join("\n");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const dataDir = resolve(args.dataDir ?? DEFAULT_DATA_DIR);
mkdirSync(dataDir, { recursive: true });

// src/core 归 TASK-CORE：现在是常量存根或仍在实现，import 失败/无 buildSnapshot 都必须让服务照常起。
const core = await loadCore();
const constants = {
  PORT: core?.PORT ?? CONTRACT_VALUES.PORT,
  SCHEMA_VERSION: core?.SCHEMA_VERSION ?? CONTRACT_VALUES.SCHEMA_VERSION,
  PROFILE_ID: core?.PROFILE_ID ?? CONTRACT_VALUES.PROFILE_ID,
  WINDOW_DAYS: core?.WINDOW_DAYS ?? CONTRACT_VALUES.WINDOW_DAYS,
};
const analyze = typeof core?.buildSnapshot === "function" ? core.buildSnapshot : null;
const port = args.port ?? constants.PORT;

if (args.replay) {
  await runReplay({
    dataDir,
    fixtures: args.fixtures ?? DEFAULT_FIXTURES,
    analyze,
    windowDays: constants.WINDOW_DAYS,
    seed: args.seed,
    append: args.append,
  });
} else {
  await runServer({ dataDir, port });
}

async function loadCore() {
  try {
    return await import("../core/index.js");
  } catch {
    return null;
  }
}

// 窗口基准 now = max(真实时钟, 最后一条记录时间)。
// 理由（规划书 §6.3）：回放/演示数据的时间戳可能晚于程序运行当天，用真实时钟会把它们全部排除在
// [now-days, now) 之外，画像变成空的。数据比现在旧时 max 取真实时钟，行为与 Date.now() 完全一致。
// 启动日志第 5 行：让人一眼看出窗口基准是"今天"还是"数据末尾"。
function describeClock(clockNow, realNow) {
  const iso = new Date(clockNow).toISOString();
  if (clockNow > realNow) return "now: " + iso + " (virtual, +" + ((clockNow - realNow) / 86400000).toFixed(1) + "d)";
  return "now: " + iso + " (real)";
}

function makeDatasetClock(store, realNow = () => Date.now()) {
  let signature = null;
  let latest = 0;
  return {
    now() {
      const counts = store.stats().counts;
      const next = counts.items + "|" + counts.exposures + "|" + counts.actions;
      if (next !== signature) {
        const ts = latestTimestamp(store.getItems(), store.getExposures(), store.getActions());
        latest = Number.isFinite(ts) ? ts : 0;
        signature = next;
      }
      return Math.max(realNow(), latest);
    },
  };
}

async function runServer({ dataDir: dir, port: listenPort }) {
  const store = createStore({ file: join(dir, "aiwatcher.db"), profileId: constants.PROFILE_ID });
  const ai = createAI({ cachePath: join(dir, "ai-cache.jsonl") });
  const labeler = createLabeler({
    store,
    ai,
    log: (...parts) => console.error(...parts),
  });
  const clock = makeDatasetClock(store);
  const app = createApp({
    store,
    labeler,
    analyze,
    clock,
    parseGoal: typeof core?.parseGoalText === "function" ? core.parseGoalText : null,
    structureGoal: typeof ai.structureGoal === "function" ? (input) => ai.structureGoal(input) : null,
    applyRelaxIntent: typeof core?.applyRelaxIntent === "function" ? core.applyRelaxIntent : null,
    port: listenPort,
    version: constants.SCHEMA_VERSION,
    profileId: constants.PROFILE_ID,
    windowDays: constants.WINDOW_DAYS,
  });

  const server = createServer(app);
  await new Promise((onReady, onError) => {
    server.once("error", onError);
    server.listen(listenPort, "127.0.0.1", onReady);
  });

  // 启动日志只到这五个字段为止：端口 / data 目录 / ai.mode / 模型名 / 时钟基准。key 一个字符都不打。
  console.log("port: " + server.address().port);
  console.log("data: " + dir);
  console.log("ai.mode: " + ai.mode);
  console.log("model: " + ai.model);
  console.log(describeClock(clock.now(), Date.now()));

  const shutdown = () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runReplay({ dataDir: dir, fixtures, analyze: analyzeFn, windowDays, seed = false, append = false }) {
  if (!existsSync(fixtures)) {
    console.error("[replay] 找不到 fixtures：" + fixtures);
    console.error("[replay] 需要 TASK-CORE 生成 fixtures/replay-14d.jsonl，或用 --fixtures <path> 指定 JSONL 文件。");
    process.exit(2);
  }

  // --seed 写服务同款库（悬浮窗/API 直接读到）；不带 --seed 仍写独立 replay.db，用完即弃。
  const dbFile = join(dir, seed ? "aiwatcher.db" : "replay.db");
  if (!seed) {
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(dbFile + suffix)) unlinkSync(dbFile + suffix);
    }
  }
  let store;
  try {
    store = createStore({ file: dbFile, profileId: constants.PROFILE_ID });
  } catch (error) {
    if (seed) console.error("[seed] 打不开 " + dbFile + "：" + (error?.message ?? error) + "（服务是否正在运行？先停掉再灌数据）");
    throw error;
  }

  if (seed) {
    const before = store.stats().counts;
    const total = before.items + before.exposures + before.actions;
    if (append) {
      console.log("[seed] 追加模式：保留既有 " + total + " 条记录（items=" + before.items + " exposures=" + before.exposures + " actions=" + before.actions + "），不清空");
    } else {
      const hadGoal = Boolean(store.getGoal());
      const cleared = store.reset();
      const clearedTotal = (cleared.items ?? 0) + (cleared.exposures ?? 0) + (cleared.actions ?? 0);
      console.log(
        "[seed] 已清空 " + clearedTotal + " 条既有真实记录并替换为合成回放数据" +
          "（items=" + (cleared.items ?? 0) + " exposures=" + (cleared.exposures ?? 0) + " actions=" + (cleared.actions ?? 0) + (hadGoal ? " goal=yes" : "") + "）",
      );
    }
  }

  const loaded = loadReplay(store, fixtures, { keepGoal: seed && append });

  const items = store.getItems();
  const exposures = store.getExposures();
  const actions = store.getActions();
  const goal = store.getGoal();
  const now = latestTimestamp(items, exposures, actions) ?? Date.now();

  const lines = [];
  lines.push("=== AI Watcher replay report ===");
  lines.push("fixtures: " + fixtures);
  lines.push("db: " + dbFile);
  lines.push("records: items=" + loaded.items + " exposures=" + loaded.exposures + " actions=" + loaded.actions + " goal=" + (goal ? "yes" : "no") + " bad_lines=" + loaded.bad);

  let snapshot = null;
  if (analyzeFn) {
    try {
      snapshot = analyzeFn({ items, exposures, actions, goal, now, windowDays });
    } catch (error) {
      console.error("[replay] buildSnapshot 抛错，退回本地基础统计：" + (error?.message ?? error));
      snapshot = null;
    }
  }

  const report = snapshot ? fromSnapshot(snapshot) : basicStats({ items, exposures, actions, now, windowDays });
  const window = report.window;
  lines.push("window: " + formatTime(window.start) + " ~ " + formatTime(window.end) + " (" + window.days + "d) exposures=" + window.exposure_count + " unique_items=" + window.unique_items);
  lines.push("topics: " + (report.topics.length ? report.topics.map((entry) => entry.t + " " + entry.w.toFixed(3)).join(" | ") : "(无已知主题)"));
  lines.push("entropy: " + (report.entropy == null ? "n/a" : report.entropy.toFixed(3)) + " (归一化, K=" + TOPICS.length + ")");
  lines.push("repeat_rate: " + (report.repeat_rate == null ? "n/a" : report.repeat_rate.toFixed(3)));
  lines.push("top_source: " + (report.top_source ? report.top_source.name + " " + (report.top_source.share * 100).toFixed(1) + "% (n=" + report.top_source.n + ")" : "n/a"));
  lines.push("alerts (" + report.alerts.length + "):");
  if (report.alerts.length === 0) lines.push("  - (无)");
  for (const alert of report.alerts) lines.push("  - [" + alert.severity + "] " + alert.rule_id + " · " + alert.title);
  if (!analyzeFn) {
    lines.push("note: 分析核心尚未提供 buildSnapshot（src/core/index.js 仅常量存根），以上为本地基础统计，不含规则 alerts。");
  }
  console.log(lines.join("\n"));

  // 数据时间戳晚于本机时钟时，服务会以虚拟时钟运行——这件事必须让用户看见，不能只写在文档里。
  if (seed) {
    const realNow = Date.now();
    const latest = latestTimestamp(items, exposures, actions);
    if (Number.isFinite(latest) && latest > realNow) {
      console.log(
        "提示：合成数据比本机时钟晚 " + ((latest - realNow) / 86400000).toFixed(1) +
          " 天，服务将以虚拟时钟运行；演示请用独立 --data-dir，避免与真实观察混在一个库里",
      );
    }
  }
  store.close();
}

function fromSnapshot(snapshot) {
  const exposure = snapshot.exposure ?? {};
  const window = snapshot.window ?? {};
  return {
    window: {
      start: window.start ?? 0,
      end: window.end ?? 0,
      days: window.days ?? constants.WINDOW_DAYS,
      exposure_count: window.exposure_count ?? 0,
      unique_items: window.unique_items ?? 0,
    },
    topics: (Array.isArray(exposure.topics) ? exposure.topics : []).map((entry) => ({ t: entry.t, w: entry.w ?? 0 })),
    entropy: typeof exposure.entropy === "number" ? exposure.entropy : null,
    repeat_rate: typeof exposure.repeat_rate === "number" ? exposure.repeat_rate : null,
    top_source: exposure.top_source ?? null,
    alerts: Array.isArray(snapshot.alerts)
      ? snapshot.alerts.map((alert) => ({ rule_id: alert.rule_id, severity: alert.severity ?? "info", title: alert.title ?? "" }))
      : [],
  };
}

// 分析核心未就绪时的最小统计：口径与契约 §6.5 一致（半开窗口、已知主题占比单列）。
function basicStats({ items, exposures, actions, now, windowDays }) {
  const start = now - windowDays * 86400000;
  const byId = new Map(items.map((item) => [item.content_id, item]));
  const inWindow = exposures.filter((entry) => Number.isFinite(entry.exposed_at) && entry.exposed_at >= start && entry.exposed_at < now);
  const totals = new Map();
  let known = 0;
  let unknown = 0;
  const uniqueItems = new Set();
  const sources = new Map();
  let knownSource = 0;
  for (const exposure of inWindow) {
    uniqueItems.add(exposure.content_id);
    const item = byId.get(exposure.content_id);
    const topics = Array.isArray(item?.topics) ? item.topics.filter((entry) => entry && TOPICS.includes(entry.t) && typeof entry.w === "number") : [];
    if (topics.length) {
      known += 1;
      for (const entry of topics) totals.set(entry.t, (totals.get(entry.t) ?? 0) + entry.w);
    } else {
      unknown += 1;
    }
    const sourceKey = item?.source_id ?? item?.source_name ?? null;
    if (sourceKey) {
      knownSource += 1;
      const bucket = sources.get(sourceKey) ?? { id: sourceKey, name: item?.source_name ?? sourceKey, n: 0 };
      bucket.n += 1;
      sources.set(sourceKey, bucket);
    }
  }
  const topics = known
    ? [...totals.entries()].map(([t, w]) => ({ t, w: w / known })).sort((a, b) => b.w - a.w || (a.t < b.t ? -1 : 1))
    : [];
  const entropy = topics.length ? -topics.reduce((acc, entry) => acc + (entry.w > 0 ? entry.w * Math.log(entry.w) : 0), 0) / Math.log(TOPICS.length) : null;
  const topSource = knownSource
    ? [...sources.values()].sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1))[0]
    : null;
  return {
    window: { start, end: now, days: windowDays, exposure_count: inWindow.length, unique_items: uniqueItems.size },
    topics,
    entropy,
    repeat_rate: inWindow.length ? 1 - uniqueItems.size / inWindow.length : null,
    top_source: topSource ? { id: topSource.id, name: topSource.name, n: topSource.n, share: topSource.n / knownSource } : null,
    alerts: [],
    actions: actions.length,
    unknown_ratio: inWindow.length ? unknown / inWindow.length : null,
  };
}

function loadReplay(store, file, options = {}) {
  const text = readFileSync(file, "utf8");
  const buckets = { items: [], exposures: [], actions: [], goal: null, bad: 0 };
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      buckets.bad += 1;
      continue;
    }
    if (!record || typeof record !== "object") {
      buckets.bad += 1;
      continue;
    }
    const kind = record.type ?? inferKind(record);
    if (kind === "item") buckets.items.push(record);
    else if (kind === "exposure") buckets.exposures.push(record);
    else if (kind === "action") buckets.actions.push(record);
    else if (kind === "goal") buckets.goal = record;
    else buckets.bad += 1;
  }
  for (const record of buckets.items) store.upsertItem(record);
  for (const record of buckets.exposures) store.addExposure(record);
  for (const record of buckets.actions) store.addAction(record);
  if (buckets.goal) {
    if (options.keepGoal && store.getGoal()) {
      console.log("[seed] 库里已有目标，保留原目标未覆盖（--append 不覆盖用户设置）");
    } else {
      store.setGoal({ profile_id: constants.PROFILE_ID, ...buckets.goal });
    }
  }
  return { items: buckets.items.length, exposures: buckets.exposures.length, actions: buckets.actions.length, goal: Boolean(buckets.goal), bad: buckets.bad };
}

// 兼容没有 type 字段的 JSONL：按契约的实体字段推断。
function inferKind(record) {
  if (typeof record.exposure_id === "string") return "exposure";
  if (typeof record.action_id === "string") return "action";
  if (typeof record.goal_text === "string") return "goal";
  if (typeof record.content_id === "string") return "item";
  return "unknown";
}

function latestTimestamp(items, exposures, actions) {
  let max = null;
  const consider = (value) => {
    if (Number.isFinite(value) && (max === null || value > max)) max = value;
  };
  for (const item of items) {
    consider(item.fetched_at);
    consider(item.published_at);
  }
  for (const exposure of exposures) consider(exposure.exposed_at);
  for (const action of actions) consider(action.occurred_at);
  return max;
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function parseArgs(argv) {
  const out = { port: null, dataDir: null, replay: false, fixtures: null, help: false, seed: false, append: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") out.port = Number(argv[++index]);
    else if (arg.startsWith("--port=")) out.port = Number(arg.slice(7));
    else if (arg === "--data-dir") out.dataDir = argv[++index];
    else if (arg.startsWith("--data-dir=")) out.dataDir = arg.slice(11);
    else if (arg === "--replay") out.replay = true;
    else if (arg === "--seed") out.seed = true;
    else if (arg === "--append") out.append = true;
    else if (arg === "--fixtures") out.fixtures = argv[++index];
    else if (arg.startsWith("--fixtures=")) out.fixtures = arg.slice(11);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else {
      console.error("未知参数: " + arg);
      console.error(USAGE);
      process.exit(1);
    }
  }
  if (out.port != null && !Number.isInteger(out.port)) {
    console.error("--port 必须是整数");
    process.exit(1);
  }
  if (out.seed && !out.replay) {
    console.error("--seed 只能与 --replay 一起使用");
    console.error(USAGE);
    process.exit(1);
  }
  if (out.append && !out.seed) {
    console.error("--append 只能与 --seed 一起使用（不带 --seed 时写的是独立 replay.db，每次都会重建）");
    console.error(USAGE);
    process.exit(1);
  }
  return out;
}

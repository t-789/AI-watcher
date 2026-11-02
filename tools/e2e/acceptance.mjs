// AI Watcher 真机验收 v2：CDP 装载扩展 → 真点击进入视频（产生行为）→ 叙述缓存 → 冷启动离线降级。
// 用法：bash -lc 'source ~/.zshrc; node tools/e2e/acceptance.mjs'
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "/Users/liuzy/Desktop/AI-watcher";
const require = createRequire(ROOT + "/ignore/temp/e2e-deps/");
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXT = ROOT + "/extension";
const PORT = 3789, CDP_PORT = 9411;
const BASE = "http://127.0.0.1:" + PORT;
const DATA = ROOT + "/ignore/temp/data-e2e";
const PROFILE = ROOT + "/ignore/temp/profile-accept";
const SHOTS = ROOT + "/ignore/temp/shots";
const results = [];
const check = (n, ok, d = "") => { results.push({ name: n, ok, detail: d }); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  — " + d : "")); };
const api = async (p) => (await fetch(BASE + p)).json();

const chromeArgs = (extra) => ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-breakpad",
  "--disable-crash-reporter", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
  "--window-size=1440,900", "--lang=zh-CN", "--remote-debugging-port=" + CDP_PORT,
  "--user-data-dir=" + PROFILE, ...extra, "about:blank"];

async function launch(extra) {
  const proc = spawn(CHROME, chromeArgs(extra), { stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; proc.stdout.on("data", (d) => (log += d)); proc.stderr.on("data", (d) => (log += d));
  let ws = null;
  for (let i = 0; i < 60; i++) {
    try { ws = (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version").then((r) => r.json())).webSocketDebuggerUrl; if (ws) break; } catch {}
    await sleep(300);
  }
  if (!ws) throw new Error("Chrome CDP 未起来: " + log.slice(-300));
  const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
  return { proc, browser };
}
async function installExt(browser) {
  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
  for (let i = 0; i < 30; i++) {
    const t = browser.targets().find((x) => x.url().includes(id));
    if (t) return { id, target: t };
    await sleep(300);
  }
  return { id, target: null };
}
const ballOf = (page) => page.evaluate(() => {
  const h = document.getElementById("ai-watcher-host");
  const b = h && h.shadowRoot && h.shadowRoot.querySelector("[data-role=ball]");
  return b ? { text: b.textContent.replace(/\s+/g, " ").trim().slice(0, 40), offline: b.dataset.offline } : null;
});

let serverProc = null, c1 = null, c2 = null, srvLog = "";
const startServer = async () => {
  const p = spawn(process.execPath, ["src/server/main.js", "--port", String(PORT), "--data-dir", DATA],
    { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => (srvLog += d)); p.stderr.on("data", (d) => (srvLog += d));
  for (let i = 0; i < 40; i++) { try { await api("/api/status"); return p; } catch { await sleep(250); } }
  return p;
};

try {
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true }); mkdirSync(DATA, { recursive: true });

  serverProc = await startServer();
  const st = await api("/api/status");
  check("本地服务在 3789 启动", st?.ok === true, "ai.mode=" + st?.ai?.mode + " model=" + st?.ai?.model);
  check("启动日志不含 key", !/sk-|authorization|api_key/i.test(srvLog), srvLog.trim().replace(/\n/g, " | ").slice(0, 140));

  c1 = await launch(["--enable-unsafe-extension-debugging"]);
  const { id, target } = await installExt(c1.browser);
  check("扩展被 Chrome 156 接受并装载", !!id, "id=" + id);
  check("我们的扩展 service worker 起来了（按 id 校验，不再误认内置组件）", !!target, target ? target.url() : "(none)");

  const page = await c1.browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror:" + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Permissions policy|unload is not allowed/.test(m.text())) errors.push("console:" + m.text().slice(0, 150)); });

  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(6000);
  for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 900)); await sleep(1500); }
  await sleep(2000);
  const ball = await ballOf(page);
  check("悬浮球渲染在真实B站页面（shadow DOM）", !!ball, JSON.stringify(ball));
  const s1 = await api("/api/status");
  check("首页曝光已入库", (s1.counts?.exposures ?? 0) > 0, "exposures=" + s1.counts?.exposures + " items=" + s1.counts?.items);
  await page.screenshot({ path: SHOTS + "/b1-home-ball.png" });

  // 真点击进入视频（不是 goto），让行为侧产生 open
  const clicked = await page.evaluate(() => {
    const a = [...document.querySelectorAll("a[href*='/video/BV']")].find((x) => x.offsetParent !== null);
    if (!a) return null;
    a.click();
    return a.href;
  });
  await sleep(9000);
  const s2 = await api("/api/status");
  check("真点击后行为被记录（open）", (s2.counts?.actions ?? 0) >= 1, "actions " + (s1.counts?.actions ?? 0) + "→" + (s2.counts?.actions ?? 0) + " url=" + String(clicked).slice(-14));
  await page.screenshot({ path: SHOTS + "/b2-video.png" });

  await page.evaluate(() => document.getElementById("ai-watcher-host")?.shadowRoot?.querySelector("[data-role=ball]")?.click());
  await sleep(2500);
  await page.screenshot({ path: SHOTS + "/b3-drawer.png" });
  const drawer = await page.evaluate(() => document.getElementById("ai-watcher-host").shadowRoot.textContent.replace(/\s+/g, " "));
  const sections = ["观察条件", "我的目标", "曝光画像", "行为 vs 曝光", "提醒", "操作"];
  check("抽屉渲染六个分区", sections.every((k) => drawer.includes(k)), sections.filter((k) => !drawer.includes(k)).join(",") || "all present");

  const goal = await fetch(BASE + "/api/goal", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal_text: "这个月想搞懂大模型在自己电脑上怎么跑起来", intent_mode: "skill" }) }).then((r) => r.json());
  check("自然语言目标写入并结构化", (goal?.goal_topics?.length ?? 0) > 0, JSON.stringify(goal?.goal_topics ?? goal).slice(0, 110));

  const prof1 = await api("/api/profile?days=7");
  writeFileSync(ROOT + "/ignore/temp/e2e-profile.json", JSON.stringify(prof1, null, 2));
  check("GET /api/profile 返回真实快照", !!prof1?.window && prof1.data_mode === "real",
    "data_mode=" + prof1?.data_mode + " exposures=" + prof1?.window?.exposure_count + " actions=" + prof1?.window?.action_count + " alerts=" + prof1?.alerts?.length);
  check("三画像结构齐备（P 可用 / G 存在 / U 有结论或显式门槛原因）",
    !!(prof1?.exposure?.available && prof1?.goal?.present) && (prof1?.behavior?.available === true || /门槛|低于|不足/.test(prof1?.behavior?.reason || "")),
    "P=" + prof1?.exposure?.available + " U=" + prof1?.behavior?.available + " G=" + !!prof1?.goal?.present);
  // 单会话通常只有 1-3 个行为样本，minBehavior=10 时刻意不给 D（证据不足不下结论）。
  // 数据够不够"要显式说明"，不能静默 null；样本充足的情形由 tools/e2e/behavior-session.mjs 单独验证。
  const bWhy = prof1?.behavior?.reason || "";
  check("行为已记录且门槛判断显式（不静默出 null）",
    (prof1?.behavior?.sample_n ?? 0) >= 1 && (prof1?.behavior_cmp?.D != null || /门槛|低于|不足/.test(bWhy)),
    "sample_n=" + prof1?.behavior?.sample_n + " D=" + prof1?.behavior_cmp?.D + " reason=" + bWhy.slice(0, 40));
  check("AI 叙述可用", !!prof1?.ai?.narrative, (prof1?.ai?.narrative || "").slice(0, 70));

  // 标注还在跑时数据每秒都在变，指纹当然变；先等排队与在飞归零再验缓存。
  let settled = null;
  for (let i = 0; i < 40; i++) { settled = (await api("/api/status")).ai; if (settled.pending === 0) break; await sleep(1500); }
  check("标注队列已落定（等待上限 60s）", settled?.pending === 0, "pending=" + settled?.pending + " labeled=" + settled?.labeled + " unlabeled=" + settled?.unlabeled);
  // 页面上还在刷、采集器还在报，数据每秒都在变；冻结入库后再验缓存才有意义。
  await fetch(BASE + "/api/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: true }) });
  await sleep(3000);
  const before = (await api("/api/status")).ai;
  const prof2 = await api("/api/profile?days=7");
  const after = (await api("/api/status")).ai;
  await fetch(BASE + "/api/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paused: false }) });
  check("叙述有缓存：重复请求不再烧 token", after.requests === before.requests && (prof2?.ai?.narrative_cached === true || after.cache_hits > before.cache_hits),
    "requests " + before.requests + "→" + after.requests + " narrative_cached=" + prof2?.ai?.narrative_cached);
  check("标注进度可观测（pending 含在飞）", typeof after.pending === "number", "ai=" + JSON.stringify({ pending: after.pending, inflight: after.inflight, labeled: after.labeled, unlabeled: after.unlabeled }));
  check("页面无扩展引起的未捕获错误", errors.length === 0, errors.slice(0, 2).join(" | "));

  await c1.browser.close(); c1.proc.kill("SIGTERM"); c1 = null;
  await sleep(1200);

  // 冷启动 + 服务停机：扩展仍装载、悬浮球降级而不是崩
  serverProc.kill("SIGTERM"); await sleep(1500);
  check("服务已停止", await fetch(BASE + "/api/status").then(() => false).catch(() => true));
  c2 = await launch(["--enable-unsafe-extension-debugging"]);
  const inst2 = await installExt(c2.browser);
  const p2 = await c2.browser.newPage();
  await p2.setViewport({ width: 1440, height: 900 });
  await p2.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(6000);
  const off = await ballOf(p2);
  check("冷启动+服务未启动：悬浮球降级而不是崩掉", !!off && (off.offline === "1" || /未启动/.test(off.text)), JSON.stringify(off) + " id=" + inst2.id);
  await p2.screenshot({ path: SHOTS + "/b4-offline.png" });

  writeFileSync(ROOT + "/ignore/temp/e2e-report.json", JSON.stringify({ results, page_errors: errors, server_log: srvLog, drawer_head: drawer.slice(0, 2500), ai_before: before, ai_after: after }, null, 2));
} catch (e) {
  check("harness 未崩溃", false, String((e && e.stack) || e).slice(0, 400));
} finally {
  try { if (c1) { await c1.browser.close(); c1.proc.kill("SIGTERM"); } } catch {}
  try { if (c2) { await c2.browser.close(); c2.proc.kill("SIGTERM"); } } catch {}
  try { if (serverProc && !serverProc.killed) serverProc.kill("SIGTERM"); } catch {}
}
function httpOk(p) { return !!(p?.exposure?.available && p?.behavior?.available); }
const bad = results.filter((r) => !r.ok);
console.log("\n=== " + (results.length - bad.length) + "/" + results.length + " 通过" + (bad.length ? " · 失败：" + bad.map((b) => b.name).join(" / ") : ""));
process.exit(bad.length ? 1 : 0);

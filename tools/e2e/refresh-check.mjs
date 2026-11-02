// 验收 UI 刷新策略：打字不被清空 / 数据没变不重绘 / 重绘不打断状态 / 手动刷新可用
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const ROOT = "/Users/liuzy/Desktop/AI-watcher";
const require = createRequire(ROOT + "/ignore/temp/e2e-deps/");
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:3789", CDP = 9414;
const DATA = ROOT + "/ignore/temp/data-refresh", PROFILE = ROOT + "/ignore/temp/profile-refresh";
const res = [];
const check = (n, ok, d = "") => { res.push({ n, ok }); console.log((ok ? "PASS  " : "FAIL  ") + n + (d ? "  — " + d : "")); };
const api = async (p) => (await fetch(BASE + p)).json();

rmSync(DATA, { recursive: true, force: true }); rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ["src/server/main.js", "--port", "3789", "--data-dir", DATA], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
for (let i = 0; i < 40; i++) { try { await api("/api/status"); break; } catch { await sleep(250); } }
const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-breakpad", "--disable-crash-reporter",
  "--disable-dev-shm-usage", "--no-first-run", "--window-size=1440,900", "--remote-debugging-port=" + CDP,
  "--user-data-dir=" + PROFILE, "--enable-unsafe-extension-debugging", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let ws = null;
for (let i = 0; i < 60; i++) { try { ws = (await fetch("http://127.0.0.1:" + CDP + "/json/version").then(r => r.json())).webSocketDebuggerUrl; if (ws) break; } catch {} await sleep(300); }
const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
const cdp = await browser.target().createCDPSession();
await cdp.send("Extensions.loadUnpacked", { path: ROOT + "/extension" });
await sleep(1500);
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
await sleep(6000);
await page.evaluate(() => document.getElementById("ai-watcher-host")?.shadowRoot?.querySelector("[data-role=ball]")?.click());
await sleep(2500);

const seq = () => page.evaluate(() => Number(document.getElementById("ai-watcher-host").dataset.renderSeq || 0));
const inputState = () => page.evaluate(() => {
  const sr = document.getElementById("ai-watcher-host").shadowRoot;
  const el = sr.querySelector("[data-role=goal-input]");
  return { value: el?.value ?? null, focused: sr.activeElement === el || document.activeElement === el };
});

// A. 打字 + 等 25 秒（跨过旧 10s 与 20s 轮询）
const seq0 = await seq();
await page.evaluate(() => { const sr = document.getElementById("ai-watcher-host").shadowRoot; sr.querySelector("[data-role=goal-input]").focus(); });
await page.keyboard.type("想刷懂游戏引擎", { delay: 90 });
const typed = await inputState();
await sleep(25000);
const after25 = await inputState();
const seq1 = await seq();
check("A 打字后立即读到", typed.value === "想刷懂游戏引擎", JSON.stringify(typed));
check("A 25 秒后输入不丢", after25.value === "想刷懂游戏引擎", "value=" + JSON.stringify(after25.value));
check("A 25 秒后焦点仍在输入框", after25.focused === true, "focused=" + after25.focused);
check("A 数据未变时未重绘", seq0 === seq1, "renderSeq " + seq0 + " -> " + seq1);

// B. 改数据 → 应重绘，且不打断 details/滚动
await page.evaluate(() => {
  const sr = document.getElementById("ai-watcher-host").shadowRoot;
  const d = sr.querySelector("details"); if (d) d.open = true;
  const panel = sr.querySelector("[data-role=body]") || sr.querySelector(".aw-panel");
  if (panel) panel.scrollTop = 200;
});
const preB = await page.evaluate(() => {
  const sr = document.getElementById("ai-watcher-host").shadowRoot;
  const d = sr.querySelector("details"); const panel = sr.querySelector("[data-role=body]") || sr.querySelector(".aw-panel");
  return { open: d ? d.open : null, scroll: panel ? panel.scrollTop : null };
});
const seqB0 = await seq();
await fetch(BASE + "/api/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  session_id: "refresh-check", page_context: "home", url: "https://www.bilibili.com/", observed_at: Date.now(),
  cards: [{ title: "刷新验收用新内容", url: "https://www.bilibili.com/video/BVrefresh1/", author: "验收UP", rank: 1, view_count: 1, duration_s: 60 }],
  actions: [], page: null }) });
// 先清掉草稿 —— 有未保存草稿时"禁止自动重绘"是设计行为，不清掉就等于在验另一条规则。
await page.evaluate(() => {
  const sr = document.getElementById("ai-watcher-host").shadowRoot;
  const el = sr.querySelector("[data-role=goal-input]");
  if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); el.blur(); }
});
await sleep(24000);
const postB = await page.evaluate(() => {
  const sr = document.getElementById("ai-watcher-host").shadowRoot;
  const d = sr.querySelector("details"); const panel = sr.querySelector("[data-role=body]") || sr.querySelector(".aw-panel");
  return { open: d ? d.open : null, scroll: panel ? panel.scrollTop : null, goal: sr.querySelector("[data-role=goal-input]")?.value ?? null };
});
const seqB1 = await seq();
check("B 数据变化触发了重绘", seqB1 > seqB0, "renderSeq " + seqB0 + " -> " + seqB1);
check("B 重绘后 details 仍展开", postB.open === true, "open=" + postB.open);
check("B 重绘后滚动位置保住", preB.scroll == null || Math.abs((postB.scroll ?? 0) - preB.scroll) <= 4, preB.scroll + " -> " + postB.scroll);
check("B 重绘没有把旧草稿复活", postB.goal === "", "goal=" + JSON.stringify(postB.goal));

// C. 手动刷新按钮：先打一个草稿，再点刷新 —— 这就是用户报的场景
await page.evaluate(() => { const sr = document.getElementById("ai-watcher-host").shadowRoot; sr.querySelector("[data-role=goal-input]").focus(); });
await page.keyboard.type("游戏引擎", { delay: 80 });
const seqC0 = await seq();
const clicked = await page.evaluate(() => {
  const sr = document.getElementById("ai-watcher-host").shadowRoot;
  const btn = [...sr.querySelectorAll("button")].find((b) => /刷新/.test(b.textContent || ""));
  if (!btn) return false; btn.click(); return true;
});
await sleep(3000);
check("C 存在手动刷新按钮并可点", clicked === true, "found=" + clicked);
check("C 手动刷新会重绘", (await seq()) > seqC0, "renderSeq " + seqC0 + " -> " + (await seq()));
const afterC = await inputState();
check("C 手动刷新后草稿不被清空", afterC.value === "游戏引擎", "value=" + JSON.stringify(afterC.value));
check("C 手动刷新后焦点仍在输入框", afterC.focused === true, "focused=" + afterC.focused);

await browser.close(); chrome.kill("SIGTERM"); srv.kill("SIGTERM"); await sleep(400);
const bad = res.filter(r => !r.ok);
console.log("\n=== " + (res.length - bad.length) + "/" + res.length + " 通过" + (bad.length ? " · 失败：" + bad.map(b => b.n).join(" / ") : ""));
process.exit(bad.length ? 1 : 0);

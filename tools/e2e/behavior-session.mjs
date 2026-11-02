// 真实会话补证：连续点开 10 个不同视频，验证 behavior.available 与 D(U,P) 在真实数据上成立。
// 用法：bash -lc 'source ~/.zshrc; node tools/e2e/behavior-session.mjs'
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = "/Users/liuzy/Desktop/AI-watcher";
const require = createRequire(ROOT + "/ignore/temp/e2e-deps/");
try { require.resolve("puppeteer-core"); } catch {
  console.error("缺少 puppeteer-core。任选其一：\n  mkdir -p ignore/temp/e2e-deps && cd ignore/temp/e2e-deps && npm i puppeteer-core\n  npm i -D puppeteer-core");
  process.exit(2);
}
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 3789, CDP = 9413;
const BASE = "http://127.0.0.1:" + PORT;
const DATA = ROOT + "/ignore/temp/data-behav";
const PROFILE = ROOT + "/ignore/temp/profile-behav";
const api = async (p) => (await fetch(BASE + p)).json();
const log = (...a) => console.log(...a);

rmSync(DATA, { recursive: true, force: true }); rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ["src/server/main.js", "--port", String(PORT), "--data-dir", DATA], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
for (let i = 0; i < 40; i++) { try { await api("/api/status"); break; } catch { await sleep(250); } }

const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-breakpad", "--disable-crash-reporter",
  "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--window-size=1440,900",
  "--remote-debugging-port=" + CDP, "--user-data-dir=" + PROFILE, "--enable-unsafe-extension-debugging", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
let ws = null;
for (let i = 0; i < 60; i++) { try { ws = (await fetch("http://127.0.0.1:" + CDP + "/json/version").then((r) => r.json())).webSocketDebuggerUrl; if (ws) break; } catch {} await sleep(300); }
const browser = await puppeteer.connect({ browserWSEndpoint: ws, defaultViewport: null });
const cdp = await browser.target().createCDPSession();
const { id } = await cdp.send("Extensions.loadUnpacked", { path: ROOT + "/extension" });
log("扩展装载 id=" + id);
await sleep(1500);

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const visited = new Set();
let clicked = 0;
const MAX_PAGE_LOADS = 14;
let loads = 0;
for (let round = 0; round < 10; round++) {
  if (loads >= MAX_PAGE_LOADS) break;
  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 }); loads++;
  await sleep(4500);
  const href = await page.evaluate((seen) => {
    const links = [...document.querySelectorAll("a[href*='/video/BV']")].filter((a) => a.offsetParent !== null);
    for (const a of links) {
      const u = a.href.split("?")[0];
      if (!seen.includes(u)) { a.click(); return u; }
    }
    return null;
  }, [...visited]);
  if (!href) { log("round", round, "no fresh link; stop"); break; }
  visited.add(href); clicked++;
  await sleep(6000);
  const where = page.url().split("?")[0];
  log("round", round, "clicked", href.slice(-14), "->", where.split("/video/")[1] ? "video page" : where.slice(0, 40));
  if (!where.includes("/video/")) { log("  (navigation did not land on video page)"); }
}
const st = await api("/api/status");
log("status:", JSON.stringify(st.counts));
const prof = await api("/api/profile?days=7");
writeFileSync(ROOT + "/ignore/temp/behavior-profile.json", JSON.stringify(prof, null, 2));
const ok = { behavior: prof?.behavior?.available === true, sample: prof?.behavior?.sample_n, D: prof?.behavior_cmp?.D,
  exposures: prof?.window?.exposure_count, actions: prof?.window?.action_count, known: prof?.window?.known_topic_ratio,
  alerts: (prof?.alerts || []).map((a) => a.rule_id) };
log("PROFILE:", JSON.stringify(ok));
log(ok.behavior && ok.D != null ? "RESULT: PASS — 真实会话下 U 可用且 D(U,P) 可算" : "RESULT: FAIL — 仍不可算");

await browser.close(); chrome.kill("SIGTERM"); srv.kill("SIGTERM");
await sleep(500);
process.exit(ok.behavior && ok.D != null ? 0 : 1);

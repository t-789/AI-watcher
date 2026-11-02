// 行为上报真机验收（open/watch/search + 同会话去重）。
//   node tests/ext/behavior-e2e.mjs --mode=fake    # 假服务：抓原始 ingest body，证明 actions 非空 + 同会话去重
//   node tests/ext/behavior-e2e.mjs --mode=search  # 假服务：只验搜索页上报关键词
//   node tests/ext/behavior-e2e.mjs --mode=real    # 真服务（无 key，0 次 DeepSeek）：证明 status/profile 里 behavior 有数据
// 有头模式运行（headless=false），截图落在 ignore/temp/shots/。
// 注意：--mode=real 的 behavior.available 受 src/core 的 THRESHOLDS.minBehavior(=10) 约束；
// open 与 watch 同一会话同一内容会合并成 1 个行为样本，所以"点一条视频"必然只得到 1 个样本，
// 单个会话的 demo 里 behavior_cmp.D 会是 null（这是"证据不足不下结论"，不是采集缺失）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { clickElement, launch } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
process.env.AIWATCHER_ROOT = ROOT;
const PORT = 3789;
const BASE = "http://127.0.0.1:" + PORT;
const TMP = path.join(ROOT, "ignore/temp");
const SHOTS = path.join(TMP, "shots");
const PROFILE = path.join(TMP, "profile-behavior");
const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=fake").split("=")[1];
const KEYWORDS = ["游戏", "攻略", "评测", "AI", "人工智能", "电影", "学习", "考研", "科技", "数码", "动画", "音乐", "科普", "体育", "新闻", "手机"];

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log((ok ? "PASS  " : "FAIL  ") + name + (detail ? "  — " + detail : ""));
};

const bodies = [];
let server = null;
let h = null;

function jsonServer(handler) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
      if (req.method === "OPTIONS") {
        res.end("{}");
        return;
      }
      const out = handler(req.url, raw);
      res.end(JSON.stringify(out === undefined ? { ok: true } : out));
    });
  });
}

function fakeServer() {
  server = jsonServer((url) => {
    if (url.startsWith("/api/ingest")) {
      try {
        bodies.push(JSON.parse(arguments.length ? "" : "") || {});
      } catch {
        /* 占位，实际解析在下面 */
      }
      return { ok: true, new_items: 0, ai_pending: 0, accepted: { exposures: 0, actions: 0 } };
    }
    if (url.startsWith("/api/status")) {
      return { ok: true, version: 1, port: PORT, data_mode: "real", window: { days: 7 }, counts: { items: 0, exposures: 0, actions: 0 }, ai: { mode: "degraded", cached: 0, pending: 0, model: "deepseek-chat" }, paused: false };
    }
    if (url.startsWith("/api/profile")) {
      return { data_mode: "real", window: { days: 7, exposure_count: 0 }, exposure: { available: false }, behavior: { available: false }, alerts: [], notes: [] };
    }
    return { ok: true };
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
}

async function realServer() {
  const dataDir = path.join(TMP, "data-behavior");
  fs.rmSync(dataDir, { recursive: true, force: true });
  const env = { ...process.env };
  delete env.DEEPSEEK_API_KEY;
  server = spawn(process.execPath, ["src/server/main.js", "--port", String(PORT), "--data-dir", dataDir], { cwd: ROOT, env, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(BASE + "/api/status")).ok) return;
    } catch {
      /* 等启动 */
    }
    await sleep(250);
  }
  throw new Error("本地服务未启动");
}

try {
  fs.mkdirSync(SHOTS, { recursive: true });
  if (mode === "fake" || mode === "search") await fakeServer();
  else await realServer();

  h = await launch({ profile: PROFILE, port: 9480, headless: false, extensionDirs: [path.join(ROOT, "extension")] });
  const page = h.page;
  check("扩展通过 Extensions.loadUnpacked 装载", !!h.ids[0], "id=" + h.ids[0]);

  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  const ingestRaw = [];
  if (mode === "fake" || mode === "search") {
    // 假服务把 body 原文也留一份，方便贴证据
    page.on("requestfinished", () => {});
    server.on("request", (req) => {
      if (!req.url.startsWith("/api/ingest")) return;
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          ingestRaw.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          /* 坏包 */
        }
      });
    });
  }

  await page.goto("https://www.bilibili.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(6000);
  const ballHome = await page.evaluate(() => {
    const host = document.getElementById("ai-watcher-host");
    return !!(host && host.shadowRoot && host.shadowRoot.querySelector("[data-role=ball]"));
  });
  check("首页悬浮球已渲染（有头）", ballHome);
  await page.screenshot({ path: path.join(SHOTS, "07-home-headed.png") });

  if (mode === "search") {
    // 搜索页只上报关键词本身：一个动作、三个字段，不带任何其它页面文本
    await page.goto("https://search.bilibili.com/all?keyword=" + encodeURIComponent("游戏攻略"), { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(8000);
    await page.screenshot({ path: path.join(SHOTS, "09-search-headed.png") });
    const searches = ingestRaw.flatMap((b) => b.actions || []).filter((a) => a.action_type === "search");
    check("搜索页上报 search 动作", searches.length >= 1, JSON.stringify(searches));
    check("search 只带关键词（字段只有 action_type/title/at）", searches.length > 0 && searches.every((s) => Object.keys(s).sort().join(",") === "action_type,at,title"), JSON.stringify(searches[0] || null));
    check("search 的 title 是关键词本身", searches.length > 0 && searches[0].title.includes("游戏"), String(searches[0] && searches[0].title));
    await h.close();
    h = null;
    const bad = results.filter((r) => !r.ok);
    console.log("\n=== " + (results.length - bad.length) + "/" + results.length + " 通过" + (bad.length ? " · 失败：" + bad.map((f) => f.name).join(", ") : ""));
    if (server) server.close();
    process.exit(bad.length ? 1 : 0);
  }

  const handles = await page.$$("a[href*='/video/BV']");
  let target = null;
  for (const handle of handles) {
    const info = await handle.evaluate((el) => ({ text: (el.textContent || "").trim().slice(0, 120), href: el.href, w: el.getBoundingClientRect().width })).catch(() => null);
    if (!info || !info.text || info.text.length < 6 || info.w < 40) continue;
    if (KEYWORDS.some((k) => info.text.includes(k))) {
      target = { handle, info };
      break;
    }
    if (!target) target = { handle, info };
  }
  if (!target) throw new Error("首页没找到可见视频卡");
  console.log("选中卡片：" + target.info.text + " → " + target.info.href);

  const clickInfo = await clickElement(page, target.handle);
  check("用 CDP Input 派发真实鼠标点击（trusted 事件）", true, "x=" + Math.round(clickInfo.x) + " y=" + Math.round(clickInfo.y));

  // B站卡片可能是新标签页打开，也可能走 SPA：两种都要跟到真正的视频页
  let videoPage = null;
  for (let i = 0; i < 80; i++) {
    const href = await page.evaluate(() => location.href).catch(() => "");
    if (/\/video\/BV/.test(href)) {
      videoPage = page;
      break;
    }
    const opened = (await h.browser.pages()).find((p) => /\/video\/BV/.test(p.url()));
    if (opened) {
      videoPage = opened;
      break;
    }
    await sleep(250);
  }
  check("点击后由平台自己跳到视频页（未使用 page.goto）", !!videoPage, videoPage ? videoPage.url() : "仍在 " + page.url());
  if (!videoPage) throw new Error("点击后没有到达视频页");
  await videoPage.bringToFront();
  const vp = videoPage;

  await sleep(7000);
  const playState = await vp.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return null;
    v.muted = true;
    v.play().catch(() => {});
    return { paused: v.paused, duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null };
  }).catch(() => null);
  console.log("播放尝试：" + JSON.stringify(playState));
  await sleep(12000);

  const state = await vp.evaluate(() => {
    const v = document.querySelector("video");
    const host = document.getElementById("ai-watcher-host");
    return {
      url: location.href,
      video: v ? { t: Math.round(v.currentTime), paused: v.paused } : null,
      ball: !!(host && host.shadowRoot && host.shadowRoot.querySelector("[data-role=ball]")),
      title: document.title.slice(0, 60),
    };
  });
  console.log("视频页状态：" + JSON.stringify(state));
  check("视频页仍有悬浮球", state.ball);
  check("视频真的在播（currentTime > 0）", !!(state.video && state.video.t > 0), JSON.stringify(state.video));
  await vp.screenshot({ path: path.join(SHOTS, "08-video-playing.png") });
  check("有头截图已存（首页 + 视频页）", fs.existsSync(path.join(SHOTS, "07-home-headed.png")) && fs.existsSync(path.join(SHOTS, "08-video-playing.png")), "07-home-headed.png / 08-video-playing.png");

  if (mode === "fake") {
    const all = ingestRaw.flatMap((b) => b.actions || []);
    const opens = all.filter((a) => a.action_type === "open");
    const watches = all.filter((a) => a.action_type === "watch");
    const videoBatches = ingestRaw.filter((b) => b.page_context === "video_related");
    check("ingest 的 actions 非空", all.length > 0, all.length + " 条动作 / 共 " + ingestRaw.length + " 次上报");
    check("同会话重复扫描只报一次 open", opens.length === 1, "open=" + opens.length + "，视频页上报批次=" + videoBatches.length);
    if (watches.length) {
      check("watch 带合法 watch_seconds（≥5）", typeof watches[0].watch_seconds === "number" && watches[0].watch_seconds >= 5, "watch_seconds=" + watches[0].watch_seconds + "，watch 条数=" + watches.length);
    } else {
      check("watch 已上报", false, "视频没播到 5s；播放尝试=" + JSON.stringify(playState));
    }
    const sample = videoBatches.find((b) => (b.actions || []).length) || ingestRaw.find((b) => (b.actions || []).length);
    if (sample) {
      const trimmed = { session_id: sample.session_id, page_context: sample.page_context, url: sample.url, observed_at: sample.observed_at, actions: sample.actions, cards: (sample.cards || []).slice(0, 1) };
      console.log("--- 真实 ingest body（裁剪到 actions + 1 张卡）---");
      console.log(JSON.stringify(trimmed, null, 2));
      fs.writeFileSync(path.join(TMP, "ingest-body-sample.json"), JSON.stringify(trimmed, null, 2));
    }
  } else {
    const st = await fetch(BASE + "/api/status").then((r) => r.json());
    const prof = await fetch(BASE + "/api/profile?days=7").then((r) => r.json());
    fs.writeFileSync(path.join(TMP, "behavior-profile.json"), JSON.stringify(prof, null, 2));
    check("counts.actions ≥ 1", ((st.counts && st.counts.actions) || 0) >= 1, "counts=" + JSON.stringify(st.counts));
    check("behavior.available === true", !!(prof.behavior && prof.behavior.available === true), JSON.stringify(prof.behavior || {}).slice(0, 240));
    check("behavior.sample_n ≥ 1", ((prof.behavior && prof.behavior.sample_n) || 0) >= 1, "sample_n=" + (prof.behavior && prof.behavior.sample_n));
    check("behavior_cmp.D 非 null", !!(prof.behavior_cmp && typeof prof.behavior_cmp.D === "number"), "D=" + (prof.behavior_cmp && prof.behavior_cmp.D));
    console.log("--- status（裁剪）---");
    console.log(JSON.stringify({ counts: st.counts, data_mode: st.data_mode, ai_mode: st.ai && st.ai.mode, ai_requests: st.ai && st.ai.requests }));
    console.log("--- profile.behavior / behavior_cmp ---");
    console.log(JSON.stringify({ window: { exposure_count: prof.window && prof.window.exposure_count, action_count: prof.window && prof.window.action_count }, behavior: prof.behavior, behavior_cmp: prof.behavior_cmp }, null, 2));
  }

  check("页面无未捕获错误", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (e) {
  check("harness 未崩溃", false, String((e && e.stack) || e).slice(0, 400));
} finally {
  try {
    if (h) await h.close();
  } catch {
    /* 已关 */
  }
  try {
    if (server && mode === "fake") server.close();
    else if (server) server.kill("SIGTERM");
  } catch {
    /* 已关 */
  }
}
const failed = results.filter((r) => !r.ok);
console.log("\n=== " + (results.length - failed.length) + "/" + results.length + " 通过" + (failed.length ? " · 失败：" + failed.map((f) => f.name).join(", ") : ""));
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
// 一条命令打开"已经装好本扩展"的 Chrome：用户可以立刻刷 B 站。
// 依赖 puppeteer-core（已预装在 ignore/temp/e2e-deps，禁止 npm i 到仓库根）。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEP_DIR = path.join(ROOT, "ignore/temp/e2e-deps");
const PROFILE = process.env.AIWATCHER_PROFILE || path.join(ROOT, "ignore/temp/profile-user");
const PORT = Number(process.env.AIWATCHER_CDP_PORT || 9222);
const EXT_DIR = path.join(ROOT, "extension");
const START_URL = process.env.AIWATCHER_URL || "https://www.bilibili.com/";

function die(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(CHROME)) die("找不到 Chrome：" + CHROME + "\n可用 CHROME_PATH 环境变量指定。");
if (!fs.existsSync(path.join(EXT_DIR, "manifest.json"))) die("找不到扩展：extension/manifest.json");

let puppeteer;
try {
  puppeteer = createRequire(path.join(DEP_DIR, "package.json"))("puppeteer-core");
} catch {
  die(
    "缺少 puppeteer-core。它应当预装在 " + DEP_DIR + "\n" +
      "如果目录为空，请在项目外的临时目录安装后指向它（不要往仓库根目录装依赖）：\n" +
      "  mkdir -p " + DEP_DIR + " && cd " + DEP_DIR + " && npm init -y && npm i puppeteer-core"
  );
}

fs.mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--user-data-dir=" + PROFILE,
    "--remote-debugging-port=" + PORT,
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    START_URL,
  ],
  { stdio: "ignore", detached: false }
);

chrome.on("exit", (code) => {
  console.log("Chrome 已退出（code=" + code + "）。");
  process.exit(0);
});

async function waitForCdp(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:" + PORT + "/json/version");
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(300);
  }
  return null;
}

const version = await waitForCdp();
if (!version) {
  console.error("Chrome 起来了但 CDP 端口 " + PORT + " 没响应。扩展未装载，请手动打开 chrome://extensions 加载：" + EXT_DIR);
  process.exit(1);
}

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:" + PORT, defaultViewport: null });

let extensionId = null;
try {
  const session = await browser.target().createCDPSession();
  const result = await session.send("Extensions.loadUnpacked", { path: EXT_DIR });
  extensionId = result && result.id ? result.id : null;
} catch (e) {
  console.error("自动装载失败：" + (e && e.message ? e.message : String(e)));
}

if (extensionId) {
  console.log("扩展已装载 id=" + extensionId);
  console.log("打开 " + START_URL + " 试试；右下角会出现悬浮球，点它看画像分析。");
} else {
  console.log("未能自动装载扩展。请手动操作：chrome://extensions → 打开「开发者模式」→「加载已解压的扩展程序」→ " + EXT_DIR);
  console.log("（本窗口会保持打开，关掉 Chrome 即结束。）");
}
console.log("本地服务需要另开一个终端：bash -lc 'source ~/.zshrc; npm start'");

let done = false;
const finish = async (reason) => {
  if (done) return;
  done = true;
  console.log("\n" + reason + "，正在断开调试连接（Chrome 会继续留在前台）。");
  try {
    await browser.disconnect();
  } catch {
    /* 已断开 */
  }
  process.exit(0);
};
process.on("SIGINT", () => finish("收到 Ctrl-C"));
process.on("SIGTERM", () => finish("收到 SIGTERM"));
browser.on("disconnected", () => finish("浏览器已关闭"));
await new Promise(() => {});

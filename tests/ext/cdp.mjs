// 浏览器驱动：puppeteer-core 从 ignore/temp/e2e-deps 里加载（开发依赖，不进仓库）。
// 说明：Chrome 156 已忽略 --load-extension，扩展只能走 CDP 的 Extensions.loadUnpacked，
// 且必须连 pages()[0]（用 browser.newPage() 会在该 Chrome 上报 "Requesting main frame too early"）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export async function launch({ profile, port, headless = false, extensionDirs = [] }) {
  const root = process.env.AIWATCHER_ROOT || process.cwd();
  const { default: puppeteer } = await import(root + "/ignore/temp/e2e-deps/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");

  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const logFd = fs.openSync(profile + "-chrome.log", "w");
  const proc = spawn(CHROME, [
    headless ? "--headless=new" : "--window-size=1440,900",
    "--no-first-run", "--no-default-browser-check", "--no-sandbox",
    "--disable-gpu", "--disable-breakpad", "--disable-crash-reporter",
    "--enable-unsafe-extension-debugging",
    "--remote-debugging-port=" + port,
    "--user-data-dir=" + profile,
    "about:blank",
  ], { stdio: ["ignore", logFd, logFd] });

  let version = null;
  for (let i = 0; i < 150; i++) {
    try {
      version = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!version) throw new Error("CDP 端口 " + port + " 没起来");

  const browser = await puppeteer.connect({
    browserWSEndpoint: version.webSocketDebuggerUrl,
    defaultViewport: { width: 1440, height: 900 },
  });

  const ids = [];
  for (const dir of extensionDirs) {
    const session = await browser.target().createCDPSession();
    const { id } = await session.send("Extensions.loadUnpacked", { path: dir });
    await session.detach();
    ids.push(id);
  }
  await sleep(1200);

  const page = (await browser.pages())[0];
  return {
    browser,
    page,
    ids,
    async close() {
      try {
        await browser.disconnect();
      } catch {
        /* 已断开 */
      }
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
    },
  };
}

/** 真实鼠标点击：CDP Input 域派发，事件是 trusted 的，和用户点击走同一条路径。 */
export async function clickElement(page, handle) {
  const box = await handle.evaluate((el) => {
    el.scrollIntoView({ block: "center" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (el.textContent || "").trim().slice(0, 100), href: el.href || "" };
  });
  await sleep(400);
  const fixed = await handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(fixed.x, fixed.y);
  await page.mouse.down();
  await page.mouse.up();
  return { ...box, x: fixed.x, y: fixed.y };
}

#!/usr/bin/env node
// 扩展静态校验：名字/形状对着 docs/CONTRACT.md 与验收清单，不启动浏览器。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "extension/manifest.json"), "utf8"));
const cases = [];

function test(name, fn) {
  cases.push({ name, fn });
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

test("manifest_version = 3", () => {
  assert(manifest.manifest_version === 3, "实际为 " + manifest.manifest_version);
  return String(manifest.manifest_version);
});

test("host_permissions 覆盖 http://127.0.0.1:3789", () => {
  const hosts = manifest.host_permissions || [];
  assert(hosts.some((h) => /127\.0\.0\.1:3789/.test(h)), "实际：" + JSON.stringify(hosts));
  return JSON.stringify(hosts);
});

test("content_scripts 覆盖 *://*.bilibili.com/*", () => {
  const scripts = manifest.content_scripts || [];
  const matches = scripts.flatMap((cs) => cs.matches || []);
  assert(matches.includes("*://*.bilibili.com/*"), "matches 实际：" + JSON.stringify(matches));
  const js = scripts.flatMap((cs) => cs.js || []);
  assert(js.includes("content/capture.js"), "缺少 content/capture.js");
  assert(js.includes("content/overlay.js"), "缺少 content/overlay.js");
  return JSON.stringify(js);
});

test("web_accessible_resources 含 extract.js", () => {
  const res = (manifest.web_accessible_resources || []).flatMap((w) => w.resources || []);
  assert(res.includes("extract.js"), "实际：" + JSON.stringify(res));
  return JSON.stringify(res);
});

test("必需文件存在", () => {
  const files = [
    "extension/manifest.json",
    "extension/background.js",
    "extension/content/capture.js",
    "extension/content/overlay.js",
    "extension/extract.js",
    "src/adapters/bilibili/extract.js",
  ];
  for (const rel of files) assert(fs.existsSync(path.join(ROOT, rel)), "缺失：" + rel);
  return files.length + " 个";
});

test("extension/extract.js 与 src/adapters/bilibili/extract.js 是同一份（单一事实来源）", () => {
  const link = path.join(ROOT, "extension/extract.js");
  const target = fs.realpathSync(link);
  const canonical = fs.realpathSync(path.join(ROOT, "src/adapters/bilibili/extract.js"));
  assert(fs.readFileSync(target, "utf8") === read("src/adapters/bilibili/extract.js"), "两份内容不一致");
  const kind = fs.lstatSync(link).isSymbolicLink() ? "symlink" : "同内容副本";
  return kind + " → " + path.relative(ROOT, canonical);
});

test("extract.js 在 node 里可 import 且顶层不访问 document", async () => {
  assert(typeof globalThis.document === "undefined", "本进程意外存在 document，无法证明顶层不访问它");
  const mod = await import(pathToFileURL(path.join(ROOT, "src/adapters/bilibili/extract.js")).href);
  const names = ["extractHomeFeed", "extractSearch", "extractVideoPage", "canonicalizeUrl", "parseCount", "parseDuration"];
  for (const name of names) assert(typeof mod[name] === "function", "缺少导出函数 " + name);
  const probes = [
    [mod.parseCount("44.8万"), 448000],
    [mod.parseDuration("01:37"), 97],
    [mod.canonicalizeUrl("//www.bilibili.com/video/BV1wcxi6zEsG/?spm_id_from=333.788"), "https://www.bilibili.com/video/BV1wcxi6zEsG/"],
    [JSON.stringify(mod.extractHomeFeed(undefined)), "[]"],
  ];
  for (const [got, want] of probes) assert(got === want, "自检失败：拿到 " + got + "，期望 " + want);
  return names.join(",") + " ; typeof document = " + typeof globalThis.document;
});

test("内容脚本用 chrome.runtime.getURL 动态 import 抽取模块", () => {
  const src = read("extension/content/capture.js");
  assert(/chrome\.runtime\.getURL\(/.test(src), "未见 chrome.runtime.getURL");
  assert(/import\(EXTRACT_URL\)/.test(src), "未见 import(EXTRACT_URL)");
  return "ok";
});

test("扩展里没有复制 DOM 抽取规则", () => {
  const banned = /bili-video-card|video-page-card-small|reply-content|stats__duration|desc-info-text/;
  const hits = ["extension/content/capture.js", "extension/content/overlay.js", "extension/background.js"].filter((rel) => banned.test(read(rel)));
  assert(hits.length === 0, "以下文件出现平台选择器：" + hits.join(", "));
  return "clean";
});

test("capture.js 上报真实 behavior actions（open/watch/search），不写死空数组", () => {
  const src = read("extension/content/capture.js");
  assert(!/actions:\s*\[\s*\]/.test(src), "actions 仍是硬编码空数组");
  for (const kind of ["open", "watch", "search"]) {
    assert(new RegExp('action_type: "' + kind + '"').test(src), "缺少 action_type: " + kind);
  }
  assert(/watch_seconds/.test(src), "watch 动作缺少 watch_seconds");
  assert(/WATCH_MIN_SECONDS/.test(src) && /currentTime/.test(src), "watch 缺少播放进度判定");
  assert(!/\.click\(\)/.test(src), "内容脚本不应代用户点平台按钮（点赞/收藏）");
  return "open/watch/search + watch_seconds";
});

test("到 127.0.0.1 的请求只从 background 发出，且带超时", () => {
  for (const rel of ["extension/content/capture.js", "extension/content/overlay.js"]) {
    const src = read(rel);
    assert(!/\bfetch\s*\(/.test(src), rel + " 里出现了 fetch(");
    assert(!/https?:\/\/127\.0\.0\.1/.test(src), rel + " 里出现了直达 127.0.0.1 的 URL");
    assert(!/"\/api\//.test(src), rel + " 里出现了 /api/ 路径");
  }
  const bg = read("extension/background.js");
  assert(/http:\/\/127\.0\.0\.1:3789/.test(bg), "background.js 未指向 http://127.0.0.1:3789");
  assert(/AbortController|AbortSignal\.timeout/.test(bg), "background.js 缺少超时控制");
  return "background 独占 fetch + 3s 超时";
});

test("外链一律显示视频标题，标题缺失才回退 URL", () => {
  const src = read("extension/content/overlay.js");
  assert(/function link\(url, title\)/.test(src), "缺少统一 link() 渲染函数");
  assert(/trunc\(title \|\| url, 26\)/.test(src), "link() 未见 title || url 回退 + 26 字截断");
  const bare = [...src.matchAll(/h\("a", null, ([^)]*)\)/g)]
    .map((m) => m[1].trim())
    .filter((arg) => !/trunc\(title \|\| url/.test(arg));
  assert(bare.length === 0, "仍有裸 URL 直接做链接文本：" + bare.join(" | "));
  return "link() 统一渲染 + title 优先 + 26 字截断";
});

test("抽屉首屏结构：结论/分布/建议/推荐/目标 + 折叠区 + 底部固定行", () => {
  const src = read("extension/content/overlay.js");
  for (const fn of ["renderConclusion", "renderExposure", "renderSuggestions", "renderRecommendations", "renderGoal", "renderDetails", "renderFooter"]) {
    assert(new RegExp("function " + fn + "\\(").test(src), "缺少 " + fn);
  }
  const order = ["renderConclusion(nodes.body)", "renderExposure(nodes.body)", "renderSuggestions(nodes.body)", "renderRecommendations(nodes.body)", "renderGoal(nodes.body)", "renderDetails(nodes.body)"];
  const idxs = order.map((s) => src.indexOf(s));
  assert(idxs.every((i) => i > 0), "render() 未按首屏顺序调用：" + JSON.stringify(idxs));
  for (let i = 1; i < idxs.length; i += 1) assert(idxs[i] > idxs[i - 1], "首屏顺序不对：" + order[i] + " 应在 " + order[i - 1] + " 之后");
  assert(/createElement\("details"\)/.test(src), "折叠区未使用原生 <details>");
  for (const inner of ["renderConditions(inner)", "renderExposureMetrics(inner)", "renderCompare(inner)", "renderAlerts(inner)"]) {
    assert(src.includes(inner), "折叠区未包含 " + inner);
  }
  assert(/data-role="footer"/.test(src), "缺少底部固定小字容器");
  return "首屏 5 块 + <details> 折叠 + 固定底部行";
});

test("首屏只保留比例数字：条形不带条数、目标不带权重", () => {
  const src = read("extension/content/overlay.js");
  assert(!/pct\(r\[key\]\) \+ \(r\.n != null/.test(src), "条形仍在拼接条数");
  assert(/aw-bar-val", pct\(r\[key\]\)/.test(src), "条形数值应只有百分比");
  assert(!/label\(t\.t\) \+ " " \+ fixed\(t\.w\)/.test(src), "目标主题仍在显示权重数值");
  return "条形=百分比，目标=标签";
});

const failures = [];
let passed = 0;
for (const { name, fn } of cases) {
  try {
    const detail = await fn();
    passed += 1;
    console.log("PASS " + name + (detail ? " — " + detail : ""));
  } catch (e) {
    failures.push(name);
    console.log("FAIL " + name + " — " + (e && e.message ? e.message : String(e)));
  }
}

const total = cases.length;
console.log("\n" + "=".repeat(52));
if (failures.length === 0) {
  console.log("check-extension: " + passed + "/" + total + " 通过");
  process.exit(0);
}
console.log("check-extension: " + failures.length + " 项失败 / 共 " + total + " 项");
process.exit(1);

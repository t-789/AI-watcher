// 所有到 127.0.0.1 的请求都从这里发出：内容脚本没有 cross-origin 权限，
// 服务端也不该收到页面上下文里的请求（契约 §5 的唯一采集入口）。
const BASE = "http://127.0.0.1:3789";
const TIMEOUT_MS = 3000;
const PAUSE_KEY = "aiwatcher_paused";
let offlineWarned = false;

async function request(path, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      ...init,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(init.headers || {}) },
    });
    const type = res.headers.get("content-type") || "";
    const data = type.includes("json") ? await res.json() : await res.text();
    if (!res.ok) {
      const err = (data && data.error) || {};
      return { ok: false, status: res.status, error: { code: err.code || "http_" + res.status, message: err.message || "请求失败" } };
    }
    return { ok: true, status: res.status, data };
  } catch (e) {
    if (!offlineWarned) {
      offlineWarned = true;
      console.warn("[ai-watcher] 本地服务未响应（127.0.0.1:3789），悬浮窗转为离线态");
    }
    return { ok: false, status: 0, error: { code: "offline", message: "本地服务未启动或超时" } };
  } finally {
    clearTimeout(timer);
  }
}

async function isPaused() {
  const got = await chrome.storage.local.get(PAUSE_KEY);
  return got[PAUSE_KEY] === true;
}

const routes = {
  ingest: (msg) => request("/api/ingest", { method: "POST", body: JSON.stringify(msg.body || {}) }),
  status: () => request("/api/status"),
  profile: (msg) => request("/api/profile?days=" + encodeURIComponent(msg.days || 7)),
  goal: (msg) => request("/api/goal", { method: "POST", body: JSON.stringify(msg.body || {}) }),
  export: () => request("/api/export"),
  reset: () => request("/api/reset", { method: "POST", body: JSON.stringify({ confirm: true }) }),
  async pause(msg) {
    const paused = msg.paused === true;
    await chrome.storage.local.set({ [PAUSE_KEY]: paused });
    return request("/api/pause", { method: "POST", body: JSON.stringify({ paused }) });
  },
  async state() {
    return { ok: true, status: 200, data: { paused: await isPaused() } };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && routes[msg.type];
  if (!handler) {
    sendResponse({ ok: false, status: 0, error: { code: "unknown_message", message: "未知的消息类型" } });
    return false;
  }
  handler(msg)
    .then((result) => {
      if (result.ok) offlineWarned = false;
      sendResponse(result);
    })
    .catch((e) => sendResponse({ ok: false, status: 0, error: { code: "worker_error", message: String((e && e.message) || e) } }));
  return true;
});

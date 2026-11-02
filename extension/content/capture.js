// 内容脚本：只描述"这一页现在长什么样"。不归类、不生成 content_id、不猜主题（契约 §5）。
// 与 overlay.js 共享同一 isolated world，状态挂在 globalThis.__aiWatcher 上。
(() => {
  const SCAN_MS = 1500;
  const WATCH_MIN_SECONDS = 5;
  const WATCH_SAMPLE_MS = 1000;
  const WATCH_SEEK_GUARD = 3;
  const EXTRACT_URL = chrome.runtime.getURL("extract.js");
  const state = {
    sessionId: newSessionId(),
    visitSeq: 1,
    href: location.href,
    pageContext: contextOf(location.href),
    reported: new Map(),
    pageSent: null,
    count: 0,
    lastReportAt: 0,
    paused: false,
    stopping: false,
    extractor: null,
    loadFailed: false,
    pageTitle: "",
    actionsSent: new Set(),
    pendingActions: [],
    actionsCount: 0,
    watch: null,
  };
  const listeners = new Set();

  function newSessionId() {
    return crypto.randomUUID ? crypto.randomUUID() : "s-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function contextOf(href) {
    try {
      const u = new URL(href);
      if (u.hostname === "search.bilibili.com") return "search";
      if (/^\/video\/|^\/bangumi\/play\//.test(u.pathname)) return "video_related";
      return "home";
    } catch {
      return "home";
    }
  }

  function emit() {
    for (const fn of listeners) {
      try {
        fn(snapshot());
      } catch {
        /* 单个订阅者出错不影响采集 */
      }
    }
  }

  function snapshot() {
    return {
      sessionId: state.sessionId,
      visitSeq: state.visitSeq,
      pageContext: state.pageContext,
      count: state.count,
      lastReportAt: state.lastReportAt,
      paused: state.paused,
      ready: !!state.extractor,
      loadFailed: state.loadFailed,
    };
  }

  function signature(card) {
    return [card.title, card.author, card.duration_s, card.view_count, card.danmaku_count].join("|");
  }

  function freshCards(cards) {
    const out = [];
    for (const card of cards) {
      if (!card || !card.url || !card.title) continue;
      const sig = signature(card);
      if (state.reported.get(card.url) === sig) continue;
      state.reported.set(card.url, sig);
      out.push(card);
    }
    return out;
  }

  async function send(body) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "ingest", body });
      if (res && res.ok) {
        state.lastReportAt = Date.now();
        state.count += (body.cards || []).length;
        state.actionsCount += (body.actions || []).length;
        emit();
        return true;
      }
      return false;
    } catch {
      /* service worker 暂时不可用：下一轮扫描会自然重试，不刷屏 */
      return false;
    }
  }

  // ---- 行为上报（契约 §2 Action）----
  // 只报用户真的做过的三件事：点开视频(open)、真的播放过(watch)、发起搜索(search)。
  // 不点赞、不收藏、不投币：这些需要点平台按钮，扩展不代劳。
  function canonicalOf(url) {
    try {
      const mod = state.extractor;
      return mod && mod.canonicalizeUrl ? mod.canonicalizeUrl(url) : String(url || "");
    } catch {
      return String(url || "");
    }
  }

  function queueAction(action) {
    if (!action || !action.action_type) return false;
    const key = action.action_type + "|" + (action.url ? canonicalOf(action.url) : action.title || "");
    if (state.actionsSent.has(key)) return false;
    state.actionsSent.add(key);
    state.pendingActions.push(action);
    dirty = true;
    return true;
  }

  function keywordOf(href) {
    try {
      const kw = new URL(href).searchParams.get("keyword");
      return kw ? kw.trim().slice(0, 60) : "";
    } catch {
      return "";
    }
  }

  // 搜索页只报关键词本身，其它页面文本一律不碰。
  function reportPageActions(page) {
    if (state.pageContext === "search") {
      const kw = keywordOf(location.href);
      if (kw) queueAction({ action_type: "search", title: kw, at: Date.now() });
      return;
    }
    if (!page || !page.title) return;
    state.pageTitle = page.title;
    queueAction({ action_type: "open", url: page.url || location.href, title: page.title, at: Date.now() });
  }

  function activeVideo() {
    let best = null;
    let bestScore = -1;
    let videos;
    try {
      videos = document.querySelectorAll("video");
    } catch {
      return null;
    }
    for (const v of videos) {
      if (!v || !(v.currentTime > 0)) continue;
      const area = (v.clientWidth || 0) * (v.clientHeight || 0);
      const score = (v.paused ? 0 : 1e9) + area;
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best;
  }

  function fallbackVideoTitle() {
    if (state.pageTitle) return state.pageTitle;
    try {
      return String(document.title || "").replace(/_哔哩哔哩.*$/, "").trim().slice(0, 120);
    } catch {
      return "";
    }
  }

  // 观看时长按"可见播放的前进量"累计：拖动进度条造成的跳变不计入，且不超过视频时长。
  function tickWatch() {
    if (state.paused || state.stopping || state.pageContext !== "video_related") return;
    const video = activeVideo();
    const now = Date.now();
    if (!video) {
      state.watch = null;
      return;
    }
    const key = canonicalOf(location.href);
    let w = state.watch;
    if (!w || w.key !== key) {
      state.watch = { key, seconds: 0, lastT: video.currentTime, lastAt: now, video };
      return;
    }
    if (w.video !== video) {
      w.video = video;
      w.lastT = video.currentTime;
      w.lastAt = now;
      return;
    }
    const dt = Math.max(0, (now - w.lastAt) / 1000);
    const dT = video.currentTime - w.lastT;
    w.lastT = video.currentTime;
    w.lastAt = now;
    if (dT > 0 && dT <= Math.max(WATCH_SEEK_GUARD, dt * WATCH_SEEK_GUARD)) w.seconds += dT;
    if (w.seconds < WATCH_MIN_SECONDS) return;
    const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    queueAction({
      action_type: "watch",
      url: location.href,
      title: fallbackVideoTitle(),
      at: now,
      watch_seconds: Math.round(dur ? Math.min(w.seconds, dur) : w.seconds),
    });
  }

  async function scan() {
    if (state.paused || state.stopping || !state.extractor) return;
    if (location.href !== state.href) {
      // SPA 路由变化：新会话 + visit 序号推进，去重表清空（契约里的 visit_seq 语义）
      state.href = location.href;
      state.sessionId = newSessionId();
      state.visitSeq += 1;
      state.pageContext = contextOf(state.href);
      state.reported.clear();
      state.pageSent = null;
      state.actionsSent.clear();
      state.watch = null;
      emit();
    }
    const mod = state.extractor;
    let cards = [];
    let page = null;
    try {
      if (state.pageContext === "video_related") {
        const info = mod.extractVideoPage(document);
        const { related, ...rest } = info;
        cards = related || [];
        if (rest.title && state.pageSent !== rest.title) {
          state.pageSent = rest.title;
          page = rest;
        }
      } else if (state.pageContext === "search") {
        cards = mod.extractSearch(document);
      } else {
        cards = mod.extractHomeFeed(document);
      }
    } catch {
      return;
    }
    reportPageActions(page);
    const changed = freshCards(cards);
    const actions = state.pendingActions.splice(0);
    if (changed.length === 0 && !page && actions.length === 0) return;
    const ok = await send({
      session_id: state.sessionId,
      page_context: state.pageContext,
      url: location.href,
      observed_at: Date.now(),
      cards: changed,
      actions,
      page: page || null,
    });
    if (!ok && actions.length) state.pendingActions.unshift(...actions);
  }

  // 平台自己的 SPA 路由由页面主世界执行，isolated world 里 patch history 看不到，
  // 所以在扫描节拍里比对 location.href。
  let dirty = false;
  const observer = new MutationObserver(() => {
    dirty = true;
  });
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    /* documentElement 还没就绪时下一拍再来 */
  }
  setInterval(() => {
    if (!dirty) return;
    dirty = false;
    scan();
  }, SCAN_MS);
  setInterval(() => {
    if (location.href !== state.href) {
      dirty = true;
    }
  }, SCAN_MS);
  // 播放进度变化不产生 DOM 变更，所以 watch 必须自己按节拍采样。
  setInterval(tickWatch, WATCH_SAMPLE_MS);

  import(EXTRACT_URL)
    .then((mod) => {
      state.extractor = mod;
      emit();
      scan();
    })
    .catch(() => {
      state.loadFailed = true;
      if (!state.loadFailedLogged) {
        state.loadFailedLogged = true;
        console.warn("[ai-watcher] 抽取模块加载失败，采集已停止");
      }
      emit();
    });

  globalThis.__aiWatcher = {
    getState: snapshot,
    subscribe(fn) {
      listeners.add(fn);
      fn(snapshot());
      return () => listeners.delete(fn);
    },
    setPaused(paused) {
      state.paused = paused === true;
      emit();
      if (!state.paused) scan();
    },
    scanNow() {
      dirty = true;
      return scan();
    },
    stop() {
      state.stopping = true;
      observer.disconnect();
    },
  };
})();

// 悬浮窗：Shadow DOM 隔离，样式自包含；只读服务端 JSON，不做任何归类或结论外推。
(() => {
  const HOST_ID = "ai-watcher-host";
  if (document.getElementById(HOST_ID)) return;

  const TOPIC_LABELS = {
    tech: "科技·AI·数码", science: "科学·科普", game: "游戏", anime: "动画·二次元",
    film_tv: "影视·剧集", music: "音乐", study: "学习·考试·求职", life: "生活·美食·旅行",
    sports: "体育·健身", news: "时事·社会·财经",
  };
  const INTENT_MODES = [
    ["relax", "放松 / 消磨"],
    ["learn_event", "了解事件"],
    ["skill", "学技能"],
    ["exam", "考试准备"],
    ["cure", "戒断 / 收缩"],
  ];
  const STYLE = "\n:host { all: initial; }\n.aw-wrap, .aw-wrap * { box-sizing: border-box; margin: 0; padding: 0; }\n.aw-wrap {\n  font-family: -apple-system, BlinkMacSystemFont, \"Segoe UI\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", sans-serif;\n  font-size: 12px; line-height: 1.5; color: #1b1f27; text-align: left;\n}\n.aw-fixed { position: absolute; right: 18px; bottom: 18px; width: 330px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; pointer-events: none; }\n.aw-caption {\n  pointer-events: none; background: rgba(20, 24, 32, 0.82); color: #e9edf5; border-radius: 999px;\n  padding: 3px 9px; font-size: 10px; letter-spacing: .2px; white-space: nowrap; backdrop-filter: blur(4px); font-variant-numeric: tabular-nums;\n}\n.aw-ball {\n  pointer-events: auto; cursor: pointer; width: 66px; height: 66px; border-radius: 50%; border: 0;\n  background: radial-gradient(circle at 30% 25%, #4f8cff, #2b5dd7 60%, #1f43a3);\n  color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;\n  box-shadow: 0 8px 24px rgba(31, 67, 163, .35); font-size: 12px; transition: transform .15s ease, background .2s ease;\n}\n.aw-ball:hover { transform: translateY(-2px); }\n.aw-fixed[data-open=\"1\"] { display: none; }\n.aw-ball[data-offline=\"1\"] { background: radial-gradient(circle at 30% 25%, #9aa3af, #6b7482 60%, #4f5765); box-shadow: 0 6px 18px rgba(60, 66, 78, .3); }\n.aw-ball-count { font-size: 20px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }\n.aw-ball-topic { max-width: 58px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; opacity: .9; }\n.aw-ball-off { font-size: 11px; font-weight: 600; text-align: center; line-height: 1.25; }\n.aw-drawer {\n  position: absolute; right: 0; bottom: 0; width: 396px; height: 100vh; background: #fffdfa;\n  border-left: 1px solid #e6e1d8; box-shadow: -12px 0 32px rgba(24, 28, 36, .12);\n  display: flex; flex-direction: column; pointer-events: auto; z-index: 2;\n}\n.aw-drawer[hidden] { display: none; }\n.aw-head { padding: 10px 14px; border-bottom: 1px solid #ece7de; background: #f7f3ec; }\n.aw-title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\n.aw-title { font-size: 13px; font-weight: 700; }\n.aw-close { border: 0; background: transparent; cursor: pointer; font-size: 15px; color: #6d6558; padding: 2px 4px; }\n.aw-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }\n.aw-chip { border-radius: 4px; padding: 1px 6px; font-size: 10px; background: #ece6da; color: #4a4438; font-variant-numeric: tabular-nums; }\n.aw-chip[data-mode=\"real\"] { background: #d8f0dd; color: #1c6b34; }\n.aw-chip[data-mode=\"synthetic\"] { background: #fde4c8; color: #8a4a08; }\n.aw-chip[data-mode=\"mixed\"] { background: #e6e0fb; color: #45318f; }\n.aw-chip[data-mode=\"empty\"] { background: #eee; color: #666; }\n.aw-chip[data-tone=\"warn\"] { background: #ffe1d6; color: #9a3412; }\n.aw-body { flex: 1; overflow-y: auto; padding: 10px 14px 18px; }\n.aw-sec { border: 1px solid #ece7de; border-radius: 8px; padding: 9px 10px; margin-bottom: 9px; background: #fff; }\n.aw-sec > h2 { font-size: 11px; font-weight: 700; color: #6d6558; letter-spacing: .6px; margin-bottom: 6px; }\n.aw-kv { display: grid; grid-template-columns: 84px 1fr; gap: 2px 8px; font-variant-numeric: tabular-nums; }\n.aw-kv dt { color: #857c6c; }\n.aw-kv dd { color: #262c36; word-break: break-word; }\n.aw-muted { color: #857c6c; }\n.aw-warn { color: #9a3412; }\n.aw-bar-row { display: grid; grid-template-columns: 92px 1fr 62px; align-items: center; gap: 6px; margin: 3px 0; }\n.aw-bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #40453f; }\n.aw-bar-track { background: #f0ece3; border-radius: 3px; height: 9px; overflow: hidden; }\n.aw-bar-fill { height: 100%; background: linear-gradient(90deg, #5b8def, #3454c8); border-radius: 3px; }\n.aw-bar-val { text-align: right; color: #6d6558; font-variant-numeric: tabular-nums; white-space: nowrap; }\n.aw-diff { display: grid; grid-template-columns: 92px 1fr 62px; align-items: center; gap: 6px; margin: 3px 0; }\n.aw-diff-mid { position: relative; height: 9px; background: #f4f1ea; border-radius: 3px; }\n.aw-diff-mid::after { content: \"\"; position: absolute; left: 50%; top: -2px; bottom: -2px; width: 1px; background: #d7d2c7; }\n.aw-diff-pos, .aw-diff-neg { position: absolute; top: 0; height: 100%; border-radius: 3px; }\n.aw-diff-pos { background: #4c9a63; left: 50%; }\n.aw-diff-neg { background: #c6663f; right: 50%; }\n.aw-alert { border-left: 3px solid #e0b34a; padding: 5px 0 5px 8px; margin-bottom: 7px; }\n.aw-alert[data-sev=\"warn\"] { border-color: #c9622f; }\n.aw-alert-title { font-weight: 700; }\n.aw-alert-detail { color: #4a4438; }\n.aw-alert-sug { color: #2c5f43; margin-top: 2px; }\n.aw-ev { display: flex; flex-direction: column; gap: 1px; margin-top: 3px; }\n.aw-ev a { color: #2b5dd7; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.aw-ev a:hover { text-decoration: underline; }\n.aw-notes { background: #f7f3ec; border-radius: 6px; padding: 6px 8px; color: #4a4438; }\n.aw-notes li { margin-left: 14px; }\n.aw-row { display: flex; gap: 6px; align-items: center; }\n.aw-field { display: flex; flex-direction: column; gap: 5px; }\n.aw-input, .aw-select {\n  width: 100%; border: 1px solid #ddd6c8; border-radius: 6px; padding: 5px 7px; font-size: 12px;\n  font-family: inherit; background: #fff; color: #1b1f27; resize: vertical;\n}\n.aw-btn {\n  border: 1px solid #cfc7b7; background: #fff; color: #2c323c; border-radius: 6px; padding: 4px 9px;\n  font-size: 11px; cursor: pointer; font-family: inherit;\n}\n.aw-btn:hover { background: #f4f1ea; }\n.aw-btn[data-primary=\"1\"] { background: #2b5dd7; border-color: #2b5dd7; color: #fff; }\n.aw-btn[data-primary=\"1\"]:hover { background: #244fb8; }\n.aw-btn[data-danger=\"1\"] { color: #9a3412; border-color: #e8c3b1; }\n.aw-btn:disabled { opacity: .55; cursor: default; }\n.aw-status { margin-top: 6px; font-size: 11px; color: #6d6558; min-height: 15px; }\n.aw-sug-item { border-top: 1px dashed #ece7de; padding-top: 5px; margin-top: 5px; }\n.aw-sug-title { font-weight: 700; }\n.aw-foot { font-size: 10px; color: #99917f; margin-top: 4px; }\n";

  const ui = {
    open: false, status: null, profile: null, online: null, goalBusy: false, actionMsg: "",
    goalDraft: "", goalDirty: false, goalMode: null,
    renderedFp: "", renderSeq: 0, drawing: false,
  };

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483000;";
  host.dataset.renderSeq = "0";
  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  shadow.appendChild(styleEl);

  const styleEl2 = document.createElement("style");
  styleEl2.textContent = [
    ".aw-concl { font-size: 13px; font-weight: 700; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }",
    ".aw-concl.aw-muted { font-weight: 400; font-size: 12px; }",
    ".aw-details { border: 1px solid #ece7de; border-radius: 8px; background: #fff; margin-bottom: 9px; }",
    ".aw-details > summary { cursor: pointer; padding: 8px 10px; font-size: 11px; color: #6d6558; font-weight: 700; letter-spacing: .4px; list-style: none; }",
    ".aw-details > summary::-webkit-details-marker { display: none; }",
    ".aw-details > summary::before { content: '\\25B8  '; }",
    ".aw-details[open] > summary::before { content: '\\25BE  '; }",
    ".aw-detail-body { padding: 0 10px 10px; }",
    ".aw-detail-body .aw-sec { border: 0; padding: 0 0 8px; margin-bottom: 8px; border-bottom: 1px dashed #ece7de; }",
    ".aw-detail-body .aw-sec:last-child { border-bottom: 0; margin-bottom: 0; padding-bottom: 0; }",
    ".aw-rec { border-top: 1px dashed #ece7de; padding-top: 6px; margin-top: 6px; }",
    ".aw-rec a { display: block; color: #2b5dd7; text-decoration: none; font-weight: 700; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".aw-rec a:hover { text-decoration: underline; }",
    ".aw-rec-src { font-size: 10px; color: #6d6558; margin-top: 1px; }",
    ".aw-rec-why { font-size: 11px; margin-top: 1px; }",
    ".aw-footer { border-top: 1px solid #ece7de; background: #f7f3ec; color: #857c6c; font-size: 10px; padding: 6px 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
  ].join("\n");
  shadow.appendChild(styleEl2);

  const wrap = document.createElement("div");
  wrap.className = "aw-wrap";
  shadow.appendChild(wrap);

  const nodes = {};
  wrap.innerHTML =
    '<div class="aw-fixed">' +
    '<div class="aw-caption" data-role="caption">服务未启动 · data_mode — · 样本 — · 窗口 —</div>' +
    '<button class="aw-ball" data-role="ball" type="button" data-offline="1"></button>' +
    "</div>" +
    '<aside class="aw-drawer" data-role="drawer" hidden>' +
    '<div class="aw-head">' +
    '<div class="aw-title-row"><span class="aw-title">AI Watcher · 观察窗</span>' +
    '<button class="aw-close" data-role="close" type="button" aria-label="收起">×</button></div>' +
    '<div class="aw-chips" data-role="chips"></div>' +
    "</div>" +
    '<div class="aw-body" data-role="body"></div>' +
    '<div class="aw-footer" data-role="footer"></div>' +
    "</aside>";

  for (const el of wrap.querySelectorAll("[data-role]")) nodes[el.dataset.role] = el;

  function h(tag, cls, textValue) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (textValue != null) el.textContent = String(textValue);
    return el;
  }

  function section(title) {
    const sec = h("section", "aw-sec");
    sec.appendChild(h("h2", null, title));
    return sec;
  }

  function kv(rows) {
    const dl = h("dl", "aw-kv");
    for (const [k, v] of rows) {
      dl.appendChild(h("dt", null, k));
      const dd = h("dd", null, v == null || v === "" ? "—" : v);
      dl.appendChild(dd);
    }
    return dl;
  }

  const pct = (x) => (typeof x === "number" && isFinite(x) ? (x * 100).toFixed(0) + "%" : "—");
  const fixed = (x, n = 2) => (typeof x === "number" && isFinite(x) ? x.toFixed(n) : "—");
  const count = (x) => (typeof x === "number" && isFinite(x) ? String(x) : "—");
  const label = (t) => TOPIC_LABELS[t] || t || "未知";
  const trunc = (s, n) => {
    const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  // 所有外链一律显示视频标题，标题缺失才回退到 URL（用户反馈：裸链接不知道是什么）。
  function link(url, title) {
    if (!url) return null;
    const a = h("a", null, trunc(title || url, 26));
    a.href = url;
    a.target = "_blank";
    a.rel = "noreferrer noopener";
    a.title = title ? String(title) : String(url);
    return a;
  }
  function titleMap(p) {
    const map = new Map();
    for (const alert of (p && p.alerts) || []) {
      for (const ev of alert.evidence || []) {
        if (ev && ev.content_id && ev.url) map.set(ev.content_id, { url: ev.url, title: ev.title });
      }
    }
    return map;
  }
  const CONTEXT_LABELS = { home: "首页推荐", search: "搜索结果", video_related: "相关推荐" };
  function firstSentence(text) {
    const s = String(text || "").trim();
    if (!s) return "";
    const m = s.split(/[。！？!?；;]/)[0];
    return m ? trunc(m, 42) : "";
  }
  const localTime = (ms) => {
    if (!ms) return "—";
    const d = new Date(ms);
    return isNaN(d.getTime()) ? "—" : d.getMonth() + 1 + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  };

  function send(msg) {
    try {
      return Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => ({ ok: false, status: 0, error: { code: "offline", message: "本地服务未启动" } }));
    } catch {
      return Promise.resolve({ ok: false, status: 0, error: { code: "offline", message: "本地服务未启动" } });
    }
  }

  function captureState() {
    const api = globalThis.__aiWatcher;
    return api && typeof api.getState === "function" ? api.getState() : null;
  }

  // ---- ball ----
  function renderBall() {
    const st = ui.status;
    const online = ui.online !== false;
    const cap = captureState();
    const ball = nodes.ball;
    ball.dataset.offline = online ? "0" : "1";
    ball.textContent = "";
    if (!online) {
      ball.appendChild(h("span", "aw-ball-off", "服务"));
      ball.appendChild(h("span", "aw-ball-off", "未启动"));
    } else {
      ball.appendChild(h("span", "aw-ball-count", cap ? cap.count : 0));
      const topics = ui.profile && ui.profile.exposure && ui.profile.exposure.available ? ui.profile.exposure.topics : null;
      const top = topics && topics.length ? label(topics[0].t) : "待样本";
      ball.appendChild(h("span", "aw-ball-topic", top));
    }
    const mode = ui.profile ? ui.profile.data_mode : null;
    const win = ui.profile ? ui.profile.window : null;
    nodes.caption.textContent =
      (online ? (st && st.paused ? "已暂停" : "采集中") : "服务未启动") +
      " · data_mode " + (mode || "—") +
      " · 样本 " + (win ? count(win.exposure_count) : "—") +
      " · 窗口 " + (win ? win.days + "天" : "—");
  }

  // ---- header chips ----
  function renderChips() {
    nodes.chips.textContent = "";
    const p = ui.profile;
    const st = ui.status;
    if (!p) {
      nodes.chips.appendChild(h("span", "aw-chip", ui.online === false ? "服务未启动" : "等待画像"));
      return;
    }
    const mode = h("span", "aw-chip", "data_mode " + p.data_mode);
    mode.dataset.mode = p.data_mode || "empty";
    nodes.chips.appendChild(mode);
    nodes.chips.appendChild(h("span", "aw-chip", "窗口 " + count(p.window && p.window.days) + "天 " + localTime(p.window && p.window.start) + "→" + localTime(p.window && p.window.end)));
    if (st && st.paused) {
      const c = h("span", "aw-chip", "采集已暂停");
      c.dataset.tone = "warn";
      nodes.chips.appendChild(c);
    }
    if (p.ai && p.ai.degraded) {
      const c = h("span", "aw-chip", "AI 降级（关键词兜底）");
      c.dataset.tone = "warn";
      nodes.chips.appendChild(c);
    }
  }

  // ---- 观察条件 ----
  function renderConditions(body) {
    const p = ui.profile;
    const sec = section("观察条件");
    if (!p) {
      sec.appendChild(h("div", "aw-muted", ui.online === false ? "本地服务未启动：没有可展示的观察条件。" : "尚未取到 /api/profile。"));
      body.appendChild(sec);
      return;
    }
    const w = p.window || {};
    sec.appendChild(kv([
      ["data_mode", p.data_mode],
      ["观察窗口", count(w.days) + " 天（" + localTime(w.start) + " → " + localTime(w.end) + "）"],
      ["样本数", count(w.exposure_count) + " 次曝光 / " + count(w.unique_items) + " 个内容"],
      ["会话数", count(w.session_count)],
      ["行为样本", count(w.action_count)],
      ["主题已知率", pct(w.known_topic_ratio) + "（未知 " + pct(w.unknown_topic_ratio) + "）"],
      ["页面来源", "首页 " + count(w.page_contexts && w.page_contexts.home) + " / 视频页 " + count(w.page_contexts && w.page_contexts.video_related) + " / 搜索 " + count(w.page_contexts && w.page_contexts.search)],
    ]));
    sec.appendChild(h("div", "aw-foot", "生成于 " + localTime(p.generated_at) + " · schema " + count(p.schema_version)));
    body.appendChild(sec);
  }

  // ---- 我的目标 ----
  function renderGoal(body) {
    const p = ui.profile;
    const sec = section("我的目标");
    const goal = p && p.goal;
    if (goal && goal.present) {
      const topics = (goal.topics || []).map((t) => label(t.t)).slice(0, 3).join("、");
      const modeName = (INTENT_MODES.find((m) => m[0] === goal.intent_mode) || [goal.intent_mode, goal.intent_mode])[1];
      sec.appendChild(h("div", null, goal.text));
      sec.appendChild(h("div", "aw-muted", "意图：" + modeName + (topics ? " · 主题：" + topics : "")));
    } else {
      sec.appendChild(h("div", "aw-muted", "还没有设置目标。没有目标就无法做「目标 vs 曝光」的对照。"));
    }
    const form = h("div", "aw-field");
    const area = h("textarea", "aw-input");
    area.rows = 2;
    area.dataset.role = "goal-input";
    area.placeholder = "用一句话写下你这次想达成什么，例如：两周内搞懂注意力机制，少刷纯娱乐";
    area.value = ui.goalDraft;
    area.addEventListener("input", () => {
      ui.goalDraft = area.value;
      const saved = goal && goal.present ? String(goal.text || "").trim() : "";
      ui.goalDirty = area.value.trim() !== saved;
    });
    const row = h("div", "aw-row");
    const sel = h("select", "aw-select");
    sel.style.maxWidth = "150px";
    if (ui.goalMode) sel.value = ui.goalMode;
    sel.addEventListener("change", () => { ui.goalMode = sel.value; });
    for (const [value, textValue] of INTENT_MODES) {
      const opt = h("option", null, textValue);
      opt.value = value;
      sel.appendChild(opt);
    }
    const btn = h("button", "aw-btn", "保存目标");
    btn.type = "button";
    btn.dataset.primary = "1";
    const status = h("div", "aw-status");
    btn.addEventListener("click", async () => {
      const text = area.value.trim();
      if (!text) {
        status.textContent = "先写一句目标再保存。";
        return;
      }
      btn.disabled = true;
      status.textContent = "提交中…";
      const res = await send({ type: "goal", body: { goal_text: text, intent_mode: sel.value } });
      btn.disabled = false;
      if (res && res.ok) {
        status.textContent = "已保存：" + (res.data && res.data.intent_mode ? res.data.intent_mode : sel.value);
        ui.goalDraft = "";
        ui.goalDirty = false;
        area.value = "";
        await refreshProfile({ force: true });
      } else {
        status.textContent = "保存失败：" + ((res && res.error && res.error.message) || "本地服务未启动");
      }
    });
    row.appendChild(sel);
    row.appendChild(btn);
    form.appendChild(area);
    form.appendChild(row);
    form.appendChild(status);
    sec.appendChild(form);
    body.appendChild(sec);
  }

  // ---- 曝光画像 ----
  function bars(rows, key) {
    const box = h("div");
    const max = rows.reduce((m, r) => Math.max(m, r[key] || 0), 0) || 1;
    for (const r of rows) {
      const row = h("div", "aw-bar-row");
      row.appendChild(h("span", "aw-bar-label", label(r.t)));
      const track = h("div", "aw-bar-track");
      const fill = h("div", "aw-bar-fill");
      fill.style.width = Math.max(1, Math.round(((r[key] || 0) / max) * 100)) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(h("span", "aw-bar-val", pct(r[key])));
      box.appendChild(row);
    }
    return box;
  }

  function renderExposure(body) {
    const p = ui.profile;
    const sec = section("主题分布");
    const e = p && p.exposure;
    if (!p || !e || !e.available) {
      const why = (p && p.notes && p.notes[0]) || "样本还不够看分布";
      sec.appendChild(h("div", "aw-muted", why));
      body.appendChild(sec);
      return;
    }
    const rows = (e.topics || []).slice(0, 6);
    sec.appendChild(bars(rows, "w"));
    body.appendChild(sec);
  }


  // ---- 对照 ----
  function diffRows(cmp, leftKey, leftName, rightName) {
    const box = h("div");
    box.appendChild(h("div", "aw-muted", leftName + "（左） vs " + rightName + "（右）· 每行是该主题的差值"));
    const rows = (cmp && cmp.by_topic) || [];
    for (const r of rows) {
      const row = h("div", "aw-diff");
      row.appendChild(h("span", "aw-bar-label", label(r.t)));
      const mid = h("div", "aw-diff-mid");
      const diff = typeof r.diff === "number" ? r.diff : 0;
      const bar = h("div", diff >= 0 ? "aw-diff-pos" : "aw-diff-neg");
      bar.style.width = Math.min(50, Math.abs(diff) * 100) + "%";
      mid.appendChild(bar);
      row.appendChild(mid);
      row.appendChild(h("span", "aw-bar-val", (diff >= 0 ? "+" : "") + fixed(diff)));
      box.appendChild(row);
    }
    return box;
  }

  function renderCompare(body) {
    const p = ui.profile;
    const sec = section("行为 vs 曝光 · 目标 vs 曝光");
    if (!p) {
      sec.appendChild(h("div", "aw-muted", "尚未取到画像。"));
      body.appendChild(sec);
      return;
    }
    const bc = p.behavior_cmp;
    const gc = p.goal_cmp;
    sec.appendChild(h("div", "aw-muted", "行为 vs 曝光"));
    if (bc && typeof bc.D === "number") {
      sec.appendChild(kv([["D 值", fixed(bc.D)]]));
      sec.appendChild(diffRows(bc, "u", "行为", "曝光"));
    } else {
      const why = p.behavior && p.behavior.reason ? p.behavior.reason : "行为样本或主题样本不足";
      sec.appendChild(h("div", "aw-muted", "不计算：" + why));
    }
    sec.appendChild(h("div", "aw-muted", "目标 vs 曝光"));
    if (gc && typeof gc.D === "number") {
      sec.appendChild(kv([["D 值", fixed(gc.D)]]));
      sec.appendChild(diffRows(gc, "g", "目标", "曝光"));
    } else {
      sec.appendChild(h("div", "aw-muted", p.goal && p.goal.present ? "不计算：目标或主题样本不足" : "不计算：尚未设置目标"));
    }
    body.appendChild(sec);
  }

  // ---- 提醒 + 建议 ----
  function renderAlerts(body) {
    const p = ui.profile;
    const sec = section("提醒 · 建议");
    const alerts = (p && p.alerts) || [];
    if (alerts.length === 0) {
      sec.appendChild(h("div", "aw-muted", "为什么不下结论："));
      const notes = (p && p.notes) || [];
      if (notes.length === 0) {
        sec.appendChild(h("div", "aw-muted", p ? "服务端未返回 notes，暂不生成结论。" : "尚未取到画像。"));
      } else {
        const ul = h("ul", "aw-notes");
        for (const note of notes) ul.appendChild(h("li", null, note));
        sec.appendChild(ul);
      }
    } else {
      for (const alert of alerts) {
        const box = h("div", "aw-alert");
        box.dataset.sev = alert.severity || "info";
        box.appendChild(h("div", "aw-alert-title", alert.title || alert.rule_id || "提醒"));
        if (alert.detail) box.appendChild(h("div", "aw-alert-detail", alert.detail));
        if (alert.suggestion) box.appendChild(h("div", "aw-alert-sug", "建议：" + alert.suggestion));
        const evs = alert.evidence || [];
        if (evs.length) {
          const list = h("div", "aw-ev");
          for (const ev of evs.slice(0, 5)) {
            if (ev && ev.url) {
              const a = link(ev.url, ev.title);
              a.title = "回到原视频：" + (ev.title || ev.url);
              list.appendChild(a);
            } else if (ev && ev.title) {
              list.appendChild(h("span", "aw-muted", ev.title));
            }
          }
          if (list.childNodes.length) box.appendChild(list);
        }
        if (alert.thresholds_used) {
          const used = Object.entries(alert.thresholds_used).map(([k, v]) => k + "=" + v).join(" ");
          box.appendChild(h("div", "aw-foot", "阈值：" + used + "（演示用阈值，非学术标准）"));
        }
        sec.appendChild(box);
      }
    }
    const notes = (p && p.notes) || [];
    if (alerts.length > 0 && notes.length) {
      const ul = h("ul", "aw-notes");
      for (const note of notes) ul.appendChild(h("li", null, note));
      sec.appendChild(ul);
    }
    const ai = p && p.ai;
    if (ai) sec.appendChild(h("div", "aw-foot", "AI " + (ai.model || "—") + (ai.degraded ? "（降级：关键词兜底）" : "") + (ai.cached ? "（缓存命中）" : "")));
    body.appendChild(sec);
  }

  // ---- 操作 ----
  function renderActions(body) {
    const sec = section("操作");
    const st = ui.status;
    const paused = !!(st && st.paused);
    const row = h("div", "aw-row");
    const pauseBtn = h("button", "aw-btn", paused ? "继续采集" : "暂停采集");
    pauseBtn.type = "button";
    pauseBtn.addEventListener("click", async () => {
      pauseBtn.disabled = true;
      const next = !paused;
      const res = await send({ type: "pause", paused: next });
      pauseBtn.disabled = false;
      const api = globalThis.__aiWatcher;
      if (api && typeof api.setPaused === "function") api.setPaused(next);
      ui.status = { ...(ui.status || {}), paused: next };
      ui.actionMsg = res && res.ok ? (next ? "采集已暂停。" : "采集已恢复。") : "切换失败：" + ((res && res.error && res.error.message) || "服务未启动");
      render();
    });
    const refreshBtn = h("button", "aw-btn", "刷新");
    refreshBtn.type = "button";
    refreshBtn.dataset.role = "refresh";
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      await refreshStatus();
      ui.actionMsg = "已刷新。";
      await refreshProfile({ force: true });
    });
    const exportBtn = h("button", "aw-btn", "导出 JSONL");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", async () => {
      exportBtn.disabled = true;
      const res = await send({ type: "export" });
      exportBtn.disabled = false;
      if (res && res.ok) {
        const blob = new Blob([typeof res.data === "string" ? res.data : JSON.stringify(res.data)], { type: "text/plain" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "ai-watcher-" + new Date().toISOString().replace(/[:.]/g, "-") + ".jsonl";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        ui.actionMsg = "已导出 JSONL。";
      } else {
        ui.actionMsg = "导出失败：" + ((res && res.error && res.error.message) || "服务未启动");
      }
      render();
    });
    const resetBtn = h("button", "aw-btn", "清空数据");
    resetBtn.type = "button";
    resetBtn.dataset.danger = "1";
    resetBtn.addEventListener("click", async () => {
      if (!window.confirm("清空本地所有曝光/行为/目标记录？此操作不可撤销。")) return;
      resetBtn.disabled = true;
      const res = await send({ type: "reset" });
      resetBtn.disabled = false;
      ui.actionMsg = res && res.ok ? "已清空。" : "清空失败：" + ((res && res.error && res.error.message) || "服务未启动");
      await refreshProfile();
    });
    row.appendChild(pauseBtn);
    row.appendChild(refreshBtn);
    row.appendChild(exportBtn);
    row.appendChild(resetBtn);
    sec.appendChild(row);
    sec.appendChild(h("div", "aw-status", ui.actionMsg || (ui.online === false ? "本地服务未启动（127.0.0.1:3789）。" : "采集与状态都来自本地服务，不做本地推断。")));
    body.appendChild(sec);
  }

  // ---- 首屏 1：结论（提醒标题合并 + 叙述首句，最多两行）----
  function renderConclusion(body) {
    const p = ui.profile;
    const sec = section("结论");
    if (!p) {
      sec.appendChild(h("div", "aw-muted", ui.online === false ? "本地服务未启动。" : "正在取画像…"));
      body.appendChild(sec);
      return;
    }
    const titles = [];
    for (const a of p.alerts || []) {
      const t = a.title || a.rule_id;
      if (t && titles.indexOf(t) < 0) titles.push(t);
    }
    sec.appendChild(h("div", "aw-concl", titles.length ? titles.slice(0, 2).join("；") : "暂时没有集中的信号"));
    const sent = firstSentence(p.ai && p.ai.narrative);
    if (sent) sec.appendChild(h("div", "aw-concl aw-muted", sent));
    body.appendChild(sec);
  }

  // ---- 首屏 3：建议（最多 3 条，链接显示视频标题）----
  function renderSuggestions(body) {
    const p = ui.profile;
    const sec = section("建议");
    const list = (p && p.ai && p.ai.suggestions) || [];
    if (!list.length) {
      sec.appendChild(h("div", "aw-muted", ui.online === false ? "服务未启动，暂时没有建议。" : "暂时没有建议。"));
      body.appendChild(sec);
      return;
    }
    const map = titleMap(p);
    for (const sug of list.slice(0, 3)) {
      const item = h("div", "aw-sug-item");
      item.appendChild(h("div", "aw-sug-title", trunc(sug.title || "建议", 20)));
      if (sug.why) item.appendChild(h("div", "aw-muted", trunc(sug.why, 60)));
      const links = h("div", "aw-ev");
      for (const id of sug.evidence_ids || []) {
        const hit = map.get(id);
        if (hit && hit.url) links.appendChild(link(hit.url, hit.title));
        else if (hit && hit.title) links.appendChild(h("span", "aw-muted", trunc(hit.title, 26)));
      }
      if (links.childNodes.length) item.appendChild(links);
      sec.appendChild(item);
    }
    body.appendChild(sec);
  }

  // ---- 首屏 4：可以点开看看（recommendations 为空时整块不出现）----
  function recWhy(rec) {
    if (rec && rec.why) return trunc(rec.why, 40);
    const b = (rec && rec.basis) || {};
    const parts = [];
    if (typeof b.goal_match === "number" && b.goal_match >= 0.6) parts.push("和你目标相关");
    if (typeof b.fills_gap === "number" && b.fills_gap >= 0.6) parts.push("这个主题你刷得少");
    if (typeof b.source_diversity === "number" && b.source_diversity >= 0.6) parts.push("换个来源");
    if (typeof b.novelty === "number" && b.novelty >= 0.6) parts.push("以前没刷到");
    return parts.length ? parts.slice(0, 2).join("；") : "你的推荐流里出现过，但你没点开";
  }

  function renderRecommendations(body) {
    const recs = (ui.profile && ui.profile.recommendations) || [];
    if (!recs.length) return;
    const sec = section("可以点开看看");
    for (const rec of recs.slice(0, 3)) {
      const item = h("div", "aw-rec");
      const a = link(rec.url, rec.title || rec.content_id);
      if (a) item.appendChild(a);
      else item.appendChild(h("div", "aw-sug-title", trunc(rec.title || "—", 26)));
      const src = rec.source_name || "未知来源";
      item.appendChild(h("div", "aw-rec-src", src + (rec.page_context ? " · " + (CONTEXT_LABELS[rec.page_context] || rec.page_context) : "")));
      item.appendChild(h("div", "aw-rec-why aw-muted", recWhy(rec)));
      sec.appendChild(item);
    }
    body.appendChild(sec);
  }

  // ---- 折叠区（首屏之后）：指标、阈值、不下结论的理由 ----
  function renderExposureMetrics(body) {
    const p = ui.profile;
    const sec = section("曝光指标");
    const e = p && p.exposure;
    if (!e || !e.available) {
      sec.appendChild(h("div", "aw-muted", "样本不足，指标不计算。"));
      body.appendChild(sec);
      return;
    }
    const src = e.top_source;
    sec.appendChild(kv([
      ["归一化熵", fixed(e.entropy) + "（越接近 1 越分散）"],
      ["重复曝光率", pct(e.repeat_rate)],
      ["单一来源占比", src ? (src.name || src.id || "未知") + " " + pct(src.share) + "（" + count(src.n) + " 次）" : "—"],
      ["内容数 / 来源数", count(e.unique_items) + " / " + count(e.source_count)],
    ]));
    body.appendChild(sec);
  }

  function renderDetails(body) {
    const d = document.createElement("details");
    d.className = "aw-details";
    const s = document.createElement("summary");
    s.textContent = "展开细节（指标、阈值、不下结论的理由）";
    d.appendChild(s);
    const inner = h("div", "aw-detail-body");
    d.appendChild(inner);
    if (!ui.profile) {
      inner.appendChild(h("div", "aw-muted", "尚未取到画像。"));
    } else {
      renderConditions(inner);
      renderExposureMetrics(inner);
      renderCompare(inner);
      renderAlerts(inner);
    }
    body.appendChild(d);
  }

  // ---- 底部不可省略的一行：data_mode + 样本数 + 为什么不下结论 ----
  function renderFooter() {
    const el = nodes.footer;
    if (!el) return;
    const p = ui.profile;
    if (!p) {
      el.textContent = (ui.online === false ? "本地服务未启动" : "等待画像") + " · data_mode — · 样本 —";
      return;
    }
    const w = p.window || {};
    const bits = ["data_mode " + (p.data_mode || "—"), "样本 " + count(w.exposure_count) + " 次曝光"];
    let reason = "";
    if (p.behavior && p.behavior.available === false && p.behavior.reason) reason = p.behavior.reason;
    else if (!(p.alerts || []).length && p.notes && p.notes[0]) reason = p.notes[0];
    if (reason) bits.push(trunc(reason, 24));
    el.textContent = bits.join(" · ");
  }

  // 指纹：只有这些字段变了才值得重绘；数据没变就不碰 DOM。
  function profileFingerprint(p) {
    if (!p) return "";
    const w = p.window || {};
    return [
      p.data_mode,
      w.start, w.exposure_count, w.unique_items, w.action_count,
      (p.alerts || []).map((a) => a.rule_id).join(","),
      p.ai && p.ai.narrative ? String(p.ai.narrative.length) + (p.ai.narrative_cached ? "c" : "") : "0",
      (p.recommendations || []).map((r) => r.content_id).join(","),
      p.goal && p.goal.present ? String(p.goal.updated_at || "") + "|" + String(p.goal.text || "") : "none",
    ].join("~");
  }

  // 用户正在输入/选择时不许重绘，否则文字会被清空。
  function isEditing() {
    const el = shadow.activeElement;
    if (!el || !el.tagName) return false;
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.tagName === "SELECT";
  }

  function render() {
    if (ui.drawing) return;
    ui.drawing = true;
    try {
      const body = nodes.body;
      const scroll = body.scrollTop;
      const prevDetails = body.querySelector("details");
      const detailsOpen = prevDetails ? prevDetails.open : false;
      ui.renderSeq += 1;
      host.dataset.renderSeq = String(ui.renderSeq);
      renderChips();
      body.textContent = "";
      renderConclusion(nodes.body);
      renderExposure(nodes.body);
      renderSuggestions(nodes.body);
      renderRecommendations(nodes.body);
      renderGoal(nodes.body);
      renderDetails(nodes.body);
      renderActions(nodes.body);
      renderFooter();
      const nextDetails = body.querySelector("details");
      if (nextDetails) nextDetails.open = detailsOpen;
      body.scrollTop = scroll;
      ui.renderedFp = profileFingerprint(ui.profile);
      renderBall();
    } finally {
      ui.drawing = false;
    }
  }

  function renderBallOnly() {
    renderBall();
  }

  async function refreshStatus() {
    const res = await send({ type: "status" });
    ui.online = !!(res && res.ok);
    ui.status = res && res.ok ? res.data : null;
    renderBallOnly();
    if (ui.open) renderChips();
    return ui.online;
  }

  async function refreshProfile(options) {
    const force = !!(options && options.force);
    const res = await send({ type: "profile", days: 7 });
    if (res && res.ok) ui.profile = res.data;
    else if (res && res.status === 0) ui.online = false;
    const fp = profileFingerprint(ui.profile);
    // 指纹没变、或用户正在编辑 → 完全不碰 DOM（球上的数字照常刷新）。
    if (!force && (fp === ui.renderedFp || ui.goalDirty || isEditing())) {
      renderBall();
      return res;
    }
    render();
    return res;
  }

  function setOpen(open) {
    ui.open = open;
    nodes.drawer.hidden = !open;
    nodes.ball.closest(".aw-fixed").dataset.open = open ? "1" : "0";
    if (open) {
      render();
      refreshStatus().then(() => refreshProfile());
    }
  }

  nodes.ball.addEventListener("click", () => setOpen(!ui.open));
  nodes.close.addEventListener("click", () => setOpen(false));

  host.style.display = "block";
  document.documentElement.appendChild(host);

  renderBallOnly();
  refreshStatus()
    .then(() => {
      if (ui.online) return refreshProfile();
      return null;
    })
    .catch(() => {});

  // 抽屉关着时只刷球上的数字（5s，不重绘）；抽屉打开时画像 20s 一次，且受指纹与编辑态约束。
  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 5000);
  setInterval(() => {
    if (!ui.open) return;
    refreshProfile().catch(() => {});
  }, 20000);

  const api = globalThis.__aiWatcher;
  if (api && typeof api.subscribe === "function") {
    api.subscribe(() => renderBallOnly());
  }
})();

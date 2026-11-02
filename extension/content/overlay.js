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

  const ui = { open: false, status: null, profile: null, online: null, goalBusy: false, actionMsg: "" };

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;z-index:2147483000;";
  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = document.createElement("style");
  styleEl.textContent = STYLE;
  shadow.appendChild(styleEl);

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
    nodes.chips.appendChild(h("span", "aw-chip", "样本 " + count(p.window && p.window.exposure_count) + " 次曝光"));
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
      const topics = (goal.topics || []).map((t) => label(t.t) + " " + fixed(t.w)).join("、");
      sec.appendChild(kv([
        ["目标", goal.text],
        ["意图模式", (INTENT_MODES.find((m) => m[0] === goal.intent_mode) || [goal.intent_mode, goal.intent_mode])[1]],
        ["目标主题", topics || "—"],
        ["来源", goal.source],
      ]));
    } else {
      sec.appendChild(h("div", "aw-muted", "还没有设置目标。没有目标就无法做「目标 vs 曝光」的对照。"));
    }
    const form = h("div", "aw-field");
    const area = h("textarea", "aw-input");
    area.rows = 2;
    area.placeholder = "用一句话写下你这次想达成什么，例如：两周内搞懂注意力机制，少刷纯娱乐";
    const row = h("div", "aw-row");
    const sel = h("select", "aw-select");
    sel.style.maxWidth = "150px";
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
        area.value = "";
        await refreshProfile();
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
      row.appendChild(h("span", "aw-bar-val", pct(r[key]) + (r.n != null ? " ·" + r.n : "")));
      box.appendChild(row);
    }
    return box;
  }

  function renderExposure(body) {
    const p = ui.profile;
    const sec = section("曝光画像（平台给了我什么）");
    const e = p && p.exposure;
    if (!p || !e || !e.available) {
      sec.appendChild(h("div", "aw-muted", "样本不足，暂不展示曝光分布。"));
      body.appendChild(sec);
      return;
    }
    sec.appendChild(h("div", "aw-muted", "主题分布（权重和 = 1）"));
    sec.appendChild(bars(e.topics || [], "w"));
    const src = e.top_source;
    sec.appendChild(kv([
      ["归一化熵", fixed(e.entropy) + "（越接近 1 越分散）"],
      ["重复曝光率", pct(e.repeat_rate)],
      ["单一来源占比", src ? (src.name || src.id || "未知") + " " + pct(src.share) + "（" + count(src.n) + " 次）" : "—"],
      ["内容数 / 来源数", count(e.unique_items) + " / " + count(e.source_count)],
    ]));
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
  function evidenceMap(p) {
    const map = new Map();
    for (const alert of (p && p.alerts) || []) {
      for (const ev of alert.evidence || []) {
        if (ev && ev.content_id && ev.url) map.set(ev.content_id, ev.url);
      }
    }
    return map;
  }

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
              const a = h("a", null, ev.title || ev.url);
              a.href = ev.url;
              a.target = "_blank";
              a.rel = "noreferrer noopener";
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
    if (ai && (ai.narrative || (ai.suggestions || []).length)) {
      const map = evidenceMap(p);
      if (ai.narrative) sec.appendChild(h("div", null, ai.narrative));
      for (const sug of (ai.suggestions || []).slice(0, 3)) {
        const item = h("div", "aw-sug-item");
        item.appendChild(h("div", "aw-sug-title", sug.title || "建议"));
        if (sug.why) item.appendChild(h("div", "aw-muted", sug.why));
        if (sug.action) item.appendChild(h("div", "aw-foot", "动作：" + sug.action));
        const links = h("div", "aw-ev");
        for (const id of sug.evidence_ids || []) {
          const url = map.get(id);
          if (url) {
            const a = h("a", null, url);
            a.href = url;
            a.target = "_blank";
            a.rel = "noreferrer noopener";
            links.appendChild(a);
          } else {
            links.appendChild(h("span", "aw-muted", id));
          }
        }
        if (links.childNodes.length) item.appendChild(links);
        sec.appendChild(item);
      }
      sec.appendChild(h("div", "aw-foot", "AI " + (ai.model || "—") + (ai.degraded ? "（降级）" : "") + (ai.cached ? "（缓存命中）" : "")));
    }
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
    row.appendChild(exportBtn);
    row.appendChild(resetBtn);
    sec.appendChild(row);
    sec.appendChild(h("div", "aw-status", ui.actionMsg || (ui.online === false ? "本地服务未启动（127.0.0.1:3789）。" : "采集与状态都来自本地服务，不做本地推断。")));
    body.appendChild(sec);
  }

  function render() {
    renderChips();
    nodes.body.textContent = "";
    renderConditions(nodes.body);
    renderGoal(nodes.body);
    renderExposure(nodes.body);
    renderCompare(nodes.body);
    renderAlerts(nodes.body);
    renderActions(nodes.body);
    renderBall();
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

  async function refreshProfile() {
    const res = await send({ type: "profile", days: 7 });
    if (res && res.ok) ui.profile = res.data;
    else if (res && res.status === 0) ui.online = false;
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

  setInterval(() => {
    refreshStatus().catch(() => {});
  }, 3000);
  setInterval(() => {
    if (ui.open) refreshProfile().catch(() => {});
  }, 10000);

  const api = globalThis.__aiWatcher;
  if (api && typeof api.subscribe === "function") {
    api.subscribe(() => renderBallOnly());
  }
})();

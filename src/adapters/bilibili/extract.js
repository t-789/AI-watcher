// B站 DOM → 归一化观测。唯一事实来源：扩展通过 chrome.runtime.getURL 动态 import 本文件，
// 不复制副本。本模块的顶层不得触碰 document，以便在 node 里被 import 做契约校验。

const BILIBILI_ORIGIN = "https://www.bilibili.com";
const VIDEO_ID = /(BV[0-9A-Za-z]{8,})|(av\d+)/i;
const MAX_DESC = 800;
const MAX_COMMENTS = 8;

function text(el) {
  if (!el) return "";
  return String(el.textContent || "").replace(/\s+/g, " ").trim();
}

function attr(el, name) {
  if (!el || typeof el.getAttribute !== "function") return "";
  const v = el.getAttribute(name);
  return v == null ? "" : String(v).trim();
}

/**
 * 把任意一条 B 站链接归一化为去重键：丢弃 query/hash/尾斜杠、统一 m. 前缀，
 * 并把 /festival/?bvid=BV.. 这类变体收敛回 /video/BV..。无法解析返回 ""。
 */
export function canonicalizeUrl(url) {
  const raw = String(url == null ? "" : url).trim();
  if (!raw) return "";
  let abs = raw;
  if (abs.startsWith("//")) abs = "https:" + abs;
  else if (abs.startsWith("/")) abs = BILIBILI_ORIGIN + abs;
  let parsed;
  try {
    parsed = new URL(abs);
  } catch {
    return "";
  }
  if (!/(^|\.)bilibili\.com$/i.test(parsed.hostname)) {
    return (parsed.origin + parsed.pathname).replace(/\/$/, "");
  }
  const bvid = VIDEO_ID.exec(parsed.pathname);
  if (bvid) {
    return BILIBILI_ORIGIN + "/video/" + (bvid[1] || bvid[2]) + "/";
  }
  const queryBv = VIDEO_ID.exec(parsed.search || "");
  if (queryBv) {
    return BILIBILI_ORIGIN + "/video/" + (queryBv[1] || queryBv[2]) + "/";
  }
  return BILIBILI_ORIGIN + (parsed.pathname.replace(/\/$/, "") || "/");
}

/** "44.8万" / "1.2亿" / "3,456" / "10万+" → 整数；无法解析返回 null（不猜 0）。 */
export function parseCount(input) {
  if (input == null) return null;
  const s = String(input).replace(/[\s,，、+　]/g, "");
  if (!s || /^(-|—|–|暂无|未知|null)$/.test(s)) return null;
  const m = /^(\d+(?:\.\d+)?)(万|亿|w|k|千)?/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "").toLowerCase();
  const scale = unit === "万" || unit === "w" ? 1e4 : unit === "亿" ? 1e8 : unit === "千" || unit === "k" ? 1e3 : 1;
  return Math.round(n * scale);
}

/** "01:37" → 97、"1:02:03" → 3723、"01:37:00" → 5820、"3分20秒" → 200；无法解析返回 null。 */
export function parseDuration(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/.exec(s);
  if (clock) {
    const h = clock[1] ? Number(clock[1]) : 0;
    const m = Number(clock[2]);
    const sec = Number(clock[3]);
    if (m > 59 || sec > 59) return h * 3600 + m * 60 + sec;
    return h * 3600 + m * 60 + sec;
  }
  const cn = /^(?:(\d+)\s*(?:小时|时))?\s*(?:(\d+)\s*分)?\s*(?:(\d+)\s*秒)?$/.exec(s);
  if (cn && (cn[1] || cn[2] || cn[3])) {
    return Number(cn[1] || 0) * 3600 + Number(cn[2] || 0) * 60 + Number(cn[3] || 0);
  }
  const mins = /^(\d+(?:\.\d+)?)\s*(?:分钟|min)$/i.exec(s);
  if (mins) return Math.round(Number(mins[1]) * 60);
  return null;
}

function midFromSpaceLink(href) {
  const m = /space\.bilibili\.com\/(\d+)/.exec(String(href || ""));
  return m ? m[1] : undefined;
}

function epochFromLocal(textValue) {
  const m = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(textValue || ""));
  if (!m) return undefined;
  const ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function statsOf(card) {
  const out = {};
  const items = card.querySelectorAll(".bili-video-card__stats--item");
  const values = [];
  for (const item of items) {
    const n = parseCount(text(item.querySelector(".bili-video-card__stats--text")) || text(item));
    if (n != null) values.push(n);
  }
  if (values.length > 0) out.view_count = values[0];
  if (values.length > 1) out.danmaku_count = values[1];
  return out;
}

/** 单张视频卡（首页 / 搜索页复用同一套 class）→ 契约 §5 cards[] 元素；不合格返回 null。 */
function cardFrom(card) {
  const titleEl = card.querySelector(".bili-video-card__info--tit");
  const title = text(titleEl) || attr(titleEl, "title");
  const linkEl =
    card.querySelector("a.bili-video-card__image--link[href]") ||
    card.querySelector(".bili-video-card__info--tit a[href]") ||
    card.querySelector("a[href*='/video/']");
  const url = canonicalizeUrl(attr(linkEl, "href"));
  if (!title || !url) return null;
  const ownerLink = card.querySelector("a.bili-video-card__info--owner[href], a[href*='space.bilibili.com']");
  const card_ = {
    title,
    url,
    author: text(card.querySelector(".bili-video-card__info--author")),
  };
  const authorId = midFromSpaceLink(attr(ownerLink, "href"));
  if (authorId) card_.author_id = authorId;
  const duration = parseDuration(text(card.querySelector(".bili-video-card__stats__duration")));
  if (duration != null) card_.duration_s = duration;
  Object.assign(card_, statsOf(card));
  return card_;
}

function cardsFrom(root, selector, seen) {
  const out = [];
  for (const el of root.querySelectorAll(selector)) {
    const card = cardFrom(el);
    if (!card) continue;
    const key = card.url + "|" + card.title;
    if (seen.has(key)) continue;
    seen.add(key);
    card.rank = out.length + 1;
    out.push(card);
  }
  return out;
}

/** 首页 feed：div.feed-card > .bili-video-card（骨架卡没有标题链接，会被过滤掉）。 */
export function extractHomeFeed(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  const seen = new Set();
  const feed = cardsFrom(doc, ".bili-video-card", seen);
  return feed;
}

/** 搜索页：.video-list 内复用同一视频卡组件；没有 .video-list 时退回全页卡片。 */
export function extractSearch(doc) {
  if (!doc || typeof doc.querySelectorAll !== "function") return [];
  const seen = new Set();
  const scoped = cardsFrom(doc, ".video-list .bili-video-card", seen);
  if (scoped.length > 0) return scoped;
  return cardsFrom(doc, ".bili-video-card", seen);
}

// 评论在 bili-comments 的多层开放 shadow root 里（lit 组件），querySelectorAll 穿不透，
// 只能逐层下钻；未登录时平台只渲染一行"登录后查看 N 条评论"，那种提示不算评论。
function deepCollect(root, predicate, out, depth) {
  if (!root || depth > 12) return out;
  for (const el of root.querySelectorAll("*")) {
    if (predicate(el)) out.push(el);
    if (el.shadowRoot) deepCollect(el.shadowRoot, predicate, out, depth + 1);
  }
  return out;
}

const LOGIN_GATE = /登录后查看|登录后可查看|登录/;

function collectComments(doc) {
  const texts = [];
  const push = (value) => {
    const t = String(value || "").replace(/\s+/g, " ").trim();
    if (!t || t.length > 300) return;
    if (LOGIN_GATE.test(t) && t.length < 40) return;
    if (texts.includes(t)) return;
    texts.push(t);
  };
  for (const el of doc.querySelectorAll(".reply-item .reply-content, .reply-content")) push(text(el));
  for (const host of doc.querySelectorAll("bili-comments")) {
    if (!host.shadowRoot) continue;
    const rich = deepCollect(host.shadowRoot, (el) => el.tagName === "BILI-RICH-TEXT", [], 0);
    for (const el of rich) push(el.shadowRoot ? el.shadowRoot.textContent : el.textContent);
  }
  return texts.slice(0, MAX_COMMENTS);
}

function relatedCards(doc) {
  const seen = new Set();
  const out = [];
  for (const el of doc.querySelectorAll(".video-page-card-small")) {
    const link = el.querySelector("a[href*='/video/'], a[href*='BV']");
    const titleEl = el.querySelector(".info .title, .title");
    const url = canonicalizeUrl(attr(link, "href"));
    const title = text(titleEl) || attr(link, "alt_title");
    if (!title || !url) continue;
    const key = url + "|" + title;
    if (seen.has(key)) continue;
    seen.add(key);
    const card = { title, url, author: text(el.querySelector("[class*='upname']")), rank: out.length + 1 };
    const playline = text(el.querySelector(".playinfo"));
    const view = parseCount(playline.split(/\s+/)[0]);
    if (view != null) card.view_count = view;
    const dm = parseCount(playline.split(/\s+/)[1]);
    if (dm != null) card.danmaku_count = dm;
    const duration = parseDuration(text(el.querySelector("[class*='duration']")));
    if (duration != null) card.duration_s = duration;
    out.push(card);
  }
  return out;
}

/**
 * 视频页 → 契约 §5 的 page 对象（外加 related 供 page_context="video_related" 的曝光用）。
 * 只读用户在页面上看得见的东西：标题、UP 主、简介、播放/弹幕数、发布时间、热评。
 */
export function extractVideoPage(doc) {
  const empty = { title: "", url: "", author: "", desc: "", comments: [], related: [] };
  if (!doc || typeof doc.querySelectorAll !== "function") return empty;

  const titleEl = doc.querySelector("h1.video-title") || doc.querySelector("h1[class*='video-title']");
  let title = text(titleEl) || attr(titleEl, "title");
  if (!title && doc.title) title = String(doc.title).replace(/_哔哩哔哩.*$/, "").trim();

  const upLink = doc.querySelector(".up-detail-top a[href*='space.bilibili.com'], .up-name");
  const descRaw = text(doc.querySelector(".desc-info-text")) || text(doc.querySelector(".basic-desc-info"));
  const desc = descRaw === "-" ? "" : descRaw.slice(0, MAX_DESC);

  const page = {
    title,
    url: canonicalizeUrl(doc.location ? doc.location.href : ""),
    author: text(doc.querySelector(".up-name")) || text(upLink),
    desc,
    comments: collectComments(doc),
    related: relatedCards(doc),
  };
  const authorId = midFromSpaceLink(attr(doc.querySelector(".up-detail-top a[href*='space.bilibili.com']"), "href"));
  if (authorId) page.author_id = authorId;
  const view = parseCount(text(doc.querySelector(".view-text")));
  if (view != null) page.view_count = view;
  const dm = parseCount(text(doc.querySelector(".dm-text")));
  if (dm != null) page.danmaku_count = dm;
  const published = epochFromLocal(text(doc.querySelector(".pubdate-ip-text")));
  if (published) page.published_at = published;
  const duration = parseDuration(text(doc.querySelector(".video-info-meta .duration, .duration")));
  if (duration != null) page.duration_s = duration;
  return page;
}

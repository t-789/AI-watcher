# AI Watcher · 集成契约 (v1)

> 本文件是并行开发的唯一事实来源。任何实现与本文件冲突，以实现方为准的只有"名字/形状"两件事：名字不改，形状不改；内部怎么写归实现者。

## 0. 分层与文件归属

| 层 | 目录 | 归属任务 | 说明 |
| --- | --- | --- | --- |
| 采集适配器 | `extension/**`、`src/adapters/bilibili/**` | TASK-EXT | 唯一与平台绑定的一层；只做"看得见的 DOM → 归一化观测" |
| 归一化契约 | 本文件 + `src/core/index.js` 的 JSDoc | 契约 | `Record` 三实体，平台/端无关 |
| 分析核心 | `src/core/**`、`tests/core/**` | TASK-CORE | 纯函数，无 I/O、无网络、无浏览器 |
| 回放适配器 | `src/adapters/replay/**`、`fixtures/**` | TASK-CORE | 合成日志，用于离线复现 |
| 服务层 | `src/server/**`、`tests/server/**` | TASK-SERVER | node:http + node:sqlite + DeepSeek |
| 面板 UI | `extension/content/overlay.*` | TASK-EXT | 读 `GET /api/profile` 的纯 JSON |
| 文档 | `docs/**`、`README.md` | 调度方 | |

不允许跨归属写文件。需要别人改契约 → 报告给调度方。

## 1. 常量（写死在 `src/core/constants.js`，TASK-CORE 提供，其他任务 import）

```js
export const PORT = 3789;
export const SCHEMA_VERSION = 1;
export const PROFILE_ID = "local-default";
// 固定主题表，K = 10，多主题内容权重和为 1；无法判断 → topics 为空数组（未知）
export const TOPICS = ["tech","science","game","anime","film_tv","music","study","life","sports","news"];
export const TOPIC_LABELS = { tech:"科技·AI·数码", science:"科学·科普", game:"游戏", anime:"动画·二次元",
  film_tv:"影视·剧集", music:"音乐", study:"学习·考试·求职", life:"生活·美食·旅行", sports:"体育·健身", news:"时事·社会·财经" };
export const WINDOW_DAYS = 7;
// 演示用阈值（不是学术标准，界面必须原样披露）
export const THRESHOLDS = { minExposure: 20, minKnownTopicRatio: 0.6, minBehavior: 10,
  outputConcentrationEntropy: 0.45, gapDistance: 0.30, repeatRate: 0.35, topSourceShare: 0.40, narrowingEntropyDrop: 0.10, topDomination: 0.20 };
```

## 2. 记录（`Record`）— 平台无关

```js
ContentItem = {
  content_id,            // 主键，稳定哈希（见 §7）
  platform: "bilibili",
  canonical_key,         // 去重键（同内容不同链接变体应一致）
  title, url, source_id, source_name,   // source_id = UP主 mid 或名字哈希
  duration_s, view_count, danmaku_count, published_at, fetched_at,
  desc, comments: string[],             // 只存用户可见的简介/热评，截断（desc ≤ 800 字，comments ≤ 8 条）
  topics: [{ t, w }],                   // 空数组 = 未知，不强行归类
  facets: [],                           // 事件信息维度，首版留空
  value_notes: null | Record,           // AI 的结构化价值线索
  origin: "real" | "reference" | "synthetic",
  annotation: { status: "pending"|"ai"|"manual"|"unknown", model, at }
}

Exposure = { exposure_id, profile_id, session_id, content_id, exposed_at,
             page_context: "home"|"search"|"video_related", observable_rank, origin }

Action   = { action_id, profile_id, session_id, exposure_id?, content_id?, topic_id?,
             action_type: "open"|"watch"|"like"|"coin"|"favorite"|"search"|"scroll_past",
             occurred_at, watch_seconds?, origin }

GoalProfile = { profile_id, goal_text, intent_mode: "relax"|"learn_event"|"skill"|"exam"|"cure",
                goal_topics: [{ t, w }], exclusions: string[], exploration_level: 0..1,
                updated_at, version, source: "user"|"ai"|"fallback" }
```

## 3. 分析核心导出（`src/core/index.js`）

```js
// 纯函数：同样输入 → 同样输出（不读时钟；now 必须由参数传入）
export function buildSnapshot(input): Snapshot
export function entropy(dist /* [{t,w}] */): number      // 归一化到 [0,1]，K=10，空输入 → 0
export function distance(a, b): number                    // 0.5*Σ|a.w-b.w|，双方都未知 → null
export function repeatRate(exposures, items): number
export function topK(candidates, k, scoreFn): Array      // 手写小根堆
export class RingWindow                                     // 手写环形队列 + 计数表
export function parseGoalText(text, intentMode): GoalProfile  // 无 AI 的关键词兜底
```

`buildSnapshot(input)` 输入：
```js
{ items: ContentItem[], exposures: Exposure[], actions: Action[],
  goal: GoalProfile | null, now /* ms */, windowDays = WINDOW_DAYS, prevWindow?: boolean }
```
输出 `Snapshot`（`GET /api/profile` 的 body 就是它 + `ai` 字段）：
```js
{
  schema_version: 1,
  data_mode: "real"|"synthetic"|"mixed"|"empty",
  generated_at: ms,
  window: { start, end, days, exposure_count, unique_items, action_count, session_count,
            unknown_topic_ratio, known_topic_ratio, page_contexts: {home:n, video_related:n, search:n} },
  goal: { present: bool, text, intent_mode, topics: [{t,w}], source },
  exposure: { available: bool, topics: [{t,w,n}], entropy, repeat_rate, unique_items,
              top_source: { id, name, n, share } | null, source_count },
  behavior: { available: bool, topics: [{t,w,n}], sample_n, reason?: string },
  behavior_cmp: { D: number|null, by_topic: [{t, u, p, diff}] } | null,
  goal_cmp:     { D: number|null, by_topic: [{t, g, p, diff}] } | null,
  trend: { prev_entropy: number|null, entropy_delta: number|null, prev_top_source_share: number|null } | null,
  alerts: [{ rule_id, severity: "info"|"warn", title, detail, evidence: [{exposure_id, content_id, title, url, at}], suggestion, thresholds_used }],
  notes: string[]   // 例如 "样本量不足，仅展示基础统计"；界面必须原样显示
}
```
规则（严格照实现，界面按 `alerts` 渲染）：
`output_concentration` / `goal_gap` / `behavior_gap` / `repeat_heavy` / `source_concentration` / `narrowing`。
门槛不满足 → 该规则不触发，并在 `notes` 里写明缺什么。**没有证据就不要出结论。**

## 4. 服务端导出（`src/server/app.js`）

```js
export function createApp(deps): (req, res) => void
// deps = { store, labeler, analyze, clock }   ← 全部可注入，测试用假实现
```
`store` 必须实现：`getItems() getExposures() getActions() getGoal() upsertItem(item) addExposure(e) addAction(a)
setGoal(g) reset() exportJSONL() stats() ensureItemForObservation(obs)`
`labeler` 必须实现：`enqueue(items) status() labelNow(items) narrative(snapshot, goal)`

### HTTP（全部 JSON；`OPTIONS` 回 204 + CORS `*`）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/status` | – | `{ ok, version, port, data_mode, window, counts:{items,exposures,actions}, ai:{mode:"live"|"degraded"|"off", cached, pending, model}, paused }` |
| POST | `/api/ingest` | §5 | `{ ok, accepted:{exposures,actions}, deduped:{exposures,actions}, new_items, ai_pending }` |
| GET | `/api/profile?days=7` | – | `Snapshot` + `ai:{narrative, suggestions[], model, cached, degraded}` |
| POST | `/api/goal` | `{ goal_text, intent_mode, exclusions?: [] }` | `GoalProfile` |
| POST | `/api/feedback` | `{ content_id, correction:"topic"|"unknown", topics?: [] }` | `{ ok }`（人工更正，标 annotation=manual） |
| POST | `/api/pause` | `{ paused: bool }` | `{ ok, paused }` |
| GET | `/api/export` | – | JSONL（`text/plain`，含三类记录 + goal） |
| POST | `/api/reset` | `{ confirm: true }` | `{ ok, cleared }` |

错误形状统一 `{ ok:false, error:{ code, message } }`，HTTP 4xx/5xx 对应。

## 5. 扩展 → 服务端（唯一采集入口）

内容脚本只上报"这一页现在长什么样"，不做归类、不生成 id：

```js
POST /api/ingest
{
  session_id,                 // 扩展生成的 UUID，一次页面会话一个
  page_context: "home" | "video_related" | "search",
  url, observed_at,           // ms
  cards: [{ title, url, author, author_id?, duration_s?, view_count?, danmaku_count?, rank }],
  actions: [{ action_type, url?, title?, at, watch_seconds? }],
  page: {        // 仅视频页/需要时
    title?, url, author?, author_id?, desc?, comments?: string[],
    duration_s?, view_count?, danmaku_count?, published_at?
  } | null
}
```
服务端负责：`content_id = sha1(platform + canonical_key)`、曝光去重（`exposure_id = sha1(session_id|content_id|page_context|visit_seq)`，同一页面会话内同一内容只计一次曝光；新会话/新加载再增加 → 这样重复曝光率才有意义）。

## 6. AI 契约（DeepSeek）

- Key 只从 `process.env.DEEPSEEK_API_KEY` 读，**任何日志/文件/响应都不能回显 key**。缺失 → `ai.mode="degraded"`，走关键词兜底，绝不 500。
- Base URL `https://api.deepseek.com/chat/completions`，`model: "deepseek-chat"`，`response_format: {"type":"json_object"}`，`temperature: 0`。
- 打标输入只给：`title`、`desc 前 300 字`、`author`、`comments 前 3 条`、`duration`。**禁止**发送页面其它内容。
- 打标输出（必须校验，字段缺失 → 丢该字段，不编造）：
```json
{"topics":[{"t":"tech","w":0.7}],"content_type":"评测|教程|资讯|vlog|娱乐|观点",
 "clickbait":0.0,"emotionality":0.0,"info_density":0.0,
 "value_notes":{"evidence":"weak|medium|strong","timeliness":"recent|dated|unknown","note":"≤40字"},
 "summary":"≤40字"}
```
- 缓存键 = `sha1(title|desc|comments[0..2])`，落 `data/ai-cache.jsonl`；命中不发请求。
- 批量：一次请求最多 8 条内容，并发上限 2，单次超时 25s，失败重试 1 次（仅网络/5xx）。
- 叙述输出：`{"narrative":"≤200字","suggestions":[{"title":"≤20字","why":"≤60字","action":"search|watch_other_source|platform_feedback|keep","evidence_ids":["<content_id>"]}]}`，最多 3 条建议，`evidence_ids` 必须来自传入的证据列表，**不得编造链接/引文**。

## 7. 确定性与数据模式

- 无网络、无 key、无 AI 时全流程仍可演示：打标降级为关键词规则，叙述降级为模板句。
- `data_mode` 由 exposure/item 的 `origin` 推导，界面必须常显；合成数据不得冒充真实观察。
- 同一份 JSONL + 同一 goal + 同一 now → `buildSnapshot` 输出必须逐字节一致（`tests/core/determinism.test.js` 覆盖）。

## 8. 目录与启动

```
docs/            ARCHITECTURE.md  MOBILE-PATH.md  CONTRACT.md
src/core/        constants.js index.js ring.js heap.js metrics.js analyze.js
src/adapters/    bilibili/extract.js  replay/generate.js
src/server/      main.js app.js store.js ai.js labeler.js
extension/       manifest.json background.js content/{capture.js,overlay.js}
tests/           core/*.test.js  server/*.test.js
fixtures/        replay-14d.jsonl（合成，可提交）
tools/           check-extension.mjs  e2e/*.mjs（不进测试入口）
```
`npm start` = `node src/server/main.js`（默认 3789）；`npm run replay` = 生成/加载合成日志到独立 db 后打印报告。

## 10. 增补（v1.1）：推荐候选池 + 抽屉精简

### 10.1 口径变更：搜索页结果不算「平台推荐曝光」
`buildSnapshot` 的曝光画像 `P` 只统计 `page_context ∈ {home, video_related}`。`page_context="search"` 的 Exposure 仍入库、仍在 `window.page_contexts.search` 计数，但**不进 P、不进熵/重复率/来源集中度的分母**——搜索是你主动拉取的内容，算进「平台喂了你什么」会失真。新增字段 `window.search_pull_count`。

### 10.2 推荐候选池（确定性排序，AI 只写理由）
`src/core/recommend.js` 导出：
```js
export function rankRecommendations(input, k = 3): Recommendation[]
// input = { items, exposures, actions, goal, now, windowDays }
```
候选 = 窗口内被记录过、但**没有被 open/watch 过**的内容（含搜索页结果）。排除 goal.exclusions 命中的条目。
```js
Recommendation = {
  content_id, title, url, source_name, page_context, score,        // 0..1
  basis: { goal_match, fills_gap, source_diversity, novelty },     // 各 0..1，供界面解释
  why: null | string                                               // 由 AI 填，≤40 字；AI 不可用则为 null
}
```
权重固定为 `0.40 goal_match + 0.25 fills_gap + 0.20 source_diversity + 0.15 novelty`；选出一条后，同主题与同来源的后续候选分别乘以 0.6 / 0.7 再继续贪心（`initial_plan` §6.6 的动态收益）。同分按 `content_id` 升序保证确定性。

### 10.3 `GET /api/profile` 新增字段（只增不改）
```js
recommendations: Recommendation[]     // ≤3 条；候选不足时允许少于 3 条或为空
```
AI 只允许为**已定序**的候选写 `why`（一句话），不得增删条目、不得改顺序、不得编造 url。AI 不可用时全为 null，界面照样渲染（用 basis 生成模板句）。

### 10.4 抽屉精简（按用户要求）
首屏只保留：**结论**（alerts 标题 + narrative 首句合并）、**主题分布百分比**、**建议**（≤3 条，链接必须显示标题而非裸 URL）、**推荐区块**、**我的目标输入**。
熵、重复率、来源集中度、D 值、阈值、样本数一律**不在首屏显示**（后端字段全部保留，可 `/api/export` 或折叠区查看）。
底部保留一行**不可省略**的小字：`data_mode` + 样本数 + 「为什么不下结论」（证据不足时必须说清，这条不许砍）。

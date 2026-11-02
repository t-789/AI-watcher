# 架构说明（AI Watcher 功能 demo）

> 本文描述**已实现**的东西。规划书 `ignore/initial_plan.md` 描述的是完整课程项目；本 demo 只做其中一条可跑通的技术路线：**在用户刷 B 站时采集"看得见的推荐内容" → 归一化落库 → 确定性统计 + AI 打标 → 悬浮窗里给出兴趣画像与可执行建议**。

## 1. 一句话边界

只读用户屏幕上本来就看得见的元信息（标题、UP 主、时长、播放量、简介、热评），**不读视频内容、不拦截网络、不调平台内部接口、不做任何账号操作**；输出反推不等于平台内部画像，界面全程标注 `data_mode` 与样本量。

## 2. 五层，只有第一层与平台绑定

```
extension/content/capture.js  ─┐  ① 采集适配器（唯一平台相关）
src/adapters/bilibili/extract.js ┘     可见 DOM → 归一化观测
        │ chrome.runtime.sendMessage → background.js → fetch
        ▼
src/server/app.js  /api/ingest      ② 归一化契约（ContentItem / Exposure / Action，SCHEMA_VERSION=1）
        │
        ├── src/server/store.js      node:sqlite（WAL）+ JSONL 导出
        │
        ▼
src/core/**                       ③ 分析核心：纯函数，无 I/O、无网络、不读时钟
        │   ring.js 手写环形队列 · heap.js 手写小根堆 · metrics.js 熵/重复率/距离 · analyze.js 六条规则
        ▼
src/server/ai.js + labeler.js     ④ AI 层：DeepSeek 打标与叙述，内容哈希缓存，无 key 自动降级
        │
        ▼
extension/content/overlay.js      ⑤ 呈现层：Shadow DOM 悬浮球 + 侧边抽屉，只吃 /api/profile 的纯 JSON
```

关键点：③ 只接受"记录 + goal + now"，**换设备/换平台不用改一行**；⑤ 只吃 JSON，换一个前端（手机 App、小程序、桌面端）不需要改分析逻辑。`extension/extract.js` 是指向 `src/adapters/bilibili/extract.js` 的符号链接，所以扩展与 node 测试用的是同一份抽取规则，不存在两份会漂移的实现。

## 3. 数据流与口径

1. **采集**：`capture.js` 用 MutationObserver + 1.5s 节流扫描，把当前页面的卡片（含 `rank`、`observed_at`）与用户行为（打开视频页 = `open`）打包成一次 `POST /api/ingest`。内容脚本不做归类、不生成 id。
2. **归一化**（服务端）：`content_id = sha1(platform + canonical_key)`；`canonicalizeUrl` 抹掉 `spm_id_from`/`vd_source`/`#reply` 等追踪参数，同一视频不同入口归并。曝光去重口径：同一 `(session_id, page_context)` + 同一 canonical url = 同一次访问（滚动重复上报自动去重）；url 变化或新会话才算新曝光 —— 这样"重复曝光率"才真的在数重复。
3. **视频页的 `page` 字段只补全元信息**（简介、热评，作为打标素材），不计曝光；用户点进视频这件事通过 `action: open` 记到行为侧。曝光 = 推荐流里刷到，行为 = 用户主动点开，两者分开正是三画像的前提。
4. **打标**：只把 `title / desc 前 300 字 / author / 前 3 条评论 / duration` 发给 DeepSeek，返回主题（必须落在固定的 10 个主题里）、内容类型、标题党/情绪/信息密度、证据与时效评价、一句话摘要。逐字段校验，非法字段丢弃，绝不补编。
5. **统计**：`buildSnapshot` 分窗口（默认近 7 天，半开区间）计算曝光画像 `P`、行为画像 `U`、目标画像 `G`，以及 `D(U,P)`、`D(G,P)`、归一化熵、重复曝光率、单一来源占比、与前窗口的趋势差。
6. **呈现**：悬浮球显示本会话采集条数与当前最集中主题；抽屉展示观察条件、目标设置、分布、集中度、差异、提醒与建议（每条建议带 evidence，可点回原视频）、暂停/导出/清空。

## 4. 分析核心：数据结构与复杂度

| 结构 | 用途 | 复杂度 | 对照验证 |
| --- | --- | --- | --- |
| `RingWindow`（手写环形队列 + 计数表） | 时间窗口内的曝光/行为，出窗逐键扣减，计数夹到非负 | 每条记录进出各一次，均摊 O(主题数)；空间 O(窗口内记录数) | 与"每次全量重扫窗口"逐步比对，10⁴ 条随机操作一致 |
| `topK`（手写小根堆） | 候选内容取 Top-K | 选择 O(C log k)，仅对最终 k 个结果排序 | 与全排序前 k 比对，10³ 组随机用例（含 k=0 / k>C / 同分）一致 |
| 倒排式主题索引（基于 Map 集合） | 主题 → 内容集合的检索 | 构建/查询 O(命中集合总长) | 由 metrics 的按主题聚合覆盖 |

差分测试抓出过两个真实 bug（`_grow()` 绕回后扩容打乱时序、`siftUp`/`siftDown` 比较方向反了建成大根堆），两者现在都有回归用例。

## 5. 六条提醒规则与阈值

规则（全部在 `src/core/analyze.js`，阈值在 `src/core/constants.js`）：

| rule_id | 触发条件 | 门槛（演示校准值） |
| --- | --- | --- |
| `output_concentration` | 曝光主题归一化熵 < 0.45 | 曝光 ≥ 20 且已知主题占比 ≥ 0.6 |
| `goal_gap` | `D(G,P)` > 0.30 | 同上 + 用户已设置目标 |
| `behavior_gap` | `D(U,P)` > 0.30 **且** 某主题 `P-U` > 0.20 | 行为样本 ≥ 10 |
| `repeat_heavy` | 重复曝光率 > 0.35 | 曝光 ≥ 20 |
| `source_concentration` | 最大单一来源占比 > 0.40 | 曝光 ≥ 20 |
| `narrowing` | 熵较前窗口下降 > 0.10 且来源更集中 | 前窗口同样达标 |

门槛不满足时不触发，并在 `notes` 里写清缺什么（曝光数、已知主题比例、行为条数、有无目标、前窗是否达标）。**没有证据就不下结论**，这是整个项目的口径底线；`alerts[].thresholds_used` 原样披露阈值，界面照抄不改写。

阈值与规划书的 50 / 80% 不同是有意的：demo 的一次浏览会话只产生几十条曝光，用规划书的门槛永远看不到任何一条提醒。它们在界面与本文里都标注为**演示校准值**，不是学术标准。

## 6. AI 使用边界

- Key 只从 `process.env.DEEPSEEK_API_KEY` 读；启动日志只打端口/数据目录/`ai.mode`/模型名，任何日志、响应、文件都不含 key。
- 无 key → `ai.mode="degraded"`：打标退化为关键词词典，叙述退化为模板句，标注状态写 `annotation.status="unknown", model="keywords"`，**不冒充 AI 结果**，也不写入 AI 缓存（等 key 补齐后应重打）。
- 缓存键 = `sha1(title|desc|comments[0..2])`，落 `data/ai-cache.jsonl`；命中零请求。成本随**唯一内容数**增长，而不是曝光数。
- 叙述只允许引用传入的证据 id，`evidence_ids` 不在证据集内的建议整条丢弃，最多 3 条。
- 画像统计、窗口更新、覆盖计算、排序全部由确定性代码完成；AI 只做标注草稿与文字表达。断网、无 key、模型报错时全流程仍可演示。

## 7. 确定性与回放

- `buildSnapshot` 不读系统时钟（`now` 是参数）、不读文件、不联网、无 console。同一份 JSONL + 同一 goal + 同一 now → 输出**逐字节一致**（`tests/core/determinism.test.js`，打乱输入顺序结果不变）。
- `fixtures/replay-14d.jsonl` 由固定种子 PRNG 生成（680 条曝光、1207 行、4 类行），重跑生成器与仓库文件逐字节相同。
- `npm run replay` 把合成日志灌进独立 db 并打印文本报告（窗口、主题分布、熵、重复率、来源集中度、alerts 清单），断网也能演示。

## 8. 与规划书的偏离（如实记录）

| 规划书 | 本 demo | 原因 |
| --- | --- | --- |
| 提醒门槛 50 曝光 / 80% 已知 / 10 条行为 | 20 / 60% / 10 | 单次会话规模小，否则永远不触发；标注为演示校准值 |
| 8—10 个一级主题（首周用样本确定） | 固定 10 个 + 词典 | demo 阶段先固定，避免每次演示口径漂移 |
| Web 界面四页 | 页面内悬浮球 + 侧边抽屉 | 用户明确要"刷视频时的悬浮窗"，抽屉内容按四页信息组织 |
| P1 才做浏览器采集 | 采集是本 demo 的主线 | 用户要求的正是真实采集链路 |
| 事件维度覆盖 / 互补参考推荐 / 平台评测 | **未实现** | 需要人工维护参考池，不在本次范围；`facets` 字段留空占位 |

## 9. 测试与验证证据

- `node --test tests/core` → 73 pass（环形队列/堆/指标/六条规则正反例/确定性/回放）。
- `node --test tests/server` → 68 pass（归一化与曝光去重、goal、profile、`CORE_UNAVAILABLE` 降级、无 key 降级、缓存命中、pause/export/reset、sqlite 重启不丢）。
- `npm test` → 146 pass / 0 fail（core 73 + server 68 + ext 5）。
- `node tools/check-extension.mjs` → 11/11 通过（manifest、单一事实来源、顶层不碰 document、fetch 只在 background 且带超时）。
- 真机验收 `node tools/e2e/acceptance.mjs` → **19/19 通过**：CDP 装载扩展（Chrome 156 已忽略 `--load-extension`）→ 真实 B 站 → 悬浮球渲染 / 曝光入库 / **真点击**后行为入库 / 抽屉六分区 / 目标结构化 / 快照可用 / 标注队列落定 / 叙述缓存命中 / 页面零未捕获错误 / 服务停机后悬浮球降级。截图与报告在 `ignore/temp/shots/`、`ignore/temp/e2e-report.json`。
- 行为样本门槛的独立补证 `node tools/e2e/behavior-session.mjs`：真实会话连续点开 10 个视频 → `behavior.available=true, sample_n=10, D(U,P)=0.2427, exposures=357, actions=19`。这条存在的原因见下。

## 9.1 一个必须讲清的口径：U 需要 10 个样本

`open` 与 `watch` 对"同一会话同一视频"合并成 1 个行为样本（避免一次观看被多个埋点累加成强兴趣），而 `THRESHOLDS.minBehavior = 10`。所以：

- 点 1—3 个视频、刷几分钟 → `behavior.available=false`，`D(U,P)=null`，界面显示"有效正向行为 N 条，低于门槛 10"。**这是刻意的"证据不足不下结论"，不是采集失败。**
- 连续点开 10 个不同视频 → 样本够，`D(U,P)` 正常给出（实测 10 个样本时 D=0.2427）。
- 合成回放（138 个行为样本）→ `D(U,P)=0.0877`，用于演示与对照。

验收时不要把"单会话 U 不可用"当成缺陷；判定标准是：**要么给出 D，要么显式说明还缺多少证据**。

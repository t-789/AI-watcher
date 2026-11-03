# 开发计划：内容可信度核验（HANDOVER §8）

> 状态：计划稿（2026-11-03），尚未实现。目标与边界以 `docs/HANDOVER.md` §8 为准，本文只回答"按什么顺序做、每步交付什么、怎么验收"。
> 规模用 S / M / L 表示相对工作量（S ≈ 半天到一天，M ≈ 2—3 天，L ≈ 一周），不排具体日期。

---

## 0. 一个核心设计决定

**LLM 只做"读"，代码做"判"。** 这和项目已有的口径一脉相承（统计与排序由确定性代码完成，AI 只做标注和表达）。

```
内容 ──门控(代码)──▶ 抽断言(LLM) ──校验(代码)──▶ 检索(外部 API) ──▶ 逐条来源立场(LLM)
                                                                            │
         浮层 ◀── 文案(模板) ◀── 档位聚合(core 纯函数，可测、可复现) ◀───────┘
```

- LLM 负责：从文本里抽出可核验断言；判断"某个来源片段对某条断言是 支持 / 反驳 / 无关"。
- 代码负责：该不该核验、来源算不算独立、来源可信度分级、最终给哪一档、要不要打扰用户。
- 好处：最敏感的"判错"决定不在模型手里，阈值可以单测、可以调、可以原样披露（和 `thresholds_used` 一样）。

---

## 阶段 0 · 先定口径（S，必须先做，不写代码）

把 HANDOVER §8.6 的三件事落成 `docs/VERIFY-SPEC.md`，组内（需求/验收同学）确认后冻结：

1. **档位与文案**（建议）：

   | 档位 id | 用户看到的 | 是否主动弹出 |
   | --- | --- | --- |
   | `contradicted` | "检索到的来源与视频中的这句说法不一致" | 是 |
   | `partially_off` | "这句说法与来源部分一致，但有出入（数字/时间/范围）" | 是（可被用户设置关掉） |
   | `incomplete` | "这件事还有其他角度，视频未提及" | 否，浮层角标 |
   | `undetermined` | "未检索到足够的独立来源，无法判断" | 否，点开才看到 |
   | `consistent` | "检索到的来源与视频说法一致" | 否，点开才看到 + 相关链接 |
   | `not_applicable` | "这类内容不做事实核验"（娱乐/vlog/观点） | 否 |

   不允许出现"虚假""谣言""错误"等定性词；所有档位必须附具体链接。

2. **打扰策略**（建议默认值，全部放 `constants.js`）：
   - 只对**用户正在看的视频**做：停留 ≥ 30 秒或播放进度 ≥ 20%，或用户主动点"核验"按钮；
   - 主动弹出只在 `contradicted` / `partially_off`，同一视频只弹一次，每天最多弹 N 次（初值 3）；
   - 用户对一次弹出点"判错了" → 记 feedback，用来算误报率。

3. **来源分级**：`src/core/constants.js` 里一张域名 → 档位表（官方/政府/学术 > 主流媒体/百科 > 行业媒体 > 自媒体/论坛），未知域名默认最低档。"独立来源"按**注册域名去重**，再加一道"标题/正文高度相似视为同一通稿"的去重。

**验收**：文档冻结；档位、阈值、来源表都有具体取值。

---

## 阶段 1 · 门控 + 断言抽取（M，不联网检索）

先把"该不该核、核什么"做扎实，这一步的错误会放大到后面所有环节。

- **门控**（`src/core/verify.js`，纯函数）：输入 `ContentItem` 的 `content_type` + `topics`（打标已有），输出 `{eligible, reason}`。初版规则：`content_type ∈ {资讯, 教程, 评测}` 且主题含 `news/science/tech/study` 之一才核；`观点/娱乐/vlog` 直接 `not_applicable`。
- **断言抽取**（`ai.js` 新增 `extractClaims`）：输入标题、简介、热评（以后可以加字幕，见陪看 brainstorm），输出：
  ```json
  {"claims":[{"text":"原文片段","kind":"number|time|event|causal|quote","is_opinion":false,"query":"建议检索词"}]}
  ```
  服务端校验：`text` 必须是输入原文的**子串**（防编造，和 `evidence_ids` 必须在证据集内同一思路）；`is_opinion=true` 的直接丢弃；每条内容最多 3 条断言。
- **缓存**：按 `sha1(title|desc|comments)` 缓存（复用打标缓存键的思路）。
- **评测集**：手工挑 30—50 条真实 B 站资讯/科普视频的元信息，标注"应抽出的断言"，放 `fixtures/verify-eval/`（只放元信息文本）。

**验收**：门控单测覆盖正反例；评测集上观点被误当事实的比例 ≤ 10%；抽取请求每条内容 ≤ 1 次。

---

## 阶段 2 · 外部检索出口（M）

- 新增 `src/server/search.js`，**唯一**检索出口，结构照抄 `ai.js`：key 只读环境变量、`fetchImpl` 可注入、超时、重试、计数器、无 key → `mode="degraded"`（功能显示"未启用"，**不**假装核过）。
- 扩展 `llm-single-exit.test.js` → "外部出口唯一"：LLM 只在 `ai.js`，检索只在 `search.js`。
- 检索结果缓存按 `sha1(query)`，带 TTL（资讯 3 天、知识类 30 天），缓存条目记 `fetched_at`，用于结论时间戳。
- **预算闸门**：每日检索次数上限（初值 50），超了就 `undetermined` + 原因"今日核验额度已用完"。
- 检索服务待选（见文末"待决问题"）。

**验收**：fake fetch 下的单测（降级、超时、缓存命中、预算耗尽）；真实 key 下手动跑 5 条。

---

## 阶段 3 · 立场判断 + 档位聚合（L，本功能的核心）

- **立场判断**（`ai.js` 新增 `judgeStances`）：一次请求输入 1 条断言 + ≤ 6 个检索片段（每个带 `source_id`），输出每个来源的 `stance: support|contradict|irrelevant` 和 `quote`（必须是该片段的子串）。不允许模型输出总体结论。
- **档位聚合**（`src/core/verify.js` 纯函数 `aggregateVerdict(stances, sourceTiers, now)`）：
  - 先按注册域名 + 相似度去重成"独立来源"；
  - `contradicted`：≥ 2 个独立、高可信档来源反驳，且 0 个同档来源支持；
  - `partially_off`：有高档反驳但也有支持，或只有数字/时间上的出入；
  - `consistent`：≥ 2 个独立来源支持，0 反驳；
  - 其余一律 `undetermined`（**搜不到 ≠ 错**）；
  - 输出带 `thresholds_used`、`checked_at`、每个来源的链接与标题。
- 阈值明显偏向"不打扰"：宁可多给 `undetermined`。

**验收**：`aggregateVerdict` 单测覆盖每一档的正反例、单一来源转载不算一致、确定性（输入顺序打乱结果不变）；评测集上 `contradicted/partially_off` 的误报 ≤ 1/20。

---

## 阶段 4 · 存储与接口（S）

- `store.js` 新表 `verifications`（只增）：`content_id, claim_text, claim_kind, verdict, sources(JSON), thresholds_used(JSON), checked_at, model, search_provider`。与打标结果分开存，不塞进 `value_notes`。
- `POST /api/verify {content_id}` → 异步排队，返回 `job_id`；`GET /api/verify?content_id=` → 当前状态/结果。
- 导出与清空把这张表一并带上。

**验收**：接口单测；`/api/reset` 后表为空；`/api/export` 含核验记录。

---

## 阶段 5 · 视频页浮层（M）

- 新内容脚本模块（或 `overlay.js` 内独立组件），只在 `/video/` 页出现，与抽屉**互不嵌套**。
- 状态：核验中 / 有提示（红点，自动展开一次）/ 无提示（灰色角标，点开看 `consistent / undetermined / incomplete`）/ 不适用（不显示）。
- 每条结论显示：原句 → 档位文案 → 来源链接（带标题）→ 检索时间 → "判错了"按钮。
- 请求一律经 `background.js`；`check-extension.mjs` 新增断言：浮层不出现定性词表里的词。

**验收**：`check-extension.mjs` 全绿；新增 e2e `tools/e2e/verify-check.mjs`（**3790 端口**、临时库、fake 检索）。

---

## 阶段 6 · 评测与交付（M）

- 跑评测集，出一页报告：每档数量、误报率、平均延迟、每次核验平均请求数与费用。
- 真实使用一周，统计"判错了"反馈率；> 10% 就回头调阈值。
- 更新 `README`（已知限制）、`ARCHITECTURE`（新增一节）、`HANDOVER`。

---

## 成本粗估（每次核验）

| 步骤 | 次数 | 备注 |
| --- | --- | --- |
| 断言抽取 | 1 次 LLM | 输入几百字，按内容哈希缓存 |
| 检索 | ≤ 3 次 | 每条断言 1 次，按 query 缓存 |
| 立场判断 | ≤ 3 次 LLM | 每条断言 1 次，输入 ≤ 6 个片段 |

最多 1 + 3 + 3 = 7 次外部调用，主要成本在**检索 API**（LLM 文本量很小）。门控 + 停留时长触发 + 每日预算三道闸门把调用量限制在"用户真的在看的资讯类视频"上。

---

## 待决问题（需要你/组里拍板）

1. **检索服务选哪家**：B 站内容以中文为主，候选有博查（Bocha）Web Search API、Tavily、SerpAPI（走百度/Google）、智谱的 web search 工具等。价格与额度变化快，选型前需要现查。建议先选一家有免费额度、中文结果好的接一个适配器，接口抽象好以后能换。
2. **`undetermined` 要不要默认给用户看**：建议"点开才看到"，不主动显示。
3. **字幕要不要作为断言来源**：只靠标题/简介能抽到的断言很少（多数资讯视频的关键说法在口播里）。这和"陪看"是同一个问题，见 `docs/BRAINSTORM-WATCH-TOGETHER.md`；一旦读字幕，就要改 README 里"不读视频内容"这条承诺。

# CLAUDE.md — AI Watcher

> 给 Claude Code 看的项目说明。每次会话自动加载，所以只写**长期有效**的东西；进度类信息放 `docs/HANDOVER.md`。
> 与用户交流、写文档、写注释、写提交信息一律用**中文**（标识符与 API 名保持英文）。

## 项目是什么

数据结构课程项目（四人组，2026.10 开题）。定位：**面向个性化推荐的信息环境监测与引导助手**——"用 AI 对抗 AI，也用 AI 帮用户重新理解 AI"。

当前是一个在**真实 B 站网页版**上跑通的功能 demo：

- Chrome MV3 扩展在用户刷 B 站时只读**屏幕上看得见**的元信息（标题 / UP 主 / 时长 / 播放量 / 简介 / 热评），记录曝光与行为；
- 本地 Node 服务（`127.0.0.1:3789`，零依赖，`node:sqlite`）做确定性统计 + DeepSeek 打标；
- 右下角悬浮球 → 抽屉里给出**三画像对照**：平台给的 P（曝光）/ 你点的 U（行为）/ 你写的 G（目标），六条证据式提醒，建议，以及"可以点开看看"的推荐。

核心承诺（也是答辩口径）：**不读视频内容、不拦截网络、不调平台内部接口、不做任何账号操作**；结论只对"已观察样本"负责，证据不足就明说"暂不判断"，不冒充平台内部画像，不做心理诊断。

下一步方向见 `docs/HANDOVER.md` §8（内容可信度核验）与 `docs/PLAN-VERIFY.md`；"陪用户看视频"的低成本思路见 `docs/BRAINSTORM-WATCH-TOGETHER.md`。

## 常用命令

```bash
npm test                                   # 全部单测（node --test tests/）
node tools/check-extension.mjs             # 扩展静态检查
npm run check                              # 上面两个
bash -lc 'source ~/.zshrc; npm start'      # 真实服务：3789 + data/（key 在 ~/.zshrc 的 DEEPSEEK_API_KEY）
npm run demo                               # 合成数据演示：data-demo/，断网无 key 可用
node src/server/main.js --port 3790 --data-dir <临时目录>   # 自验一律这样起
bash -lc 'source ~/.zshrc; node tools/e2e/acceptance.mjs'   # 真机验收（需 puppeteer-core）
```

Node ≥ 22.5。没有构建步骤，没有 npm 依赖（puppeteer-core 只给 e2e 用，装在 `ignore/temp/e2e-deps`）。

## 代码地图

| 层 | 位置 | 要点 |
| --- | --- | --- |
| ① 采集（唯一平台相关） | `extension/content/capture.js`、`src/adapters/bilibili/extract.js` | `extension/extract.js` 是**软链接**到 adapters，DOM 规则只有一份 |
| ② 契约 / 落库 | `src/server/app.js`（`createApp(deps)` 全注入）、`store.js` | 契约冻结在 `docs/CONTRACT.md`，schema 只增不改 |
| ③ 分析核心 | `src/core/*` | **纯函数**：无 I/O、不读时钟（`now` 是参数）、无 console；手写 `ring.js` 环形队列、`heap.js` 小根堆；阈值/主题/权重全在 `constants.js` |
| ④ AI | `src/server/ai.js`（**唯一** LLM 出口）、`labeler.js` | 打标按内容哈希缓存；叙述+建议+推荐理由合并成一次请求、按数据指纹缓存；无 key 自动降级为关键词 + 模板句 |
| ⑤ 呈现 | `extension/content/overlay.js` | Shadow DOM 悬浮球 + 抽屉，只吃 `/api/profile` 的 JSON；`background.js` 是扩展里**唯一** fetch 出口 |

API：`/api/status | ingest | profile | goal | feedback | pause | export | reset`。主题表固定 10 个：`tech science game anime film_tv music study life sports news`。

## 不可违反的规则

1. **端口纪律**：3789 是用户真实数据（`data/`）。任何自验、测试、子任务一律用 **3790+** 和临时 `--data-dir`。曾经因此把用户真实浏览数据写进临时库。
2. **LLM 单一出口**：只有 `src/server/ai.js` 能发 LLM 请求（`tests/server/llm-single-exit.test.js` 锁住）。新增外部能力（如检索）也要走同样的"单一出口 + 可注入 fetch + 可降级"模式。
3. **AI 不做判断，代码做判断**：统计、窗口、阈值、排序都由确定性代码完成；AI 只做标注草稿与文字表达。AI 输出逐字段校验，非法字段丢弃、绝不补编；只允许引用传入的 id，不得编造链接、标题、引文。降级结果**不写缓存**、不冒充 AI 结果。
4. **确定性**：同一 JSONL + goal + now → `buildSnapshot` 逐字节一致（`tests/core/determinism.test.js`）。`fixtures/replay-14d.jsonl` 由固定种子生成，不得漂移；`generate.js` 已与目标解析解耦，**不要接回去**。
5. **口径**（详见 HANDOVER §4）：P 只算 `home`/`video_related`，搜索页另计；曝光按 `(session, page_context, canonical url)` 去重；视频页 `page` 只补元信息不算曝光；`open`+`watch` 同一内容合并为 1 个行为样本，`minBehavior=10`，样本不足时界面写"缺多少"而不是硬给数字；阈值是**演示校准值**，界面原样披露。
6. **合成数据标 `origin="synthetic"`**，演示库 `data-demo/` 与真实库 `data/` 不混用；`--seed` 会清空目标库。
7. **扩展约束**（`tools/check-extension.mjs`）：fetch 只在 background 且带超时；链接必须带标题；首屏不显示指标数字；搜索地址一律由服务端给，扩展里不硬编码。改 `overlay.js` 后先 `node --check`，CSS 写错会让整个悬浮球不渲染。
8. **隐私**：key 只从环境变量读，绝不进日志/响应/文件；发给模型的只有标题、简介前 300 字、UP 主、前 3 条评论、时长。

## 改代码的习惯

- 先读 `docs/HANDOVER.md` §4 口径，再动 `src/core`。
- 改完必须 `npm test` + `node tools/check-extension.mjs` 全绿；动到采集/悬浮窗时跑真机验收。
- 新功能先写进 `docs/` 再实现；文档写**已实现**的东西，计划另起文件，限制如实记录（README "已知限制"、ARCHITECTURE "与规划书的偏离"）。
- 提交信息格式：`type(scope): 中文说明`（如 `fix(core): ...`、`docs: ...`）。只在用户要求时提交。
- `ignore/` 不进版本控制（规划书 `initial_plan.md`、开题 PPT、老师建议 `advice.txt`、e2e 截图都在这里）。

## 背景材料

- 开题 PPT：`ignore/AI_Watcher_开题汇报(1).pptx`——双向画像（用户行为正向侧写 / 平台输出反向画像）、画像滞后 / 行为放大 / 范围收窄 / 相互强化四种关系、可解释提醒与渐进式调整。
- 老师建议（`ignore/advice.txt`）：事件的多方位报道、内容"营养价值"、引导用户与平台博弈、防止以偏概全。
- 分工：秦子宸（需求与验收）、吴秉宸（界面与体验）、曾弘远（分析与集成）、刘正扬（实验验证与交付，即本仓库主要使用者）。
- 之前的开发由 DeepSeek 的 harness 完成，2026-11-03 起交给 Claude Code。

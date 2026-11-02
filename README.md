# AI Watcher · 功能 demo

> 刷 B 站的时候，右下角有个悬浮球。它把你**屏幕上本来就看得见**的东西（标题、UP 主、时长、播放量、简介、热评）记下来，交给本地服务做统计 + DeepSeek 打标，点开悬浮球就能看到：**平台在喂你什么、你主动点了什么、和你想看的差多远**。
>
> 它不读视频内容、不拦截网络、不调平台内部接口、不做任何账号操作（不点赞、不关注、不自动播放）。

这是课程项目的**技术路线验证 demo**：把"采集 → 归一化 → 确定性统计 → AI 标注 → 界面"这条链路真正跑通。完整产品规划见 `ignore/initial_plan.md`（不进版本控制），架构与移动端迁移见 `docs/ARCHITECTURE.md`、`docs/MOBILE-PATH.md`。

---

## 3 分钟跑起来

前置：Node ≥ 22.5（用到 `node:sqlite`）、Chrome、一个 DeepSeek API key。

```bash
# 1. 服务端（默认 3789 端口，数据落在 ./data/）
export DEEPSEEK_API_KEY=sk-xxxx          # 已在 ~/.zshrc 里 export 的话：bash -lc 'source ~/.zshrc; npm start'
npm start

# 2. 装扩展（二选一）
#    手动（持久生效）：Chrome → chrome://extensions → 打开"开发者模式" → "加载已解压的扩展程序" → 选本仓库的 extension/ 目录
#    一键（每次自动装载，适合演示/自动化）：
npm run chrome

# 3. 打开 https://www.bilibili.com ，正常刷
```

刷几十秒后，右下角的球上会出现"已采集 N 条 + 当前最集中的主题"。**点球**打开抽屉。

第一次用建议先在抽屉里"我的目标"写一句自然语言（例如「这个月想搞懂大模型在自己电脑上怎么跑」），选一个意图模式，保存。没有目标就只算得出「行为 vs 曝光」，算不出「目标 vs 曝光」。

> Chrome 156 起 `--load-extension` 已被忽略，所以脚本走 CDP 装载；手动加载走 `chrome://extensions` 不受影响。CDP 装载的扩展**不跨浏览器重启**，需要长期用就用手动路径装一次。

## 断网 / 没有 key 也能演示

```bash
npm run demo     # 把 fixtures/replay-14d.jsonl（14 天合成日志，680 条曝光）灌进 ./data-demo 并起服务
```

打开 B 站，点悬浮球，抽屉里就是一份**完整**的画像（315 次曝光 / 56 条内容 / 熵 0.386 / 重复率 82% / 单一来源 73% / 5 条提醒）。界面会明确标 `data_mode = synthetic`，不会拿合成数据冒充真实观察。

> 演示库（`data-demo/`）和真实库（`data/`）分开：在演示库里刷真实视频会把两种数据混在一起，`data_mode` 会变成 `mixed`。

## 悬浮球里有什么

| 分区 | 内容 |
| --- | --- |
| 观察条件 | `data_mode`（real / synthetic / mixed / empty）、观察窗口、样本数、会话数、行为样本数、主题已知率、页面来源分布 |
| 我的目标 | 一句话目标 + 意图模式（放松 / 了解事件 / 学技能 / 备考 / 换个口味），保存后由 AI 结构化成主题权重，可随时改 |
| 曝光画像 | 平台给了你什么：主题分布、归一化熵（越低越集中）、重复曝光率、单一来源占比、Top 来源 |
| 行为 vs 曝光 · 目标 vs 曝光 | `D(U,P)`、`D(G,P)`（0—1 的分布距离）与按主题的差值，说明是"平台放大"还是"你自己也在看" |
| 提醒 · 建议 | 触发的规则 + 证据（可点回原视频）+ 建议；**没触发时会写明为什么不结论**（样本不足 / 已知主题比例不够 / 没有目标…） |
| 操作 | 暂停采集、导出 JSONL、清空数据（需确认） |

## 数据与隐私

- 全部本地：`data/aiwatcher.db`（SQLite/WAL）+ `data/ai-cache.jsonl`（AI 打标缓存）。没有云端账号，没有遥测。
- 发给 DeepSeek 的只有：标题、简介前 300 字、UP 主名、前 3 条评论、时长。**不发页面其它内容**，不发 URL 之外的标识。
- Key 只从环境变量读，日志只打端口/数据目录/AI 模式/模型名。
- 想清空：抽屉里的"清空"，或 `curl -X POST 127.0.0.1:3789/api/reset -d '{"confirm":true}' -H 'Content-Type: application/json'`；想搬走：`curl 127.0.0.1:3789/api/export > my-log.jsonl`。

## 命令行

| 命令 | 作用 |
| --- | --- |
| `npm start` | 起本地服务（3789）+ 真实库 `data/` |
| `npm run demo` | 灌合成回放数据到 `data-demo/` 并起服务（断网/无 key 可演示） |
| `npm run replay` | 只跑回放：打印窗口、主题分布、熵、重复率、来源集中度、触发的提醒清单 |
| `npm run chrome` | 用独立 profile 启动一个装好本扩展的 Chrome |
| `npm test` | 全部单测（146 条：core 73 / server 68 / ext 5） |
| `npm run check` | 单测 + 扩展静态检查（manifest / 单一事实来源 / fetch 只在 background） |
| `npm run accept` | 真机端到端验收：装扩展 → 真 B 站 → 悬浮球/抽屉/画像 → 停机降级（需 puppeteer-core：`mkdir -p ignore/temp/e2e-deps && cd ignore/temp/e2e-deps && npm i puppeteer-core`，或 `npm i -D puppeteer-core`） |
| `node tools/e2e/behavior-session.mjs` | 行为门槛补证：连续点开 10 个视频，验证 `behavior.available` 与 `D(U,P)` 真的能算出来 |

服务端参数：`--port`、`--data-dir`、`--replay`、`--seed`（配 `--replay`，灌进服务同款库）、`--append`、`--fixtures`。

## 目录

```
extension/          MV3 扩展：capture.js（采集）· overlay.js（悬浮球+抽屉）· background.js（唯一 fetch 出口）
                    extract.js 是符号链接，指向 src/adapters/bilibili/extract.js（DOM 规则只有一份）
src/core/           分析核心：ring.js 手写环形队列 · heap.js 手写小根堆 · metrics.js 熵/重复率/距离 · analyze.js 六条规则
src/adapters/       bilibili/（DOM 抽取纯函数）· replay/（固定种子合成日志生成器）
src/server/         app.js HTTP · store.js node:sqlite · ai.js DeepSeek+校验+缓存 · labeler.js 队列与叙述缓存
tests/              core 73 · server 64 · ext 5
fixtures/           回放-14d.jsonl（合成，可提交，重复生成逐字节相同）
docs/               CONTRACT.md（集成契约）· ARCHITECTURE.md · MOBILE-PATH.md
tools/              check-extension.mjs · e2e/acceptance.mjs
```

## 已知限制（都实测过，不打算藏）

1. **评论要登录态**：未登录时 B 站评论区只渲染"登录后查看 1000+ 条评论"，DOM 里没有评论节点，所以匿名会话抓到的 `comments` 是空的。你日常登录的 Chrome 里会正常抓到（抽取逻辑已用本地 DOM 复刻验证：8 条上限、穿透 `bili-comments` 的 shadow root、过滤登录提示）。**不会为了拿评论去登录或调平台接口。**
2. **CDP 装载的扩展不跨重启**（Chrome 156 忽略 `--load-extension`）。长期使用走 `chrome://extensions` 手动加载。
3. **阈值是演示校准值**：曝光 ≥ 20、已知主题 ≥ 60%、行为 ≥ 10、熵 < 0.45、`D` > 0.30 等，比规划书的 50/80% 低，否则一次浏览会话永远看不到任何提醒。界面与 `alerts[].thresholds_used` 原样披露，不冒充学术标准。
4. **单平台、单用户**：只做 B 站网页版，不做多平台、不做跨设备同步。
5. **行为门槛要够样本**：`open`+`watch` 对同一视频合并成 1 个行为样本，算法要求 ≥10 个才计算 `D(U,P)`。单次会话点 1—3 个视频时界面会写"有效正向行为 N 条，低于门槛 10"而不是硬给一个数。实测连续点开 10 个视频后 `sample_n=10`、`D(U,P)=0.2427`（脚本：`node tools/e2e/behavior-session.mjs`）。
6. **AI 会抖动**：同一内容打标结果可能不同；缓存按内容哈希，所以重复曝光不会重复花钱。无 key / 断网时自动降级为关键词词典 + 模板句，标注状态写 `unknown`，不冒充 AI 结果。
7. **不做**：事件维度覆盖与互补参考推荐、平台评测报告、手机跨 App 监测（这些在规划书里是 P1/P2，见 `docs/MOBILE-PATH.md`）。
8. **手动刷新会丢焦点**：抽屉"刷新"按钮重绘后输入框内容保留，但焦点不回到输入框（打字期间的自动重绘已被草稿保护挡住，不会发生）；可接受的残留。
9. **符号链接**：`extension/extract.js` 是指向 `src/adapters/bilibili/extract.js` 的 symlink，macOS/Linux 正常，Windows 上 clone 会成为断链（需要把文件复制过去，或改构建步骤）。

## 边界声明（答辩口径）

它记录的是**已观察样本**，不是平台内部画像：输出分布集中只能说"在你的记录里集中"，不能证明平台形成了信息茧房，也不能诊断个人心理状态。所有结论都带样本数与数据来源，证据不足时明确说"暂不判断"。

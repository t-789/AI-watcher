// 固定种子合成日志：14 个虚拟日，覆盖正常 / 重复加重 / 同步集中 / 目标改变后输出未变 / 收窄。
// 同一 seed 必须产出逐字节相同的 JSONL——因此这里只用手写 PRNG 与固定的虚拟时钟。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DAY_MS, PROFILE_ID, TOPICS } from "../../core/constants.js";
import { parseGoalText } from "../../core/index.js";

export const REPLAY_SEED = 20261102;
// 虚拟时钟起点（UTC），与程序运行当天无关：回放不能拿真实日期替代记录时间。
export const REPLAY_START_MS = Date.UTC(2026, 10, 1, 8, 0, 0);
export const REPLAY_DAYS = 14;
export const FIXTURE_NOW = REPLAY_START_MS + REPLAY_DAYS * DAY_MS;

export const SCENARIOS = ["normal", "repeat_heavy", "sync_concentration", "goal_shift_output_unchanged", "narrowing"];

const SCENARIO_TAG = {
  normal: "norm",
  repeat_heavy: "rep",
  sync_concentration: "sync",
  goal_shift_output_unchanged: "goal",
  narrowing: "narrow",
};

/** mulberry32：32 位状态的确定性 PRNG（同一 seed 同一序列）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n, width) {
  const s = String(n);
  return s.length >= width ? s : "0".repeat(width - s.length) + s;
}

// 每个主题 5 条：同一主题的条目多数集中在 2 个来源上，便于观察来源集中度。
const TOPIC_CONTENT = {
  tech: [
    ["AI 编程助手实测：把一周的活压到一天", "mid_101", "硬核老王"],
    ["本地跑大模型：消费级显卡够用吗", "mid_101", "硬核老王"],
    ["新手机影像横评：三颗镜头的差距", "mid_101", "硬核老王"],
    ["从零写一个编译器：第 1 讲", "mid_101", "硬核老王"],
    ["开源工具周报：这周值得试的 5 个", "mid_103", "开源观察"],
  ],
  science: [
    ["厨房里的化学实验：三分钟看懂", "mid_1001", "科学小实验"],
    ["望远镜入门：为什么口径决定一切", "mid_1002", "天文笔记"],
    ["为什么树叶是绿的：光谱的答案", "mid_1001", "科学小实验"],
    ["统计学的三个常见误用", "mid_1002", "天文笔记"],
    ["太空电梯的材料问题讲清楚", "mid_1001", "科学小实验"],
  ],
  game: [
    ["独立游戏推荐：五个被低估的小品", "mid_201", "独立游戏仓库"],
    ["手游抽卡概率实测：100 次十连够吗", "mid_202", "抽卡数学"],
    ["硬核解谜游戏通关思路复盘", "mid_201", "独立游戏仓库"],
    ["电竞赛事复盘：这场翻盘怎么打出来", "mid_203", "赛事复盘室"],
    ["主机与 PC 的帧数对比实验", "mid_202", "抽卡数学"],
  ],
  anime: [
    ["本季番剧观察：作画崩在第三集", "mid_301", "番剧观察员"],
    ["分镜拆解：这一场为什么紧张", "mid_302", "作画研究室"],
    ["声优访谈：一句台词录了二十遍", "mid_301", "番剧观察员"],
    ["动画电影原画展记录", "mid_302", "作画研究室"],
    ["老番重看：十年前的叙事节奏", "mid_301", "番剧观察员"],
  ],
  film_tv: [
    ["剧集拆解：这条支线删掉会怎样", "mid_401", "剧集拆解"],
    ["纪录片手记：拍了八个月的河流", "mid_402", "纪录片手记"],
    ["老电影修复前后对比", "mid_401", "剧集拆解"],
    ["悬疑片的三次反转是否成立", "mid_401", "剧集拆解"],
    ["冷门佳片推荐：五部小成本电影", "mid_402", "纪录片手记"],
  ],
  music: [
    ["编曲日记：从和弦到成品", "mid_501", "编曲日记"],
    ["歌单考古：十年前的夏天", "mid_502", "歌单考古"],
    ["现场录音为什么比专辑好听", "mid_501", "编曲日记"],
    ["翻唱改编的版权边界", "mid_502", "歌单考古"],
    ["混音入门：三件事先做对", "mid_501", "编曲日记"],
  ],
  study: [
    ["备考实录：两点一线的第十四天", "mid_601", "备考实录"],
    ["学习方法研究：间隔重复怎么用", "mid_602", "学习方法研究"],
    ["真题拆解：这类题的固定套路", "mid_601", "备考实录"],
    ["考研时间表：还剩三个月怎么排", "mid_601", "备考实录"],
    ["笔记体系对比：手写还是软件", "mid_602", "学习方法研究"],
  ],
  life: [
    ["一周便当：十五分钟能做什么", "mid_701", "生活实验室"],
    ["租房改造：五百块换一屋子光", "mid_701", "生活实验室"],
    ["沿海小城的四天", "mid_702", "厨房与路"],
    ["露营第一课：装备别一次买齐", "mid_702", "厨房与路"],
    ["厨房收纳的三个反常识", "mid_701", "生活实验室"],
  ],
  sports: [
    ["训练日志：从五公里到十公里", "mid_801", "训练日志"],
    ["球场视角：这次防守为什么成功", "mid_802", "球场视角"],
    ["羽毛球步法的常见错误", "mid_802", "球场视角"],
    ["力量训练的恢复安排", "mid_801", "训练日志"],
    ["跑步伤膝？先看这三个指标", "mid_801", "训练日志"],
  ],
  news: [
    ["时事梳理：这周的五条主线", "mid_901", "时事梳理"],
    ["财经白话：利率变化跟我有什么关系", "mid_902", "财经白话"],
    ["政策解读：新规落地后的三个月", "mid_901", "时事梳理"],
    ["数据看社会：一个被误读的统计", "mid_902", "财经白话"],
    ["国际观察：谈判桌上的三个信号", "mid_901", "时事梳理"],
  ],
};

function makeItem(index, title, sourceId, sourceName, topics) {
  const id = "item_" + pad(index, 3);
  return {
    content_id: id,
    platform: "bilibili",
    canonical_key: "bv1" + pad(index, 3) + "x",
    title,
    url: "https://www.bilibili.com/video/BV1" + pad(index, 3) + "x",
    source_id: sourceId,
    source_name: sourceName,
    duration_s: 180 + ((index * 37) % 1200),
    view_count: 8000 + index * 1237,
    danmaku_count: 20 + index * 7,
    published_at: REPLAY_START_MS - (index % 20) * DAY_MS,
    fetched_at: REPLAY_START_MS,
    desc: "合成演示内容，非真实平台数据。",
    comments: ["合成评论：讲得清楚", "合成评论：有数据支撑"],
    topics,
    facets: [],
    value_notes: null,
    origin: "synthetic",
    annotation: { status: "unknown", model: null, at: null },
  };
}

// 每条基础标题展开成若干"期"，把候选池撑到接近真实推荐流的规模，否则重复率会失真地接近 1。
const VARIANTS = { tech: 6 };
const DEFAULT_VARIANTS = 2;

function buildItems() {
  const items = [];
  const byTopic = new Map();
  let index = 0;
  for (let ti = 0; ti < TOPICS.length; ti += 1) {
    const topic = TOPICS[ti];
    const rows = TOPIC_CONTENT[topic];
    const variants = VARIANTS[topic] ?? DEFAULT_VARIANTS;
    const list = [];
    for (let r = 0; r < rows.length; r += 1) {
      const [baseTitle, sourceId, sourceName] = rows[r];
      for (let v = 0; v < variants; v += 1) {
        index += 1;
        // 每 3 条里有 1 条是多主题（权重和仍为 1），用于覆盖"多主题内容"。
        const topics = r === 2 ? [{ t: topic, w: 0.7 }, { t: TOPICS[(ti + 1) % TOPICS.length], w: 0.3 }] : [{ t: topic, w: 1 }];
        const item = makeItem(index, baseTitle + " · 第 " + (v + 1) + " 期", sourceId, sourceName, topics);
        items.push(item);
        list.push(item);
      }
    }
    byTopic.set(topic, list);
  }
  const unknown = [];
  const unknownTitles = ["推荐流里的广告片段", "搬运合集（无简介）", "标题党短视频"];
  for (const title of unknownTitles) {
    index += 1;
    const item = makeItem(index, title, "mid_9001", "未知来源", []);
    items.push(item);
    unknown.push(item);
  }
  return { items, byTopic, unknown };
}

function planForDay(day) {
  if (day <= 3) {
    return {
      scenario: "normal",
      count: 50,
      topics: TOPICS.map((t) => ({ t, w: 1 })),
      poolShare: 0.1,
      unknownRate: 0.06,
    };
  }
  if (day <= 6) {
    return {
      scenario: "repeat_heavy",
      count: 55,
      topics: [{ t: "tech", w: 5 }, { t: "game", w: 2 }, { t: "study", w: 1.5 }, { t: "news", w: 1.5 }],
      poolShare: 0.35,
      unknownRate: 0.03,
    };
  }
  if (day <= 8) {
    return {
      scenario: "sync_concentration",
      count: 45,
      topics: [{ t: "tech", w: 6 }, { t: "game", w: 2 }, { t: "film_tv", w: 1 }, { t: "news", w: 1 }],
      poolShare: 0.4,
      unknownRate: 0.02,
    };
  }
  if (day <= 10) {
    return {
      scenario: "goal_shift_output_unchanged",
      count: 45,
      topics: [{ t: "tech", w: 6 }, { t: "game", w: 2 }, { t: "film_tv", w: 1 }, { t: "news", w: 1 }],
      poolShare: 0.4,
      unknownRate: 0.02,
    };
  }
  return {
    scenario: "narrowing",
    count: 45,
    topics: [{ t: "tech", w: 8.5 }, { t: "game", w: 1.5 }],
    poolShare: 0.45,
    unknownRate: 0.02,
  };
}

function pickWeighted(rng, weights) {
  let total = 0;
  for (const entry of weights) total += entry.w;
  let r = rng() * total;
  for (const entry of weights) {
    r -= entry.w;
    if (r <= 0) return entry.t;
  }
  return weights[weights.length - 1].t;
}

function pickFrom(rng, list) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

const GOAL_LINES = [
  {
    day: 0,
    text: "就是想放松一下，刷刷游戏和番剧",
    intent: "relax",
  },
  {
    day: 4,
    text: "想提升编程和 AI 工具的能力",
    intent: "skill",
  },
  {
    day: 9,
    text: "准备期末考试，想系统复习",
    intent: "exam",
  },
];

/**
 * 生成合成记录。返回 { records, scenarios, stats, now }；records 已经是可直接 JSONL 化的行对象。
 */
export function buildRecords(options = {}) {
  const seed = Number.isFinite(Number(options.seed)) ? Number(options.seed) : REPLAY_SEED;
  const rng = mulberry32(seed);
  const { items, byTopic, unknown } = buildItems();
  // 重复池 = 同一来源（mid_101）的 tech 条目：重复加重与来源集中同时出现，对应"同步集中"线索。
  const pool = byTopic.get("tech").filter((item) => item.source_id === "mid_101");

  const exposures = [];
  const actions = [];
  const goals = [];
  const scenariosSeen = new Set();
  let exposureSeq = 0;
  let actionSeq = 0;

  for (let day = 0; day < REPLAY_DAYS; day += 1) {
    const plan = planForDay(day);
    const tag = SCENARIO_TAG[plan.scenario];
    scenariosSeen.add(plan.scenario);
    const dayStart = REPLAY_START_MS + day * DAY_MS;
    let sessionIndex = 1;
    let sessionLeft = 0;
    let sessionId = "";
    for (let i = 0; i < plan.count; i += 1) {
      if (sessionLeft === 0) {
        sessionId = "sess_d" + pad(day, 2) + "_" + pad(sessionIndex, 2);
        sessionIndex += 1;
        sessionLeft = 8 + Math.floor(rng() * 6);
      }
      sessionLeft -= 1;
      const at = dayStart + Math.floor(((DAY_MS * 0.9) / plan.count) * i) + Math.floor(rng() * 60000);
      const item = rng() < plan.poolShare ? pickFrom(rng, pool) : rng() < plan.unknownRate
        ? pickFrom(rng, unknown)
        : pickFrom(rng, byTopic.get(pickWeighted(rng, plan.topics)));
      exposureSeq += 1;
      const exposure = {
        type: "exposure",
        exposure_id: "exp_" + tag + "_" + pad(exposureSeq, 4),
        profile_id: PROFILE_ID,
        session_id: sessionId,
        content_id: item.content_id,
        exposed_at: at,
        page_context: i % 3 === 0 ? "home" : i % 7 === 0 ? "search" : "video_related",
        observable_rank: (i % 12) + 1,
        origin: "synthetic",
      };
      exposures.push(exposure);

      const roll = rng();
      let actionType = null;
      if (roll < 0.26) actionType = "open";
      else if (roll < 0.34) actionType = "like";
      else if (roll < 0.38) actionType = "favorite";
      else if (roll < 0.46) actionType = "scroll_past";
      if (actionType) {
        actionSeq += 1;
        const action = {
          type: "action",
          action_id: "act_" + pad(actionSeq, 4),
          profile_id: PROFILE_ID,
          session_id: sessionId,
          exposure_id: exposure.exposure_id,
          content_id: item.content_id,
          action_type: actionType,
          occurred_at: at + 2000 + Math.floor(rng() * 30000),
          origin: "synthetic",
        };
        if (actionType === "open") action.watch_seconds = Math.floor(item.duration_s * (0.2 + rng() * 0.7));
        actions.push(action);
      }

      // 主动搜索只记录主题，不保存原始搜索文本。
      if (rng() < 0.12) {
        actionSeq += 1;
        actions.push({
          type: "action",
          action_id: "act_" + pad(actionSeq, 4),
          profile_id: PROFILE_ID,
          session_id: sessionId,
          topic_id: plan.topics[0].t,
          action_type: "search",
          occurred_at: at + 15000 + Math.floor(rng() * 30000),
          origin: "synthetic",
        });
      }
    }
  }

  for (let i = 0; i < GOAL_LINES.length; i += 1) {
    const line = GOAL_LINES[i];
    const profile = parseGoalText(line.text, line.intent, {
      profile_id: PROFILE_ID,
      updated_at: REPLAY_START_MS + line.day * DAY_MS,
      version: i + 1,
    });
    goals.push(Object.assign({ type: "goal" }, profile));
  }

  const records = [];
  for (const item of items) records.push(Object.assign({ type: "item" }, item));
  const stream = [];
  for (const exposure of exposures) stream.push({ at: exposure.exposed_at, rank: 0, id: exposure.exposure_id, line: exposure });
  for (const action of actions) stream.push({ at: action.occurred_at, rank: 1, id: action.action_id, line: action });
  for (const goal of goals) stream.push({ at: goal.updated_at, rank: 2, id: "goal_" + goal.version, line: goal });
  stream.sort((a, b) => a.at - b.at || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const entry of stream) records.push(entry.line);

  return {
    records,
    scenarios: [...scenariosSeen],
    now: FIXTURE_NOW,
    stats: {
      items: items.length,
      exposures: exposures.length,
      actions: actions.length,
      goals: goals.length,
      days: REPLAY_DAYS,
    },
  };
}

export function toJSONL(records) {
  let out = "";
  for (const record of records) out += JSON.stringify(record) + "\n";
  return out;
}

export function generateJSONL(options = {}) {
  return toJSONL(buildRecords(options).records);
}

/** 把回放 JSONL 还原成 buildSnapshot 的输入。goal 取 updated_at 最大的一条。 */
export function parseReplay(text) {
  const items = [];
  const exposures = [];
  const actions = [];
  let goal = null;
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.type === "item") items.push(record);
    else if (record.type === "exposure") exposures.push(record);
    else if (record.type === "action") actions.push(record);
    else if (record.type === "goal") {
      if (!goal || Number(record.updated_at) >= Number(goal.updated_at)) goal = record;
    }
  }
  return { items, exposures, actions, goal, now: FIXTURE_NOW };
}

export function fixturePath() {
  return fileURLToPath(new URL("../../../fixtures/replay-14d.jsonl", import.meta.url));
}

export function writeFixture(path = fixturePath(), options = {}) {
  const jsonl = generateJSONL(options);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, jsonl);
  return { path, bytes: Buffer.byteLength(jsonl), lines: jsonl.split("\n").length - 1 };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const result = writeFixture();
  process.stdout.write("wrote " + result.path + " (" + result.lines + " lines, " + result.bytes + " bytes)\n");
}

// 契约 §1：常量集中在此文件，其他模块一律 import，禁止散落魔法数。

export const PORT = 3789;
export const SCHEMA_VERSION = 1;
export const PROFILE_ID = "local-default";

// 固定主题表，K = 10；无法判断时 topics 为空数组（未知），不强行归类。
export const TOPICS = ["tech", "science", "game", "anime", "film_tv", "music", "study", "life", "sports", "news"];

export const TOPIC_LABELS = {
  tech: "科技·AI·数码",
  science: "科学·科普",
  game: "游戏",
  anime: "动画·二次元",
  film_tv: "影视·剧集",
  music: "音乐",
  study: "学习·考试·求职",
  life: "生活·美食·旅行",
  sports: "体育·健身",
  news: "时事·社会·财经",
};

export const WINDOW_DAYS = 7;

// 演示用阈值（不是学术标准；alerts[].thresholds_used 原样披露，界面必须照抄）。
export const THRESHOLDS = {
  minExposure: 20,
  minKnownTopicRatio: 0.6,
  minBehavior: 10,
  outputConcentrationEntropy: 0.45,
  gapDistance: 0.3,
  repeatRate: 0.35,
  topSourceShare: 0.4,
  narrowingEntropyDrop: 0.1,
  topDomination: 0.2,
};

export const DAY_MS = 86400000;
export const RING_CAPACITY = 64;
export const ROUND_DIGITS = 4;
export const ALERT_EVIDENCE_LIMIT = 5;

export const PAGE_CONTEXTS = ["home", "video_related", "search"];

export const INTENT_MODES = ["relax", "learn_event", "skill", "exam", "cure"];

// 无关键词命中时 parseGoalText 的兜底先验（关键词命中时只作很弱的偏置）。
export const INTENT_PRIORS = {
  relax: { game: 0.3, anime: 0.25, film_tv: 0.2, music: 0.15, life: 0.1 },
  learn_event: { news: 0.4, science: 0.3, tech: 0.3 },
  skill: { study: 0.4, tech: 0.4, science: 0.2 },
  exam: { study: 0.7, science: 0.3 },
  cure: { life: 0.4, music: 0.3, film_tv: 0.3 },
};

export const INTENT_EXPLORATION = { relax: 0.4, learn_event: 0.7, skill: 0.6, exam: 0.3, cure: 0.5 };

// 行为权重（计划书 §6.4，待校准的设计参数）：同一会话同一内容取最大值，不累加；负反馈不进归一化。
export const BEHAVIOR_WEIGHTS = { open: 1, watch: 1, like: 2, coin: 2, favorite: 3, search: 2 };
export const NEGATIVE_ACTIONS = ["scroll_past"];
export const WATCH_RATIO_FALLBACK = 0.5;

export const GOAL_KEYWORDS = {
  tech: ["ai", "人工智能", "大模型", "芯片", "数码", "显卡", "编程", "代码", "软件", "算法", "工具", "手机", "相机"],
  science: ["科学", "科普", "物理", "化学", "生物", "天文", "实验", "数学", "统计", "论文", "知识", "冷知识"],
  game: ["游戏", "手游", "端游", "攻略", "电竞", "steam", "主机", "开黑", "抽卡"],
  anime: ["动漫", "番剧", "二次元", "动画", "漫画", "cos", "声优"],
  film_tv: ["电影", "剧集", "电视剧", "综艺", "纪录片", "影视", "追剧", "影评"],
  music: ["音乐", "歌单", "专辑", "演唱会", "翻唱", "bgm", "乐器", "编曲"],
  study: ["学习", "考试", "考研", "四六级", "复习", "课程", "真题", "期末", "作业", "求职", "面试", "实习", "笔记"],
  life: ["生活", "美食", "旅行", "做饭", "vlog", "日常", "探店", "租房", "露营"],
  sports: ["体育", "健身", "篮球", "足球", "跑步", "训练", "比赛", "nba", "羽毛球"],
  news: ["新闻", "时事", "财经", "社会", "股票", "政策", "国际", "热点", "事件"],
};

// 目标解析按"分句等权"合并：一句话里出现多个意图时，每个分句贡献一份分布，
// 不允许最后出现的那个关键词把整句吃掉（旧实现按全句命中计数，会让"放松身心+了解时事"塌陷成单一主题）。
export const GOAL_KEYWORD_WEIGHT = 1;
// 同一分句里同一主题命中多个近义词的额外加分（封顶见 GOAL_KEYWORD_HIT_CAP），避免"知识/小知识"线性放大。
export const GOAL_KEYWORD_EXTRA = 0.15;
export const GOAL_KEYWORD_HIT_CAP = 2;
// 意图先验在分句内的权重倍数：分句没有关键词命中时直接用先验，因此不再是被 1.0 关键词压掉的陪衬。
export const INTENT_PRIOR_WEIGHT = 1;
export const GOAL_MIN_TOPIC_WEIGHT = 0.05;
// 目标主题上限：避免画像里塞进一堆 5% 的碎片。
export const GOAL_TOPIC_LIMIT = 4;

// 「放松」是正当目标（用户裁决），不是噪声：命中 relax 意图或文本出现放松类词时，
// 为这组主题保留固定份额，避免模型把它整块丢掉。组内比例固定，保证可复现。
export const RELAX_GROUP = ["game", "anime", "film_tv"];
export const RELAX_GROUP_WEIGHT = 0.4;
export const RELAX_GROUP_RATIO = { game: 0.5, anime: 0.3, film_tv: 0.2 };
export const RELAX_INTENT_RE = /放松|轻松|休息|解压|消遣|休闲|娱乐|摸鱼|打发时间/;

// 环形队列表（RingWindow）的计数键前缀：同一张计数表同时维护主题权重、主题出现次数、来源次数。
export const COUNTER_PREFIX = { topicWeight: "tw:", topicCount: "tc:", source: "src:" };

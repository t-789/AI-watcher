// 契约 §3 的分析核心导出面；常量同时转出，服务层可以只 import 本文件。
export { PORT, PROFILE_ID, SCHEMA_VERSION, THRESHOLDS, TOPICS, TOPIC_LABELS, WINDOW_DAYS } from "./constants.js";
export { buildSnapshot, parseGoalText } from "./analyze.js";
export { distance, entropy, repeatRate } from "./metrics.js";
export { topK } from "./heap.js";
export { RingWindow } from "./ring.js";

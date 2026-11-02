export { PORT, PROFILE_ID, SCHEMA_VERSION, THRESHOLDS, TOPICS, TOPIC_LABELS, WINDOW_DAYS } from "./constants.js";
export { applyRelaxIntent, buildSnapshot, parseGoalText } from "./analyze.js";
export { distance, entropy, repeatRate } from "./metrics.js";
export { topK } from "./heap.js";
export { RingWindow } from "./ring.js";
// 契约 §10.2：确定性推荐排序（AI 只写 why）
export { rankRecommendations, RECO_WEIGHTS } from "./recommend.js";

// 判定策略（report.mjs 运行期与单测共用同一份实现）
//
// 为什么单独成模块：这里的每个数字与每条分层规则都决定"什么算回归"，
// 判断错了产出的不是噪声而是误导性结论（曾出现同一份代码因 runner 抖动
// 被连续判定为 5 次"回归"）。抽出来后单测可以断言**线上实现**本身，
// 而不是断言它的副本。judgment.d.ts 提供类型。

/** 默认劣化阈值（%）；可按指标覆盖 */
export const DEFAULT_PCT = 15;

/** p95 天然比中位数抖，在基础阈值上放宽 */
export const P95_EXTRA_PCT = 10;

/**
 * 指标阈值覆盖。标定依据都来自真实 CI 采样（同一份代码的多次运行）：
 *
 * - longTaskCount：基数常常是 0，纯百分比会被无限放大 → 要求「+20% 且 +5」同时成立
 * - longTaskMs：少数 long task 的求和（样本里只有 1~5 段），实测噪声样本为
 *   +25.0%/+34ms、+18.9%/+76ms、+16.5%/+69ms、+17.5%/+329ms、+35.7%/+81ms
 *   ——百分比与绝对值都无法单独区分噪声，故要求「+50% 且 +100ms」同时成立；
 *   真正的成倍恶化（136→250ms、227→500ms）仍会被判 FAIL
 * - longFrameCount：同 longTaskCount 的基数问题
 * - jankCount / jankRatePct：稳态基数为 0，用绝对增量门槛
 * - cls：基数极小（千分位），用绝对增量判定
 * - heapDeltaMB：波动天然大，放宽到 25%
 */
export const METRIC_RULES = {
  longTaskCount: { pct: 20, absMin: 5 },
  longTaskMs: { pct: 50, absMin: 100 },
  longFrameCount: { pct: 20, absMin: 3 },
  jankCount: { pct: 50, absMin: 6 },
  jankRatePct: { pct: 50, absMin: 5 },
  cls: { abs: 0.02 },
  heapDeltaMB: { pct: 25 },
};

/**
 * 主指标：直接反映用户可感知的耗时，可以**单独**判定 FAIL。
 * 它们的量级大（数百毫秒级）且语义明确，CI 抖动的相对影响可控。
 */
export const PRIMARY_METRICS = [
  "ttiMs",
  "inputSyncMs",
  "inputPaintMs",
  "frameMs",
  "searchMs",
  "switchMs",
  "saveMs",
];

/**
 * 只有这些标量参与比较；matchCount / frameBudgetMs / step 之类是 fixture 属性或测量配置。
 */
export const COMPARED_SCALARS = [
  "longTaskCount",
  "longTaskMs",
  "longFrameCount",
  "jankCount",
  "jankRatePct",
  "cls",
  "heapDeltaMB",
];

/** 去掉 `.p95` 后缀，取基础指标名 */
export function baseMetric(metric) {
  return metric.endsWith(".p95") ? metric.slice(0, -4) : metric;
}

/** 是否为主指标（`.p95` 行继承其基础指标的分层） */
export function isPrimary(metric) {
  return PRIMARY_METRICS.includes(baseMetric(metric));
}

/**
 * 该指标是否**必须**有主指标佐证才能判 FAIL。
 *
 * 规则：只有显式登记在 PRIMARY_METRICS 里的指标才享有"单独判 FAIL"的能力，
 * 其余（派生/计数/求和/占比/未知指标）都要求同一场景内有主指标同样超阈值。
 * 理由：同一份代码在共享 CI runner 上，longTaskMs 这类派生标量能自然波动 35%
 * （实测），没有主指标佐证的"回归"不可行动；反过来，真正影响用户可感知耗时的
 * 退化必然会体现在主指标上。
 *
 * 未知指标默认纳入"需佐证"一侧——"能单独判 FAIL"是一种需要论证的特权，
 * 新指标想获得它，必须显式加进 PRIMARY_METRICS。
 */
export function requiresPrimaryCorroboration(metric) {
  return !isPrimary(metric);
}

/** 取指标对应的阈值规则（`xxx.p95` 行在基础规则上放宽） */
export function ruleFor(metric) {
  if (METRIC_RULES[metric]) return METRIC_RULES[metric];
  if (metric.endsWith(".p95")) {
    const base = METRIC_RULES[baseMetric(metric)] ?? { pct: DEFAULT_PCT };
    return { pct: (base.pct ?? DEFAULT_PCT) + P95_EXTRA_PCT };
  }
  return { pct: DEFAULT_PCT };
}

/**
 * 单指标是否劣化超阈值。
 * - 规则带 abs 时按绝对增量判定
 * - 基数为 0 时百分比无意义，退化为绝对增量门槛（absMin）
 * - 规则同时带 pct 与 absMin 时要求两者**同时**成立（避免小基数百分比放大）
 */
export function isOver(metric, current, base) {
  const rule = ruleFor(metric);
  const delta = current - base;
  if (rule.abs !== undefined) return delta > rule.abs;
  if (base === 0) {
    return delta > (rule.absMin ?? 0.5);
  }
  const pctOk = delta / base > rule.pct / 100;
  if (rule.absMin !== undefined) return pctOk && delta >= rule.absMin;
  return pctOk;
}

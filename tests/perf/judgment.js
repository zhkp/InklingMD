// 判定策略（report.mjs 运行期与单测共用同一份实现）
//
// 为什么单独成模块：这里的每个数字与每条分层规则都决定"什么算回归"，
// 判断错了产出的不是噪声而是误导性结论（曾出现同一份代码因 runner 抖动
// 被连续判定为 5 次"回归"）。抽出来后单测可以断言**线上实现**本身，
// 而不是断言它的副本。judgment.d.ts 提供类型。

/** 中位数（与 report 的聚合口径一致；统一在这里定义，避免多处实现漂移） */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 样本标准差（n-1）。少于 2 点无法估计，返回 null */
export function sampleSd(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  return Number.isFinite(sd) ? sd : null;
}

/**
 * 噪声门槛倍数：变化必须超过 **3σ** 才算可行动。
 *
 * 为什么必须有这一层（实测，同一份代码的 5 次 CI 运行）：
 *   ttiMs        基线 888ms   3σ≈241ms（占 27%）
 *   longTaskMs   基线 302ms   3σ≈161ms（占 53%）
 *   inputSyncMs  基线 1.9ms   3σ≈1.25ms（占 66%）
 *   frameMs.p95  基线 17.1ms  3σ≈0.39ms（占 2.3%，vsync 量化反而极稳）
 * 也就是"哪个指标能分辨多大差异"是**环境属性**，靠人给常数（15%）必然出错——
 * 本 PR 前几轮反复出现的假 FAIL 与漏检，根因都在这里。
 */
export const NOISE_SIGMA = 3;

/** 估计噪声所需的最少历史点数（少于 3 点不足以谈散布） */
export const NOISE_MIN_POINTS = 3;

/** 由历史序列估计 3σ 门槛；历史不足或零方差时返回 null（判定退化为百分比 + 绝对地板） */
export function noiseThreshold(history, sigma = NOISE_SIGMA) {
  if (!Array.isArray(history) || history.length < NOISE_MIN_POINTS) return null;
  const sd = sampleSd(history);
  if (sd === null || sd <= 0) return null;
  return sigma * sd;
}

/**
 * 比较时使用的参考值：历史点数足够时用**历史中位数**（滚动参考），否则用基线记录的点值。
 *
 * 为什么不用单点基线：实测 5 次同代码运行的聚合值整体偏移达 -8%~-25%
 * （基线那次恰好是偏慢的一次），单点参考会把整批指标一起判成"改善"或"恶化"。
 */
export function referenceValue(entry, statistic = "median") {
  if (!entry) return undefined;
  const key = statistic === "p95" ? "historyP95" : "history";
  const history = entry[key];
  if (Array.isArray(history) && history.length >= NOISE_MIN_POINTS) return median(history);
  return entry[statistic];
}

/** 取某个统计量对应的噪声门槛（3σ） */
export function noiseFor(entry, statistic = "median") {
  const key = statistic === "p95" ? "historyP95" : "history";
  return noiseThreshold(entry?.[key]);
}

/**
 * 噪声门槛的"分辨率"：3σ 占参考值的百分比。
 *
 * 它回答"这个指标在当前环境下最小能分辨多大的变化"——占比 50% 意味着
 * 小于一半的变化在统计上与抖动不可分，该行即使显示 PASS 也不能读成"没问题"。
 * 这正是"静默漏检"的来源：假 FAIL 会被人发现，掩盖真回归不会。
 *
 * σ 不可用（历史 <3 点或零方差）或参考值 ≤ 0 时返回 null（此时无门槛可谈）。
 */
export function resolutionPct(entry, statistic = "median") {
  const noise = noiseFor(entry, statistic);
  const reference = referenceValue(entry, statistic);
  if (noise === null || !(reference > 0)) return null;
  return (noise / reference) * 100;
}

/**
 * 会话标定指标（issue #236）：与编辑器代码无关的固定合成工作量（见 metrics.runSessionProbe）。
 *
 * 关键区别——**进基线，但不参与判定**：
 * - **要进基线**：只有持久化了历史，报告才能算出参考值、3σ 门槛与"环境异常"结论；
 * - **不参与判定**：`COMPARED_SCALARS` 是判定白名单，标定指标刻意不在其中——
 *   机器变慢不是代码回归，它绝不能被判成 FAIL/WARN。
 *
 * ⚠️ 这两个集合必须分开维护：`buildStats`（写基线）取两者的并集，
 * 判定循环只取 `COMPARED_SCALARS`。实测踩过——把标定值只留给"不持久化"的一侧，
 * 结果是播种产物里根本没有 `probeMs`，基线没有历史、归因行永远不出现。
 */
export const SESSION_PROBE_METRICS = ["probeMs", "probeLayoutMs", "probeCpuMs"];

/** 是否为会话标定指标（进基线但不参与判定） */
export function isSessionProbe(metric) {
  return SESSION_PROBE_METRICS.includes(metric);
}

/**
 * 分辨率提醒阈值（%）：3σ 达到参考值这个比例时，报告会显式列出该指标。
 *
 * 取 30% 的依据：默认劣化阈值是 15%（p95 为 25%），3σ 一旦超过两倍基础阈值，
 * 意味着"连默认阈值 2 倍幅度的变化都测不出来"，此时该指标的相对判定只剩
 * "抓大事故"的能力，读者必须知道。低于此值则门槛仍能覆盖默认阈值，无需提醒。
 */
export const RESOLUTION_WARN_PCT = 30;

/**
 * 整机漂移提醒阈值（%）：比基线差的相对行占比达到这个比例时，报告会提示
 * 「本次疑似整机变慢」。
 *
 * 取 70% 的依据：纯噪声下"变差"的行占比应在 50% 附近（参考值取历史中位数，
 * 上下对称）；实测一次共享 runner 被拖慢的运行是 **88%**（50/57 行、中位 Δ +18.7%，
 * 16 个场景里互不相关的指标一起变差），而同分支安静时段运行接近 50%。
 * 70% 落在两者之间，留有足够余量。
 *
 * **只做披露、不改判定**：整体变慢也可能是真实回归（例如全链路变慢），
 * 在共享 runner 上二者无法凭此区分——真正的区分需要环境无关的标定负载，
 * 属于后续工作。这里只把证据摆在 FAIL 旁边，避免读者误判成因。
 */
export const DRIFT_WARN_PCT = 70;

/** 默认劣化阈值（%）；可按指标覆盖 */
export const DEFAULT_PCT = 15;

/** p95 天然比中位数抖，在基础阈值上放宽 */
export const P95_EXTRA_PCT = 10;

/**
 * 指标阈值覆盖。标定依据都来自真实采样（同一份代码的多次运行）：
 *
 * - longTaskCount：基数常常是 0，纯百分比会被无限放大 → 要求「+20% 且 +5」同时成立
 * - longTaskMs：少数 long task 的求和（样本里只有 1~5 段），实测噪声样本为
 *   +25.0%/+34ms、+18.9%/+76ms、+16.5%/+69ms、+17.5%/+329ms、+35.7%/+81ms
 *   ——百分比与绝对值都无法单独区分噪声，故要求「+50% 且 +100ms」同时成立；
 *   真正的成倍恶化（136→250ms、227→500ms）仍会被判 FAIL
 * - inputSyncMs：**量级只有 1.5~2.5ms**，15% 阈值等于 0.29ms，完全埋在噪声里。
 *   同代码实测中位数：本机 1.5 / 1.6 / 2.0，CI 1.9 / 2.2 / 2.5（散布 ±0.5ms），
 *   故加绝对地板「Δ≥1ms」：CI 曾因 Δ0.3ms 判出假 FAIL
 * - saveMs：同代码实测 33.4 / 34.0 / 38.0ms（散布 4.6ms ≈ 13.5%，已逼近 15% 阈值），
 *   故加绝对地板「Δ≥8ms」
 * - longFrameCount：同 longTaskCount 的基数问题
 * - jankCount / jankRatePct：稳态基数为 0，用绝对增量门槛
 * - cls：基数极小（千分位），用绝对增量判定
 * - heapDeltaMB：波动天然大，放宽到 25%
 *
 * 通用原则：每个指标都有**可分辨的噪声地板**，低于地板的差异不可行动。
 * 地板必须由同代码的重复实测得出，不能凭感觉给。
 */
export const METRIC_RULES = {
  longTaskCount: { pct: 20, absMin: 5 },
  longTaskMs: { pct: 50, absMin: 100 },
  longFrameCount: { pct: 20, absMin: 3 },
  jankCount: { pct: 50, absMin: 6 },
  jankRatePct: { pct: 50, absMin: 5 },
  inputSyncMs: { pct: 15, absMin: 1 },
  saveMs: { pct: 15, absMin: 8 },
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

/** 取指标对应的阈值规则（`xxx.p95` 行在基础规则上放宽，并继承绝对地板） */
export function ruleFor(metric) {
  if (METRIC_RULES[metric]) return METRIC_RULES[metric];
  if (metric.endsWith(".p95")) {
    const base = METRIC_RULES[baseMetric(metric)] ?? { pct: DEFAULT_PCT };
    return {
      pct: (base.pct ?? DEFAULT_PCT) + P95_EXTRA_PCT,
      // 绝对地板必须继承：否则 inputSyncMs.p95 这种 2ms 量级的尾部指标
      // 仍会被 0.3ms 的噪声顶过 25% 阈值
      ...(base.absMin !== undefined ? { absMin: base.absMin } : {}),
    };
  }
  return { pct: DEFAULT_PCT };
}

/**
 * 单指标是否劣化超阈值。
 * - 规则带 abs 时按绝对增量判定
 * - 基数为 0 时百分比无意义，退化为绝对增量门槛（absMin）
 * - 规则同时带 pct 与 absMin 时要求两者**同时**成立（避免小基数百分比放大）
 */
export function isOver(metric, current, base, noise) {
  const rule = ruleFor(metric);
  const delta = current - base;
  if (rule.abs !== undefined) return delta > rule.abs;
  if (base === 0) {
    return delta > (rule.absMin ?? 0.5);
  }
  const pctOk = delta / base > rule.pct / 100;
  const minOk = rule.absMin === undefined || delta >= rule.absMin;
  // 噪声门槛：变化必须超过 3σ（来自基线历史），否则无法与运行间抖动区分
  const noiseOk = typeof noise !== "number" || delta > noise;
  return pctOk && minOk && noiseOk;
}

/** 只按百分比 + 绝对地板判断（不含噪声门槛）：用于区分"超阈值"与"被噪声抑制" */
export function isOverIgnoringNoise(metric, current, base) {
  return isOver(metric, current, base, null);
}

/**
 * 一行"过了相对阈值、但被抑制"的原因；没有则返回 null。
 *
 * 为什么需要它：被抑制不等于"没变化"。若直接落成 PASS，读者会以为指标纹丝不动，
 * 而实际上它可能涨了 25%（只是幅度在实测噪声/绝对地板之内）。判定要可解释：
 * - "floor"：幅度低于该指标的绝对地板（如 inputSyncMs Δ<1ms）
 * - "noise"：幅度在运行噪声内（< 3σ，来自基线历史）
 */
export function suppressionReason(metric, current, base, noise) {
  const rule = ruleFor(metric);
  const delta = current - base;
  if (delta <= 0) return null; // 改善或持平不算"被抑制"
  if (rule.abs !== undefined) return null; // 绝对值型指标没有相对阈值可谈
  if (base === 0) return null; // 基数为 0 的走绝对增量门槛
  if (!(delta / base > rule.pct / 100)) return null; // 未过相对阈值 → 正常 PASS
  if (rule.absMin !== undefined && delta < rule.absMin) return "floor";
  if (typeof noise === "number" && delta <= noise) return "noise";
  return null;
}

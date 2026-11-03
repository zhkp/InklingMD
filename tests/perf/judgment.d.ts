// judgment.js 的类型声明：让 tsc 与 vitest 能直接引用这份 .js 实现做断言。

export type MetricRule = {
  pct?: number;
  abs?: number;
  absMin?: number;
};

/** 基线里单个指标的记录（history / historyP95 为逐次运行的聚合值） */
export type MetricEntry = {
  median?: number;
  p95?: number | null;
  max?: number | null;
  n?: number | null;
  scalar?: boolean;
  history?: number[];
  historyP95?: number[];
};

export function median(values: number[]): number;
export function sampleSd(values: number[]): number | null;

export const NOISE_SIGMA: number;
export const NOISE_MIN_POINTS: number;
export function noiseThreshold(
  history: number[] | undefined,
  sigma?: number,
): number | null;
export function referenceValue(
  entry: MetricEntry | undefined,
  statistic?: "median" | "p95",
): number | null | undefined;
export function noiseFor(
  entry: MetricEntry | undefined,
  statistic?: "median" | "p95",
): number | null;

export const DEFAULT_PCT: number;
export const P95_EXTRA_PCT: number;
/** 参考值的滚动窗口长度（取历史最近 K 点，issue #270 方案 C） */
export const REFERENCE_WINDOW: number;
export const METRIC_RULES: Record<string, MetricRule>;
/** 需要「历史推导地板」保护的小基数计数指标（issue #270 方案 B） */
export const COUNT_METRICS: string[];
/** 参考值低于此值的计数指标才启用历史推导地板 */
export const COUNT_SMALL_BASE: number;
/** 历史极差 → 地板下限的系数 */
export const COUNT_FLOOR_FACTOR: number;
export const PRIMARY_METRICS: string[];
export const COMPARED_SCALARS: string[];

export function baseMetric(metric: string): string;
export function isPrimary(metric: string): boolean;
export function requiresPrimaryCorroboration(metric: string): boolean;
export function ruleFor(metric: string): MetricRule;
/**
 * 由同一份代码的历史散布推导的绝对地板下限（只对小基数计数指标生效，且只用于收紧）。
 * 历史不足 3 点、极差为 0 或参考值不在「小基数」范围时返回 undefined。
 */
export function historyFloor(
  entry: MetricEntry | undefined | null,
  metric: string,
  statistic?: "median" | "p95",
): number | undefined;
/**
 * 该指标在当前基线上生效的绝对地板 = 登记常数与历史推导下限取大者（单向：只会收紧）。
 * 返回 undefined 表示该指标没有地板。
 */
export function effectiveAbsMin(
  entry: MetricEntry | undefined | null,
  metric: string,
  statistic?: "median" | "p95",
): number | undefined;
/**
 * 「生效地板」是否真的被历史推导值抬高（严格大于登记常数；无登记常数则为 false）。
 * 报告据此决定是否把该行列进「地板被抬高」的披露名单（#274 / #285）。
 */
export function isRaisedFloor(
  registeredAbsMin: number | undefined,
  floorDerived: number | undefined,
): boolean;
/**
 * noise 为 3σ 门槛；null/undefined 表示不启用噪声门槛（历史不足或绝对值型指标）。
 * absMin 为调用方算好的「生效地板」（effectiveAbsMin）；不传则用规则里登记的常数。
 */
export function isOver(
  metric: string,
  current: number,
  base: number,
  noise?: number | null,
  absMin?: number,
): boolean;
/**
 * 噪声门槛的分辨率：3σ 占参考值的百分比（"最小能分辨多大的变化"）。
 * σ 不可用或参考值 ≤0 时返回 null
 */
export function resolutionPct(
  entry: MetricEntry | undefined | null,
  statistic?: "median" | "p95",
): number | null;
/**
 * 多轮聚合（issue #294）：`FAIL ⟺ 参与判定的每一轮都超阈值`（末轮仍超才算确认）。
 *
 * `overRounds` 只能包含**实际参与判定**的轮次、按轮次顺序排列，且必须由调用方
 * 区分「未超」（false）与「缺失」（不应出现——缺失场景走 UNCONFIRMED 分支）。
 */
export function confirmVerdict(overRounds: boolean[]): "pass" | "warn" | "fail";
/** 3σ 达到参考值这个百分比时，报告会显式列出该指标（默认 30） */
export const RESOLUTION_WARN_PCT: number;
/** 会话标定指标（进基线但不参与判定，issue #236） */
export const SESSION_PROBE_METRICS: string[];
/** 归因指标（进基线但不参与判定，issue #379） */
export const ATTRIBUTION_METRICS: string[];
/** 比基线差的相对行占比达到此比例时，报告提示「疑似整机变慢」（默认 70，仅披露不改判定） */
export const DRIFT_WARN_PCT: number;
/**
 * 过了相对阈值但被抑制的原因；没有则 null。
 * "floor" = 低于该指标的绝对地板；"noise" = 在运行噪声内（< 3σ）
 */
export function suppressionReason(
  metric: string,
  current: number,
  base: number,
  noise?: number | null,
  absMin?: number,
): "floor" | "noise" | null;

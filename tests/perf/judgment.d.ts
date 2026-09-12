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
export const METRIC_RULES: Record<string, MetricRule>;
export const PRIMARY_METRICS: string[];
export const COMPARED_SCALARS: string[];

export function baseMetric(metric: string): string;
export function isPrimary(metric: string): boolean;
export function requiresPrimaryCorroboration(metric: string): boolean;
export function ruleFor(metric: string): MetricRule;
/** noise 为 3σ 门槛；null/undefined 表示不启用噪声门槛（历史不足或绝对值型指标） */
export function isOver(
  metric: string,
  current: number,
  base: number,
  noise?: number | null,
): boolean;
export function isOverIgnoringNoise(metric: string, current: number, base: number): boolean;
/**
 * 过了相对阈值但被抑制的原因；没有则 null。
 * "floor" = 低于该指标的绝对地板；"noise" = 在运行噪声内（< 3σ）
 */
export function suppressionReason(
  metric: string,
  current: number,
  base: number,
  noise?: number | null,
): "floor" | "noise" | null;

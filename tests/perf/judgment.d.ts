// judgment.js 的类型声明：让 tsc 与 vitest 能直接引用这份 .js 实现做断言。

export type MetricRule = {
  pct?: number;
  abs?: number;
  absMin?: number;
};

export const DEFAULT_PCT: number;
export const P95_EXTRA_PCT: number;
export const METRIC_RULES: Record<string, MetricRule>;
export const PRIMARY_METRICS: string[];
export const COMPARED_SCALARS: string[];

export function baseMetric(metric: string): string;
export function isPrimary(metric: string): boolean;
export function requiresPrimaryCorroboration(metric: string): boolean;
export function ruleFor(metric: string): MetricRule;
export function isOver(metric: string, current: number, base: number): boolean;

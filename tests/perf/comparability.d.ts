// comparability.js 的类型声明。
// 有了它，tsc 与 vitest 都能以类型安全的方式引用这份 .mjs 实现，
// 从而直接对线上代码做断言，而不是测试一份副本。

export const MODE_FALLBACK: string;

export interface ComparabilityFixture {
  version: number;
  hash: string;
}

/** 采样文件中参与可比性判断的字段（其余字段与本策略无关） */
export interface ComparabilityPeer {
  env: string;
  profile: string;
  /** 旧基线可能缺该字段，按 MODE_FALLBACK 处理 */
  mode?: string;
  fixture: ComparabilityFixture;
}

export interface ComparabilityResult {
  ok: boolean;
  /** ok=false 时给出可读原因（NEW / ENV_MISMATCH / PROFILE_MISMATCH / MODE_MISMATCH / FIXTURE_CHANGED） */
  reason: string;
}

export function baselineComparability(
  raw: ComparabilityPeer,
  baseline: ComparabilityPeer | null | undefined,
): ComparabilityResult;

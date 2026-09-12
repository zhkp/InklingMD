// 基线可比性策略（report.mjs 运行期与单测共用同一份实现）
//
// 为什么单独成模块：这段策略决定"当前采样能不能和某份基线比"，一旦判断错误，
// 产出的不是噪声而是**误导性结论**（实测过 headed 采样与 headless 基线相比得出
// -49.4% 的"改善"，纯粹是 vsync 地板差 16.7ms vs 8.4ms；反向组合会造 +100% 假回归）。
// 放在 .mjs 里是为了 report.mjs 能直接 import；同目录的 comparability.d.mts 提供类型，
// 于是 tsc 与 vitest 都能直接测试这份线上实现，而不是测试它的副本。

/**
 * 旧基线（本次改动前生成）没有 mode 字段时的回退值。
 * 已存在的基线全部由 headless 运行产出（本地默认 headless，CI 无 GPU 也必然 headless），
 * 因此按 headless 兼容在语义上是正确的，不必强制重建基线。
 */
export const MODE_FALLBACK = "headless";

/**
 * 旧基线没有 rounds 字段时的回退值。
 * 本 PR 之前 quick 档的采样轮数是 1，因此按 1 兼容在语义上正确。
 * 注意这与当前 quick=2 不一致 → 旧基线会被判不可比，需要重建（这是有意的：
 * 1 轮的标量只有一个样本、2 轮是两个样本，中位数与噪声水平都不同，不能混比）。
 */
export const ROUNDS_FALLBACK = 1;

/**
 * 判断当前采样与基线是否可比。
 * 四个维度任一不一致都不可比——它们的物理含义不同，混比得到的差值不是性能变化：
 * - env：本地 vs CI（dev server 与 runner 差异）
 * - profile：quick 1 轮 vs full 3 轮（样本量不同，中位数不可比）
 * - mode：headless（vsync 锁 60Hz）vs headed/uncapped（帧间隔反映显示器节拍或单帧工作耗时）
 * - fixture：内容变了，测量的对象就不是同一个
 */
export function baselineComparability(raw, baseline) {
  if (!baseline) return { ok: false, reason: "NEW" };

  if (baseline.env !== raw.env) {
    return {
      ok: false,
      reason: `ENV_MISMATCH(baseline=${baseline.env}, now=${raw.env})`,
    };
  }

  if (baseline.profile !== raw.profile) {
    return {
      ok: false,
      reason: `PROFILE_MISMATCH(baseline=${baseline.profile}, now=${raw.profile})`,
    };
  }

  const baseMode = baseline.mode ?? MODE_FALLBACK;
  const curMode = raw.mode ?? MODE_FALLBACK;
  if (baseMode !== curMode) {
    return {
      ok: false,
      reason: `MODE_MISMATCH(baseline=${baseMode}, now=${curMode})`,
    };
  }

  const baseRounds = baseline.rounds ?? ROUNDS_FALLBACK;
  const curRounds = raw.rounds ?? ROUNDS_FALLBACK;
  if (baseRounds !== curRounds) {
    return {
      ok: false,
      reason: `ROUNDS_MISMATCH(baseline=${baseRounds}, now=${curRounds})`,
    };
  }

  const baselineFixture = baseline.fixture;
  if (
    !baselineFixture ||
    baselineFixture.version !== raw.fixture.version ||
    baselineFixture.hash !== raw.fixture.hash
  ) {
    return { ok: false, reason: "FIXTURE_CHANGED" };
  }

  return { ok: true, reason: "OK" };
}

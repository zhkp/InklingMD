// 判定策略测试（issue #216 第三轮）
//
// 背景：这些阈值是拿真实 CI 采样标定出来的——同一份代码在共享 runner 上，
// longTaskMs 能自然波动 +25%~+36%（绝对值 +34ms~+329ms）。若只看默认 15%，
// 每次 CI 都会产出若干"回归"，而它们既无代码变更也无主指标佐证。
//
// 这里把标定值与分层规则锁死：改阈值必须同步改测试，避免悄悄放宽判定。

import { describe, expect, it } from "vitest";
import {
  baseMetric,
  DEFAULT_PCT,
  isOver,
  isPrimary,
  median,
  METRIC_RULES,
  NOISE_MIN_POINTS,
  NOISE_SIGMA,
  noiseFor,
  noiseThreshold,
  P95_EXTRA_PCT,
  referenceValue,
  requiresPrimaryCorroboration,
  ruleFor,
  sampleSd,
  suppressionReason,
} from "../perf/judgment.js";

describe("阈值规则解析", () => {
  it("未登记指标用默认 15%；p95 行在基础值上放宽 10 个百分点", () => {
    expect(ruleFor("ttiMs").pct).toBe(DEFAULT_PCT);
    expect(ruleFor("ttiMs.p95").pct).toBe(DEFAULT_PCT + P95_EXTRA_PCT);
    expect(ruleFor("switchMs.p95").pct).toBe(25);
  });

  it("已登记指标返回自身规则，绝对值类指标用 abs", () => {
    expect(ruleFor("longTaskMs")).toEqual({ pct: 50, absMin: 100 });
    expect(ruleFor("longTaskCount")).toEqual({ pct: 20, absMin: 5 });
    expect(ruleFor("cls")).toEqual({ abs: 0.02 });
  });

  it("基础指标名解析（.p95 行的分层与规则都继承基础指标）", () => {
    expect(baseMetric("frameMs.p95")).toBe("frameMs");
    expect(baseMetric("frameMs")).toBe("frameMs");
  });
});

describe("单指标超阈值判定", () => {
  it("基数为 0 时百分比无意义，退化为绝对增量门槛", () => {
    // jankRatePct 的 absMin=5
    expect(isOver("jankRatePct", 4, 0)).toBe(false);
    expect(isOver("jankRatePct", 12, 0)).toBe(true);
  });

  it("同时带 pct 与 absMin 时必须两者都成立", () => {
    // 20 → 25：+25% 未到 50%
    expect(isOver("jankRatePct", 25, 20)).toBe(false);
    // 20 → 40：+100% 且 +20
    expect(isOver("jankRatePct", 40, 20)).toBe(true);
  });

  it("绝对增量型指标（cls）与增量门槛型指标（longTaskCount）", () => {
    expect(isOver("cls", 0.01, 0)).toBe(false);
    expect(isOver("cls", 0.03, 0)).toBe(true);

    // longTaskCount：+1 次不判，+6 次判
    expect(isOver("longTaskCount", 2, 1)).toBe(false);
    expect(isOver("longTaskCount", 7, 1)).toBe(true);
    expect(isOver("longTaskCount", 3, 0)).toBe(false);
  });
});

describe("longTaskMs 标定值（依据真实 CI 噪声样本）", () => {
  // 同一份代码、无任何变更时实测到的 5 个样本，必须全部不判超阈值
  const noiseSamples: Array<[string, number, number]> = [
    ["open-S-plain", 170, 136],
    ["open-M-plain", 478, 402],
    ["tab-switch-S-rich", 488, 419],
    ["tab-switch-M-rich", 2213, 1884],
    ["open-S-rich", 308, 227],
  ];

  it.each(noiseSamples)("%s：%d vs 基线 %d 不判超阈值", (_name, cur, base) => {
    expect(isOver("longTaskMs", cur, base)).toBe(false);
  });

  it("真正的成倍恶化仍然判超阈值", () => {
    expect(isOver("longTaskMs", 250, 136)).toBe(true); // +83.8%、+114ms
    expect(isOver("longTaskMs", 500, 227)).toBe(true); // +120.3%、+273ms
  });

  it("只有绝对增量达标但涨幅不足时不判（避免大基数误判）", () => {
    // tab-switch-M-rich 的量级：+200ms 但仅 +10.6%
    expect(isOver("longTaskMs", 2084, 1884)).toBe(false);
  });
});

describe("小量级主指标的绝对地板（依据同代码重复实测）", () => {
  it("inputSyncMs：CI 曾因 Δ0.3ms 开出假 FAIL，地板 1ms 应拦住", () => {
    // 同代码实测中位数：本机 1.5/1.6/2.0，CI 1.9/2.2/2.5
    expect(isOver("inputSyncMs", 2.2, 1.9)).toBe(false); // +15.8%、Δ0.3ms ← 真实发生过的假 FAIL
    expect(isOver("inputSyncMs", 2.5, 1.9)).toBe(false); // +31.6%、Δ0.6ms
    expect(isOver("inputSyncMs", 2.0, 1.5)).toBe(false); // +33.3%、Δ0.5ms
  });

  it("inputSyncMs：真正的同步耗时上升仍会被判超标", () => {
    expect(isOver("inputSyncMs", 3.0, 1.6)).toBe(true); // +87.5%、Δ1.4ms
    expect(isOver("inputSyncMs", 4.2, 1.9)).toBe(true); // +121%、Δ2.3ms
  });

  it("saveMs：同代码实测散布 4.6ms，地板 8ms 应拦住贴线噪声", () => {
    expect(isOver("saveMs", 38, 34)).toBe(false); // +11.8%、Δ4ms
    expect(isOver("saveMs", 38, 33.4)).toBe(false); // +13.8%、Δ4.6ms
  });

  it("saveMs：真正的恶化仍会被判超标", () => {
    expect(isOver("saveMs", 48, 34)).toBe(true); // +41.2%、Δ14ms
  });

  it(".p95 行必须继承基础指标的绝对地板（否则 2ms 量级的尾部仍被噪声顶过）", () => {
    expect(ruleFor("inputSyncMs.p95")).toEqual({ pct: 25, absMin: 1 });
    expect(isOver("inputSyncMs.p95", 2.4, 1.9)).toBe(false); // Δ0.5ms
    expect(isOver("inputSyncMs.p95", 3.4, 1.9)).toBe(true); // Δ1.5ms
  });
});

describe("指标分层与佐证要求", () => {
  it("主指标可单独判 FAIL，其 p95 行继承主指标身份", () => {
    for (const metric of ["ttiMs", "frameMs", "switchMs", "searchMs", "saveMs"]) {
      expect(isPrimary(metric)).toBe(true);
      expect(isPrimary(`${metric}.p95`)).toBe(true);
      expect(requiresPrimaryCorroboration(metric)).toBe(false);
      expect(requiresPrimaryCorroboration(`${metric}.p95`)).toBe(false);
    }
  });

  it("派生指标与未知指标都需要主指标佐证", () => {
    for (const metric of [
      "longTaskMs",
      "longTaskCount",
      "longFrameCount",
      "jankCount",
      "jankRatePct",
      "cls",
      "heapDeltaMB",
    ]) {
      expect(isPrimary(metric)).toBe(false);
      expect(requiresPrimaryCorroboration(metric)).toBe(true);
    }
    // 未登记的新指标默认纳入"需佐证"一侧（"能单独判 FAIL"需要显式登记）
    expect(requiresPrimaryCorroboration("someFutureMetric")).toBe(true);
  });

  it("绝对判定行的指标名不参与分层（由调用方按 absolute 标记豁免）", () => {
    expect(isPrimary("frameMs.p95(绝对)")).toBe(false);
  });

  it("METRIC_RULES 的键必须是已登记比较的派生标量或小量级主指标", () => {
    expect(Object.keys(METRIC_RULES).sort()).toEqual(
      [
        "cls",
        "heapDeltaMB",
        "inputSyncMs",
        "jankCount",
        "jankRatePct",
        "longFrameCount",
        "longTaskCount",
        "longTaskMs",
        "saveMs",
      ].sort(),
    );
  });
});

// ── 噪声门槛（第四轮）：用基线自身的历史散布替代手工常数 ──
//
// 依据是 5 次同代码 CI 运行的实测：inputSyncMs 的 5 次中位数是 [1.9, 1.3, 1.2, 2.2, 1.6]，
// σ=0.42 → 3σ=1.25ms；而 15% 阈值在 1.9ms 上只等于 0.29ms——之前的假 FAIL 就出在这里。

describe("统计工具", () => {
  it("median 与 sampleSd（n-1）", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(sampleSd([2, 2, 2])).toBe(0);
    expect(sampleSd([1])).toBeNull();
    expect(sampleSd([1, 3])).toBeCloseTo(1.414, 2);
  });

  it("noiseThreshold：点数不足或零方差时不启用（返回 null）", () => {
    expect(noiseThreshold(undefined)).toBeNull();
    expect(noiseThreshold([1, 2])).toBeNull(); // < NOISE_MIN_POINTS
    expect(noiseThreshold([2, 2, 2])).toBeNull(); // σ=0（量化型指标）
    // 真实 inputSyncMs 历史 → 3σ ≈ 1.25
    expect(noiseThreshold([1.9, 1.3, 1.2, 2.2, 1.6])).toBeCloseTo(1.25, 1);
    expect(NOISE_SIGMA).toBe(3);
    expect(NOISE_MIN_POINTS).toBe(3);
  });

  it("referenceValue：历史足够时用历史中位数（滚动参考），否则用点值", () => {
    const entry = { median: 1.9, history: [1.9, 1.3, 1.2, 2.2, 1.6] };
    expect(referenceValue(entry)).toBe(1.6); // 历史中位数
    expect(referenceValue({ median: 1.9, history: [1.9, 1.3] })).toBe(1.9); // 点值
    expect(referenceValue({ median: 1.9 })).toBe(1.9);
    // p95 走 historyP95
    const withP95 = { median: 2.4, historyP95: [2.4, 3.0, 2.6, 2.8, 3.1] };
    expect(referenceValue(withP95, "p95")).toBe(2.8);
    expect(noiseFor(entry)).toBeCloseTo(1.25, 1);
    expect(noiseFor({ historyP95: [2.4, 3.0, 2.6, 2.8, 3.1] }, "p95")).toBeCloseTo(
      0.81,
      1,
    );
  });
});

describe("噪声门槛对判定的作用", () => {
  const NOISE = 1.25; // inputSyncMs 的 3σ（真实历史估计）

  it("变化超过 3σ 才算超阈值", () => {
    // Δ=4.8ms > 1.25 → 超阈值
    expect(isOver("inputSyncMs", 6.4, 1.6, NOISE)).toBe(true);
  });

  it("变化在 3σ 内 → 不算超阈值（但会被标注为被抑制，而非 PASS）", () => {
    expect(isOver("inputSyncMs", 2.7, 1.6, NOISE)).toBe(false);
    expect(suppressionReason("inputSyncMs", 2.7, 1.6, NOISE)).toBe("noise");
  });

  it("未启用噪声门槛（null）时退回百分比 + 绝对地板", () => {
    expect(isOver("inputSyncMs", 6.4, 1.6, null)).toBe(true);
    expect(isOver("inputSyncMs", 2.0, 1.6, null)).toBe(false); // 地板 1ms 拦下
  });

  it("suppressionReason 区分 floor / noise / 正常 PASS", () => {
    expect(suppressionReason("inputSyncMs", 2.0, 1.6, NOISE)).toBe("floor"); // Δ0.4 < 地板 1ms
    expect(suppressionReason("inputSyncMs", 2.7, 1.6, NOISE)).toBe("noise"); // 过地板、未过 3σ
    expect(suppressionReason("inputSyncMs", 1.5, 1.6, NOISE)).toBeNull(); // 改善
    expect(suppressionReason("ttiMs", 850, 800, 241)).toBeNull(); // +6% 未过 15%
    expect(suppressionReason("longTaskCount", 3, 0, null)).toBeNull(); // 基数为 0 走绝对增量
  });
});

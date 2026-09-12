// 基线可比性策略的矩阵测试（issue #216 第二轮复审发现）
//
// 背景：`report.mjs` 原先只校验 env / profile / fixture 三个维度，而 env 只区分 local 与 ci-*，
// 于是 **headed 采样会去和 headless 基线比较**——实测得出 `frameMs 16.6 → 8.4 = -49.4%`，
// 纯属 vsync 地板差（16.7ms vs 8.4ms）；反向组合会造出 +100% 的假回归。
// 现在策略抽到 comparability.js，这里直接断言线上实现（不是它的副本）。

import { describe, expect, it } from "vitest";
import {
  baselineComparability,
  MODE_FALLBACK,
  ROUNDS_FALLBACK,
  type ComparabilityPeer,
} from "../perf/comparability.js";

const raw = (over: Partial<ComparabilityPeer> = {}): ComparabilityPeer => ({
  env: "ci-ubuntu",
  profile: "quick",
  mode: "headless",
  rounds: 2,
  fixture: { version: 2, hash: "hashabc12345" },
  ...over,
});

describe("基线可比性策略", () => {
  it("四维完全一致时可比", () => {
    const result = baselineComparability(raw(), raw());
    expect(result.ok).toBe(true);
    expect(result.reason).toBe("OK");
  });

  it("没有基线时标记为 NEW（首次运行，非错误）", () => {
    const result = baselineComparability(raw(), null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("NEW");
  });

  it("env 不同不可比（本地 vs CI 的 dev server 与 runner 差异）", () => {
    const result = baselineComparability(raw({ env: "local" }), raw());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ENV_MISMATCH");
  });

  it("profile 不同不可比（quick 1 轮 vs full 3 轮，中位数不可比）", () => {
    const result = baselineComparability(raw({ profile: "full" }), raw());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("PROFILE_MISMATCH");
  });

  it("测量模式不同不可比（headless 的 vsync 地板会伪装成大幅改善）", () => {
    const result = baselineComparability(raw({ mode: "headed" }), raw());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("MODE_MISMATCH");
    expect(result.reason).toContain("baseline=headless");
    expect(result.reason).toContain("now=headed");
  });

  it("uncapped 与 headless 同样不可比", () => {
    const result = baselineComparability(raw({ mode: "uncapped" }), raw());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("MODE_MISMATCH");
  });

  it("旧基线缺 mode 时按 headless 兼容；但当前是 headed 时仍判不可比", () => {
    const legacy = { ...raw(), mode: undefined } as ComparabilityPeer;

    // 兼容分支：旧基线（无 mode）+ 当前 headless → 可比
    expect(baselineComparability(raw(), legacy).ok).toBe(true);
    // 保护分支：旧基线 + 当前 headed → 不可比，避免拿 vsync 地板差当性能变化
    const headed = baselineComparability(raw({ mode: "headed" }), legacy);
    expect(headed.ok).toBe(false);
    expect(headed.reason).toContain("MODE_MISMATCH");
  });

  it("当前采样缺 mode 时同样按 headless 处理", () => {
    const noMode = { ...raw(), mode: undefined } as ComparabilityPeer;
    expect(baselineComparability(noMode, raw()).ok).toBe(true);
  });

  it("fixture 版本或指纹变化不可比（测的不是同一份文档）", () => {
    const versionChanged = baselineComparability(
      raw({ fixture: { version: 3, hash: "hashabc12345" } }),
      raw(),
    );
    expect(versionChanged.ok).toBe(false);
    expect(versionChanged.reason).toBe("FIXTURE_CHANGED");

    const hashChanged = baselineComparability(
      raw({ fixture: { version: 2, hash: "different000" } }),
      raw(),
    );
    expect(hashChanged.ok).toBe(false);
    expect(hashChanged.reason).toBe("FIXTURE_CHANGED");
  });

  it("旧基线缺 fixture 字段时按不可比处理（不能默认放行）", () => {
    // 只缺 fixture，其余维度一致——否则会先撞上前面的 ROUNDS_MISMATCH 分支
    const broken = {
      env: "ci-ubuntu",
      profile: "quick",
      mode: "headless",
      rounds: 2,
    } as ComparabilityPeer;
    const result = baselineComparability(raw(), broken);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FIXTURE_CHANGED");
  });

  it("采样轮数不同不可比（1 轮的标量只有 1 个样本，噪声水平与 2 轮不同）", () => {
    const result = baselineComparability(raw({ rounds: 3 }), raw());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ROUNDS_MISMATCH");
    expect(result.reason).toContain("baseline=2");
    expect(result.reason).toContain("now=3");
  });

  it("旧基线缺 rounds 时按 1 兼容——与当前 quick=2 不匹配，从而强制重建基线", () => {
    const legacy = { ...raw(), rounds: undefined } as ComparabilityPeer;
    const result = baselineComparability(raw(), legacy);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ROUNDS_MISMATCH");
    expect(result.reason).toContain("baseline=1");
    // 当前采样同样缺 rounds 时按 1 处理 → 与旧基线（1 轮）可比
    const noRounds = { ...raw(), rounds: undefined } as ComparabilityPeer;
    expect(baselineComparability(noRounds, legacy).ok).toBe(true);
  });

  it("兼容回退值固定为 headless 与 1 轮（已存在的基线都是该组合产出的）", () => {
    expect(MODE_FALLBACK).toBe("headless");
    expect(ROUNDS_FALLBACK).toBe(1);
  });
});

// 单测超时按档位的单测（issue #247）
//
// 背景：最重的 L 档（2 万行）在 CI 的 wall 实测 114–174s、中位 ≈138s，紧贴 config 里的
// 全局 180s 线——慢会话会周期性穿线，而单场景超时会把整轮判定作废。修复方向是
// 用 `testTimeoutMs(tier)` 按档位放宽，S/M 维持现状，XL / 自定义档给足余量。
// 这里把档位→超时矩阵与 env 覆盖锁死，防止文案/常量再漂移。

import { afterEach, describe, expect, it } from "vitest";
import { testTimeoutMs } from "../perf/runner";

const ORIGINAL = process.env.PERF_TEST_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PERF_TEST_TIMEOUT_MS;
  else process.env.PERF_TEST_TIMEOUT_MS = ORIGINAL;
});

describe("testTimeoutMs（#247：单测超时按档位）", () => {
  it("档位→超时矩阵：S/M 180s、L 300s、XL / 自定义档(C) 600s", () => {
    delete process.env.PERF_TEST_TIMEOUT_MS;
    expect(testTimeoutMs("S")).toBe(180_000);
    expect(testTimeoutMs("M")).toBe(180_000);
    expect(testTimeoutMs("L")).toBe(300_000);
    expect(testTimeoutMs("XL")).toBe(600_000);
    expect(testTimeoutMs("C")).toBe(600_000);
  });

  it("未知档位回退 180s（与 config 全局兜底同值）", () => {
    delete process.env.PERF_TEST_TIMEOUT_MS;
    expect(testTimeoutMs("")).toBe(180_000);
    expect(testTimeoutMs("ZZ")).toBe(180_000);
  });

  it("PERF_TEST_TIMEOUT_MS 覆盖所有档位（含未知档）", () => {
    process.env.PERF_TEST_TIMEOUT_MS = "90000";
    for (const tier of ["S", "M", "L", "XL", "C", "ZZ", ""]) {
      expect(testTimeoutMs(tier)).toBe(90_000);
    }
  });

  it("非法值（非数字 / 0 / 负数）忽略，回退到档位线", () => {
    for (const bad of ["abc", "0", "-1", ""]) {
      process.env.PERF_TEST_TIMEOUT_MS = bad;
      expect(testTimeoutMs("L")).toBe(300_000);
      expect(testTimeoutMs("S")).toBe(180_000);
    }
  });
});
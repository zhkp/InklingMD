// 绝对阈值判定资格的策略测试（issue #216 复审发现）
//
// 背景：report.mjs 原先用 `PERF_ABSOLUTE !== "0"` 决定是否产出绝对判定——默认开启、
// 与运行模式无关。而绝对判定只在 uncapped / headed 下才有意义（headless 被 vsync 锁 60Hz，
// 帧间隔反映显示器节拍而非单帧工作耗时）。后果是 headless 的首次运行（无 baseline、无代码变更）
// 也会因 jankRate 贴线而打印「回归确认」+ exit 1，与真实回归在退出码层面无法区分。
//
// 修复后策略集中在 runner.absoluteEligible()，并被写入 raw 采样，因此这里必须锁死矩阵。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { absoluteEligible, detectMode } from "../perf/runner";

const KEYS = ["PERF_HEADED", "PERF_UNCAPPED", "PERF_ABSOLUTE"] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("测量模式识别", () => {
  it("默认 headless；PERF_HEADED=1 → headed；PERF_UNCAPPED=1 → uncapped", () => {
    expect(detectMode()).toBe("headless");

    process.env.PERF_HEADED = "1";
    expect(detectMode()).toBe("headed");

    process.env.PERF_UNCAPPED = "1";
    // 同时设置时 uncapped 语义更强（帧间隔反映单帧真实工作耗时），优先识别
    expect(detectMode()).toBe("uncapped");
  });
});

describe("绝对判定资格", () => {
  it("headless 默认不产出绝对判定（否则首次运行就会误报回归）", () => {
    expect(absoluteEligible()).toBe(false);
  });

  it("headed / uncapped 默认产出绝对判定", () => {
    process.env.PERF_HEADED = "1";
    expect(absoluteEligible()).toBe(true);

    delete process.env.PERF_HEADED;
    process.env.PERF_UNCAPPED = "1";
    expect(absoluteEligible()).toBe(true);
  });

  it("PERF_ABSOLUTE=1 可在 headless 下强制开启（复现/调试用）", () => {
    process.env.PERF_ABSOLUTE = "1";
    expect(absoluteEligible()).toBe(true);
  });

  it("PERF_ABSOLUTE=0 可在 headed 下强制关闭", () => {
    process.env.PERF_HEADED = "1";
    process.env.PERF_ABSOLUTE = "0";
    expect(absoluteEligible()).toBe(false);
  });

  it("空字符串视为未设置（工作流用空值表示『不覆盖默认策略』）", () => {
    process.env.PERF_ABSOLUTE = "";
    expect(absoluteEligible()).toBe(false);

    process.env.PERF_HEADED = "1";
    expect(absoluteEligible()).toBe(true);
  });
});

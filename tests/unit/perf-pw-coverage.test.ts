// playwright 报告覆盖核算的单测（issue #247）
//
// 背景：单场景超时会让 playwright 整轮退出非 0，旧行为把整轮按 infra 故障作废。
// 方向 2 需要从 playwright json 报告里算出「应测但没落盘 raw」的场景，把它们单列于报告。
// 报告的 suites 可嵌套、spec 的 tests/results 可能缺失、skipped 是复测过滤的合法跳过，
// 这些边界一旦读错就会误报/漏报，所以在这里逐条锁死。

import { describe, expect, it } from "vitest";
import {
  expectedScenarioIds,
  parseScenarioId,
  unmeasuredScenarios,
} from "../perf/pw-coverage.js";

/** 构造一个 spec 节点（status 省略时模拟 tests/results 缺失的畸形形状） */
function spec(title: string, status?: string): Record<string, unknown> {
  if (status === undefined) return { title };
  return { title, tests: [{ results: [{ status }] }] };
}

describe("expectedScenarioIds（#247）", () => {
  it("递归展开嵌套 suites，收集 id + status", () => {
    const report = {
      suites: [
        {
          title: "root",
          specs: [spec("open-S-rich", "passed")],
          suites: [
            {
              title: "nested",
              specs: [spec("scroll-M-rich", "failed"), spec("tab-switch-L-plain", "timedOut")],
              suites: [{ title: "deep", specs: [spec("save-S-rich", "passed")] }],
            },
          ],
        },
      ],
    };

    expect(expectedScenarioIds(report)).toEqual([
      { id: "open-S-rich", status: "passed" },
      { id: "scroll-M-rich", status: "failed" },
      { id: "tab-switch-L-plain", status: "timedOut" },
      { id: "save-S-rich", status: "passed" },
    ]);
  });

  it("五类 status：skipped 排除（复测过滤是合法跳过），其余保留", () => {
    const report = {
      suites: [
        {
          title: "root",
          specs: [
            spec("a-S-rich", "passed"),
            spec("b-S-rich", "failed"),
            spec("c-S-rich", "timedOut"),
            spec("d-S-rich", "interrupted"),
            spec("e-S-rich", "skipped"),
          ],
        },
      ],
    };

    expect(expectedScenarioIds(report).map((s) => s.id)).toEqual([
      "a-S-rich",
      "b-S-rich",
      "c-S-rich",
      "d-S-rich",
    ]);
  });

  it("缺 tests / results 时兜底 interrupted（按「没跑完」处理，不当作不存在）", () => {
    const report = { suites: [{ title: "root", specs: [spec("open-S-rich"), spec("input-S-rich")] }] };

    expect(expectedScenarioIds(report)).toEqual([
      { id: "open-S-rich", status: "interrupted" },
      { id: "input-S-rich", status: "interrupted" },
    ]);
  });

  it("畸形 / 缺失报告一律返回 []，绝不抛异常", () => {
    expect(expectedScenarioIds(null)).toEqual([]);
    expect(expectedScenarioIds(undefined)).toEqual([]);
    expect(expectedScenarioIds({})).toEqual([]);
    expect(expectedScenarioIds({ suites: "nope" })).toEqual([]);
    expect(expectedScenarioIds({ suites: [null, 42, {}, { specs: [null, { title: "" }] }] })).toEqual([]);
  });
});

describe("unmeasuredScenarios（#247）", () => {
  it("差集：应测但 raw 里没有落盘的场景（保留 status 供归因）", () => {
    const expected = [
      { id: "open-S-rich", status: "passed" },
      { id: "input-L-rich", status: "timedOut" },
      { id: "scroll-M-rich", status: "passed" },
    ];

    expect(unmeasuredScenarios(expected, ["open-S-rich", "scroll-M-rich"])).toEqual([
      { id: "input-L-rich", status: "timedOut" },
    ]);
  });

  it("全部落盘 → 空数组；非数组输入不炸", () => {
    const expected = [{ id: "open-S-rich", status: "passed" }];
    expect(unmeasuredScenarios(expected, ["open-S-rich"])).toEqual([]);
    expect(unmeasuredScenarios(null, null)).toEqual([]);
    expect(unmeasuredScenarios(expected, undefined)).toEqual(expected);
  });
});

describe("parseScenarioId（#247）", () => {
  it("从尾部解析 scenario / tier / kind，兼容含连字符的场景名", () => {
    expect(parseScenarioId("tab-switch-M-rich")).toEqual({
      scenario: "tab-switch",
      tier: "M",
      kind: "rich",
    });
    expect(parseScenarioId("open-S-rich")).toEqual({ scenario: "open", tier: "S", kind: "rich" });
    expect(parseScenarioId("scroll-XL-plain")).toEqual({
      scenario: "scroll",
      tier: "XL",
      kind: "plain",
    });
  });

  it("非法输入返回 null（不足三段 / 非字符串 / 空段）", () => {
    expect(parseScenarioId("open")).toBeNull();
    expect(parseScenarioId("open-S")).toBeNull();
    expect(parseScenarioId("")).toBeNull();
    expect(parseScenarioId(null)).toBeNull();
    expect(parseScenarioId(42)).toBeNull();
  });
});
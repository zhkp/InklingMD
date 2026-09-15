// 会话标定负载的单元测试（issue #236）
//
// 标定负载是"与编辑器代码无关的固定工作量"，用来把「机器慢」从「代码回归」里分开。
// 这里锁死采集器的语义（多轮取中位数、未采集时**不伪造 0**），因为它的输出会进基线、
// 参与"环境异常"判定——伪造 0 会让一次没测到的运行看起来像"机器变快了"。

import { describe, expect, it } from "vitest";
import { createSessionProbe, PROBE_LOOP_ITERS, PROBE_NODES } from "../perf/metrics.js";

/** 假页面：每次 evaluate 依次返回给定的标定结果 */
function fakePage(results: Array<{ layoutMs: number; cpuMs: number }>) {
  let i = 0;
  return {
    calls: () => i,
    evaluate: async () => results[Math.min(i++, results.length - 1)],
  };
}

describe("会话标定采集器（#236）", () => {
  it("多轮取中位数成标量：probeMs = 中位布局 + 中位 CPU", async () => {
    const probe = createSessionProbe();
    const page = fakePage([
      { layoutMs: 10, cpuMs: 100 },
      { layoutMs: 30, cpuMs: 300 },
      { layoutMs: 20, cpuMs: 200 },
    ]);
    await probe.measure(page);
    await probe.measure(page);
    await probe.measure(page);

    expect(page.calls()).toBe(3);
    expect(probe.scalars()).toEqual({
      probeLayoutMs: 20,
      probeCpuMs: 200,
      probeMs: 220,
    });
  });

  it("一次都没测到时返回空对象，不伪造 0（否则会伪装成「机器变快了」）", () => {
    const probe = createSessionProbe();
    expect(probe.scalars()).toEqual({});
  });

  it("标定工作量是写死的常量（可变的话标定值本身就不可比）", () => {
    expect(PROBE_NODES).toBe(1500);
    expect(PROBE_LOOP_ITERS).toBe(20_000_000);
  });
});

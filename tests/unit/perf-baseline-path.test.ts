// 基线路径的环境隔离（#420）
//
// 首版实现只对 `local` 加前缀，`prod-local` 被当成 CI 默认环境、落进
// `.perf-baseline/quick/headless/r2/` —— 实测把 dev 的 CI 基线覆盖了一次。
// 这组断言就是防它回归的：新环境必须有自己的目录。
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { baselinePath, envDirPrefix } from "../perf/baseline-path.mjs";

const BASE = resolve(".perf-baseline");

describe("envDirPrefix", () => {
  it("local 走独立目录，CI 默认环境沿用历史布局（无前缀）", () => {
    expect(envDirPrefix("local")).toBe("local/");
    expect(envDirPrefix("ci-ubuntu")).toBe("");
    expect(envDirPrefix("ci-windows")).toBe("");
  });

  it("prod-* 等新环境必须有自己的命名空间，不能落到 CI 共享目录", () => {
    expect(envDirPrefix("prod-local")).toBe("prod-local/");
    expect(envDirPrefix("prod-ci-ubuntu")).toBe("prod-ci-ubuntu/");
  });
});

describe("baselinePath", () => {
  it("dev CI 基线与 prod CI 基线不在同一目录", () => {
    const dev = baselinePath(BASE, "ci-ubuntu", "quick", "input-source-M-rich", "headless", 2);
    const prod = baselinePath(BASE, "prod-ci-ubuntu", "quick", "input-source-M-rich", "headless", 2);
    expect(dev).toBe(
      join(BASE, "quick", "headless", "r2", "input-source-M-rich.json"),
    );
    expect(prod).toBe(
      join(BASE, "prod-ci-ubuntu", "quick", "headless", "r2", "input-source-M-rich.json"),
    );
    expect(dev).not.toBe(prod);
  });

  it("本机两种口径同样互不覆盖（local/ vs prod-local/）", () => {
    const dev = baselinePath(BASE, "local", "quick", "open-S-rich", "headless", 2);
    const prod = baselinePath(BASE, "prod-local", "quick", "open-S-rich", "headless", 2);
    expect(dev).toBe(join(BASE, "local", "quick", "headless", "r2", "open-S-rich.json"));
    expect(prod).toBe(join(BASE, "prod-local", "quick", "headless", "r2", "open-S-rich.json"));
  });

  it("mode / rounds 缺省时回落到 comparability 的同一缺省值", () => {
    // comparability.js: MODE_FALLBACK=headless、ROUNDS_FALLBACK=1
    const p = baselinePath(BASE, "ci-ubuntu", "full", "id", undefined, undefined);
    expect(p).toBe(join(BASE, "full", "headless", "r1", "id.json"));
  });
});

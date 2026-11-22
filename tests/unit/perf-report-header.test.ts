// 报告头部的运行时描述（#421 评审 4）
//
// prod 通道跑的是 `vite build` 产物 + `vite preview`；若头部仍写「vite dev server /
// 绝对值不代表生产构建」，读者会得出与通道目的相反的结论。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEV_RUNTIME_LINE,
  PROD_RUNTIME_LINE,
  runtimeDescription,
} from "../perf/report-header.mjs";

describe("runtimeDescription", () => {
  it("prod-* 环境声明生产构建，且不再自称 dev server", () => {
    for (const env of ["prod-local", "prod-ci-ubuntu", "prod-ci-windows"]) {
      const line = runtimeDescription(env);
      expect(line).toBe(PROD_RUNTIME_LINE);
      expect(line).toContain("生产构建");
      expect(line).not.toContain("vite dev server");
      expect(line).not.toContain("绝对值不代表生产构建");
    }
  });

  it("dev 口径（local / ci-*）保持原声明", () => {
    for (const env of ["local", "ci-ubuntu", "ci-windows"]) {
      expect(runtimeDescription(env)).toBe(DEV_RUNTIME_LINE);
      expect(DEV_RUNTIME_LINE).toContain("vite dev server");
    }
  });

  it("report.mjs 头部确实用了这个函数（不是仍有第二份写死的声明）", () => {
    const src = readFileSync("tests/perf/report.mjs", "utf8");
    expect(src).toContain("runtimeDescription(payload.env)");
    // 写死的 dev 声明只允许出现在 report-header.mjs 里
    expect(src).not.toContain("Playwright chromium + vite dev server");
  });
});

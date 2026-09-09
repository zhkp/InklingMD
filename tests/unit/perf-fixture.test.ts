// Benchmark fixture 生成器的确定性契约测试（issue #216）
//
// 为什么放在 tests/unit 而不是 tests/perf：
// vitest.config.ts 已把 tests/perf/** 排除（perf 走独立 Playwright 配置与 npm run benchmark），
// 放进 tests/perf 的用例不会被门禁跑到。fixture 的确定性是 baseline 比较成立的前提，
// 必须有真实断言锁定，因此单测放在 tests/unit 下。

import { describe, expect, it } from "vitest";
import {
  buildFixture,
  countLines,
  fixtureHash,
  FIXTURE_VERSION,
} from "../perf/fixtures";

describe("perf fixture 生成器", () => {
  it("同参数两次生成字节级一致（baseline 比较成立的前提）", () => {
    const a = buildFixture({ lines: 1000, kind: "rich" });
    const b = buildFixture({ lines: 1000, kind: "rich" });
    expect(a).toBe(b);
    expect(fixtureHash(a)).toBe(fixtureHash(b));
  });

  it("不同档位 / 不同类型的指纹互不相同", () => {
    const hashes = new Set([
      fixtureHash(buildFixture({ lines: 1000, kind: "rich" })),
      fixtureHash(buildFixture({ lines: 5000, kind: "rich" })),
      fixtureHash(buildFixture({ lines: 20000, kind: "rich" })),
      fixtureHash(buildFixture({ lines: 1000, kind: "plain" })),
    ]);
    expect(hashes.size).toBe(4);
  });

  it("生成结果的行数严格等于请求行数（含奇数行与超大档）", () => {
    // 1001 是奇数：用于验证「不足一节用段落补齐」的分支不会多/少一行
    for (const lines of [1, 27, 1001, 1000, 5000, 20000]) {
      expect(countLines(buildFixture({ lines, kind: "rich" }))).toBe(lines);
      expect(countLines(buildFixture({ lines, kind: "plain" }))).toBe(lines);
    }
  });

  it("rich 档覆盖设计要求的 9 类结构标记", () => {
    const doc = buildFixture({ lines: 2000, kind: "rich" });
    const required: Array<[string, string]> = [
      ["标题", "## 基准章节"],
      ["加粗", "**加粗**"],
      ["斜体", "*斜体*"],
      ["删除线", "~~删除线~~"],
      ["行内代码", "`行内代码`"],
      ["链接", "[链接](https://"],
      ["无序列表", "- 无序列表项"],
      ["嵌套列表", "  - 嵌套列表项"],
      ["有序列表", "1. 有序列表项"],
      ["引用", "> 引用块"],
      ["表格", "| --- | --- |"],
      ["代码块", "```ts"],
      ["图片占位", "![图片占位]("],
      ["行内公式", "$E = mc^2$"],
      ["块级公式", "$$"],
    ];
    for (const [name, needle] of required) {
      expect(doc.includes(needle), `rich 档缺少${name}`).toBe(true);
    }
  });

  it("plain 档不含结构标记，保证「长度 vs 复杂度」对照有效", () => {
    const doc = buildFixture({ lines: 2000, kind: "plain" });
    for (const needle of ["## ", "```", "| ---", "> 引用", "- 无序", "![", "]("]) {
      expect(doc.includes(needle), `plain 档不应包含 ${needle}`).toBe(false);
    }
  });

  it("指纹为 sha256 前 12 位十六进制", () => {
    const hash = fixtureHash(buildFixture({ lines: 100, kind: "rich" }));
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("FIXTURE_VERSION 为正整数（baseline 失效判定依赖它）", () => {
    expect(Number.isInteger(FIXTURE_VERSION)).toBe(true);
    expect(FIXTURE_VERSION).toBeGreaterThan(0);
  });
});

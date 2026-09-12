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
import { pickSearchKeyword } from "../perf/runner";

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

  it("rich 档覆盖设计要求的结构标记（含 mermaid 与真实图片）", () => {
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
      ["行内公式", "$E = mc^2$"],
      ["块级公式", "$$"],
    ];
    for (const [name, needle] of required) {
      expect(doc.includes(needle), `rich 档缺少${name}`).toBe(true);
    }
    // 评审 P1-2：mermaid 是本项目最重的渲染元素，缺失会导致压测负载失真
    expect(doc.includes("```mermaid"), "rich 档缺少 mermaid 块").toBe(true);
    expect(doc.includes("flowchart TD"), "mermaid 块缺少图形定义").toBe(true);
  });

  it("rich 档图片必须是可解码的 data URI，而不是必然 404 的相对路径", () => {
    const doc = buildFixture({ lines: 2000, kind: "rich" });
    const match = /\]\((data:image\/png;base64,[A-Za-z0-9+/=]+)\)/.exec(doc);
    expect(match, "未找到 data URI 图片").not.toBeNull();

    // 真实解码校验：base64 还原后必须是合法 PNG 签名，
    // 否则"图片进入了测量"这件事只是字符串层面的假象
    const bytes = Buffer.from(match![1].split(",")[1], "base64");
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.length).toBeGreaterThan(100);
    // PNG 的 IHDR 里应能读出真实尺寸（256x192），证明确实有可布局的图片
    expect(bytes.readUInt32BE(16)).toBe(256);
    expect(bytes.readUInt32BE(20)).toBe(192);

    // v1 的相对路径已废弃：mock 环境必然 404，等于没测图片
    expect(doc.includes("](assets/bench-"), "仍在使用必然 404 的相对路径").toBe(false);
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

  it("FIXTURE_VERSION 已升到 v2（内容变更必须作废旧 baseline）", () => {
    expect(Number.isInteger(FIXTURE_VERSION)).toBe(true);
    expect(FIXTURE_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("search 场景关键词推导（自定义文档支持）", () => {
  it("生成 fixture 一律用 bench- 编号（命中数可观，可量测）", () => {
    const doc = buildFixture({ lines: 1000, kind: "rich" });
    expect(pickSearchKeyword(doc)).toBe("bench-");
  });

  it("自定义文档：不取 YAML frontmatter 里的词（渲染后不参与搜索）", () => {
    const doc = [
      "---",
      "title: Markdown编辑器性能测试文档",
      "author: 测试工程师",
      "---",
      "",
      "# 正文标题在这里",
      "正文内容。",
    ].join("\n");
    const keyword = pickSearchKeyword(doc);
    expect(keyword).not.toContain("title");
    expect(doc.includes(keyword)).toBe(true);
    // 且必须来自 frontmatter 之后的正文
    expect(doc.indexOf(keyword)).toBeGreaterThan(doc.lastIndexOf("---"));
  });

  it("自定义文档：关键词必须真实存在于文档中（否则搜索场景会 0 命中超时）", () => {
    const doc = "# 性能压测\n\n普通段落，没有编号也没有特殊标记。\n";
    const keyword = pickSearchKeyword(doc);
    expect(keyword.length).toBeGreaterThanOrEqual(4);
    expect(doc.includes(keyword)).toBe(true);
  });

  it("极端文档：无长文本行时仍有可用关键词", () => {
    expect(pickSearchKeyword("a\nb\nc\n").length).toBeGreaterThan(0);
  });
});

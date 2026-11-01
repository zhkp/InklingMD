// 换行风格检测与还原单测（issue #368）
//
// 覆盖对象：src/lib/eol.ts 的 detectEol / applyEol。
// 语义锁定：
// - detectEol：CRLF / LF / 混合 / 孤立 CR / 空文件 / 无换行 / 数量持平 /
//   末尾换行状态；
// - applyEol：LF ↔ CRLF 互转、只动换行符不动正文、孤立 CR 归一、null 直通、
//   末尾换行保持（原文件无末尾换行时只去掉序列化器补的那一个 \n）。

import { describe, expect, it } from "vitest";
import { applyEol, detectEol } from "../../src/lib/eol";

describe("detectEol", () => {
  it("纯 CRLF → eol=crlf，非混合，有末尾换行", () => {
    expect(detectEol("# 标题\r\n\r\n正文段落。\r\n")).toEqual({
      eol: "crlf",
      mixed: false,
      finalNewline: true,
    });
  });

  it("纯 LF → eol=lf，非混合，有末尾换行", () => {
    expect(detectEol("# 标题\n\n正文段落。\n")).toEqual({
      eol: "lf",
      mixed: false,
      finalNewline: true,
    });
  });

  it("混合（CRLF 多 LF 少）→ 主导 crlf，mixed=true", () => {
    expect(detectEol("a\r\nb\r\nc\n")).toEqual({
      eol: "crlf",
      mixed: true,
      finalNewline: true,
    });
  });

  it("混合（LF 多 CRLF 少）→ 主导 lf，mixed=true", () => {
    expect(detectEol("a\nb\nc\r\n")).toEqual({
      eol: "lf",
      mixed: true,
      finalNewline: true,
    });
  });

  it("孤立 CR（经典 Mac）并入 lf 侧并计为混合", () => {
    expect(detectEol("a\rb\rc\r\n")).toEqual({ eol: "lf", mixed: true, finalNewline: true });
    expect(detectEol("a\rb\rc")).toEqual({ eol: "lf", mixed: false, finalNewline: false });
  });

  it("空文件与无换行文件 → eol=null，无末尾换行", () => {
    expect(detectEol("")).toEqual({ eol: null, mixed: false, finalNewline: false });
    expect(detectEol("单行无换行")).toEqual({ eol: null, mixed: false, finalNewline: false });
  });

  it("CRLF 与 LF 数量持平时取 crlf（确定性口径，无平台倾向）", () => {
    expect(detectEol("a\r\nb\n")).toEqual({ eol: "crlf", mixed: true, finalNewline: true });
  });

  it("末尾换行状态：末行无换行 → finalNewline=false（CRLF / LF 两侧都要识别）", () => {
    expect(detectEol("a\r\nb").finalNewline).toBe(false);
    expect(detectEol("a\nb").finalNewline).toBe(false);
    expect(detectEol("a\r\nb\r\n").finalNewline).toBe(true);
    expect(detectEol("a\nb\n").finalNewline).toBe(true);
  });
});

describe("applyEol", () => {
  it("目标 crlf：LF 内容转为 CRLF，正文逐字不变", () => {
    const content = "# 标题\n\n正文 **加粗** 段落。\n第二行带 空白\t制表。\n";
    const out = applyEol(content, "crlf");
    expect(out).toBe("# 标题\r\n\r\n正文 **加粗** 段落。\r\n第二行带 空白\t制表。\r\n");
    // 只动换行符：剥掉 CR 后与原文逐字节一致
    expect(out.replace(/\r/g, "")).toBe(content);
  });

  it("目标 lf：残留 CRLF / 孤立 CR 归一为 LF", () => {
    expect(applyEol("a\r\nb\rc\nd", "lf")).toBe("a\nb\nc\nd");
  });

  it("目标 crlf：输入残留 CRLF 时先归一再转换，不产生 \r\r\n", () => {
    expect(applyEol("a\r\nb\n", "crlf")).toBe("a\r\nb\r\n");
    expect(applyEol("a\r\nb\n", "crlf")).not.toContain("\r\r");
  });

  it("eol=null（无换行文件 / 新建文件）：不做 CRLF 转换", () => {
    expect(applyEol("hello\nworld\n", null)).toBe("hello\nworld\n");
    expect(applyEol("", null)).toBe("");
  });

  it("末尾换行保持：原文件无末尾换行时去掉序列化器补的那一个 \\n", () => {
    // CRLF 文件末行无换行：序列化结果 "a\nb\n" → 写盘应为 "a\r\nb"（无末尾换行）
    expect(applyEol("a\nb\n", "crlf", false)).toBe("a\r\nb");
    expect(applyEol("a\nb\n", "lf", false)).toBe("a\nb");
    // 原文件有末尾换行：保持不变
    expect(applyEol("a\nb\n", "crlf", true)).toBe("a\r\nb\r\n");
  });

  it("末尾换行保持只去掉一个 \\n：用户额外输入的末尾空行保留", () => {
    // 用户在文末新增空段落 → 序列化 "a\n\n"；原文件无末尾换行时去掉一个 → "a\n"
    expect(applyEol("a\n\n", "lf", false)).toBe("a\n");
    expect(applyEol("a\n\n\n", "lf", false)).toBe("a\n\n");
  });

  it("无换行文件（eol=null）同样遵循末尾换行保持", () => {
    // 单行无换行文件：序列化 "hello\n" → 写盘应为 "hello"
    expect(applyEol("hello\n", null, false)).toBe("hello");
    expect(applyEol("hello\n", null, true)).toBe("hello\n");
  });

  it("往返幂等：CRLF 归一 LF 再还原 CRLF，内容逐字节稳定", () => {
    const original = "第一段。\r\n\r\n# 标题\r\n- 列表项\r\n";
    const lf = applyEol(original, "lf");
    expect(lf).toBe("第一段。\n\n# 标题\n- 列表项\n");
    const back = applyEol(lf, "crlf");
    expect(back).toBe(original);
  });

  it("末行无换行的 CRLF 文件往返：编辑后仍无末尾换行", () => {
    const original = "a\r\nb"; // 无末尾换行
    const lf = applyEol(original, "lf", false);
    expect(lf).toBe("a\nb");
    expect(applyEol(lf, "crlf", false)).toBe(original);
  });
});

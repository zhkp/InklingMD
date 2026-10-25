// #362 M0：read_document / file_stat 的前端封装契约
//
// 断言的是"一次读取只产生一个不可分割的 pair"这条硬约束：
// 内容与 stat 必须来自同一次 IPC；changedDuringRead 只重试一次，
// 重试仍失败就按读取失败上报——绝不把可疑 pair 交给调用方当基线。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import { CmdError, fileStat, formatCmdError, readDocument } from "../../src/lib/fs";
import type { DocumentSnapshot } from "../../src/lib/fs";

const DOC = "/docs/a.md";
const snapshot = (content: string, mtimeUs = 1_700_000_000_000_000): DocumentSnapshot => ({
  content,
  stat: { mtimeUs, size: new TextEncoder().encode(content).byteLength },
});

beforeEach(() => {
  invokeMock.mockReset();
  isTauriMock.mockReturnValue(true);
});

describe("readDocument：成对读取", () => {
  it("一次 IPC 同时拿到内容与磁盘身份（不做第二次 stat 调用）", async () => {
    invokeMock.mockResolvedValue(snapshot("# 标题\n正文"));

    const result = await readDocument(DOC);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("read_document", { filePath: DOC });
    expect(result).toEqual(snapshot("# 标题\n正文"));
  });

  it("changedDuringRead 自动重试一次，用第二次的成对结果", async () => {
    invokeMock
      .mockRejectedValueOnce({ code: "changedDuringRead", message: "读取期间被修改" })
      .mockResolvedValueOnce(snapshot("v2", 2));

    const result = await readDocument(DOC);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual(snapshot("v2", 2));
  });

  it("连续两次 changedDuringRead 仍失败：抛出 code，绝不返回可疑 pair", async () => {
    invokeMock.mockRejectedValue({ code: "changedDuringRead", message: "读取期间被修改" });

    await expect(readDocument(DOC)).rejects.toMatchObject({ code: "changedDuringRead" });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("非 changedDuringRead 的错误不重试（notFound 一次即失败）", async () => {
    invokeMock.mockRejectedValue({ code: "notFound", message: "文件不存在" });

    await expect(readDocument(DOC)).rejects.toMatchObject({ code: "notFound" });
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("非 UTF-8 文件保留 encodingUnsupported 与可读文案（B8）", async () => {
    invokeMock.mockRejectedValue({
      code: "encodingUnsupported",
      message: "文件不是 UTF-8 编码（可能是 GBK/Big5 等旧编码），无法打开: /docs/gbk.md",
    });

    const error = await readDocument("/docs/gbk.md").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CmdError);
    expect((error as CmdError).code).toBe("encodingUnsupported");
    expect((error as Error).message).toContain("不是 UTF-8 编码");
  });
});

describe("fileStat", () => {
  it("返回结构化磁盘身份", async () => {
    invokeMock.mockResolvedValue({ mtimeUs: 1_700_000_000_000_001, size: 42 });

    await expect(fileStat(DOC)).resolves.toEqual({
      mtimeUs: 1_700_000_000_000_001,
      size: 42,
    });
    expect(invokeMock).toHaveBeenCalledWith("file_stat", { filePath: DOC });
  });

  it("缺失文件抛 notFound（不是裸 Error，也不退化成 io）", async () => {
    invokeMock.mockRejectedValue({ code: "notFound", message: "文件不存在: /docs/gone.md" });

    const error = await fileStat("/docs/gone.md").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CmdError);
    expect((error as CmdError).code).toBe("notFound");
  });

  it("错误上的 path / target 透传（tempKept 场景 UI 要能另存为）", async () => {
    invokeMock.mockRejectedValue({
      code: "tempKept",
      message: "内容保留在临时文件",
      path: "/d/.a.md.tmp.1",
      target: "/d/a.md",
    });

    const error = await fileStat(DOC).catch((e: unknown) => e);

    expect((error as CmdError).path).toBe("/d/.a.md.tmp.1");
    expect((error as CmdError).target).toBe("/d/a.md");
  });
});

describe("formatCmdError", () => {
  it("旧命令的裸字符串错误降级为 io（不猜具体原因）", () => {
    expect(formatCmdError("写入临时文件失败: disk full")).toEqual({
      code: "io",
      message: "写入临时文件失败: disk full",
    });
  });

  it("未知 code 也降级为 io，但保留 message", () => {
    expect(formatCmdError({ code: "somethingElse", message: "x" })).toEqual({
      code: "io",
      message: "x",
    });
  });

  it("合法结构化错误原样归一，且不带空字段", () => {
    expect(formatCmdError({ code: "permissionDenied", message: "拒绝访问" })).toEqual({
      code: "permissionDenied",
      message: "拒绝访问",
    });
  });
});

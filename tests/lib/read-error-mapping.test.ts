// #159 readTextFile 后端结构化错误映射测试
//
// 背景：Rust 端 read_text_file 对非 UTF-8 文件返回英文错误
// "stream did not contain valid UTF-8"，直接拼进中文提示透传给用户；
// 修复后后端返回带稳定标记的结构化错误（ENCODING_UNSUPPORTED /
// FILE_TOO_LARGE），前端 readTextFile 据此映射为可读中文提示。

import { describe, it, expect, vi, beforeEach } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/path", () => ({
  resolve: (...args: string[]) => Promise.resolve(args.join("/")),
}));

import { readTextFile } from "../../src/lib/fs";

beforeEach(() => {
  invokeMock.mockReset();
});

describe("#159 readTextFile 结构化错误映射", () => {
  it("非 UTF-8 标记映射为编码不支持的可读中文，不透传英文错误", async () => {
    invokeMock.mockRejectedValue(
      new Error("ENCODING_UNSUPPORTED: 文件不是 UTF-8 编码（可能是 GBK/Big5 等旧编码），无法打开"),
    );

    await expect(readTextFile("/notes/gbk.md")).rejects.toThrow(
      "无法打开：文件不是 UTF-8 编码（可能是 GBK/Big5 等旧编码），请转换编码后重试",
    );
    await expect(readTextFile("/notes/gbk.md")).rejects.not.toThrow("ENCODING_UNSUPPORTED");
  });

  it("文件过大标记映射为大小上限提示", async () => {
    invokeMock.mockRejectedValue(
      new Error("FILE_TOO_LARGE: 文件过大（305.2 MB，超过 10 MB 打开上限），无法打开"),
    );

    await expect(readTextFile("/notes/huge.md")).rejects.toThrow(
      "无法打开：文件过大，超过打开大小上限",
    );
    await expect(readTextFile("/notes/huge.md")).rejects.not.toThrow("FILE_TOO_LARGE");
  });

  it("其他错误原样透传（不误伤既有错误语义）", async () => {
    invokeMock.mockRejectedValue(new Error("文件不存在: /notes/missing.md"));

    await expect(readTextFile("/notes/missing.md")).rejects.toThrow(
      "文件不存在: /notes/missing.md",
    );
  });

  it("路径含标记串的普通错误不被误映射（startsWith 而非 includes）", async () => {
    invokeMock.mockRejectedValue(
      new Error("文件不存在: /notes/ENCODING_UNSUPPORTED.md"),
    );

    // 若误用 includes，该消息会命中编码分支；startsWith 保证原样透传
    await expect(readTextFile("/notes/ENCODING_UNSUPPORTED.md")).rejects.toThrow(
      "文件不存在: /notes/ENCODING_UNSUPPORTED.md",
    );
    await expect(
      readTextFile("/notes/ENCODING_UNSUPPORTED.md"),
    ).rejects.not.toThrow("无法打开");
  });

  it("非 Error 形式的错误也能映射（按字符串内容识别标记）", async () => {
    invokeMock.mockRejectedValue("ENCODING_UNSUPPORTED: raw string rejection");

    await expect(readTextFile("/notes/gbk.md")).rejects.toThrow(
      "无法打开：文件不是 UTF-8 编码（可能是 GBK/Big5 等旧编码），请转换编码后重试",
    );
  });

  it("正常读取成功返回内容", async () => {
    invokeMock.mockResolvedValue("# 正常内容");

    await expect(readTextFile("/notes/ok.md")).resolves.toBe("# 正常内容");
  });
});

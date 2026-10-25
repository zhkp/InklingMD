// #362 §12 ①：把 #391 的写盘错误并入 `CmdError` 一套契约
//
// 过渡期 Rust 仍以字符串前缀（`TARGET_MISSING: ...`）返回写盘错误；`save_document`
// 改成结构化序列化后，进来的会直接是 `{code, message}`。两种形态都必须落到同一个
// `CmdErrorCode` 上，否则「读错误走 CmdError、写错误走 WriteError」会长期并存。

import { describe, expect, it } from "vitest";
import { CmdError, formatCmdError } from "../../src/lib/cmd-error";
import {
  WriteError,
  isWriteErrorCode,
  mapWriteError,
  writeErrorCode,
} from "../../src/lib/writeErrors";

describe("写盘错误并入 CmdError", () => {
  it("formatCmdError 认得 4 个写盘码，不再降级成 io", () => {
    for (const code of [
      "TARGET_MISSING",
      "PARENT_MISSING",
      "NOT_A_FILE",
      "PARENT_NOT_DIR",
    ] as const) {
      expect(isWriteErrorCode(code)).toBe(true);
      expect(formatCmdError({ code, message: "x" })).toEqual({ code, message: "x" });
    }
  });

  it("过渡期字符串前缀被解析成 WriteError（同时是 CmdError）", () => {
    const err = mapWriteError("PARENT_MISSING: 所在目录已不存在: /d/doc.md");

    expect(err).toBeInstanceOf(WriteError);
    expect(err).toBeInstanceOf(CmdError);
    expect(writeErrorCode(err)).toBe("PARENT_MISSING");
    // 用统一的人话，不把后端原始串直接抛给用户
    expect((err as Error).message).toContain("文件夹已不存在");
  });

  it("结构化错误同样能取到 code（PR-2 的 save_document 走这条）", () => {
    const err = mapWriteError({ code: "NOT_A_FILE", message: "目标路径不是普通文件: /d/a.md" });

    expect(writeErrorCode(err)).toBe("NOT_A_FILE");
    // 结构化形态自带更具体的文案：保留它
    expect((err as Error).message).toBe("目标路径不是普通文件: /d/a.md");
  });

  it("camelCase 形态（save_document / ErrorCode）归一到同一组写盘码", () => {
    // 写路径上「目标不存在」就是「原文件已不在原处」，必须能驱动三选项弹窗
    expect(writeErrorCode({ code: "notFound", message: "文件不存在" })).toBe("TARGET_MISSING");
    expect(writeErrorCode({ code: "parentMissing", message: "父目录缺失" })).toBe("PARENT_MISSING");
    expect(writeErrorCode({ code: "notAFile", message: "不是普通文件" })).toBe("NOT_A_FILE");

    const wrapped = mapWriteError({ code: "notAFile", message: "目标路径不是普通文件: /d/a.md" });
    expect(wrapped).toBeInstanceOf(WriteError);
    expect(writeErrorCode(wrapped)).toBe("NOT_A_FILE");
    // 结构化形态的具体文案要保住（比默认人话更准）
    expect((wrapped as Error).message).toBe("目标路径不是普通文件: /d/a.md");
  });

  it("普通 IO 错误不被误判成写盘意图错误", () => {
    const err = mapWriteError(new Error("disk full"));

    expect(writeErrorCode(err)).toBeNull();
    expect(err.message).toBe("disk full");
    expect(formatCmdError(err).code).toBe("io");
  });

  it("writeErrorCode 对旧字符串错误也能取到（catch 到裸串的调用方不至于失明）", () => {
    expect(writeErrorCode("TARGET_MISSING: 目标文件已不存在")).toBe("TARGET_MISSING");
    expect(writeErrorCode("写入临时文件失败: disk full")).toBeNull();
  });
});

// issue #363：写盘意图错误（目标缺失 / 父目录缺失 / 非普通文件 / 父路径被文件占用）。
//
// Epic #384 起统一到 `CmdError` 一套契约：这 4 个 code 是 `CmdErrorCode` 的成员，
// 本模块只留「后端前缀 ↔ code」的过渡适配（现在 Rust 返回 `TARGET_MISSING: ...` 这样的
// 裸字符串），不再维护独立的错误类型体系。PR-2 的 `save_document` 改成结构化序列化后，
// `mapWriteError` 的前缀分支可以直接删掉，调用方（`fs.ts` / `saveCurrent`）无需改动。

import { CmdError, formatCmdError } from "./cmd-error";
import type { CmdErrorCode } from "./cmd-error";

/** 写盘意图错误码（`CmdErrorCode` 的子集，wire 形态大写） */
export type WriteErrorCode = Extract<
  CmdErrorCode,
  "TARGET_MISSING" | "PARENT_MISSING" | "NOT_A_FILE" | "PARENT_NOT_DIR"
>;

const WRITE_ERROR_CODES: readonly WriteErrorCode[] = [
  "TARGET_MISSING",
  "PARENT_MISSING",
  "NOT_A_FILE",
  "PARENT_NOT_DIR",
];

export const WRITE_ERROR_MESSAGES: Record<WriteErrorCode, string> = {
  TARGET_MISSING: "文件已不在原位置（可能已被删除或移动）",
  PARENT_MISSING: "文件所在的文件夹已不存在（可能已被删除、移动，或磁盘已断开）",
  NOT_A_FILE: "原路径已被其他内容（如同名文件夹）占用",
  PARENT_NOT_DIR: "文件所在的文件夹路径已被同名文件占用",
};

/** 大写写盘码是唯一真值源：归一、校验、前缀扫描都从它派生 */
export function isWriteErrorCode(code: unknown): code is WriteErrorCode {
  return typeof code === "string" && (WRITE_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * camelCase（读盘 / 未来的 `save_document`）→ 写盘码。
 *
 * 同一个条件在两条链路上有两个写法，必须在这里归一（#362 评审阻塞 2）：
 * 写盘命令（#391）用大写前缀，`ErrorCode` 序列化用 camelCase。不归一的话，
 * `save_document` 改成结构化序列化后 `writeErrorCode()` 会拿到 `null`，
 * `saveCurrent` 的三选项与 `markMissingOnDisk` 会静默失效，
 * `switchTab`（只认 `notAFile`）与 `resolveMissingFileSave`（只认 `NOT_A_FILE`）也永远互不命中。
 *
 * 只列 camelCase 这一侧：大写码由 `isWriteErrorCode` 认，避免两份清单漂移。
 */
const CAMEL_TO_WRITE_CODE: Record<string, WriteErrorCode> = {
  // 写路径上「目标不存在」就是「原文件已不在原处」（notFound 在读路径另有含义）
  notFound: "TARGET_MISSING",
  parentMissing: "PARENT_MISSING",
  notAFile: "NOT_A_FILE",
};

/** 把任意形态的 code 归一到写盘码（认不出返回 null） */
function normalizeWriteCode(code: unknown): WriteErrorCode | null {
  if (isWriteErrorCode(code)) return code;
  if (typeof code !== "string") return null;
  return CAMEL_TO_WRITE_CODE[code] ?? null;
}

/**
 * 带结构化 code 的写盘错误。
 *
 * 继承 `CmdError`：写盘与读取共用一套「按 code 分流」的契约，
 * 调用方既可以用 `instanceof CmdError` 统一兜底，也可以用 `writeErrorCode()` 只取写盘码。
 */
export class WriteError extends CmdError {
  declare readonly code: WriteErrorCode;

  constructor(code: WriteErrorCode, message: string = WRITE_ERROR_MESSAGES[code]) {
    super({ code, message });
    this.name = "WriteError";
  }
}

/**
 * 把后端写盘错误归一为 `WriteError`；其他错误原样返回。
 *
 * 三种来源：① 过渡期的字符串前缀；② 未来的结构化 `{code, message}`；③ 真实 `Error`。
 */
export function mapWriteError(error: unknown): Error {
  if (error instanceof CmdError) {
    const code = normalizeWriteCode(error.code);
    if (code) return error instanceof WriteError && error.code === code ? error : new WriteError(code, error.message);
  }
  const raw = error instanceof Error ? error.message : String(error);
  const hit = WRITE_ERROR_CODES.find((code) => raw.startsWith(code));
  if (hit) return new WriteError(hit);
  const shape = formatCmdError(error);
  const normalized = normalizeWriteCode(shape.code);
  if (normalized) return new WriteError(normalized, shape.message);
  return error instanceof Error ? error : new Error(raw);
}

/** 取写盘错误的结构化标记；非写盘错误返回 null（大写 / camelCase / 裸串三种来源都要能认） */
export function writeErrorCode(error: unknown): WriteErrorCode | null {
  if (error instanceof CmdError) {
    const code = normalizeWriteCode(error.code);
    if (code) return code;
  }
  const shape = formatCmdError(error);
  const normalized = normalizeWriteCode(shape.code);
  if (normalized) return normalized;
  // 过渡期：catch 到的可能是裸字符串（例如跨模块没经过 fs.ts 包装）
  const raw = error instanceof Error ? error.message : String(error);
  return WRITE_ERROR_CODES.find((code) => raw.startsWith(code)) ?? null;
}

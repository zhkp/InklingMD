// issue #363：写盘结构化错误（与 src-tauri commands 的 WRITE_ERROR_* 常量保持契约一致）。
// 独立于 fs.ts：调用方据 code 区分「文件已不在原处」与普通 IO 失败，
// 不随 fs 封装层一起被替换（测试常整体 mock fs.ts）。

export type WriteErrorCode = "TARGET_MISSING" | "PARENT_MISSING" | "NOT_A_FILE" | "PARENT_NOT_DIR";

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

/** 带结构化标记的写盘错误 */
export class WriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    message: string = WRITE_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "WriteError";
  }
}

/** 把后端写盘错误标记映射为 WriteError；其他错误原样返回（startsWith 口径同 fs.ts 的 mapReadError） */
export function mapWriteError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const code = WRITE_ERROR_CODES.find((c) => raw.startsWith(c));
  if (code) return new WriteError(code);
  return error instanceof Error ? error : new Error(raw);
}

/** 取写盘错误的结构化标记；非 WriteError 返回 null */
export function writeErrorCode(error: unknown): WriteErrorCode | null {
  return error instanceof WriteError ? error.code : null;
}

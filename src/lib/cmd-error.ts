// 命令错误契约（Epic #384 · B1）
//
// Rust 侧 `CmdError { code, message, path?, target? }` 的唯一前端对应物。
// 单独成模块（而不是塞进 fs.ts）的原因：store 只需要「按 code 分流」这件纯逻辑，
// 不该因为测试整模块 mock `lib/fs` 而丢掉错误分类能力。
//
// 约定：
// * `code` 是唯一分流依据，**不再**用字符串前缀匹配（旧 `ENCODING_UNSUPPORTED` 前缀
//   只保留在 `read_text_file` 的兼容路径上，见 fs.ts 的 mapReadError）。
// * `message` 是给人看的文案，缺失文件/编码不支持等仍然可读。
// * `path` 只放「内容所在 temp」，`target` 是原目标路径（供 UI「另存为」）。

/**
 * 与 Rust `ErrorCode` 一一对应（顺序无关，值必须一致）。
 *
 * 后 4 个是 #391 落地的**写盘意图错误**（wire 形态是字符串前缀 `TARGET_MISSING: ...`），
 * 保留大写原样是为了不与已有前后端契约漂移；PR-2 的 `save_document` 改成结构化序列化后，
 * 这 4 个码继续作为 `CmdErrorCode` 的成员使用，`writeErrors.ts` 届时只剩纯映射。
 */
export type CmdErrorCode =
  | "notFound"
  | "parentMissing"
  | "permissionDenied"
  | "changedDuringRead"
  | "fileTooLarge"
  | "encodingUnsupported"
  | "invalidArgument"
  | "io"
  | "tempKept"
  | "tempRegisterFailed"
  | "notAFile"
  | "TARGET_MISSING"
  | "PARENT_MISSING"
  | "NOT_A_FILE"
  | "PARENT_NOT_DIR";

export interface CmdErrorShape {
  code: CmdErrorCode;
  message: string;
  /** 内容所在（temp） */
  path?: string;
  /** 原目标路径，供 UI「另存为」 */
  target?: string;
}

const CMD_ERROR_CODES: ReadonlySet<string> = new Set<CmdErrorCode>([
  "notFound",
  "parentMissing",
  "permissionDenied",
  "changedDuringRead",
  "fileTooLarge",
  "encodingUnsupported",
  "invalidArgument",
  "io",
  "tempKept",
  "tempRegisterFailed",
  "notAFile",
  "TARGET_MISSING",
  "PARENT_MISSING",
  "NOT_A_FILE",
  "PARENT_NOT_DIR",
]);

export function isCmdErrorCode(value: unknown): value is CmdErrorCode {
  return typeof value === "string" && CMD_ERROR_CODES.has(value);
}

/**
 * 把任意 reject 值归一为 `CmdErrorShape`。
 *
 * 兼容三种来源：① 新命令的结构化对象；② 旧命令的裸字符串（如
 * `write_text_file` 在 PR-1 过渡期仍返回 String）；③ 真实 `Error`。
 * 认不出 code 时统一降级为 `io`，**不猜测**具体原因。
 */
export function formatCmdError(error: unknown): CmdErrorShape {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; message?: unknown; path?: unknown; target?: unknown };
    if (isCmdErrorCode(candidate.code)) {
      const shape: CmdErrorShape = {
        code: candidate.code,
        message: typeof candidate.message === "string" ? candidate.message : String(candidate.message ?? ""),
      };
      if (typeof candidate.path === "string") shape.path = candidate.path;
      if (typeof candidate.target === "string") shape.target = candidate.target;
      return shape;
    }
    // 认不出 code 但带着可读文案（未来新增码 / 跨版本）：保留文案，只降级分类
    if (typeof candidate.message === "string") {
      return { code: "io", message: candidate.message };
    }
  }
  return { code: "io", message: error instanceof Error ? error.message : String(error) };
}

/** 带结构化 code 的 Error：既能被 `catch` 当普通错误处理，也能按 code 分流 */
export class CmdError extends Error {
  readonly code: CmdErrorCode;
  readonly path?: string;
  readonly target?: string;

  constructor(shape: CmdErrorShape) {
    super(shape.message);
    this.name = "CmdError";
    this.code = shape.code;
    if (shape.path !== undefined) this.path = shape.path;
    if (shape.target !== undefined) this.target = shape.target;
  }
}

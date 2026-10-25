// 真实文件系统版 Tauri 后端（#363）：把 invoke 接到临时目录上，按 Rust 命令的契约
// （src-tauri/src/commands/mod.rs）复刻写盘/读盘语义，让 store、自动保存、监听器、
// 退出流程在真实磁盘状态（删除、改名、目录被占用……）下端到端运行。
//
// 契约以 Rust 实现为准，Rust 侧由 commands/mod.rs 的单元测试覆盖；这里只复刻
// 前端可观察的行为：
// - write_text_file：父目录缺失 → PARENT_MISSING（createParents=true 时 create_dir_all）；
//   父目录或祖先被普通文件占据 → PARENT_NOT_DIR；
//   目标存在但不是普通文件 → NOT_A_FILE；mustExist=true 且目标缺失 → TARGET_MISSING；
//   写临时文件 + rename 原子替换
// - write_binary_file：父目录缺失时仅在 createParentDir=true 且祖父目录存在时建一层
// - file_mtime / read_text_file：Path::exists 跟随符号链接，不存在即报错；
//   file_mtime 对非普通文件（如同名目录）报 NOT_A_FILE

import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

const WRITE_ERROR_TARGET_MISSING = "TARGET_MISSING";
const WRITE_ERROR_PARENT_MISSING = "PARENT_MISSING";
const WRITE_ERROR_NOT_A_FILE = "NOT_A_FILE";
const WRITE_ERROR_PARENT_NOT_DIR = "PARENT_NOT_DIR";

export interface InvokeCall {
  cmd: string;
  args: Record<string, unknown>;
}

function isDir(p: string): boolean {
  try {
    return nodeFs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 父目录或最近的已存在祖先被普通文件占据（ensure_parent_dir 的 PARENT_NOT_DIR） */
function parentBlockedByFile(parent: string): boolean {
  let p = parent;
  while (!nodeFs.existsSync(p)) {
    const up = nodePath.dirname(p);
    if (up === p) return false;
    p = up;
  }
  return !isDir(p);
}

/** 结构化读盘错误（与 Rust `CmdError { code, message }` 同形，前端按 code 分流） */
function cmdError(code: string, message: string): never {
  throw { code, message };
}

/** stat 或按 Rust 语义抛 notFound / notAFile（#362：读路径必须给出可分类的错误） */
function statOfFile(filePath: string): nodeFs.Stats {
  let stat: nodeFs.Stats;
  try {
    stat = nodeFs.statSync(filePath);
  } catch {
    return cmdError("notFound", `文件不存在: ${filePath}`);
  }
  if (!stat.isFile()) {
    return cmdError("notAFile", `目标路径不是普通文件: ${filePath}`);
  }
  return stat;
}

/** 与 Rust `FileStat` 对齐：微秒 mtime + 字节数 */
function toFileStat(stat: nodeFs.Stats) {
  return { mtimeUs: Math.round(stat.mtimeMs * 1000), size: stat.size };
}

function atomicWrite(filePath: string, bytes: Buffer): void {
  const parent = nodePath.dirname(filePath);
  const tmp = nodePath.join(
    parent,
    `.${nodePath.basename(filePath)}.tmp-${Math.random().toString(36).slice(2)}`,
  );
  nodeFs.writeFileSync(tmp, bytes);
  try {
    nodeFs.renameSync(tmp, filePath);
  } catch (e) {
    nodeFs.rmSync(tmp, { force: true });
    throw `替换目标文件失败 ${filePath}: ${(e as Error).message}`;
  }
}

function checkTarget(filePath: string, mustExist: boolean): void {
  let stat: nodeFs.Stats | null = null;
  try {
    stat = nodeFs.statSync(filePath);
  } catch {
    stat = null;
  }
  if (stat && !stat.isFile()) {
    throw `${WRITE_ERROR_NOT_A_FILE}: 目标路径不是普通文件: ${filePath}`;
  }
  if (!stat && mustExist) {
    throw `${WRITE_ERROR_TARGET_MISSING}: 目标文件已不存在: ${filePath}`;
  }
}

export function createRealFsBackend() {
  const calls: InvokeCall[] = [];
  const handlers: Record<string, (a: Record<string, any>) => unknown> = {
    write_text_file: ({ filePath, content, mustExist, createParents }) => {
      const parent = nodePath.dirname(filePath);
      if (!isDir(parent)) {
        if (parentBlockedByFile(parent)) {
          throw `${WRITE_ERROR_PARENT_NOT_DIR}: 所在文件夹路径已被文件占用: ${parent}`;
        }
        if (createParents) {
          nodeFs.mkdirSync(parent, { recursive: true });
        } else {
          throw `${WRITE_ERROR_PARENT_MISSING}: 所在目录已不存在: ${parent}`;
        }
      }
      checkTarget(filePath, !!mustExist);
      atomicWrite(filePath, Buffer.from(content, "utf8"));
    },
    write_binary_file: ({ filePath, data, createParentDir }) => {
      const parent = nodePath.dirname(filePath);
      if (!isDir(parent)) {
        if (parentBlockedByFile(parent)) {
          throw `${WRITE_ERROR_PARENT_NOT_DIR}: 所在文件夹路径已被文件占用: ${parent}`;
        }
        if (createParentDir && isDir(nodePath.dirname(parent))) {
          nodeFs.mkdirSync(parent);
        } else {
          throw `${WRITE_ERROR_PARENT_MISSING}: 所在目录已不存在: ${parent}`;
        }
      }
      checkTarget(filePath, false);
      atomicWrite(filePath, Buffer.from(data, "base64"));
    },
    read_text_file: ({ filePath }) => {
      if (!nodeFs.existsSync(filePath)) throw `读取失败 ${filePath}: 文件不存在`;
      return nodeFs.readFileSync(filePath, "utf8");
    },
    // #362 成对读取：内容与 stat 成对返回，并复刻 meta1/meta2 双检
    read_document: ({ filePath }) => {
      const before = statOfFile(filePath);
      const content = nodeFs.readFileSync(filePath, "utf8");
      const after = statOfFile(filePath);
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
        return cmdError("changedDuringRead", `读取期间文件被修改: ${filePath}`);
      }
      return { content, stat: toFileStat(after) };
    },
    file_stat: ({ filePath }) => toFileStat(statOfFile(filePath)),
    // #362 写路径：替换语义 + 回执。语义必须与 Rust `save_document` 一致，
    // 否则「删除后保存」「外部改动」这些真实 FS 用例会变成伪断言
    save_document: (a: Record<string, any>) => {
      const { filePath, content, expected, createParentDirs, overwriteExisting } = a as {
        filePath: string;
        content: string;
        expected?: { mtimeUs: number; size: number } | null;
        createParentDirs?: boolean;
        overwriteExisting?: boolean;
      };
      const parent = nodePath.dirname(filePath);
      if (!nodeFs.existsSync(parent) || !nodeFs.statSync(parent).isDirectory()) {
        if (!createParentDirs) return { kind: "parentMissing", parent };
        nodeFs.mkdirSync(parent, { recursive: true });
      }
      const exists = nodeFs.existsSync(filePath);
      if (exists && !nodeFs.statSync(filePath).isFile()) {
        return cmdError("notAFile", `目标路径不是普通文件: ${filePath}`);
      }
      if (exists) {
        const current = toFileStat(nodeFs.statSync(filePath));
        if (expected && (current.mtimeUs !== expected.mtimeUs || current.size !== expected.size)) {
          return { kind: "conflict", disk: current, registerFailed: false };
        }
        if (!expected && !overwriteExisting) {
          return { kind: "conflict", disk: current, registerFailed: false };
        }
      } else if (expected) {
        // 目标消失绝不复活（#363）
        return { kind: "notFound" };
      }
      atomicWrite(filePath, Buffer.from(content, "utf8"));
      return { kind: "written", stat: toFileStat(nodeFs.statSync(filePath)), foreignWrite: false };
    },
    file_mtime: ({ filePath }) => {
      if (!nodeFs.existsSync(filePath)) throw `文件不存在: ${filePath}`;
      const stat = nodeFs.statSync(filePath);
      if (!stat.isFile()) throw `${WRITE_ERROR_NOT_A_FILE}: 目标路径不是普通文件: ${filePath}`;
      return Math.floor(stat.mtimeMs);
    },
    rename_path: ({ from, to }) => nodeFs.renameSync(from, to),
    delete_path: ({ path }) => nodeFs.rmSync(path, { recursive: true }),
    find_asset_by_hash: () => null,
    list_dir: ({ dirPath }) => ({
      name: nodePath.basename(dirPath),
      path: dirPath,
      is_dir: true,
      children: [],
    }),
    allow_asset_dir: () => undefined,
  };

  const invoke = async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    const handler = handlers[cmd];
    return handler ? handler(args) : undefined;
  };

  /** 对某路径发起过的写盘调用（不论成败） */
  const writesTo = (filePath: string) =>
    calls.filter((c) => c.cmd.startsWith("write_") && c.args.filePath === filePath);

  return { invoke, calls, writesTo };
}

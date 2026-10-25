// 保存前的基线判定（Epic #384 · B1 · M2 判定三路）
//
// 一切「磁盘与基线不一致」都必须走同一套判定：写前冲突、写后回执
// （foreignWrite）、watcher 检测、switchTab 核验共用本模块，避免四份真值源。
//
// 两条原则：
// 1. **基线比较是精确的**：不再用 5ms 容差。容差窗口内的外写会被当成"没变"，
//    正是 #362 的漏报来源；文件系统时间戳粒度已由 `mtimeUs` 微秒精度覆盖。
// 2. **先比内容再判冲突**：只看 stat 会把"仅 touch / 同样内容重写"误报成冲突
//    （无内容的误报），而"保留 mtime 同长度外写"又会被漏掉。

import type { FileStat } from "./fs";

/** 基线判定：`unknown` 表示没有可比对的基线（不是"没变"） */
export type BaselineVerdict = "unchanged" | "changed" | "unknown";

/**
 * 比较"我记录的基线"与"现在磁盘上的身份"。
 *
 * `unknown` 必须由调用方走「读盘取成对基线」流程，**不得**当作 `unchanged`
 * 静默跳过，也不得当作 `changed` 直接判冲突。
 */
export function evaluateBaseline(
  baseline: FileStat | undefined,
  current: FileStat,
): BaselineVerdict {
  if (!baseline) return "unknown";
  if (baseline.mtimeUs === current.mtimeUs && baseline.size === current.size) {
    return "unchanged";
  }
  return "changed";
}

export type ReconcileResult =
  /** 磁盘内容 == 本次要写的内容：视为保存成功，不写盘 */
  | { kind: "same-as-write" }
  /** 磁盘内容 == 旧基线（仅时间戳变化 / 同样内容重写）：adopt 后重试一次 */
  | { kind: "touch-only" }
  | { kind: "conflict" };

/**
 * 三路判定：磁盘内容、本次要写的内容、旧基线内容。
 *
 * - `diskContent === contentToSave` → 成功（磁盘已是编辑器内容）；
 * - `diskContent === baselineContent` → 仅 touch（不是冲突，也不丢本地编辑）；
 * - 其余 → 真冲突。基线内容未知时一律算冲突：宁可多问一次，
 *   也不能在没有证据的情况下把外部内容覆盖掉。
 */
export function reconcileDiskContent(
  diskContent: string,
  contentToSave: string,
  baselineContent: string | undefined,
): ReconcileResult {
  if (diskContent === contentToSave) return { kind: "same-as-write" };
  if (baselineContent !== undefined && diskContent === baselineContent) {
    return { kind: "touch-only" };
  }
  return { kind: "conflict" };
}

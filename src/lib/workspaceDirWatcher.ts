// 工作区目录外部变更监听 Hook（issue #369）
//
// 职责：以 3 秒轮询对「工作区根 + 已展开且已在当前树中」的目录做浅层扫描
// （listDir，复用 Rust 侧统一的忽略规则），比较直接子项条目集，发现差异后
// 调用与内部操作相同的 refreshTree 出口刷新对应目录——文件树更新与 Quick
// Open 索引失效在 refreshTree 内一并完成（#228 的单一失效点不变）。
//
// 设计取舍（与 Epic #385 范围约束一致）：
// - 不引入 notify 文件系统事件框架，复用现有 3 秒轮询量级；
// - 只扫工作区根与已展开目录，不做全树递归。根**始终**参与扫描：根行可折叠，
//   但折叠只影响文件树可见性，Quick Open 索引仍须随根级外部变更失效；
// - 条目集只比「名称 + 是否目录」，文件内容变更由 useFileWatcher 对已打开
//   tab 的 mtime 轮询负责，两者职责不重叠；
// - listDir 失败（目录被外部删除 / 无权限）静默跳过：删除由父目录的条目
//   集对比发现，失败目录不触发刷新循环；
// - 与 useFileWatcher 不同，本 Hook 在浏览器 mock 环境同样生效——目录
//   枚举是确定性的（无 mtime 假数据问题），且这是 E2E 验证外部变更感知
//   的唯一途径。

import { useEffect, useRef } from "react";
import { useWorkspace } from "../store/workspace";
import { listDir, type FileNode } from "./fs";

/** 轮询间隔：与 useFileWatcher 的 3 秒量级保持一致（Epic 验收口径） */
const POLL_INTERVAL = 3000;

/**
 * 比较目录直接子项的条目签名集（名称 + 是否目录）是否发生变化
 *
 * 导出供单测直接断言；签名只含条目身份，不含内容 / mtime。
 */
export function directoryEntriesChanged(
  currentChildren: FileNode[],
  freshChildren: FileNode[],
): boolean {
  if (currentChildren.length !== freshChildren.length) return true;
  const signature = (node: FileNode): string => `${node.is_dir ? "d" : "f"}:${node.name}`;
  const current = new Set(currentChildren.map(signature));
  for (const fresh of freshChildren) {
    if (!current.delete(signature(fresh))) return true;
  }
  return current.size > 0;
}

/** 在当前树中按路径查找目录节点（浅拷贝快照，避免持有可变引用遍历） */
function findDirNode(root: FileNode | null, path: string): FileNode | null {
  if (!root) return null;
  const stack: FileNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.path === path) return node.is_dir ? node : null;
    if (node.is_dir) {
      for (const child of node.children) stack.push(child);
    }
  }
  return null;
}

/**
 * 轮询扫描一轮：返回发生外部变更、需要 refreshTree 的目录路径列表。
 *
 * 导出供单测注入 mock listDir / state 驱动（不依赖真实定时器）。
 * 逐目录顺序 await：天然限流，避免上百个展开目录时并发 IPC 洪峰。
 */
export async function scanExpandedDirs(
  listDirFn: typeof listDir,
  getState: typeof useWorkspace.getState,
): Promise<string[]> {
  const { rootPath, workspaceMode, tree } = getState();
  if (!rootPath || workspaceMode !== "folder" || !tree) return [];

  const changed: string[] = [];
  // 扫描集合 = 已展开目录 ∪ 工作区根。根必须始终参与：它虽然在 openWorkspace
  // 时被加入 expandedDirs，但根行本身是可折叠的（用户折叠后 expandedDirs 不再
  // 含 rootPath），而 Quick Open 的索引仍需要随根级外部变更失效——「折叠目录
  // 不可见故不扫」的裁定对根不成立。
  const scanDirs = new Set(getState().expandedDirs);
  scanDirs.add(rootPath);
  for (const dir of scanDirs) {
    // 陈旧持久化路径（其他工作区遗留）不在当前树中，直接跳过；
    // 树中的节点必然位于当前 rootPath 之下，无需再做前缀判定
    const node = findDirNode(getState().tree, dir);
    if (!node) continue;
    // 该目录的枚举正在进行（内部操作在途），本轮让路，下轮再比
    if (getState().loadingDirs.has(dir)) continue;

    let listing: FileNode;
    try {
      listing = await listDirFn(dir);
    } catch {
      // 目录不可读 / 已被删除：交给父目录的条目集对比发现，自身不触发刷新
      continue;
    }
    // listDir 往返期间树可能已被内部操作更新，比较用最新快照
    const latest = findDirNode(getState().tree, dir);
    if (!latest) continue;
    if (directoryEntriesChanged(latest.children, listing.children)) {
      changed.push(dir);
    }
  }
  return changed;
}

/**
 * 工作区目录外部变更监听（App 挂载一次）
 *
 * 每 3 秒（以及窗口重新聚焦 / 页面重新可见时）浅扫已展开目录；
 * 发现条目集差异的目录统一走 refreshTree 刷新。
 */
export function useWorkspaceDirWatcher(): void {
  const scanningRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const check = async () => {
      if (cancelled || scanningRef.current) return;
      scanningRef.current = true;
      try {
        const changedDirs = await scanExpandedDirs(listDir, useWorkspace.getState);
        if (cancelled) return;
        // 同一目录一轮只刷一次；多目录变更各自走 refreshTree 出口
        // （refreshTree 内部 loadDirectory 已去重并发强制刷新）
        for (const dir of changedDirs) {
          if (cancelled) break;
          await useWorkspace.getState().refreshTree(dir);
        }
      } catch {
        // 轮询异常不冒泡：下一轮继续
      } finally {
        scanningRef.current = false;
      }
    };

    timer = window.setInterval(() => void check(), POLL_INTERVAL);

    // 窗口重新聚焦 / 页面可见时立即补一轮（用户从终端切回来时无需等满 3 秒）
    const onFocusOrVisible = () => void check();
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
    };
  }, []);
}

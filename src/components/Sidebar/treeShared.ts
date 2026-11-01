// Sidebar 内部共享的常量、类型与纯函数
// 文件树与右键菜单之间通过自定义事件通信，避免 props 层层透传。

import type { FileNode } from "../../lib/fs";

/** 判断是否为 Markdown 文件 */
export function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name);
}

/** 取文件名（路径最后一段） */
export function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** 取父目录路径 */
export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  if (idx < 0) return "";
  if (idx === 0) return p.slice(0, 1);
  if (idx === 2 && /^[a-zA-Z]:[\\/]/.test(p)) return p.slice(0, 3);
  return p.slice(0, idx);
}

/**
 * 删除确认文案（#366）：一次说清删除对已打开文件的影响——打开中的子文件
 * tab 会一并关闭；未保存修改会先备份到「可恢复文件」（onFileDeleted 写快照）；
 * 备份存储空间不足时明确警告会永久丢失。
 * @param openPaths 位于被删路径下（含自身）的已打开文件
 * @param dirtyPaths 其中有未保存修改的文件
 * @param backupWritable 快照存储当前是否可写
 */
export function buildDeleteConfirmMessage(
  node: Pick<FileNode, "name" | "is_dir">,
  openPaths: string[],
  dirtyPaths: string[],
  backupWritable: boolean,
): string {
  let msg = node.is_dir
    ? `确定删除文件夹「${node.name}」及其所有内容吗？`
    : `确定删除「${node.name}」吗？`;
  if (node.is_dir && openPaths.length > 0) {
    msg += `\n\n其中 ${openPaths.length} 个文件正在编辑器中打开，删除后这些标签页会一并关闭。`;
  }
  if (dirtyPaths.length === 0) return msg;

  const names = dirtyPaths.slice(0, 3).map(basename).join("、") + (dirtyPaths.length > 3 ? " 等" : "");
  const subject = node.is_dir
    ? `${dirtyPaths.length} 个有未保存的修改（${names}）`
    : `「${node.name}」有未保存的修改`;
  const lead = node.is_dir ? "\n" : "\n\n";
  return backupWritable
    ? `${msg}${lead}${subject}，会先备份到侧边栏「可恢复文件」，之后可恢复为新标签页。`
    : `${msg}${lead}${subject}。备份存储空间不足，这些修改无法备份，删除后会永久丢失。`;
}

/** 自定义事件名 */
export const TREE_MENU_EVENT = "inkling-tree-menu";
export const TREE_ACTION_EVENT = "inkling-tree-action";

/** 右键菜单传给 Sidebar 的载荷 */
export interface MenuPayload {
  node: FileNode;
  x: number;
  y: number;
}

/** Sidebar 指令文件树执行的动作 */
export type TreeAction =
  | { type: "rename"; node: FileNode }
  | { type: "new"; parentPath: string; kind: "file" | "dir" };

/** 新建项的输入框状态 */
export interface NewItemState {
  parentPath: string;
  kind: "file" | "dir";
}

/** 文件树固定行高与视口外预渲染行数 */
export const TREE_ROW_HEIGHT = 28;
export const TREE_OVERSCAN = 8;
export const TREE_FALLBACK_HEIGHT = 560;

/** 窗口化文件树中的一行 */
export type FileTreeRow =
  | { kind: "node"; node: FileNode; depth: number }
  | { kind: "new"; parentPath: string; itemKind: "file" | "dir"; depth: number }
  | { kind: "loading"; path: string; depth: number }
  | { kind: "error"; path: string; message: string; depth: number };

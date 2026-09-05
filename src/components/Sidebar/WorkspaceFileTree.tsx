// 工作区文件树（issue #50 从 Sidebar 抽出）：
// 按展开状态扁平化，只渲染视口附近的行（窗口化）；
// 重命名 / 新建流程分别由 useRename / useNewItem hook 承载，
// 右键菜单指令通过 TREE_ACTION_EVENT 汇入（容器上仅一个监听器）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../store/workspace";
import { flattenVisibleTree } from "../../lib/fileTree";
import type { FileNode } from "../../lib/fs";
import { IconFileText, IconFolder } from "../icons";
import { FileTreeNode } from "./FileTreeNode";
import { useRename } from "./useRename";
import { useNewItem } from "./useNewItem";
import {
  TREE_ACTION_EVENT,
  TREE_FALLBACK_HEIGHT,
  TREE_MENU_EVENT,
  TREE_OVERSCAN,
  TREE_ROW_HEIGHT,
  type FileTreeRow,
  type MenuPayload,
  type TreeAction,
} from "./treeShared";

export function WorkspaceFileTree({ tree }: { tree: FileNode }) {
  const expandedDirs = useWorkspace((s) => s.expandedDirs);
  const loadedDirs = useWorkspace((s) => s.loadedDirs);
  const loadingDirs = useWorkspace((s) => s.loadingDirs);
  const directoryErrors = useWorkspace((s) => s.directoryErrors);
  const currentFile = useWorkspace((s) => s.currentFile);
  const openTabs = useWorkspace((s) => s.openTabs);
  const openingFiles = useWorkspace((s) => s.openingFiles);
  const fileOpenErrors = useWorkspace((s) => s.fileOpenErrors);
  const toggleDirExpanded = useWorkspace((s) => s.toggleDirExpanded);
  const loadDirectory = useWorkspace((s) => s.loadDirectory);
  const openFile = useWorkspace((s) => s.openFile);

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(TREE_FALLBACK_HEIGHT);

  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    renamingNode,
    renameValue,
    renameInputRef,
    startRename,
    setRenameValue,
    commitRename,
    cancelRename,
  } = useRename();
  const {
    newItem,
    newItemValue,
    newInputRef,
    startNewItem,
    setNewItemValue,
    commitNewItem,
    cancelNewItem,
  } = useNewItem();

  const openedPaths = useMemo(() => new Set(openTabs.map((tab) => tab.path)), [openTabs]);

  const rows = useMemo<FileTreeRow[]>(() => {
    const next: FileTreeRow[] = [];
    for (const row of flattenVisibleTree(tree, expandedDirs)) {
      next.push({ kind: "node", ...row });
      if (!row.node.is_dir || !expandedDirs.has(row.node.path)) continue;

      if (newItem?.parentPath === row.node.path) {
        next.push({
          kind: "new",
          parentPath: row.node.path,
          itemKind: newItem.kind,
          depth: row.depth + 1,
        });
      }
      if (loadingDirs.has(row.node.path)) {
        next.push({ kind: "loading", path: row.node.path, depth: row.depth + 1 });
      } else {
        const message = directoryErrors.get(row.node.path);
        if (message) {
          next.push({ kind: "error", path: row.node.path, message, depth: row.depth + 1 });
        }
      }
    }
    return next;
  }, [tree, expandedDirs, newItem, loadingDirs, directoryErrors]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateHeight = () => {
      if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 文件树动作只在容器上监听一次，避免监听器数量随节点增长
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<TreeAction>).detail;
      if (!detail) return;
      if (detail.type === "rename") {
        startRename(detail.node);
        return;
      }
      startNewItem(detail.parentPath, detail.kind);
    };
    window.addEventListener(TREE_ACTION_EVENT, handler);
    return () => window.removeEventListener(TREE_ACTION_EVENT, handler);
  }, [startRename, startNewItem]);

  const start = Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - TREE_OVERSCAN);
  const end = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / TREE_ROW_HEIGHT) + TREE_OVERSCAN,
  );
  const visibleRows = rows.slice(start, end);

  return (
    <div
      ref={scrollRef}
      className="workspace-tree-scroll"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      role="tree"
    >
      <div className="workspace-tree-spacer" style={{ height: `${rows.length * TREE_ROW_HEIGHT}px` }}>
        {visibleRows.map((row, offset) => {
          const index = start + offset;
          const rowStyle = { top: `${index * TREE_ROW_HEIGHT}px` };

          if (row.kind === "new") {
            return (
              <div
                key={`new:${row.parentPath}`}
                className="workspace-tree-virtual-row"
                style={rowStyle}
              >
                <div
                  className="tree-row tree-row-new"
                  style={{ paddingLeft: `${row.depth * 12 + 24}px` }}
                  data-tree-row
                >
                  <span className="tree-icon">
                    {row.itemKind === "file" ? (
                      <IconFileText size={14} />
                    ) : (
                      <IconFolder size={14} />
                    )}
                  </span>
                  <input
                    ref={newInputRef}
                    className="rename-input"
                    placeholder={row.itemKind === "file" ? "新文件.md" : "新目录"}
                    value={newItemValue}
                    onChange={(e) => setNewItemValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitNewItem();
                      else if (e.key === "Escape") cancelNewItem();
                    }}
                    onBlur={() => void commitNewItem()}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              </div>
            );
          }

          if (row.kind === "loading") {
            return (
              <div
                key={`loading:${row.path}`}
                className="workspace-tree-virtual-row"
                style={rowStyle}
              >
                <div
                  className="tree-row tree-row-status"
                  style={{ paddingLeft: `${row.depth * 12 + 24}px` }}
                >
                  加载中…
                </div>
              </div>
            );
          }

          if (row.kind === "error") {
            return (
              <div
                key={`error:${row.path}`}
                className="workspace-tree-virtual-row"
                style={rowStyle}
              >
                <button
                  className="tree-row tree-row-status tree-row-error"
                  style={{ paddingLeft: `${row.depth * 12 + 24}px` }}
                  title={row.message}
                  onClick={() => void loadDirectory(row.path, true).catch(() => {})}
                >
                  加载失败，点击重试
                </button>
              </div>
            );
          }

          const { node, depth } = row;
          return (
            <div
              key={node.path}
              className="workspace-tree-virtual-row"
              style={rowStyle}
              role="treeitem"
              aria-level={depth + 1}
            >
              <FileTreeNode
                node={node}
                depth={depth}
                expanded={expandedDirs.has(node.path)}
                loaded={loadedDirs.has(node.path)}
                loading={loadingDirs.has(node.path)}
                error={directoryErrors.has(node.path)}
                active={currentFile === node.path}
                opened={openedPaths.has(node.path)}
                opening={openingFiles.has(node.path)}
                openError={fileOpenErrors.get(node.path)}
                renaming={renamingNode?.path === node.path}
                renameValue={renameValue}
                renameInputRef={renameInputRef}
                onRenameValue={setRenameValue}
                onCommitRename={commitRename}
                onCancelRename={cancelRename}
                onToggle={() => toggleDirExpanded(node.path)}
                onOpen={() => void openFile(node.path).catch(() => {})}
                onMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  window.dispatchEvent(
                    new CustomEvent<MenuPayload>(TREE_MENU_EVENT, {
                      detail: { node, x: e.clientX, y: e.clientY },
                    }),
                  );
                }}
                loadDirectory={loadDirectory}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

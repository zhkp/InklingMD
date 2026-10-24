// 文件树右键菜单（issue #50 从 Sidebar 抽出为 TreeContextMenu）
// 通过 TREE_ACTION_EVENT 派发重命名/新建指令给文件树，
// 删除前一次确认说清对已打开文件的影响（#366），支持书签/新窗口/复制路径。

import { useEffect } from "react";
import { useWorkspace } from "../../store/workspace";
import { probeSnapshotStorageHealth } from "../../store/workspace/shared";
import { useUI } from "../../store/ui";
import { isPathWithin } from "../../lib/path-utils";
import { openInNewWindow } from "../../lib/newWindow";
import { deletePath } from "../../lib/fs";
import { askConfirmation, showMessage } from "../../lib/dialogs";
import { useContextMenuClamping } from "../../hooks/useContextMenuClamping";
import { useMenuA11y } from "../../hooks/useMenuA11y";
import {
  buildDeleteConfirmMessage,
  isMarkdown,
  TREE_ACTION_EVENT,
  type MenuPayload,
  type TreeAction,
} from "./treeShared";

export function TreeContextMenu({
  payload,
  onClose,
}: {
  payload: MenuPayload;
  onClose: () => void;
}) {
  const rootPath = useWorkspace((s) => s.rootPath);
  const openTabs = useWorkspace((s) => s.openTabs);
  const onFileDeleted = useWorkspace((s) => s.onFileDeleted);
  const toggleBookmark = useWorkspace((s) => s.toggleBookmark);
  const isBookmarked = useWorkspace((s) => s.isBookmarked);
  const ref = useContextMenuClamping<HTMLDivElement>({ x: payload.x, y: payload.y });
  // #188：打开即聚焦首项 + 方向键导航（Esc/点击外部由下方现有监听处理）
  useMenuA11y({ ref, enabled: true, focusFirstOnOpen: true });

  // 点击外部或 Esc 关闭
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  /** 派发动作事件给文件树 */
  const dispatchAction = (action: TreeAction) => {
    window.dispatchEvent(new CustomEvent(TREE_ACTION_EVENT, { detail: action }));
    onClose();
  };

  /**
   * 删除文件/目录（#366）：一次确认说清影响——其下已打开的 tab 会关闭，
   * 未保存修改由 onFileDeleted 先写入「可恢复文件」快照；删除后展开该区块便于找回
   */
  const handleDelete = async () => {
    const { node } = payload;
    // isPathWithin：含自身、按路径段匹配（不误算 notes-old 之于 notes）、Windows 大小写折叠
    const affected = openTabs.filter((t) => isPathWithin(t.path, node.path));
    const dirtyPaths = affected.filter((t) => t.dirty).map((t) => t.path);
    const msg = buildDeleteConfirmMessage(
      node,
      affected.map((t) => t.path),
      dirtyPaths,
      dirtyPaths.length === 0 || probeSnapshotStorageHealth().writable,
    );
    const confirmed = await askConfirmation(msg, {
      title: "删除确认",
      kind: "warning",
    });
    if (!confirmed) {
      onClose();
      return;
    }
    try {
      await deletePath(node.path);
      // 确认框不阻塞 JS：停留期间自动保存可能已把提示时未保存的文件存成干净状态，
      // 仍按确认框的承诺为它们留备份
      onFileDeleted(node.path, { alsoBackup: dirtyPaths });
      if (dirtyPaths.length > 0 && !useUI.getState().sectionExpanded.snapshots) {
        useUI.getState().toggleSectionExpanded("snapshots");
      }
    } catch (e) {
      await showMessage(`删除失败：${e instanceof Error ? e.message : String(e)}`, { kind: "error" });
    }
    onClose();
  };

  /** 复制路径 */
  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(payload.node.path);
    } catch {
      // 忽略
    }
    onClose();
  };

  /** 在新窗口打开文件（仅桌面端；浏览器回退到当前窗口新 tab） */
  const handleOpenInNewWindow = async () => {
    try {
      const ok = await openInNewWindow(payload.node.path);
      if (!ok) {
        // 浏览器端无多窗口，回退到当前窗口打开
        await useWorkspace.getState().openFile(payload.node.path);
      }
    } catch (e) {
      await showMessage(`打开文件失败：${e instanceof Error ? e.message : String(e)}`, { kind: "error" });
    } finally {
      onClose();
    }
  };

  const { node, x, y } = payload;
  const isRoot = rootPath === node.path;
  const isMdFile = !node.is_dir && isMarkdown(node.name);

  return (
    <div className="tree-context-backdrop">
      <div
        ref={ref}
        className="tree-context-menu"
        style={{ left: x, top: y }}
        role="menu"
      >
        {node.is_dir && (
          <>
            <button
              className="tree-context-item" role="menuitem"
              onClick={() =>
                dispatchAction({ type: "new", parentPath: node.path, kind: "file" })
              }
            >
              新建文件
            </button>
            <button
              className="tree-context-item" role="menuitem"
              onClick={() =>
                dispatchAction({ type: "new", parentPath: node.path, kind: "dir" })
              }
            >
              新建文件夹
            </button>
            <div className="tree-context-sep" />
          </>
        )}
        <button
          className="tree-context-item" role="menuitem"
          onClick={() => dispatchAction({ type: "rename", node })}
          disabled={isRoot}
          title={isRoot ? "工作区根目录不能重命名" : ""}
        >
          重命名
        </button>
        <button
          className="tree-context-item tree-context-danger" role="menuitem"
          onClick={() => void handleDelete()}
          disabled={isRoot}
          title={isRoot ? "工作区根目录不能删除" : ""}
        >
          删除
        </button>
        <div className="tree-context-sep" />
        {!node.is_dir && (
          <>
            <button
              className="tree-context-item" role="menuitem"
              onClick={() => {
                toggleBookmark(node.path);
                onClose();
              }}
            >
              {isBookmarked(node.path) ? "取消书签" : "加入书签"}
            </button>
            {isMdFile && (
              <button
                className="tree-context-item" role="menuitem"
                onClick={() => void handleOpenInNewWindow()}
              >
                在新窗口打开
              </button>
            )}
            <div className="tree-context-sep" />
          </>
        )}
        <button className="tree-context-item" role="menuitem" onClick={() => void handleCopyPath()}>
          复制路径
        </button>
      </div>
    </div>
  );
}

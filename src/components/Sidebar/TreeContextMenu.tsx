// 文件树右键菜单（issue #50 从 Sidebar 抽出为 TreeContextMenu）
// 通过 TREE_ACTION_EVENT 派发重命名/新建指令给文件树，
// 删除前对未保存 tab 做二次确认，支持书签/新窗口/复制路径。

import { useEffect } from "react";
import { useWorkspace } from "../../store/workspace";
import { openInNewWindow } from "../../lib/newWindow";
import { deletePath } from "../../lib/fs";
import { askConfirmation, showMessage } from "../../lib/dialogs";
import { useContextMenuClamping } from "../../hooks/useContextMenuClamping";
import { useMenuA11y } from "../../hooks/useMenuA11y";
import { isMarkdown, TREE_ACTION_EVENT, type MenuPayload, type TreeAction } from "./treeShared";

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

  /** 删除文件/目录，未保存的 tab 会弹确认（closeTab 内部处理） */
  const handleDelete = async () => {
    const { node } = payload;
    const msg = node.is_dir
      ? `确定删除文件夹「${node.name}」及其所有内容吗？`
      : `确定删除「${node.name}」吗？`;
    const confirmed = await askConfirmation(msg, {
      title: "删除确认",
      kind: "warning",
    });
    if (!confirmed) {
      onClose();
      return;
    }
    // 如果有未保存的 tab 被影响，提示
    if (node.is_dir) {
      const affected = openTabs.filter((t) => t.path.startsWith(node.path));
      const dirty = affected.filter((t) => t.dirty);
      if (dirty.length > 0) {
        const ok = await askConfirmation(
          `文件夹下有 ${dirty.length} 个未保存的文件，删除将丢失这些修改，确定继续吗？`,
          { title: "未保存修改警告", kind: "warning" },
        );
        if (!ok) {
          onClose();
          return;
        }
      }
    } else {
      const tab = openTabs.find((t) => t.path === node.path);
      if (tab?.dirty) {
        const ok = await askConfirmation(
          `「${node.name}」有未保存的修改，删除将丢失修改，确定继续吗？`,
          { title: "未保存修改警告", kind: "warning" },
        );
        if (!ok) {
          onClose();
          return;
        }
      }
    }
    try {
      await deletePath(node.path);
      onFileDeleted(node.path);
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

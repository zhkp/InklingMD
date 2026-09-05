// 导出下拉菜单：复制富文本/Markdown、导出 HTML/Word/PDF/PNG/大纲。
// 富文本类导出依赖 ProseMirror DOM，源代码模式下不可用。
import { useRef } from "react";
import type { Editor } from "@milkdown/kit/core";
import { useMenuA11y } from "../../hooks/useMenuA11y";
import {
  exportHTML,
  exportPDF,
  exportDocx,
  exportPNG,
  exportOutline,
  copyMarkdown,
  copyRichText,
} from "../../lib/exporter";
import { showMessage } from "../../lib/dialogs";
import { IconDownload, IconChevronDown } from "../icons";

interface ExportMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  getEditor: () => Editor | undefined;
  /** 源代码模式下富文本导出需先退出 */
  sourceMode: boolean;
}

export function ExportMenu({ open, onOpenChange, getEditor, sourceMode }: ExportMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // #188：打开聚焦首项 + 方向键导航（Esc 关闭由 EditorTopbar 统一处理）
  useMenuA11y({ ref: menuRef, enabled: open, focusFirstOnOpen: true });

  /** 富文本类导出的源码模式守卫；被拦截时返回 true */
  const blockedBySourceMode = () => {
    if (sourceMode) {
      void showMessage("请先退出源代码模式再导出富文本格式", { kind: "info" });
      return true;
    }
    return false;
  };

  return (
    <div className="export-menu">
      <button
        className="topbar-btn topbar-btn-label"
        onClick={() => onOpenChange(!open)}
        title="导出"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <IconDownload size={15} />
        导出
        <IconChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="export-backdrop" onClick={() => onOpenChange(false)} />
          <div className="export-dropdown" role="menu" ref={menuRef}>
            <button
              className="export-item" role="menuitem"
              onClick={() => {
                onOpenChange(false);
                if (blockedBySourceMode()) return;
                void copyRichText(getEditor).then((ok) => {
                  if (!ok) void showMessage("复制失败，请检查浏览器剪贴板权限", { kind: "error" });
                });
              }}
            >
              复制为富文本
            </button>
            <button
              className="export-item" role="menuitem"
              onClick={() => {
                onOpenChange(false);
                void copyMarkdown().then((ok) => {
                  if (!ok) void showMessage("复制失败，请检查浏览器剪贴板权限", { kind: "error" });
                });
              }}
            >
              复制为 Markdown
            </button>
            <div className="export-sep" />
            <button
              className="export-item" role="menuitem"
              onClick={() => {
                onOpenChange(false);
                if (blockedBySourceMode()) return;
                void exportHTML(getEditor);
              }}
            >
              导出 HTML
            </button>
            <button
              className="export-item" role="menuitem"
              onClick={() => {
                onOpenChange(false);
                void exportDocx().then((r) => {
                  if (!r.ok && r.error) void showMessage(r.error, { kind: "error" });
                });
              }}
            >
              导出 Word（.docx，Pandoc）
            </button>
            <button
              className="export-item" role="menuitem"
              onClick={() => {
                onOpenChange(false);
                if (blockedBySourceMode()) return;
                void exportPDF(getEditor);
              }}
            >
              导出 PDF（打印）
            </button>
            <button
              className="export-item" role="menuitem"
              onClick={() => {
                onOpenChange(false);
                if (blockedBySourceMode()) return;
                void exportPNG(getEditor);
              }}
            >
              导出长图（PNG）
            </button>
            <button
              className="export-item" role="menuitem"
              onClick={() => {
                onOpenChange(false);
                void exportOutline();
              }}
            >
              导出大纲（仅标题）
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// 编辑器顶栏：文件名、保存指示器、源码/富文本分段开关、
// 导出与主题下拉菜单、收纳更多操作菜单。
import { useEffect, useState } from "react";
import type { Editor } from "@milkdown/kit/core";
import { SaveIndicator } from "./SaveIndicator";
import { ExportMenu } from "./ExportMenu";
import { ThemeMenu } from "./ThemeMenu";
import { MoreMenu } from "./MoreMenu";
import {
  IconPanelLeft,
  IconCode,
} from "../icons";

interface EditorTopbarProps {
  currentFile: string;
  sourceMode: boolean;
  onToggleSourceMode: () => void;
  onToggleZenMode: () => void;
  onToggleSidebar: () => void;
  onOpenShortcuts: () => void;
  onOpenSettings: () => void;
  getEditor: () => Editor | undefined;
}

export function EditorTopbar({
  currentFile,
  sourceMode,
  onToggleSourceMode,
  onToggleZenMode,
  onToggleSidebar,
  onOpenShortcuts,
  onOpenSettings,
  getEditor,
}: EditorTopbarProps) {
  const [exportOpen, setExportOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // #188：任一顶栏下拉打开时按 Esc 关闭（菜单自身只处理方向键/聚焦）
  useEffect(() => {
    if (!exportOpen && !themeOpen && !moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setExportOpen(false);
      setThemeOpen(false);
      setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportOpen, themeOpen, moreOpen]);

  return (
    <div className="editor-topbar">
      <div className="topbar-left">
        <button
          className="topbar-btn"
          onClick={onToggleSidebar}
          title="切换侧边栏 (Ctrl/Cmd+\)"
          aria-label="切换侧边栏"
        >
          <IconPanelLeft size={15} />
        </button>
        <span
          className="topbar-file"
          title={
            currentFile.startsWith("untitled-")
              ? "未命名草稿（Ctrl+S 另存为）"
              : currentFile
          }
        >
          {currentFile.startsWith("untitled-")
            ? "未命名草稿"
            : currentFile.split(/[\\/]/).pop()}
        </span>
        <SaveIndicator />
      </div>

      <div className="topbar-actions">
        <button
          className={`topbar-btn topbar-btn-label${sourceMode ? " topbar-btn-active" : ""}`}
          onClick={onToggleSourceMode}
          title="源代码模式 (Ctrl/Cmd+Alt+S)"
          aria-pressed={sourceMode}
        >
          <IconCode size={14} />
          {sourceMode ? "富文本" : "源码"}
        </button>

        <ExportMenu
          open={exportOpen}
          onOpenChange={(next) => {
            setExportOpen(next);
            if (next) {
              setThemeOpen(false);
              setMoreOpen(false);
            }
          }}
          getEditor={getEditor}
          sourceMode={sourceMode}
        />

        <ThemeMenu
          open={themeOpen}
          onOpenChange={(next) => {
            setThemeOpen(next);
            if (next) {
              setExportOpen(false);
              setMoreOpen(false);
            }
          }}
        />

        <MoreMenu
          open={moreOpen}
          onOpenChange={(next) => {
            setMoreOpen(next);
            if (next) {
              setExportOpen(false);
              setThemeOpen(false);
            }
          }}
          zenMode={false}
          onToggleZen={onToggleZenMode}
          onOpenShortcuts={onOpenShortcuts}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </div>
  );
}

// 分屏右侧面板：独立于主编辑器的第二编辑器实例，
// 支持源码模式切换、左右交换与关闭。
import type { Editor } from "@milkdown/kit/core";
import { MarkdownEditor } from "./Editor";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
import { useWorkspace } from "../../store/workspace";
import { IconArrowLeftRight, IconX, IconCode } from "../icons";

interface SplitPaneProps {
  file: string;
  content: string;
  sourceMode: boolean;
  revision?: number;
  editorZoom: number;
  onToggleSourceMode: () => void;
  /** 分屏编辑器就绪回调（独立于主编辑器实例） */
  onReady: (getEditor: (() => Editor | undefined) | null) => void;
}

export function SplitPane({
  file,
  content,
  sourceMode,
  revision = 0,
  editorZoom,
  onToggleSourceMode,
  onReady,
}: SplitPaneProps) {
  const splitClose = useWorkspace((s) => s.splitClose);
  const splitSwap = useWorkspace((s) => s.splitSwap);

  return (
    <div className="split-pane">
      <div className="split-pane-header">
        <span className="topbar-file" title={file}>
          {file.split(/[\\/]/).pop()}
        </span>
        <div className="topbar-actions">
          <button
            className={`topbar-btn${sourceMode ? " topbar-btn-active" : ""}`}
            onClick={onToggleSourceMode}
            title="源代码模式 (Ctrl/Cmd+Alt+S)"
            aria-pressed={sourceMode}
          >
            <IconCode />
          </button>
          <button className="topbar-btn" onClick={splitSwap} title="左右交换">
            <IconArrowLeftRight />
          </button>
          <button className="topbar-btn" onClick={splitClose} title="关闭分屏">
            <IconX />
          </button>
        </div>
      </div>
      <div
        className="editor-scroll editor-scroll-split-pane"
        style={{ zoom: editorZoom }}
      >
        <EditorErrorBoundary fileName={file}>
          <MarkdownEditor
            filePath={file}
            revision={revision}
            value={content}
            onChange={(md) =>
              useWorkspace.getState().setSplitContentFor(file, md)
            }
            onReady={onReady}
            sourceMode={sourceMode}
          />
        </EditorErrorBoundary>
      </div>
    </div>
  );
}

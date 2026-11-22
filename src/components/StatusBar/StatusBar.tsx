import { useWorkspace } from "../../store/workspace";
import { useSettings, ZOOM_DEFAULT } from "../../store/settings";
import { useDeferredStats } from "../../lib/useDeferredStats";
import "./StatusBar.css";

export function StatusBar() {
  const currentFile = useWorkspace((s) => s.currentFile);
  const content = useWorkspace((s) => s.currentContent);
  const saving = useWorkspace((s) => s.saving);
  const editorZoom = useSettings((s) => s.editorZoom);
  const resetEditorZoom = useSettings((s) => s.resetEditorZoom);

  // 输入停顿后才重新统计；切 tab / 保存时立即刷新（issue #374）
  const stats = useDeferredStats(content, currentFile, saving);

  if (!currentFile) return null;

  const zoomPct = Math.round(editorZoom * 100);

  return (
    <footer className="status-bar">
      <span className="status-item">字数 {stats.words}</span>
      <span className="status-sep">·</span>
      <span className="status-item">字符 {stats.chars}</span>
      <span className="status-sep">·</span>
      <span className="status-item">行 {stats.lines}</span>
      <span className="status-sep">·</span>
      <span className="status-item">阅读 {stats.readingMinutes} 分钟</span>
      <span className="status-spacer" />
      {/* 缩放比例：非 100% 时显示并可点击重置（Ctrl/Cmd+滚轮调整，Ctrl/Cmd+0 重置） */}
      <button
        type="button"
        className={`status-item status-zoom${editorZoom === ZOOM_DEFAULT ? "" : " status-zoom-active"}`}
        title="点击重置为 100% (Ctrl/Cmd+0)"
        onClick={() => resetEditorZoom()}
      >
        {zoomPct}%
      </button>
    </footer>
  );
}

export default StatusBar;

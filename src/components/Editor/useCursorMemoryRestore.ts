// 编辑位置记忆恢复（issue #30 / #136）：
// 编辑器就绪后按 filePath 恢复光标与滚动位置（切 tab / 打开文件）。
// 退出源码模式（sourceMode true→false）的那一次不参与恢复——该方向的
// 恢复由 useSourceModeTransition 全权负责（并把映射后的值写回 tab 记忆），
// 否则本钩子持有的过期记忆（源码会话期间从不更新）会与映射恢复在
// 同一帧互相逐帧覆盖，最终停在过期值。
import { useEffect, useRef } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { useWorkspace } from "../../store/workspace";

export interface CursorMemoryRestoreOptions {
  filePath: string;
  /** 编辑器实例是否仍在初始化 */
  loading: boolean;
  sourceMode: boolean;
  getEditor: () => Editor | undefined;
}

export function useCursorMemoryRestore({
  filePath,
  loading,
  sourceMode,
  getEditor,
}: CursorMemoryRestoreOptions) {
  // 必须按本实例的 filePath 读取，不能读 activeTabPath：切 tab 时它已指向新文件（issue #30）
  const getCursorStateFor = useWorkspace((s) => s.getCursorStateFor);
  // 区分「模式翻转」与「切 tab/打开文件」（issue #136）
  const prevSourceModeRef = useRef(sourceMode);
  useEffect(() => {
    const wasSourceMode = prevSourceModeRef.current;
    prevSourceModeRef.current = sourceMode;
    if (loading || sourceMode) return;
    // 刚从源码模式退出：tab 记忆是进入源码模式前的过期值（或 null→0），
    // 参与恢复会与 useSourceModeTransition 的映射恢复竞态，本帧直接让位
    if (wasSourceMode) return;
    const editor = getEditor();
    if (!editor) return;
    const { pos, scrollTop } = getCursorStateFor(filePath);
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // 恢复光标位置，夹紧到文档有效范围
      if (pos != null) {
        const docSize = view.state.doc.content.size;
        const safePos = Math.max(0, Math.min(pos, docSize));
        try {
          const sel = TextSelection.near(view.state.doc.resolve(safePos));
          view.dispatch(view.state.tr.setSelection(sel));
        } catch {
          // pos 无效时忽略
        }
      }
      // 恢复滚动位置：无记忆值时归零。外层 .editor-scroll 跨 tab 复用，
      // 残留上一文件的 scrollTop，显式重置避免新文件串用旧位置（issue #30）。
      // 立即设置一次 + 下一帧重试：长文档首帧可能尚未排版出完整高度。
      const scrollEl =
        (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
        view.dom.closest<HTMLElement>(".editor-scroll");
      if (!scrollEl) return;
      const target = scrollTop ?? 0;
      const apply = () => {
        if (scrollEl.isConnected) scrollEl.scrollTop = target;
      };
      apply();
      // 大文档打开瞬间代码块/图表尚为占位高度，scrollHeight 可能不足，
      // scrollTop 被钳制在 maxScroll。逐帧重试直到占位撑开、位置到位
      // （30 帧上限；占位高度 v2.3.4 起接近最终值，通常 1-2 帧收敛）
      let frames = 0;
      const settle = () => {
        if (!scrollEl.isConnected) return;
        if (Math.abs(scrollEl.scrollTop - target) < 1 || ++frames > 30) return;
        apply();
        requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    });
  }, [filePath, loading, getEditor, getCursorStateFor, sourceMode]);
}

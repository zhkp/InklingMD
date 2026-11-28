// 编辑位置记忆恢复（tab 切换 / 文件打开时生效）：
// 从 workspace store 读取该文件记忆的光标位置与滚动位置，恢复到 WYSIWYG 编辑器。
//
// 单一写者原则（issue #136）：sourceMode 翻转（进入/退出源码模式）触发的
// effect 重跑必须跳过恢复——退出源码模式时的光标/滚动恢复由
// useSourceModeTransition 全权负责。若本 effect 也参与恢复，它会用过期的
// tab 记忆（进入源码模式前的旧 scrollTop，且进入时 WYSIWYG 容器塌缩被钳 0
// 还会把记忆污染为 0）与模式切换恢复形成双写者竞态：两条 30 帧逐帧 settle
// 循环交替向同一滚动容器写不同目标，胜负取决于 rAF 注册时序，最终视口
// 可能停在过期位置。跳过后，模式切换路径只有 useSourceModeTransition 一个写者。
import { useEffect, useRef } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { useWorkspace } from "../../store/workspace";
import { hasActiveHydration } from "./tab-editor-cache";

interface CursorStateRestoreOptions {
  /** 是否处于源码模式 */
  sourceMode: boolean;
  /** 本编辑器实例绑定的文件路径 */
  filePath: string;
  /** 同路径重载修订号：reloadFile 后需要重新恢复记忆位置（改前靠重挂触发） */
  revision: number;
  /** Milkdown 编辑器是否就绪 */
  loading: boolean;
  getEditor: () => Editor | undefined;
}

export function useCursorStateRestore({
  sourceMode,
  filePath,
  revision,
  loading,
  getEditor,
}: CursorStateRestoreOptions) {
  const getCursorStateFor = useWorkspace((s) => s.getCursorStateFor);
  // 上次 effect 运行时的 sourceMode：发生变化说明本次触发来自模式切换，
  // 恢复应让位给 useSourceModeTransition
  const prevSourceModeRef = useRef(sourceMode);
  const prevFilePathRef = useRef(filePath);

  useEffect(() => {
    const sameFile = prevFilePathRef.current === filePath;
    prevFilePathRef.current = filePath;
    const modeFlipped = sameFile && prevSourceModeRef.current !== sourceMode;
    prevSourceModeRef.current = sourceMode;
    if (modeFlipped) return;
    if (loading || sourceMode) return;
    const editor = getEditor();
    if (!editor) return;
    const { pos, scrollTop } = getCursorStateFor(filePath);
    let disposed = false;
    let rafId = 0;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // 本编辑器实例是否仍在分片水合（按 view 判定：分屏侧水合不该牵连主编辑器）
      const hydratingHere = () => hasActiveHydration(view);
      // 位置记忆只恢复折叠光标：切回缓存 tab 时 Editor 已恢复切走前的区间选区，
      // 这里再用 TextSelection.near(pos) 会把它折叠成单点。小文档缓存命中时
      // 水合在 Editor 的 layout effect 里同步完成，本 effect 运行时
      // hasActiveHydration 已为 false，原判据拦不住（#431 评审）。
      const hasRangeSelection = !view.state.selection.empty;
      // 恢复光标位置，夹紧到文档有效范围（水合未完成时末片会用缓存选区再恢复一次）
      if (pos != null && !hydratingHere() && !hasRangeSelection) {
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
      // 立即设置一次 + 逐帧重试：长文档首帧可能尚未排版出完整高度。
      const scrollEl =
        (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
        view.dom.closest<HTMLElement>(".editor-scroll");
      if (!scrollEl) return;
      const target = scrollTop ?? 0;
      const apply = () => {
        if (scrollEl.isConnected) scrollEl.scrollTop = target;
      };
      apply();
      // 首帧写入后记录实际落点：长文档此时可能还没排版出完整高度，
      // scrollTop 会被钳制在 maxScroll，不能拿 target 当基线。
      const hydrationBaseline = scrollEl.scrollTop;
      // 水合期间不再逐帧写 scrollTop：那会把用户在水合窗口内的滚动持续拽回
      // 记忆位置（#431 评审 B6）。水合完成后，仅当用户没有自己滚动过才收敛到 target。
      let frames = 0;
      let hydrationFinished = false;
      const settle = () => {
        if (disposed || !scrollEl.isConnected) return;
        if (hydratingHere()) {
          rafId = requestAnimationFrame(settle);
          return;
        }
        if (!hydrationFinished) {
          hydrationFinished = true;
          // 用户在水合窗口内滚动过（位置已偏离首帧落点）：尊重用户，不再拽回
          if (Math.abs(scrollEl.scrollTop - hydrationBaseline) >= 1) return;
        }
        if (Math.abs(scrollEl.scrollTop - target) < 1 || ++frames > 30) return;
        apply();
        rafId = requestAnimationFrame(settle);
      };
      rafId = requestAnimationFrame(settle);
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
    };
  }, [filePath, revision, loading, getEditor, getCursorStateFor, sourceMode]);
}

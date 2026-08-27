// 进入/退出源码模式的双向切换逻辑：
// - 进入：采集 WYSIWYG 光标与滚动位置，互斥专注/打字机模式
// - 退出：把源码灌回 ProseMirror，重置撤销历史，恢复光标与滚动位置
// - 解析失败：回退源码模式并把内容复制到剪贴板，避免白屏
import { useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { Plugin } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  flushAllMarkdownPublishers,
} from "./markdown-publisher";
import { useSettings } from "../../store/settings";
import { useWorkspace } from "../../store/workspace";
import {
  mapScrollTop,
  markdownOffsetToProsePos,
  prosePosToMarkdownOffset,
} from "../../lib/source-mode-cursor";
import { getSourceModeScroll } from "../../lib/source-mode-scroll";
import { showMessage } from "../../lib/dialogs";

export interface CursorScrollSnapshot {
  cursor: number;
  scrollTop: number;
  /** 源容器（WYSIWYG/CM）滚动容器总高度，用于退出时按高度比例映射到目标印记容器 */
  scrollHeight?: number;
}

interface SourceModeTransitionOptions {
  sourceMode: boolean;
  filePath: string;
  value: string;
  getEditor: () => Editor | undefined;
  /** 与编辑器 publisher 共享的最近同步值 ref */
  lastSyncedRef: { current: string };
  /** 持续缓存的富文本滚动位置（避免在 display:none 时现场读取被浏览器重排钳 0） */
  getWysiwygScrollTop?: () => number;
}

/**
 * 管理源码模式的进入/退出过渡。
 * 返回 enterSnapshot（供 SourceModeEditor 挂载时恢复光标）
 * 与 exitSnapshotRef（供其卸载时回写退出快照）。
 */
export function useSourceModeTransition({
  sourceMode,
  filePath,
  value,
  getEditor,
  lastSyncedRef,
  getWysiwygScrollTop,
}: SourceModeTransitionOptions) {
  const prevSourceModeRef = useRef(sourceMode);
  const exitSnapshotRef = useRef<CursorScrollSnapshot | null>(null);
  const [enterSnapshot, setEnterSnapshot] = useState<CursorScrollSnapshot | null>(
    sourceMode ? { cursor: 0, scrollTop: 0 } : null,
  );
  const getEditorRef = useRef(getEditor);
  getEditorRef.current = getEditor;

  useLayoutEffect(() => {
    const prev = prevSourceModeRef.current;
    if (sourceMode && !prev) {
      const settings = useSettings.getState();
      if (settings.focusMode) settings.setFocusMode(false);
      if (settings.typewriterMode) settings.setTypewriterMode(false);

      let cursor = 0;
      let scrollTop = getWysiwygScrollTop ? getWysiwygScrollTop() : 0;
      // 先 flush 防抖窗口内的待发编辑（idle 编辑器自动跳过），store 内容即事实源。
      // 不能无条件「当场序列化」：未编辑文档的序列化结果可能与原文有规范化
      // 差异，会被误当编辑发布、标 dirty 并改写从未编辑的文件
      flushAllMarkdownPublishers();
      const fresh =
        useWorkspace.getState().openTabs.find((t) => t.path === filePath)
          ?.content ?? value;
      const editor = getEditor();
      let scrollHeight = 0;
      if (editor) {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const head = view.state.selection.head;
          const textBefore = view.state.doc.textBetween(0, head, "\n", "\n");
          cursor = prosePosToMarkdownOffset(fresh, textBefore);
          const scrollEl =
            (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
            view.dom.closest(".editor-scroll");
          if (scrollEl instanceof HTMLElement) {
            if (scrollTop === 0) scrollTop = scrollEl.scrollTop;
            scrollHeight = scrollEl.scrollHeight;
          }
        });
      }
      setEnterSnapshot({ cursor, scrollTop, scrollHeight });
      lastSyncedRef.current = fresh;
    }

    if (!sourceMode && prev) {
      const liveCmScroll = getSourceModeScroll(filePath);
      const snap = liveCmScroll ?? exitSnapshotRef.current;
      exitSnapshotRef.current = null;
      const editor = getEditor();
      if (editor) {
        let parseOk = false;
        try {
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const parser = ctx.get(parserCtx);
            const newDoc = parser(value);
            let tr = view.state.tr.replaceWith(
              0,
              view.state.doc.content.size,
              newDoc.content,
            );
            // 重置撤销历史（issue #27）：整文档替换后旧 PM undo 步骤指向
            // 切换前的快照，Ctrl+Z 会退回与当前 markdown 不一致的旧文档。
            // 取 history 插件初始空状态灌入，让撤销从退出源码模式后的首次
            // 编辑开始。history 插件 key 是 "history$" 前缀且模块私有，
            // 通过插件实例拿到真实 key，setMeta 用同一字符串键才能被
            // prosemirror-history 的 applyTransaction 命中。
            // 类型断言说明：@milkdown/kit 的 Plugin 类型未声明 key 字段
            // （prosemirror 实际有），history 的 init() 不读入参。
            type HistoryPlugin = Plugin & {
              key: string;
              spec: { state?: { init: () => unknown } };
            };
            const historyPlugin = view.state.plugins.find((p) =>
              (p as HistoryPlugin).key.startsWith("history"),
            ) as HistoryPlugin | undefined;
            if (historyPlugin?.spec.state) {
              tr = tr.setMeta(historyPlugin.key, {
                historyState: historyPlugin.spec.state.init(),
              });
            }
            view.dispatch(tr);
          });
          lastSyncedRef.current = value;
          parseOk = true;
        } catch (e) {
          console.error("退出源码模式时解析失败：", e);
          void navigator.clipboard.writeText(value).catch(() => {});
          void showMessage(
            "解析失败：无法切换回渲染视图。当前 Markdown 仍保留在编辑器中，并已尝试复制到剪贴板。请检查源码语法后重试。",
            { title: "解析失败", kind: "error" },
          );
          // 失败时恢复快照以便 SourceModeEditor 重新就绪
          setEnterSnapshot({
            cursor: snap?.cursor ?? 0,
            scrollTop: snap?.scrollTop ?? 0,
          });
          useWorkspace.getState().setTabSourceMode(true, filePath);
          prevSourceModeRef.current = true;
          return;
        }
        setEnterSnapshot(null);
        if (parseOk && snap) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const ed = getEditorRef.current();
              if (!ed) return;
              ed.action((ctx) => {
                const view = ctx.get(editorViewCtx);
                const docSize = view.state.doc.content.size;
                const pos = markdownOffsetToProsePos(docSize, value, snap.cursor);
                try {
                  const sel = TextSelection.near(
                    view.state.doc.resolve(Math.max(1, Math.min(pos, docSize - 1))),
                    -1,
                  );
                  view.dispatch(view.state.tr.setSelection(sel));
                } catch {
                  try {
                    view.dispatch(
                      view.state.tr.setSelection(
                        TextSelection.near(view.state.doc.resolve(1), 1),
                      ),
                    );
                  } catch {
                    // pos 无效时忽略
                  }
                }
                const scrollEl =
                  (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
                  view.dom.closest(".editor-scroll");
                if (scrollEl instanceof HTMLElement) {
                  // CM（源码）与 PM（印记）布局不同导致滚动容器高度不同，若两侧高度
                  // 均可读，则按高度比例把源码滚动位置映射到印记容器，避免等像素赋值造成错位。
                  const targetTop =
                    snap.scrollHeight && scrollEl.scrollHeight > 0
                      ? mapScrollTop(snap.scrollTop, snap.scrollHeight, scrollEl.scrollHeight)
                      : snap.scrollTop;
                  const applyScroll = () => {
                    if (scrollEl.isConnected) {
                      scrollEl.scrollTop = targetTop;
                    }
                  };
                  applyScroll();
                  // 单一写者原则（issue #136）：把映射后的光标与滚动位置写回
                  // tab 记忆，取代进入源码模式前的过期值。后续切 tab 再切回时
                  // 「编辑位置记忆」effect 恢复的就是本次模式切换的最终位置。
                  useWorkspace
                    .getState()
                    .saveCursorState(
                      filePath,
                      view.state.selection.head,
                      Math.round(targetTop),
                    );
                  let frames = 0;
                  const settle = () => {
                    if (!scrollEl.isConnected) return;
                    if (
                      Math.abs(scrollEl.scrollTop - targetTop) < 1 ||
                      ++frames > 30
                    )
                      return;
                    applyScroll();
                    requestAnimationFrame(settle);
                  };
                  requestAnimationFrame(settle);
                }
              });
            });
          });
        }
      }
    }

    prevSourceModeRef.current = sourceMode;
  }, [sourceMode, getEditor, value, filePath, lastSyncedRef]);

  return { enterSnapshot, exitSnapshotRef };
}

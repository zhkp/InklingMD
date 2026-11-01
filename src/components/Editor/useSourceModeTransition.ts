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
import { markOutlineImmediateRefresh } from "./outline-tracker";
import { useSettings } from "../../store/settings";
import { useWorkspace } from "../../store/workspace";
import { selectOutlineForFile, useOutline } from "../../store/outline";
import {
  mapScrollTop,
  markdownNormLine,
  markdownOffsetToProsePos,
  offsetToLineColumn,
  prosePosToMarkdownOffset,
} from "../../lib/source-mode-cursor";
import { getSourceModeScroll } from "../../lib/source-mode-scroll";
import { showMessage } from "../../lib/dialogs";

export interface CursorScrollSnapshot {
  cursor: number;
  scrollTop: number;
  /** 源容器（WYSIWYG/CM）滚动容器总高度，比例映射兜底用 */
  scrollHeight?: number;
  /** 视口顶部可见内容对应的 markdown 偏移（内容锚点，#136）：恢复时
   *  把同一段内容滚到目标容器视口顶部，密度不均也不丢阅读位置 */
  anchorOffset?: number;
  /** 退出时光标所在行是否在源码视口内（#136）：仅此时退出恢复才做
   *  光标可见性微调，避免「只滚动未动光标」往返场景被陈旧光标拽偏 */
  cursorVisible?: boolean;
}

/**
 * 读取滚动容器的有效 zoom（editorZoom != 100% 时 EditorBody 会对 .editor-scroll
 * 施加 CSS zoom）。优先取 computed zoom（标准返回数值 "1.25"，旧实现返回
 * 百分比 "125%"），不可用时用「视口高度 / 布局高度」几何推断，最终兜底 1。
 */
function getScrollZoom(el: HTMLElement, rect: DOMRect): number {
  try {
    const raw = window.getComputedStyle(el).zoom;
    if (typeof raw === "string" && raw.trim()) {
      const parsed = parseFloat(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return raw.trim().endsWith("%") ? parsed / 100 : parsed;
      }
    }
  } catch {
    // 走几何兜底
  }
  if (el.clientHeight > 0 && rect.height > 0) {
    const inferred = rect.height / el.clientHeight;
    if (Number.isFinite(inferred) && inferred > 0) return inferred;
  }
  return 1;
}

/**
 * 内容锚点 → PM 精确位置（退出方向，#136）。
 * 权重比例法（markdownOffsetToProsePos）在代码占比高的文档里会偏出当前
 * 区块。此处退出现场即有解析好的 PM doc：取锚点行的纯文本形态，在
 * doc 全文文本里定位（重复行取与权重估计最近的一处），再二分找出
 * 覆盖该文本索引的最小 PM pos。锚点行命不中时向下/向上最多收集 8 条
 * 候选行逐一尝试（标记密集行剥标记后常可命中）；全部失败退回权重比例法。
 * 行归一化复用 source-mode-cursor 的 markdownNormLine，消除双实现漂移（review N3）。
 */
function resolveAnchorProsePos(
  view: EditorView,
  markdown: string,
  anchorOffset: number,
  docSize: number,
): number {
  const fallback = markdownOffsetToProsePos(docSize, markdown, anchorOffset);
  const lines = markdown.split("\n");
  const { line } = offsetToLineColumn(markdown, anchorOffset);
  const candidates: string[] = [];
  const pushLine = (i: number) => {
    for (const t of markdownNormLine((lines[i] ?? "").trim())) {
      if (t) candidates.push(t);
    }
  };
  for (let i = line; i < lines.length && candidates.length < 4; i++) {
    pushLine(i);
  }
  for (let i = line - 1; i >= 0 && candidates.length < 8; i--) {
    pushLine(i);
  }
  if (candidates.length === 0) return fallback;
  try {
    const pmText = view.state.doc.textBetween(0, docSize, "\n", "\n");
    if (!pmText) return fallback;
    // 消歧估计：把权重法估计的 pos 换算成 PM 文本索引
    let estIdx = -1;
    try {
      estIdx = view.state.doc.textBetween(0, fallback, "\n", "\n").length;
    } catch {
      // 估计失败不影响主流程
    }
    for (const pmLine of candidates) {
      let best = -1;
      let search = 0;
      let guard = 0;
      while (search <= pmText.length && guard++ < 100) {
        const occ = pmText.indexOf(pmLine, search);
        if (occ < 0) break;
        if (
          best < 0 ||
          (estIdx >= 0 && Math.abs(occ - estIdx) < Math.abs(best - estIdx))
        ) {
          best = occ;
        }
        search = occ + 1;
      }
      if (best < 0) continue;
      // 二分：textBetween(0, pos) 长度首次覆盖命中文本索引的 pos 即锚点位置
      const target = best + 1;
      let lo = 1;
      let hi = Math.max(1, docSize - 1);
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (view.state.doc.textBetween(0, mid, "\n", "\n").length >= target) {
          hi = mid;
        } else {
          lo = mid + 1;
        }
      }
      return lo;
    }
    return fallback;
  } catch {
    return fallback;
  }
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
  /** 持续缓存的富文本滚动容器总高度（同理：过渡现场读取时容器已塌陷，值不可信） */
  getWysiwygScrollHeight?: () => number;
  /** 持续缓存的富文本视口顶部内容对应的 PM 位置（内容锚点，#136）。
   *  过渡时容器已 display:none，posAtCoords 现场读不可靠，必须用缓存值 */
  getWysiwygTopPos?: () => number;
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
  getWysiwygScrollHeight,
  getWysiwygTopPos,
}: SourceModeTransitionOptions) {
  const prevSourceModeRef = useRef(sourceMode);
  // Parsing failure updates local snapshot state and asynchronously flips the
  // store back to source mode. Ignore the intermediate local re-render so the
  // failing parser is not called in an update loop before the prop catches up.
  const parseFailurePendingRef = useRef(false);
  const exitSnapshotRef = useRef<CursorScrollSnapshot | null>(null);
  const [enterSnapshot, setEnterSnapshot] = useState<CursorScrollSnapshot | null>(
    sourceMode ? { cursor: 0, scrollTop: 0 } : null,
  );
  const getEditorRef = useRef(getEditor);
  getEditorRef.current = getEditor;

  useLayoutEffect(() => {
    const prev = prevSourceModeRef.current;
    if (parseFailurePendingRef.current) {
      if (sourceMode) parseFailurePendingRef.current = false;
      prevSourceModeRef.current = sourceMode;
      return;
    }
    if (sourceMode && !prev) {
      const settings = useSettings.getState();
      if (settings.focusMode) settings.setFocusMode(false);
      if (settings.typewriterMode) settings.setTypewriterMode(false);

      let cursor = 0;
      let scrollTop = getWysiwygScrollTop ? getWysiwygScrollTop() : 0;
      // 进入瞬间 .md-editor-wysiwyg 已 display:none 塌陷，现场读 scrollHeight
      // ≈ clientHeight，会让比例映射分母失真、目标被钳到容器底部。与
      // scrollTop 同策略：读持续缓存的实时高度，无缓存时才退回现场值。
      let scrollHeight = getWysiwygScrollHeight ? getWysiwygScrollHeight() : 0;
      // 先 flush 防抖窗口内的待发编辑（idle 编辑器自动跳过），store 内容即事实源。
      // 不能无条件「当场序列化」：未编辑文档的序列化结果可能与原文有规范化
      // 差异，会被误当编辑发布、标 dirty 并改写从未编辑的文件
      flushAllMarkdownPublishers();
      const fresh =
        useWorkspace.getState().openTabs.find((t) => t.path === filePath)
          ?.content ?? value;
      // 内容锚点（#136）：视口顶部那段内容在 PM 中的位置（滚动监听持续缓存，
      // 此时容器已 display:none，posAtCoords 现场读不可靠）→ markdown 偏移。
      // textBetween 只读文本不依赖布局，容器塌陷也能安全计算。
      let anchorOffset = 0;
      const topPos = getWysiwygTopPos ? getWysiwygTopPos() : 0;
      const editor = getEditor();
      if (editor) {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const docSize = view.state.doc.content.size;
          let anchorPos = Math.max(0, Math.min(topPos, docSize));
          // 代码块内嵌 CM6（nodeview），其 DOM 无法被 posAtCoords 映射，
          // 命中时返回的位置常在块内/块尾而非真实可见行。统一吸附到块首：
          // 视口顶部看到的块就是锚点目标块（#136）
          try {
            const $pos = view.state.doc.resolve(anchorPos);
            for (let d = $pos.depth; d > 0; d--) {
              if ($pos.node(d).type.name === "code_block") {
                anchorPos = $pos.before(d);
                break;
              }
            }
          } catch {
            // resolve 失败保留原位置
          }
          // 双候选锚点（#136）：posAtCoords 可能恰好落在视口顶部块的边界上，
          // 此时 textBefore 末行是「上一块」；过采 24 字符可让末行变成视口顶部
          // 块的前缀。因此基础 pos 与过采 pos 各采样一次，取更接近比例估计
          // 偏移的候选（posRatio 同时传入尾窗口匹配用于歧义候选的距离裁决）。
          const ratioFor = (end: number) =>
            docSize > 0 ? Math.max(0, Math.min(end, docSize)) / docSize : 0;
          const offsetForEnd = (end: number): number => {
            const e = Math.max(0, Math.min(end, docSize));
            if (e <= 0) return -1;
            const text = view.state.doc.textBetween(0, e, "\n", "\n");
            return prosePosToMarkdownOffset(fresh, text, ratioFor(e));
          };
          const estOffset =
            docSize > 0 ? (anchorPos / docSize) * fresh.length : -1;
          const baseOffset = offsetForEnd(anchorPos);
          const overscanOffset = offsetForEnd(anchorPos + 24);
          anchorOffset =
            baseOffset < 0
              ? Math.max(0, overscanOffset)
              : overscanOffset < 0 || overscanOffset === baseOffset
                ? baseOffset
                : estOffset < 0
                  ? baseOffset
                  : Math.abs(baseOffset - estOffset) <=
                      Math.abs(overscanOffset - estOffset)
                    ? baseOffset
                    : overscanOffset;
          // 光标跟随阅读位置：源码模式光标落在视口顶部内容处，退出时
          // 锚点即光标，往返切换不漂移
          cursor = anchorOffset;
          const scrollEl =
            (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
            view.dom.closest(".editor-scroll");
          if (scrollEl instanceof HTMLElement) {
            if (scrollTop === 0) scrollTop = scrollEl.scrollTop;
            if (scrollHeight <= 0) scrollHeight = scrollEl.scrollHeight;
          }
        });
      }
      setEnterSnapshot({ cursor, scrollTop, scrollHeight, anchorOffset });
      lastSyncedRef.current = fresh;
    }

    if (!sourceMode && prev) {
      // 真实退出流程中：子组件 SourceModeEditor 的 layout cleanup
      // （unregisterSourceModeScroll + onUnmountSnapshot）先于本父级 layout
      // effect 执行，因此 liveCmScroll（注册表）在生产路径必然为 null；
      // 快照实际来自 exitSnapshotRef（onUnmountSnapshot 注入）。liveCmScroll
      // 仅作纯兜底保留（防御注册表在极少数非 React 释放顺序下的残留）。
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
            // 整文档替换挂「同帧刷新大纲」标记（#375）：否则面板在退出后的
            // 首个可见帧仍是源码模式退出前的快照，新增标题要等 tracker 的
            // 150ms 防抖才出现。同时把面板此刻的快照带过去——源码侧已按最新
            // 文档定位过，tracker 自己手里的索引还停在进入源码模式那一刻；
            // 快照里的标题集可能比最新文档旧一个防抖窗口，tracker 会按标题
            // 身份（level + 文本）重映射，不是直接吃索引。
            // 快照按 filePath 取（selectOutlineForFile）：切到别的文件时拿到
            // 空快照 → activeIndex 为 null，不会把旧文件的高亮串过来。
            let tr = markOutlineImmediateRefresh(
              view.state.tr.replaceWith(
                0,
                view.state.doc.content.size,
                newDoc.content,
              ),
              { active: selectOutlineForFile(useOutline.getState(), filePath) },
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
            scrollHeight: snap?.scrollHeight,
            anchorOffset: snap?.anchorOffset,
          });
          useWorkspace.getState().setTabSourceMode(true, filePath);
          parseFailurePendingRef.current = true;
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
                // 内容锚点（#136）：源码视口顶部那行内容的 markdown 偏移
                // （CM 侧 lineBlockAtHeight 采集，随快照回传）→ PM 位置。
                // 锚点缺失时退回光标偏移。不再按滚动比例映射：两容器密度
                // 分布不均，比例映射保住百分比却会落到不同内容上。
                const anchorOffset = snap.anchorOffset ?? snap.cursor;
                const pos = resolveAnchorProsePos(view, value, anchorOffset, docSize);
                const safePos = Math.max(1, Math.min(pos, docSize - 1));
                try {
                  const sel = TextSelection.near(
                    view.state.doc.resolve(safePos),
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
                // 把退出恢复后的光标与滚动位置写回 tab 记忆（单一事实源，#136）：
                // 之后 tab 切走再切回，恢复的是模式切换结束时的位置，
                // 而非进入源码模式前被容器塌缩钳 0 污染的旧值
                const persist = (scrollTop: number) => {
                  useWorkspace
                    .getState()
                    .saveCursorState(
                      filePath,
                      Math.max(0, Math.min(pos, docSize)),
                      scrollTop,
                    );
                };
                if (scrollEl instanceof HTMLElement) {
                  // 把锚点内容滚到视口顶部：用 coordsAtPos 读该内容当前实际
                  // 像素位置，换算成目标 scrollTop。每帧用最新测量重算，跟随
                  // PM 渐进排版（图片/懒测量块高度后补）收敛。不依赖 PM 的
                  // tr.scrollIntoView：Milkdown 下 PM 内部认定的滚动容器与
                  // .editor-scroll 不一致，其滚动不会作用到实际容器。
                  // 不做无条件的「滚到光标可见」收尾校正：选区就设在锚点上，
                  // 两者天然一致；无条件拽视口会在「只滚动未动光标」往返场景
                  // 造成漂移。仅当退出时光标确在源码视口内（见下方 finalize
                  // 的 cursorVisible 门控）才做最小幅度可见性微调。
                  const computeTarget = (): number => {
                    try {
                      // 统一坐标系：coordsAtPos 与 getBoundingClientRect 返回
                      // 缩放后的视口坐标，而 scrollTop 是滚动容器布局单位；
                      // editorZoom != 100% 时（EditorBody 对 .editor-scroll
                      // 施加 CSS zoom）视口偏移须除以有效 zoom 换算回布局单位
                      const coords = view.coordsAtPos(view.state.selection.head);
                      const rect = scrollEl.getBoundingClientRect();
                      const zoom = getScrollZoom(scrollEl, rect);
                      const raw =
                        scrollEl.scrollTop + (coords.top - rect.top) / zoom;
                      const maxScroll = Math.max(
                        0,
                        scrollEl.scrollHeight - scrollEl.clientHeight,
                      );
                      return Math.max(0, Math.min(raw, maxScroll));
                    } catch {
                      // coordsAtPos 失败（极端场景）退回比例映射兜底
                      return snap.scrollHeight && scrollEl.scrollHeight > 0
                        ? mapScrollTop(snap.scrollTop, snap.scrollHeight, scrollEl.scrollHeight)
                        : snap.scrollTop;
                    }
                  };
                  const applyScroll = () => {
                    if (scrollEl.isConnected) scrollEl.scrollTop = computeTarget();
                  };
                  applyScroll();
                  let frames = 0;
                  // 收敛收尾：锚点滚动稳定后，仅当退出时光标确实在源码视口内
                  // （说明用户刚在那附近编辑/阅读）才做最小幅度的可见性微调，
                  // 把光标行拽回可视区。「只滚动未动光标」场景光标不可见，
                  // 跳过微调，避免被陈旧光标拽偏阅读位置（#136）
                  const finalize = (target: number) => {
                    if (snap.cursorVisible) {
                      try {
                        const cursorPos = resolveAnchorProsePos(
                          view,
                          value,
                          snap.cursor,
                          docSize,
                        );
                        const safe = Math.max(1, Math.min(cursorPos, docSize - 1));
                        const coords = view.coordsAtPos(safe);
                        const rect = scrollEl.getBoundingClientRect();
                        const zoom = getScrollZoom(scrollEl, rect);
                        const cursorTop =
                          scrollEl.scrollTop + (coords.top - rect.top) / zoom;
                        const cursorBottom =
                          scrollEl.scrollTop + (coords.bottom - rect.top) / zoom;
                        const viewTop = scrollEl.scrollTop;
                        const viewBottom = viewTop + scrollEl.clientHeight;
                        const margin = 8;
                        if (cursorTop < viewTop + margin) {
                          scrollEl.scrollTop = Math.max(0, cursorTop - margin);
                        } else if (cursorBottom > viewBottom - margin) {
                          scrollEl.scrollTop =
                            cursorBottom + margin - scrollEl.clientHeight;
                        }
                      } catch {
                        // 微调失败不影响锚点恢复结果
                      }
                    }
                    persist(scrollEl.isConnected ? scrollEl.scrollTop : target);
                  };
                  const settle = () => {
                    if (!scrollEl.isConnected) return;
                    const target = computeTarget();
                    if (
                      Math.abs(scrollEl.scrollTop - target) < 1 ||
                      ++frames > 30
                    ) {
                      finalize(target);
                      return;
                    }
                    applyScroll();
                    requestAnimationFrame(settle);
                  };
                  requestAnimationFrame(settle);
                } else {
                  // 无滚动容器（罕见）：仍写回源码侧原值，保持记忆与实际一致
                  persist(snap.scrollTop);
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

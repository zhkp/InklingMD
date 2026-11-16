// 大纲面板
// 解析当前文档的标题，生成可点击的目录树。
// 点击标题 → 滚动编辑器到对应标题位置。
// 当前光标所在标题高亮（由主编辑器的 outline-tracker 插件发布）。

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  findEditorHeadingPos,
  type EditorOutlineHeading,
} from "../../lib/outline";
import { runSourceModeScrollToHeading } from "../../lib/source-mode-scroll";
import { selectOutlineForFile, useOutline } from "../../store/outline";
import {
  reuseOutlineItems,
  type CachedOutlineItem,
} from "./outline-item-cache";
import { useWorkspace } from "../../store/workspace";
import "./OutlinePanel.css";

interface OutlinePanelProps {
  /** 获取 Milkdown 编辑器实例，用于滚动定位 */
  getEditor: () => Editor | undefined;
}

interface OutlineItemProps {
  heading: EditorOutlineHeading;
  active: boolean;
  activeRef: (el: HTMLButtonElement | null) => void;
  onClick: (heading: EditorOutlineHeading) => void;
}

/** 列表项 memo 化：滚动仅切换 active 两项的重渲染，标题多时不重建整列表 */
const OutlineItem = memo(function OutlineItem({
  heading,
  active,
  activeRef,
  onClick,
}: OutlineItemProps) {
  return (
    <button
      ref={active ? activeRef : undefined}
      className={`outline-item outline-h${heading.level}${active ? " outline-item-active" : ""}`}
      style={{ paddingLeft: `${(heading.level - 1) * 12 + 8}px` }}
      title={heading.text}
      onClick={() => onClick(heading)}
    >
      <span className="outline-item-text">{heading.text}</span>
    </button>
  );
});

const OUTLINE_SCROLL_DURATION = 280;
const outlineScrollFrames = new WeakMap<HTMLElement, number>();

/** 尽量将当前大纲项置于可视区中央；首尾内容不足时自然贴边。 */
function centerOutlineItem(scroller: HTMLElement, item: HTMLElement) {
  const scrollerRect = scroller.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const itemCenter = itemRect.top + itemRect.height / 2;
  const scrollerCenter = scrollerRect.top + scrollerRect.height / 2;
  let targetTop = scroller.scrollTop + itemCenter - scrollerCenter;

  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  targetTop = Math.max(0, Math.min(targetTop, maxTop));
  if (Math.abs(targetTop - scroller.scrollTop) < 0.5) return;

  const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
  scroller.scrollTo({ top: targetTop, behavior });
}

/** 用固定时长的缓动滚动，避免原生 smooth 在长文档中耗时过长 */
function animateScrollTo(scroller: HTMLElement, targetTop: number) {
  const activeFrame = outlineScrollFrames.get(scroller);
  if (activeFrame != null) cancelAnimationFrame(activeFrame);

  const startTop = scroller.scrollTop;
  const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const endTop = Math.max(0, Math.min(targetTop, maxTop));
  const distance = endTop - startTop;

  if (
    Math.abs(distance) < 1 ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    scroller.scrollTop = endTop;
    outlineScrollFrames.delete(scroller);
    return;
  }

  const startTime = performance.now();
  const step = (now: number) => {
    if (!scroller.isConnected) {
      outlineScrollFrames.delete(scroller);
      return;
    }

    const progress = Math.min((now - startTime) / OUTLINE_SCROLL_DURATION, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    scroller.scrollTop = startTop + distance * eased;

    if (progress < 1) {
      const frame = requestAnimationFrame(step);
      outlineScrollFrames.set(scroller, frame);
    } else {
      scroller.scrollTop = endTop;
      outlineScrollFrames.delete(scroller);
    }
  };

  const frame = requestAnimationFrame(step);
  outlineScrollFrames.set(scroller, frame);
}

/** 滚动编辑器到快照对应的标题节点 */
function scrollToHeading(
  getEditor: () => Editor | undefined,
  heading: EditorOutlineHeading,
  currentFile: string | null,
) {
  // 如果是源码模式，尝试走源码模式滚动路由（Issue #118）
  if (currentFile) {
    const sourceScrolled = runSourceModeScrollToHeading(currentFile, heading);
    if (sourceScrolled) return;
  }

  const editor = getEditor();
  if (!editor) return;
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const doc = view.state.doc;
    const targetPos = findEditorHeadingPos(doc, heading);
    if (targetPos != null) {
      // 先更新选区并聚焦。若先启动 smooth scroll，ProseMirror 会在选区
      // 更新时恢复旧滚动位置，导致第一次点击的滚动被抵消。
      const sel = TextSelection.near(doc.resolve(targetPos + 1));
      view.dispatch(view.state.tr.setSelection(sel));
      view.focus();

      // 等选区、焦点及相关 React 状态完成布局后，再滚动实际的编辑区容器。
      requestAnimationFrame(() => {
        if (!view.dom.isConnected) return;
        const dom = view.nodeDOM(targetPos);
        const scroller = view.dom.closest<HTMLElement>(".editor-scroll");
        if (!(dom instanceof HTMLElement) || !scroller) return;

        const targetRect = dom.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const toolbar =
          view.dom
            .closest<HTMLElement>(".md-editor-root")
            ?.querySelector<HTMLElement>(".table-toolbar") ?? null;
        const topOffset = (toolbar?.getBoundingClientRect().height ?? 0) + 8;
        const targetTop =
          scroller.scrollTop + targetRect.top - scrollerRect.top - topOffset;
        animateScrollTo(scroller, targetTop);
      });
    }
  });
}

export function OutlinePanel({ getEditor }: OutlinePanelProps) {
  // 快照走独立 store：滚动高频更新只重渲染本面板，不再牵连 App 树
  const currentFile = useWorkspace((s) => s.currentFile);
  const snapshot = useOutline((s) => selectOutlineForFile(s, currentFile));
  const { headings, activeIndex } = snapshot;
  const treeRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const setActiveItemRef = useCallback((el: HTMLButtonElement | null) => {
    activeItemRef.current = el;
  }, []);
  // `getEditor` 由父组件每次渲染新建（内联箭头），不能进 useCallback 依赖：
  // 否则下面的列表 useMemo 每次都被推翻，等于没缓存。用 ref 延后读取。
  const getEditorRef = useRef(getEditor);
  useEffect(() => {
    getEditorRef.current = getEditor;
  });
  const handleClick = useCallback(
    (heading: EditorOutlineHeading) =>
      scrollToHeading(getEditorRef.current, heading, currentFile),
    [currentFile],
  );

  useEffect(() => {
    if (activeIndex == null) return;
    const frame = requestAnimationFrame(() => {
      const tree = treeRef.current;
      const item = activeItemRef.current;
      if (tree && item) centerOutlineItem(tree, item);
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIndex]);

  /**
   * 列表元素缓存（#375 收尾）：两条独立的浪费都要挡掉。
   *
   * 1. **父级重渲染**：源码模式每键都改内容 → App 重渲染 → `getEditor` 新引用
   *    → 本面板重渲染。若每次都 `headings.map`，763 个标题的文档每次新建
   *    763 个 React 元素（dev 下 `jsxDEV` 的元素创建实测吃掉 ~60ms，顶出长任务）。
   *    用 useMemo 把依赖收到「快照 + 活动项 + 稳定回调」。
   * 2. **发布引起的整表重建**：大纲发布时 `headings` 是全新对象数组，即便
   *    文字没变，浅比较也全部失效。这里按 `id` 缓存**元素本身**：标题内容与
   *    active 都没变时复用同一个 React 元素对象——引用相同，React 直接跳过
   *    该子树的协调与渲染，只新建真正变化的那几项。DOM 结构仍是完整列表，
   *    不影响滚动定位与既有断言。
   */
  const elementCache = useRef(new Map<string, CachedOutlineItem>());
  const items = useMemo(() => {
    const { elements, cache } = reuseOutlineItems(
      elementCache.current,
      headings,
      activeIndex,
      (heading, active) => (
        <OutlineItem
          key={heading.id}
          heading={heading}
          active={active}
          activeRef={setActiveItemRef}
          onClick={handleClick}
        />
      ),
    );
    // 只保留当前文档的缓存，切文件不会累积
    elementCache.current = cache;
    return elements;
  }, [headings, activeIndex, handleClick, setActiveItemRef]);

  return (
    <aside className="outline-panel">
      <div className="outline-header">
        <span className="outline-title">大纲</span>
      </div>
      <div className="outline-tree" ref={treeRef}>
        {headings.length === 0 ? (
          <div className="outline-empty">文档暂无标题</div>
        ) : (
          items
        )}
      </div>
    </aside>
  );
}

export default OutlinePanel;

// 大纲列表的元素复用（#375 收尾）
//
// 背景：源码模式每键都会更新内容 → App 重渲染 → 大纲面板重渲染；大纲发布时
// `headings` 还是全新对象数组。若每次都在面板里 `headings.map(<OutlineItem/>)`，
// 763 个标题的文档每渲染一次就新建 763 个 React 元素——`input-source-L-rich`
// 实测顶出 ~60ms 长任务（热点帧 `jsxDEV` / `addValueToProperties`）。
//
// 解法：按 `id` 缓存**元素对象本身**。渲染输入（标题内容 + active + 回调身份）
// 都没变时复用同一个元素引用——React 看到相同 element 会跳过该子树的协调与
// 渲染；DOM 结构仍是完整列表，滚动定位与既有断言不受影响。
import type { ReactElement } from "react";
import type { EditorOutlineHeading } from "../../lib/outline";

/** 创建列表项时绑定的回调；身份变化即代表旧元素不可复用 */
export interface OutlineItemCallbacks {
  onClick: (heading: EditorOutlineHeading) => void;
  activeRef: (el: HTMLButtonElement | null) => void;
}

export interface CachedOutlineItem {
  element: ReactElement;
  heading: EditorOutlineHeading;
  active: boolean;
  /** 创建该元素时绑定的回调（#419 评审 B1）：回调换了就不能复用 */
  callbacks: OutlineItemCallbacks;
}

/** 两个标题是否会渲染出完全一样的列表项 */
export function sameOutlineHeading(
  a: EditorOutlineHeading,
  b: EditorOutlineHeading,
): boolean {
  return (
    a.id === b.id &&
    a.index === b.index &&
    a.level === b.level &&
    a.text === b.text &&
    a.pos === b.pos &&
    a.nodeId === b.nodeId
  );
}

/**
 * 复用上一轮的元素对象，只新建真正变化的项。
 *
 * 命中条件是**渲染输入完全一致**：同 id、同标题字段、同 active、同回调身份。
 * 回调（`onClick` 闭包了 `currentFile`）换掉时必须重建——否则换文件后点击
 * 仍会走旧文件的滚动处理器（#419 评审 B1：id 是 `h-<index>-<slug>`，不含
 * 文件路径，两个同构文档的 id 逐字段相同，靠缓存命中就会留下旧闭包）。
 *
 * 返回新数组与新缓存（缓存只保留当前文档的 id，切文件不会累积）。
 */
export function reuseOutlineItems(
  prev: ReadonlyMap<string, CachedOutlineItem>,
  headings: readonly EditorOutlineHeading[],
  activeIndex: number | null,
  callbacks: OutlineItemCallbacks,
  create: (
    heading: EditorOutlineHeading,
    active: boolean,
    callbacks: OutlineItemCallbacks,
  ) => ReactElement,
): {
  elements: ReactElement[];
  cache: Map<string, CachedOutlineItem>;
} {
  const cache = new Map<string, CachedOutlineItem>();
  const elements = headings.map((heading) => {
    const active = heading.index === activeIndex;
    const cached = prev.get(heading.id);
    if (
      cached &&
      cached.active === active &&
      cached.callbacks.onClick === callbacks.onClick &&
      cached.callbacks.activeRef === callbacks.activeRef &&
      sameOutlineHeading(cached.heading, heading)
    ) {
      cache.set(heading.id, cached);
      return cached.element;
    }
    const element = create(heading, active, callbacks);
    cache.set(heading.id, { element, heading, active, callbacks });
    return element;
  });
  return { elements, cache };
}

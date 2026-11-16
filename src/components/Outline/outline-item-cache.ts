// 大纲列表的元素复用（#375 收尾）
//
// 背景：源码模式每键都会更新内容 → App 重渲染 → 大纲面板重渲染；大纲发布时
// `headings` 还是全新对象数组。若每次都在面板里 `headings.map(<OutlineItem/>)`，
// 763 个标题的文档每渲染一次就新建 763 个 React 元素，dev 下 `jsxDEV` 的
// 元素创建实测吃掉 ~60ms，直接顶出长任务（L 档 20k 行输入实测 13→0.3 次/轮）。
//
// 解法：按 `id` 缓存**元素对象本身**。标题内容与 active 都没变时复用同一个
// 元素引用——React 看到相同 element 会跳过该子树的协调与渲染；DOM 结构仍是
// 完整列表，滚动定位与既有断言不受影响。
import type { ReactElement } from "react";
import type { EditorOutlineHeading } from "../../lib/outline";

export interface CachedOutlineItem {
  element: ReactElement;
  heading: EditorOutlineHeading;
  active: boolean;
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
 * 返回新数组与新缓存（缓存只保留当前文档的 id，切文件不会累积）。
 * 缓存命中条件是「同 id + 渲染输入完全一致」；`active` 变化时必然新建。
 */
export function reuseOutlineItems(
  prev: ReadonlyMap<string, CachedOutlineItem>,
  headings: readonly EditorOutlineHeading[],
  activeIndex: number | null,
  create: (heading: EditorOutlineHeading, active: boolean) => ReactElement,
): {
  elements: ReactElement[];
  cache: Map<string, CachedOutlineItem>;
} {
  const cache = new Map<string, CachedOutlineItem>();
  const elements = headings.map((heading) => {
    const active = heading.index === activeIndex;
    const cached = prev.get(heading.id);
    if (cached && cached.active === active && sameOutlineHeading(cached.heading, heading)) {
      cache.set(heading.id, cached);
      return cached.element;
    }
    const element = create(heading, active);
    cache.set(heading.id, { element, heading, active });
    return element;
  });
  return { elements, cache };
}

// 分片水合期间的交互补齐（#431 评审）
//
// 用户在一个编辑器里点击/输入/粘贴/拖放时，如果落点可能在尚未挂载的尾部区域，
// 先把**这个编辑器**的水合同步补齐，保证命中位置准确。
// - 鼠标点击命中已挂载前缀时不补齐（坐标映射已准确，不必付 O(剩余全文) 的插入）；
// - 只作用于传入的 view：无参 flush 会顺带把分屏另一侧的大文档同步插完。

import type { EditorView } from "@milkdown/kit/prose/view";
import {
  flushActiveHydration,
  markActiveHydrationInteraction,
} from "./tab-editor-cache";
import { pointerNeedsHydration } from "./editor-root-click";

/** 在编辑器 DOM 上安装交互补齐监听，返回卸载函数 */
export function attachHydrationFlushOnInteraction(view: EditorView): () => void {
  const flushOnInteraction = (event: Event) => {
    if (event.type === "mousedown") {
      const me = event as MouseEvent;
      if (!pointerNeedsHydration(view, me.clientX, me.clientY)) {
        // 命中已挂载前缀：不补齐，但用户选区已经被改到点击处，
        // 末片不能再套用缓存选区（#431 评审）。
        markActiveHydrationInteraction(view);
        return;
      }
    }
    flushActiveHydration(view);
  };
  view.dom.addEventListener("mousedown", flushOnInteraction, true);
  view.dom.addEventListener("keydown", flushOnInteraction, true);
  view.dom.addEventListener("beforeinput", flushOnInteraction, true);
  view.dom.addEventListener("paste", flushOnInteraction, true);
  view.dom.addEventListener("drop", flushOnInteraction, true);
  return () => {
    view.dom.removeEventListener("mousedown", flushOnInteraction, true);
    view.dom.removeEventListener("keydown", flushOnInteraction, true);
    view.dom.removeEventListener("beforeinput", flushOnInteraction, true);
    view.dom.removeEventListener("paste", flushOnInteraction, true);
    view.dom.removeEventListener("drop", flushOnInteraction, true);
  };
}

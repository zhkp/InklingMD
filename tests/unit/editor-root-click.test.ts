// 分片水合期间的点击补齐判据（#431 评审）
//
// 根容器点击与交互捕获监听必须共用同一判据：命中已挂载前缀时不补齐尾部，
// 否则每次常规点击都会同步插入剩余全文，重新造出长任务。

import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@milkdown/kit/prose/view";
import { pointerNeedsHydration } from "../../src/components/Editor/editor-root-click";

function fakeView(pos: number | null, docSize = 100): EditorView {
  return {
    posAtCoords: vi.fn(() => (pos == null ? null : { pos })),
    state: { doc: { content: { size: docSize } } },
  } as unknown as EditorView;
}

describe("pointerNeedsHydration（#431 评审）", () => {
  it("命中已挂载前缀：不补齐（常规点击不付 O(剩余全文)）", () => {
    const view = fakeView(10);
    expect(pointerNeedsHydration(view, 5, 5)).toBe(false);
    expect(view.posAtCoords).toHaveBeenCalledWith({ left: 5, top: 5 });
  });

  it("映射到已挂载文档末尾（点击越过后半段）：需要补齐", () => {
    expect(pointerNeedsHydration(fakeView(97), 5, 5)).toBe(false);
    expect(pointerNeedsHydration(fakeView(98), 5, 5)).toBe(true);
    expect(pointerNeedsHydration(fakeView(99), 5, 5)).toBe(true);
  });

  it("坐标落空（内边距/内容区之外）：需要补齐后再定位", () => {
    expect(pointerNeedsHydration(fakeView(null), 5, 5)).toBe(true);
  });
});

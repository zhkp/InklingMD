// 大纲列表元素复用（#375 收尾）的回归测试。
//
// 这条机制的失效方式很隐蔽：删掉缓存后功能完全正常，只是万行文档每次重渲染
// 都新建上百个 React 元素，dev 下 `jsxDEV` 的元素创建会顶出 ~60ms 长任务
// （L 档 20k 行实测 13→0.3 次/轮）。所以直接用「元素引用是否被复用」来锁。
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { EditorOutlineHeading } from "../../src/lib/outline";
import {
  reuseOutlineItems,
  sameOutlineHeading,
} from "../../src/components/Outline/outline-item-cache";

function heading(
  id: string,
  index: number,
  text = id,
  extra: Partial<EditorOutlineHeading> = {},
): EditorOutlineHeading {
  return { id, index, level: 1, text, pos: index * 10, nodeId: null, ...extra };
}

/** 用一个带标记的假元素代替 JSX，便于断言引用是否复用 */
function makeCreate() {
  return vi.fn(
    (h: EditorOutlineHeading, active: boolean): ReactElement =>
      ({ type: "item", key: h.id, props: { id: h.id, active } }) as unknown as ReactElement,
  );
}

describe("reuseOutlineItems", () => {
  it("同 id 且渲染输入未变时复用元素引用（发布不重建整表）", () => {
    const create = makeCreate();
    const first = [heading("a", 0), heading("b", 1), heading("c", 2)];
    const r1 = reuseOutlineItems(new Map(), first, 0, create);
    expect(create).toHaveBeenCalledTimes(3);

    // 发布产生了全新的对象数组，但内容完全一致 → 不该新建任何元素
    const second = [heading("a", 0), heading("b", 1), heading("c", 2)];
    const r2 = reuseOutlineItems(r1.cache, second, 0, create);
    expect(create).toHaveBeenCalledTimes(3);
    expect(r2.elements[0]).toBe(r1.elements[0]);
    expect(r2.elements[1]).toBe(r1.elements[1]);
    expect(r2.elements[2]).toBe(r1.elements[2]);
  });

  it("active 变化只重建受影响的两项", () => {
    const create = makeCreate();
    const headings = [heading("a", 0), heading("b", 1), heading("c", 2)];
    const r1 = reuseOutlineItems(new Map(), headings, 0, create);
    create.mockClear();

    const r2 = reuseOutlineItems(r1.cache, headings, 1, create);
    expect(create).toHaveBeenCalledTimes(2); // 旧的 active + 新的 active
    expect(create.mock.calls.map((c) => (c[0] as EditorOutlineHeading).id)).toEqual([
      "a",
      "b",
    ]);
    expect(r2.elements[2]).toBe(r1.elements[2]); // 未受影响项保持引用
  });

  it("文本/层级/位置变化会重建对应项", () => {
    const create = makeCreate();
    const base = [heading("a", 0), heading("b", 1)];
    const r1 = reuseOutlineItems(new Map(), base, null, create);
    create.mockClear();

    reuseOutlineItems(
      r1.cache,
      [heading("a", 0, "改过的标题"), heading("b", 1)],
      null,
      create,
    );
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as EditorOutlineHeading).text).toBe(
      "改过的标题",
    );
  });

  it("新增/删除项：新增才建元素，缓存不保留已删除的 id", () => {
    const create = makeCreate();
    const r1 = reuseOutlineItems(
      new Map(),
      [heading("a", 0), heading("b", 1)],
      null,
      create,
    );
    create.mockClear();

    const r2 = reuseOutlineItems(r1.cache, [heading("a", 0), heading("c", 2)], null, create);
    expect(create).toHaveBeenCalledTimes(1);
    expect([...r2.cache.keys()]).toEqual(["a", "c"]); // b 已被剔除
    expect(r2.elements[0]).toBe(r1.elements[0]);
  });

  it("sameOutlineHeading 逐字段比较（id 相同但文本变了不算同一项）", () => {
    expect(sameOutlineHeading(heading("a", 0), heading("a", 0))).toBe(true);
    expect(sameOutlineHeading(heading("a", 0), heading("a", 0, "x"))).toBe(false);
    expect(
      sameOutlineHeading(heading("a", 0), heading("a", 0, "a", { level: 2 })),
    ).toBe(false);
    expect(
      sameOutlineHeading(heading("a", 0), heading("a", 0, "a", { pos: 99 })),
    ).toBe(false);
  });
});

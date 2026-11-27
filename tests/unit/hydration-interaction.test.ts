// 分片水合期间的交互补齐作用域（#431 评审）
//
// 真实双 EditorView + 真实水合任务：
// - 命中已挂载前缀的点击不补齐（常规点击不付 O(剩余全文)）；
// - 命中尾部/落空时只补齐被点击的那个 view，分屏另一侧仍在分片。

import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import {
  hasActiveHydration,
  startDocHydration,
} from "../../src/components/Editor/tab-editor-cache";
import { attachHydrationFlushOnInteraction } from "../../src/components/Editor/hydration-interaction";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: {
      group: "block",
      content: "text*",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
  },
});

function makeDoc(count: number) {
  return schema.nodes.doc.create(
    null,
    Array.from({ length: count }, (_, i) =>
      schema.nodes.paragraph.create(null, schema.text(`block-${i}`)),
    ),
  );
}

function mountView(): EditorView {
  const doc = makeDoc(40);
  const root = document.createElement("div");
  document.body.appendChild(root);
  return new EditorView(root, {
    state: EditorState.create({ doc, selection: TextSelection.create(doc, 1) }),
  });
}

function click(view: EditorView): void {
  // 只验证本组件的捕获监听：阻止事件继续冒泡到 ProseMirror 自身的 mousedown 处理，
  // 后者在 jsdom/happy-dom 里依赖真实布局（posAtCoords 被本测试替换过）
  const stopper = (event: Event) => event.stopImmediatePropagation();
  view.dom.addEventListener("mousedown", stopper, true);
  view.dom.dispatchEvent(
    new MouseEvent("mousedown", { clientX: 10, clientY: 10, bubbles: true }),
  );
  view.dom.removeEventListener("mousedown", stopper, true);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("attachHydrationFlushOnInteraction（#431 评审）", () => {
  it("前缀命中不补齐；尾部命中只补齐当前 view", () => {
    const a = mountView();
    const b = mountView();
    const taskA = startDocHydration({
      view: a,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    const taskB = startDocHydration({
      view: b,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    const detach = attachHydrationFlushOnInteraction(a);

    // 点击命中已挂载前缀：两个 view 都不补齐
    a.posAtCoords = vi.fn(() => ({ pos: 1 })) as never;
    click(a);
    expect(a.state.doc.childCount).toBe(8);
    expect(b.state.doc.childCount).toBe(8);
    expect(hasActiveHydration(a)).toBe(true);

    // 点击越过已挂载尾部（映射到文档末尾）：只补齐被点击的 A
    a.posAtCoords = vi.fn(() => ({ pos: a.state.doc.content.size - 1 })) as never;
    click(a);
    expect(a.state.doc.childCount).toBe(40);
    expect(hasActiveHydration(a)).toBe(false);
    expect(taskA.isActive()).toBe(false);
    expect(b.state.doc.childCount).toBe(8);
    expect(hasActiveHydration(b)).toBe(true);

    detach();
    taskB.cancel();
    a.destroy();
    b.destroy();
  });

  it("非鼠标交互（输入/粘贴）直接补齐当前 view", () => {
    const a = mountView();
    const b = mountView();
    const taskA = startDocHydration({
      view: a,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    const taskB = startDocHydration({
      view: b,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    const detach = attachHydrationFlushOnInteraction(a);

    a.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(a.state.doc.childCount).toBe(40);
    expect(taskA.isActive()).toBe(false);
    expect(b.state.doc.childCount).toBe(8);

    detach();
    taskB.cancel();
    a.destroy();
    b.destroy();
  });
});

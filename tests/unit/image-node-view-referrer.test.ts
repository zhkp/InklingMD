// #162 远程图片 referrerpolicy 回归防护
// 编辑器渲染 <img> 时必须携带 referrerpolicy=no-referrer，避免文档被打开时
// 把页面 URL / 工作区上下文经 Referer 头泄露给外部图床（跟踪像素场景）。
// 直接构造 ImageNodeView 断言真实 DOM 属性（与 image-node-view-menu 同套手法）。

import { describe, expect, it, vi } from "vitest";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { ImageNodeView } from "../../src/components/Editor/image-node-view";

function fakeNode(): Node {
  return {
    attrs: { src: "", alt: "示例图片", title: null },
    type: { name: "image" },
  } as unknown as Node;
}

function makeView(): ImageNodeView {
  const view = { dispatch: vi.fn() } as unknown as PMView;
  return new ImageNodeView(fakeNode(), view, () => undefined, "/doc.md");
}

/** ImageNodeView.img 是私有字段，测试从渲染出的 DOM 读取 img 元素 */
function imgOf(v: ImageNodeView): HTMLImageElement {
  const img = v.dom.querySelector("img");
  if (!img) throw new Error("img 未渲染");
  return img;
}

describe("#162 图片 referrerpolicy", () => {
  it("img 元素带 referrerpolicy=no-referrer", () => {
    const v = makeView();
    expect(imgOf(v).getAttribute("referrerpolicy")).toBe("no-referrer");
    v.destroy();
  });

  it("渲染后（含 src 路径）仍保留 no-referrer 属性", () => {
    const node = {
      attrs: { src: "assets/photo.png", alt: "图", title: null },
      type: { name: "image" },
    } as unknown as Node;
    const view = { dispatch: vi.fn() } as unknown as PMView;
    const v = new ImageNodeView(node, view, () => undefined, "/doc.md");
    expect(imgOf(v).getAttribute("referrerpolicy")).toBe("no-referrer");
    v.destroy();
  });
});

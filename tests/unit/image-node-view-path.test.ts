// 图片 NodeView 跨文档复用时的基准路径（#431 评审）
//
// 背景：编辑器实例跨 tab 复用后，ProseMirror 替换文档时对「同位置 + 同 src/属性」
// 的图片节点会直接复用 NodeView **且不调用 update()**。若路径只在构造时解析，
// 新文档会显示旧文档目录下的同名图片。修复方式：Editor 在文档切换时调用
// refreshImageDocumentPaths(view)，让存活实例按当前文档路径重新解析。
//
// 本测试用真实 ProseMirror EditorView + 真实 NodeView 复用路径：
// 1. 复用确实发生（DOM 同一性），且刷新前仍是旧路径解析结果；
// 2. refreshImageDocumentPaths 后按新文档目录重新解析；
// 3. 文档路径未变时不做多余解析。

import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema, type Node as PMNode } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import {
  ImageNodeView,
  refreshImageDocumentPaths,
} from "../../src/components/Editor/image-node-view";

/** 路径解析改为可观察的假实现：把 documentPath 直接编进结果，便于断言 */
const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock("../../src/lib/fs", () => ({
  resolveImageSrc: (src: string, documentPath: string) =>
    resolveMock(src, documentPath) as Promise<string>,
}));

function makeSchema() {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        group: "block",
        content: "inline*",
        toDOM: () => ["p", 0],
        parseDOM: [{ tag: "p" }],
      },
      image: {
        inline: true,
        group: "inline",
        attrs: { src: { default: "" }, alt: { default: null }, title: { default: null } },
        toDOM: () => ["img"],
      },
      text: { group: "inline" },
    },
  });
}

const schema = makeSchema();

function makeDoc(): PMNode {
  return schema.nodes.doc.create(
    null,
    schema.nodes.paragraph.create(
      null,
      schema.nodes.image.create({ src: "assets/photo.png", alt: "图", title: null }),
    ),
  );
}

function mountView(pathRef: { value: string }): EditorView {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const doc = makeDoc();
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
  });
  return new EditorView(root, {
    state,
    nodeViews: {
      image: (node, view, getPos) =>
        new ImageNodeView(node, view, getPos, () => pathRef.value),
    },
  });
}

/** 等待 resolveImageSrc 的 then 回调落盘 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function imgSrc(view: EditorView, pos: number): string | null {
  const dom = view.nodeDOM(pos);
  if (!(dom instanceof HTMLElement)) throw new Error("图片节点 DOM 不存在");
  return dom.querySelector("img")?.getAttribute("src") ?? null;
}

afterEach(() => {
  document.body.innerHTML = "";
  resolveMock.mockReset();
});

describe("图片 NodeView 文档路径（#431 评审）", () => {
  it("文档切换复用 NodeView 时，刷新后按新文档目录重新解析", async () => {
    resolveMock.mockImplementation(
      async (src: string, documentPath: string) =>
        `https://asset.local${documentPath}/${src}`,
    );

    const pathRef = { value: "/docs/a/note.md" };
    const view = mountView(pathRef);
    await flushMicrotasks();
    expect(imgSrc(view, 1)).toBe("https://asset.local/docs/a/note.md/assets/photo.png");

    const before = view.nodeDOM(1);
    // 切到另一份内容完全相同的文档：PM 复用 NodeView（不调用 update()）
    pathRef.value = "/docs/b/other.md";
    const nextDoc = makeDoc();
    view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, nextDoc.content));

    expect(view.nodeDOM(1)).toBe(before); // 确认走的是复用路径，而非重建
    expect(imgSrc(view, 1)).toBe("https://asset.local/docs/a/note.md/assets/photo.png");

    refreshImageDocumentPaths(view);
    await flushMicrotasks();
    // 同一个 src 必须按新文档目录解析，不能继续显示旧文档的图片
    expect(imgSrc(view, 1)).toBe("https://asset.local/docs/b/other.md/assets/photo.png");
    expect(resolveMock).toHaveBeenLastCalledWith("assets/photo.png", "/docs/b/other.md");

    view.destroy();
  });

  it("文档路径未变时刷新不重复解析", async () => {
    resolveMock.mockImplementation(
      async (src: string, documentPath: string) =>
        `https://asset.local${documentPath}/${src}`,
    );

    const pathRef = { value: "/docs/a/note.md" };
    const view = mountView(pathRef);
    await flushMicrotasks();
    expect(resolveMock).toHaveBeenCalledTimes(1);

    refreshImageDocumentPaths(view);
    await flushMicrotasks();
    expect(resolveMock).toHaveBeenCalledTimes(1);

    view.destroy();
  });
});

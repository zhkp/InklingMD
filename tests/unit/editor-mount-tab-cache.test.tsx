// 真实挂载 MarkdownEditor 的行为回归（#431 评审 B1 / cachedContent 接线）
//
// 1. 同 filePath/revision 的外部 value 更新（崩溃恢复合并路径）必须进入已挂载文档；
// 2. 切 tab 前 flush 的发布内容要进入缓存：切回后 undo 能撤销切走前的输入
//    （缓存内容用 flush 前的旧值会让缓存 miss、ProseMirror 历史被重置）。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import type { EditorView } from "@milkdown/kit/prose/view";
import { MarkdownEditor } from "../../src/components/Editor/Editor";
import { useWorkspace } from "../../src/store/workspace";

function seedTabs(): void {
  useWorkspace.setState({
    openTabs: [
      {
        path: "/docs/a.md",
        docId: "doc-a",
        content: "OLD-CONTENT",
        dirty: false,
        lastSavedAt: null,
        cursorPos: null,
        scrollTop: null,
        revision: 0,
      },
      {
        path: "/docs/b.md",
        docId: "doc-b",
        content: "B-CONTENT",
        dirty: false,
        lastSavedAt: null,
        cursorPos: null,
        scrollTop: null,
        revision: 0,
      },
    ] as never,
    activeTabPath: "/docs/a.md",
    currentFile: "/docs/a.md",
    currentContent: "OLD-CONTENT",
  } as never);
}

async function waitForEditor(
  getEditor: () => (() => Editor | undefined) | null,
): Promise<{ editor: Editor; view: EditorView }> {
  await waitFor(() => expect(getEditor()).not.toBeNull(), { timeout: 10_000 });
  const editor = getEditor()!()!;
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  await waitFor(() => expect(view.dom.isConnected).toBe(true));
  return { editor, view };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("MarkdownEditor 真实挂载（#431 评审）", () => {
  it("同 path/revision 的外部 value 更新必须更新已挂载文档（B1）", async () => {
    seedTabs();
    let getEditor: (() => Editor | undefined) | null = null;
    const onReady = (getter: (() => Editor | undefined) | null) => {
      if (getter) getEditor = getter;
    };

    const props = (value: string) => ({
      filePath: "/docs/a.md",
      revision: 0,
      value,
      onReady,
    });
    const { rerender } = render(<MarkdownEditor {...props("OLD-CONTENT")} />);
    const { view } = await waitForEditor(() => getEditor);
    await waitFor(() => expect(view.state.doc.textContent).toContain("OLD-CONTENT"));

    // 崩溃恢复 mergeDraftIntoExistingTab：同 path/revision 直接改 store content
    rerender(<MarkdownEditor {...props("RECOVERED-CONTENT")} />);
    await waitFor(
      () => expect(view.state.doc.textContent).toContain("RECOVERED-CONTENT"),
      { timeout: 3_000 },
    );
  });

  it("切 tab 前 flush 的内容进入缓存：切回后能撤销切走前的输入", async () => {
    seedTabs();
    let getEditor: (() => Editor | undefined) | null = null;
    const onReady = (getter: (() => Editor | undefined) | null) => {
      if (getter) getEditor = getter;
    };

    // onChange 必须绑定到自己的 filePath：切 tab 的 layout effect 会用**旧**
    // onChangeRef 刷完旧 tab，再切到新回调（真实 App 的接线方式）
    const props = (filePath: string, value: string) => ({
      filePath,
      revision: 0,
      value,
      onChange: (md: string) =>
        useWorkspace.getState().setContentFor(filePath, md),
      onReady,
    });

    const { rerender } = render(<MarkdownEditor {...props("/docs/a.md", "AAA")} />);
    const { view } = await waitForEditor(() => getEditor);
    await waitFor(() => expect(view.state.doc.textContent).toContain("AAA"));

    // 用户输入后不等 150ms 发布防抖，立即切 tab
    view.dispatch(view.state.tr.insertText("X", 1));
    expect(view.state.doc.textContent).toContain("X");

    rerender(<MarkdownEditor {...props("/docs/b.md", "B-CONTENT")} />);
    await waitFor(() => expect(view.state.doc.textContent).toContain("B-CONTENT"));

    // 切回 A：value 取 store 里 flush 之后的最新内容
    const aContent =
      useWorkspace.getState().openTabs.find((t) => t.path === "/docs/a.md")
        ?.content ?? "";
    expect(aContent).toContain("X");
    rerender(<MarkdownEditor {...props("/docs/a.md", aContent)} />);
    await waitFor(() => expect(view.state.doc.textContent).toContain("X"));

    // 缓存命中时恢复的是同一份历史：undo 必须撤掉切走前的输入
    undo(view.state, (tr) => view.dispatch(tr));
    expect(view.state.doc.textContent).not.toContain("X");
  });
});

// 真实挂载 MarkdownEditor 的行为回归（#431 评审 B1 / cachedContent 接线）
//
// 1. 同 filePath/revision 的外部 value 更新（崩溃恢复合并路径）必须进入已挂载文档；
// 2. 切 tab 前 flush 的发布内容要进入缓存：切回后 undo 能撤销切走前的输入
//    （缓存内容用 flush 前的旧值会让缓存 miss、ProseMirror 历史被重置）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { editorViewCtx, type Editor } from "@milkdown/kit/core";
import { undo } from "@milkdown/kit/prose/history";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { MarkdownEditor } from "../../src/components/Editor/Editor";
import {
  hasActiveHydration,
  markActiveHydrationInteraction,
} from "../../src/components/Editor/tab-editor-cache";
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
  vi.restoreAllMocks();
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

  it("水合窗口内点击已挂载前缀后切走：缓存的是现场选区，不是启动水合前的旧选区", async () => {
    const BLOCKS = 80;
    const bigContent =
      Array.from({ length: BLOCKS }, (_, i) => `block-${i}`).join("\n\n") + "\n";
    useWorkspace.setState({
      openTabs: [
        {
          path: "/docs/a.md",
          docId: "doc-a",
          content: bigContent,
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
      currentContent: bigContent,
    } as never);

    let getEditor: (() => Editor | undefined) | null = null;
    const onReady = (getter: (() => Editor | undefined) | null) => {
      if (getter) getEditor = getter;
    };
    const props = (filePath: string, value: string) => ({
      filePath,
      revision: 0,
      value,
      onReady,
    });

    const { rerender } = render(
      <MarkdownEditor {...props("/docs/a.md", bigContent)} />,
    );
    const { view } = await waitForEditor(() => getEditor);
    await waitFor(
      () => expect(view.state.doc.textContent).toContain(`block-${BLOCKS - 1}`),
      { timeout: 10_000 },
    );

    // 切到 B：A 的完整 doc 进入缓存
    rerender(<MarkdownEditor {...props("/docs/b.md", "B-CONTENT")} />);
    await waitFor(() => expect(view.state.doc.textContent).toContain("B-CONTENT"));

    // 按住水合尾部的 0ms 宏任务：切回 A 后只挂载首片，模拟「用户在大文档水合中点击前缀」。
    // 注意：按住期间的所有断言必须同步完成——RTL 的 waitFor/asyncWrapper 自身也用
    // setTimeout(0) 排空微任务，被按住会直接挂住。
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    let heldChunks = 0;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (!delay) {
        heldChunks += 1;
        return 1;
      }
      return realSetTimeout(fn as never, delay, ...(args as never[]));
    }) as typeof setTimeout);

    rerender(<MarkdownEditor {...props("/docs/a.md", bigContent)} />);
    // 缓存命中：首片同步挂载、尾部被按住 → 水合在途
    expect(hasActiveHydration(view)).toBe(true);
    expect(view.state.doc.childCount).toBeLessThan(BLOCKS);
    expect(view.state.doc.textContent).not.toContain(`block-${BLOCKS - 1}`);
    expect(heldChunks).toBeGreaterThan(0);

    // 真实鼠标事件在 jsdom 无布局、前缀判定不可复现：直接驱动点击产生的两个真实副作用
    // （交互标记 + 选区落到已挂载块内），与 hydration-interaction.test.ts 的口径一致
    markActiveHydrationInteraction(view);
    let clickPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "block-5") {
        clickPos = pos + 2;
        return false;
      }
      return true;
    });
    expect(clickPos).toBeGreaterThan(0);
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, clickPos)),
    );
    expect(view.state.selection.from).toBe(clickPos);

    // 尾部仍未挂载就切走（同步完成，见上面的 waitFor 说明）
    rerender(<MarkdownEditor {...props("/docs/b.md", "B-CONTENT")} />);
    expect(view.state.doc.textContent).toContain("B-CONTENT");
    timerSpy.mockRestore();

    // 再切回 A：缓存命中，水合末片恢复切走时的现场选区（不是启动水合时的旧位置）
    rerender(<MarkdownEditor {...props("/docs/a.md", bigContent)} />);
    await waitFor(() =>
      expect(view.state.doc.textContent).toContain(`block-${BLOCKS - 1}`),
    );
    expect(view.state.selection.from).toBe(clickPos);
  }, 20_000);
});

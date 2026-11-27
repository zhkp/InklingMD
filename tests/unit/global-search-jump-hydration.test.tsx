// 全局搜索跳转与分片水合（#431 评审）
//
// Codex 评审：大文档切回 tab 时编辑器只同步挂载首个分片，后续分片按宏任务追加。
// GlobalSearchPanel.jumpTo 若直接读 view.state.doc 做文本定位，命中位于后续分片时
// 找不到命中文本，会回退到位置 0（跳转到文档开头）。
// 本测试用真实 EditorView + 真实 startDocHydration 复现「水合在途」窗口，
// 断言 jumpTo 会先补齐水合、并把选区落在命中处而不是文首。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Schema, type Node as PMNode } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { editorViewCtx } from "@milkdown/kit/core";
import { GlobalSearchPanel } from "../../src/components/GlobalSearch/GlobalSearchPanel";
import { useWorkspace } from "../../src/store/workspace";
import * as fsApi from "../../src/lib/fs";
import {
  hasActiveHydration,
  startDocHydration,
} from "../../src/components/Editor/tab-editor-cache";

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

/** 40 块文档，只有第 36 块（索引 35）含搜索词 needle */
function makeFullDoc(): PMNode {
  return schema.nodes.doc.create(
    null,
    Array.from({ length: 40 }, (_, i) =>
      schema.nodes.paragraph.create(
        null,
        schema.text(i === 35 ? `block-${i} needle` : `block-${i}`),
      ),
    ),
  );
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

function sleep(ms: number) {
  return new Promise<void>((resolve) => realSetTimeout(resolve, ms));
}

let view: EditorView | null = null;
let fullDoc: PMNode;

describe("GlobalSearchPanel 跳转前补齐水合（#431 评审）", () => {
  beforeEach(() => {
    fullDoc = makeFullDoc();
    useWorkspace.setState({
      rootPath: "/test/workspace",
      currentFile: null,
      openTabs: [],
      // openFile 的真实副作用是切换 tab；跳转链路校验的是 currentFile
      openFile: async (filePath: string) => {
        useWorkspace.setState({ currentFile: filePath });
      },
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    view?.destroy();
    view = null;
    document.body.innerHTML = "";
    useWorkspace.setState({ currentFile: null, openTabs: [] });
  });

  it("命中在后续分片时先补齐水合，选区落在命中处而不是文档开头", async () => {
    // 期望位置：完整文档里 needle 的绝对位置（第 36 块）
    let expectedPos = -1;
    fullDoc.descendants((node, pos) => {
      if (node.isText && node.text?.includes("needle")) {
        expectedPos = pos + node.text.indexOf("needle");
        return false;
      }
      return true;
    });
    expect(expectedPos).toBeGreaterThan(0);

    vi.spyOn(fsApi, "searchInWorkspace").mockResolvedValue({
      hits: [
        {
          path: "/test/workspace/big.md",
          line: 36,
          column: 1,
          preview: "block-35 needle",
        },
      ],
      truncated: false,
    });

    const editor = {
      action: <T,>(cb: (ctx: { get: (key: unknown) => unknown }) => T): T =>
        cb({ get: (key) => (key === editorViewCtx ? view : null) }),
    };

    render(
      <GlobalSearchPanel getEditor={() => editor as never} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByPlaceholderText("在工作区搜索…"), {
      target: { value: "needle" },
    });
    // 搜索防抖 300ms（此时尚未拦截定时器）
    await act(async () => {
      await sleep(350);
    });
    const hitButton = screen.getByRole("button", { name: /block-35 needle/ });

    // 水合尾部用 0ms 宏任务排下一片：按住这些宏任务，
    // 确定性复现「用户点击命中时尾部还没挂载」的在途窗口
    let heldChunks = 0;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
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

    const root = document.createElement("div");
    document.body.appendChild(root);
    const placeholder = schema.nodes.doc.create(
      null,
      schema.nodes.paragraph.create(null, schema.text("placeholder")),
    );
    view = new EditorView(root, {
      state: EditorState.create({
        doc: placeholder,
        selection: TextSelection.create(placeholder, 1),
      }),
    });

    // 真实分片水合：首片 8 块同步挂载，尾部被按住 → 水合在途
    startDocHydration({ view, fullDoc, fromCache: true, chunkSize: 8 });
    expect(view.state.doc.childCount).toBe(8);
    expect(heldChunks).toBeGreaterThan(0);
    expect(hasActiveHydration(view)).toBe(true);

    await act(async () => {
      fireEvent.click(hitButton);
      // jumpTo 先 await openFile（微任务），再等 200ms 定位
      await sleep(250);
    });

    // 修复后：跳转前已补齐全部 40 块，文本定位命中第 36 块
    expect(view.state.doc.childCount).toBe(40);
    expect(hasActiveHydration(view)).toBe(false);
    expect(view.state.selection.$from.parent.textContent).toBe("block-35 needle");
    expect(view.state.selection.from).toBe(expectedPos);
  });
});

// useCursorStateRestore 单元测试（issue #136 单一写者原则）
// 重点验证：
// - sourceMode 翻转（进入/退出源码模式）触发的 effect 重跑必须跳过恢复
// - tab 切换 / 文件打开（filePath 变化）仍正常恢复光标与滚动位置

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { editorViewCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { useCursorStateRestore } from "../../src/components/Editor/useCursorStateRestore";
import {
  flushActiveHydration,
  hasActiveHydration,
  startDocHydration,
} from "../../src/components/Editor/tab-editor-cache";
import { useWorkspace } from "../../src/store/workspace";

interface ScrollElMock {
  scrollTop: number;
  isConnected: boolean;
}

function makeMockEditor(
  scrollEl: ScrollElMock,
  options: { selectionEmpty?: boolean } = {},
) {
  const resolve = vi.fn().mockReturnValue({ pos: 10 });
  const view = {
    state: {
      doc: {
        content: { size: 100 },
        // TextSelection.near 对非真实 ResolvedPos 会抛错并被 hook 捕获，
        // resolve 调用与否即代表光标恢复路径是否被触发
        resolve,
      },
      tr: { setSelection: vi.fn().mockReturnThis() },
      selection: { empty: options.selectionEmpty ?? true },
    },
    dispatch: vi.fn(),
    scrollDOM: scrollEl,
  };
  const editor = {
    action: (fn: (ctx: { get: (key: unknown) => unknown }) => void) => {
      fn({ get: (key: unknown) => (key === editorViewCtx ? view : undefined) });
    },
  };
  return { editor, view, resolve };
}

/**
 * 真实 ProseMirror 视图（水合/选区都是真实事务）：
 * 供缓存区间选区与水合窗口滚动的行为回归使用。
 */
const realSchema = new Schema({
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

function makeRealView(blocks: number) {
  const fullDoc = realSchema.nodes.doc.create(
    null,
    Array.from({ length: blocks }, (_, i) =>
      realSchema.nodes.paragraph.create(null, realSchema.text(`block-${i}`)),
    ),
  );
  const root = document.createElement("div");
  document.body.appendChild(root);
  const view = new EditorView(root, {
    state: EditorState.create({
      doc: fullDoc,
      selection: TextSelection.create(fullDoc, 1),
    }),
  });
  const scrollEl = { scrollTop: 0, isConnected: true } as unknown as HTMLElement;
  Object.defineProperty(view, "scrollDOM", { value: scrollEl, configurable: true });
  return { view, scrollEl, fullDoc };
}

function editorOf(view: EditorView) {
  return {
    action: (fn: (ctx: { get: (key: unknown) => unknown }) => void) =>
      fn({ get: (key: unknown) => (key === editorViewCtx ? view : undefined) }),
  } as never;
}

describe("useCursorStateRestore", () => {
  let rafQueue: FrameRequestCallback[];
  let scrollEl: ScrollElMock;

  beforeEach(() => {
    rafQueue = [];
    window.requestAnimationFrame = (cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    };
    scrollEl = { scrollTop: 0, isConnected: true };
  });

  afterEach(() => {
    while (rafQueue.length) rafQueue.shift()?.(0);
    vi.restoreAllMocks();
  });

  it("退出源码模式（true→false 翻转）跳过恢复，让位给 useSourceModeTransition", () => {
    useWorkspace.setState({
      openTabs: [
        { path: "/tmp/a.md", content: "# A", dirty: false, lastSavedAt: null, cursorPos: 40, scrollTop: 77 },
      ],
    });
    const { editor, resolve } = makeMockEditor(scrollEl);

    const { rerender } = renderHook(
      ({ sourceMode }) =>
        useCursorStateRestore({
          sourceMode,
          filePath: "/tmp/a.md",
          revision: 0,
          loading: false,
          getEditor: () => editor as never,
        }),
      { initialProps: { sourceMode: true } },
    );

    // 初始 sourceMode=true：guard 直接返回，不恢复
    expect(resolve).not.toHaveBeenCalled();
    expect(scrollEl.scrollTop).toBe(0);

    // 退出源码模式：翻转触发重跑，必须跳过（单一写者，#136）
    rerender({ sourceMode: false });
    expect(resolve).not.toHaveBeenCalled();
    expect(scrollEl.scrollTop).toBe(0);
    while (rafQueue.length) rafQueue.shift()?.(0);
    expect(scrollEl.scrollTop).toBe(0);
  });

  it("进入源码模式（false→true 翻转）后的重跑同样跳过恢复", () => {
    useWorkspace.setState({
      openTabs: [
        { path: "/tmp/a.md", content: "# A", dirty: false, lastSavedAt: null, cursorPos: 40, scrollTop: 77 },
      ],
    });
    const { editor, resolve } = makeMockEditor(scrollEl);

    const { rerender } = renderHook(
      ({ sourceMode }) =>
        useCursorStateRestore({
          sourceMode,
          filePath: "/tmp/a.md",
          revision: 0,
          loading: false,
          getEditor: () => editor as never,
        }),
      { initialProps: { sourceMode: false } },
    );

    // 初始挂载（非翻转）：正常恢复 tab 记忆
    expect(resolve).toHaveBeenCalled();
    expect(scrollEl.scrollTop).toBe(77);
    const callsAfterMount = resolve.mock.calls.length;

    // 进入源码模式：翻转触发重跑，跳过
    rerender({ sourceMode: true });
    expect(resolve.mock.calls.length).toBe(callsAfterMount);
    expect(scrollEl.scrollTop).toBe(77);
  });

  it("tab 切换（filePath 变化、模式不变）仍正常恢复光标与滚动位置", () => {
    useWorkspace.setState({
      openTabs: [
        { path: "/tmp/a.md", content: "# A", dirty: false, lastSavedAt: null, cursorPos: 40, scrollTop: 77 },
        { path: "/tmp/b.md", content: "# B", dirty: false, lastSavedAt: null, cursorPos: 8, scrollTop: 210 },
      ],
    });
    const { editor } = makeMockEditor(scrollEl);

    const { rerender } = renderHook(
      ({ filePath }) =>
        useCursorStateRestore({
          sourceMode: false,
          filePath,
          revision: 0,
          loading: false,
          getEditor: () => editor as never,
        }),
      { initialProps: { filePath: "/tmp/a.md" } },
    );

    expect(scrollEl.scrollTop).toBe(77);

    // 切到 b.md：恢复 b 的记忆
    rerender({ filePath: "/tmp/b.md" });
    expect(scrollEl.scrollTop).toBe(210);
    while (rafQueue.length) rafQueue.shift()?.(0);
    expect(scrollEl.scrollTop).toBe(210);
  });

  it("切回缓存 tab 时已有区间选区，不被位置记忆折叠成单点（#431 评审）", () => {
    // 小文档缓存命中：分片水合在 Editor 的 layout effect 里同步完成，
    // 本 effect 运行时 hasActiveHydration 已为 false，只能在选区侧拦截。
    useWorkspace.setState({
      openTabs: [
        { path: "/tmp/a.md", content: "# A", dirty: false, lastSavedAt: null, cursorPos: 40, scrollTop: 77 },
      ],
    });
    const { editor, view, resolve } = makeMockEditor(scrollEl, {
      selectionEmpty: false,
    });

    renderHook(() =>
      useCursorStateRestore({
        sourceMode: false,
        filePath: "/tmp/a.md",
        revision: 0,
        loading: false,
        getEditor: () => editor as never,
      }),
    );

    // 缓存选区必须原样保留：不解析记忆位置、不 dispatch 折叠选区
    expect(resolve).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
    // 滚动位置仍照常恢复
    expect(scrollEl.scrollTop).toBe(77);
  });

  it("无滚动记忆时显式归零，不残留上一文件的滚动位置", () => {
    useWorkspace.setState({
      openTabs: [{ path: "/tmp/c.md", content: "# C", dirty: false, lastSavedAt: null, cursorPos: null, scrollTop: null }],
    });
    scrollEl.scrollTop = 123; // 残留上一文件的位置
    const { editor } = makeMockEditor(scrollEl);

    renderHook(() =>
      useCursorStateRestore({
        sourceMode: false,
        filePath: "/tmp/c.md",
        revision: 0,
        loading: false,
        getEditor: () => editor as never,
      }),
    );

    expect(scrollEl.scrollTop).toBe(0);
  });

  it("缓存命中恢复的区间选区不被位置记忆折叠（#431 评审 B4）", () => {
    const { view, scrollEl, fullDoc } = makeRealView(3);
    // 小文档缓存命中：水合在 layout effect 里同步完成（hasActiveHydration=false），
    // 只能靠「已有区间选区」判据避免被 TextSelection.near(pos) 折叠
    startDocHydration({
      view,
      fullDoc,
      fromCache: true,
      selection: { anchor: 2, head: 8 },
      historyState: undefined,
      chunkSize: 32,
    });
    expect(view.state.selection.from).toBe(2);
    expect(view.state.selection.to).toBe(8);
    expect(hasActiveHydration(view)).toBe(false);

    useWorkspace.setState({
      openTabs: [
        {
          path: "/tmp/cached.md",
          content: "",
          dirty: false,
          lastSavedAt: null,
          cursorPos: 8,
          scrollTop: 0,
        },
      ],
    });

    renderHook(() =>
      useCursorStateRestore({
        sourceMode: false,
        filePath: "/tmp/cached.md",
        revision: 0,
        loading: false,
        getEditor: () => editorOf(view),
      }),
    );

    expect(scrollEl.scrollTop).toBe(0);
    expect(view.state.selection.from).toBe(2);
    expect(view.state.selection.to).toBe(8);
    view.destroy();
  });

  it("水合期间用户滚动不被记忆位置逐帧拽回（#431 评审 B6）", () => {
    const { view, scrollEl, fullDoc } = makeRealView(40);
    const task = startDocHydration({
      view,
      fullDoc,
      fromCache: true,
      chunkSize: 8,
    });
    expect(hasActiveHydration(view)).toBe(true);

    useWorkspace.setState({
      openTabs: [
        {
          path: "/tmp/hydrating.md",
          content: "",
          dirty: false,
          lastSavedAt: null,
          cursorPos: 1,
          scrollTop: 100,
        },
      ],
    });

    renderHook(() =>
      useCursorStateRestore({
        sourceMode: false,
        filePath: "/tmp/hydrating.md",
        revision: 0,
        loading: false,
        getEditor: () => editorOf(view),
      }),
    );

    // 首帧写入记忆位置
    expect(scrollEl.scrollTop).toBe(100);

    // 水合窗口内用户滚动：后续帧不得写回 100
    scrollEl.scrollTop = 500;
    for (let i = 0; i < 5 && rafQueue.length > 0; i += 1) rafQueue.shift()?.(0);
    expect(scrollEl.scrollTop).toBe(500);

    // 水合完成后再跑帧：用户已滚动，仍不得拽回
    flushActiveHydration(view);
    expect(task.isActive()).toBe(false);
    for (let i = 0; i < 10 && rafQueue.length > 0; i += 1) rafQueue.shift()?.(0);
    expect(scrollEl.scrollTop).toBe(500);
    view.destroy();
  });
});

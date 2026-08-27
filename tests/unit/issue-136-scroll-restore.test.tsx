// 模式切换双向滚动恢复回归（issue #136）
//
// 方向 A（退出源码模式）：
//   旧实现里「编辑位置记忆」effect 持有过期 tab 记忆（源码会话期间从不更新），
//   与 useSourceModeTransition 的映射恢复在同一帧互相逐帧覆盖，视口最终弹回
//   进入源码模式前的旧位置（多为顶部）。修复后记忆钩子在模式翻转帧让位，
//   transition 独占写者并把映射值写回 tab 记忆。
// 方向 B（进入源码模式）：
//   旧实现挂载时单次赋值 scrollTop，CM6 视口化渲染的高度估算未收敛，赋值被钳制
//   后不再修正，视口停在文章上部。修复后「立即设置 + 逐帧 settle」，且目标值按
//   容器高度比例映射（两容器高度不同），收敛后兜底保证光标可见。
//
// 断言策略（长文档、底部光标、非零滚动）：
// - 方向 A：退出后滚动容器停在映射目标值（非过期值）、光标恢复到文档后段、
//   tab 记忆被映射值覆盖；并覆盖「竞态」场景（两个写者同时在位）
// - 方向 B：模拟测量漂移与钳制，settle 循环最终收敛到比例映射目标；
//   光标越出可视区域时兜底 dispatch scrollIntoView

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, render } from "@testing-library/react";
import { Schema, type Node as PMNode } from "@milkdown/kit/prose/model";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { EditorView as CMView } from "@codemirror/view";
import { useSourceModeTransition } from "../../src/components/Editor/useSourceModeTransition";
import { useCursorMemoryRestore } from "../../src/components/Editor/useCursorMemoryRestore";
import { SourceModeEditor } from "../../src/components/Editor/SourceModeEditor";
import {
  registerSourceModeScroll,
  unregisterSourceModeScroll,
} from "../../src/lib/source-mode-scroll";
import { mapScrollTop } from "../../src/lib/source-mode-cursor";
import { useWorkspace, type OpenTab } from "../../src/store/workspace";

/* ---------- 测试数据：真实长文档 ---------- */

const PARA_COUNT = 400;

function paragraphText(i: number) {
  return `第 ${i} 节：这是一段用于模式切换滚动恢复回归的长文档正文，模拟真实笔记内容。`;
}

/** 真实 PM doc（与单测 schema 构建方式一致） */
function makeLongDoc(count: number): PMNode {
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
  const blocks = [];
  for (let i = 0; i < count; i++) {
    blocks.push(schema.nodes.paragraph.create(null, schema.text(paragraphText(i))));
  }
  return schema.nodes.doc.create(null, blocks);
}

/** 对应的 markdown 源码（段落间空行，与序列化形态一致） */
function makeLongMarkdown(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(paragraphText(i));
  return lines.join("\n\n");
}

/* ---------- requestAnimationFrame 手动控制 ---------- */

function stubRaf() {
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    pending.set(++nextId, cb);
    return nextId;
  };
  window.cancelAnimationFrame = (id: number) => {
    pending.delete(id);
  };
  let time = 0;
  const tick = () => {
    const entry = pending.entries().next().value;
    if (!entry) return;
    pending.delete(entry[0]);
    entry[1]((time += 16.7));
  };
  const flush = (maxFrames = 80) => {
    let n = 0;
    while (pending.size > 0 && n < maxFrames) {
      tick();
      n++;
    }
  };
  /** 按谓词刷帧：CM6 内部也往同一 rAF 队列注册回调，需刷到目标条件成立 */
  const flushUntil = (pred: () => boolean, maxFrames = 200) => {
    let n = 0;
    while (!pred() && pending.size > 0 && n < maxFrames) {
      tick();
      n++;
    }
  };
  const restore = () => {
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancel;
  };
  return { tick, flush, flushUntil, restore, size: () => pending.size };
}

/* ---------- mock PM 编辑器 ---------- */

function makeMockPmEditor(doc: PMNode, scrollEl: object) {
  const state: {
    plugins: unknown[];
    doc: PMNode;
    selection: { head: number };
    tr: unknown;
  } = { plugins: [], doc, selection: { head: 1 }, tr: null };
  let selectedHead: number | null = null;
  const mockTr = {
    replaceWith: vi.fn().mockReturnThis(),
    setMeta: vi.fn().mockReturnThis(),
    setSelection: vi.fn((sel: { head: number }) => {
      selectedHead = sel.head;
      state.selection.head = sel.head;
      return mockTr;
    }),
  };
  state.tr = mockTr;
  const mockView = {
    state,
    dispatch: vi.fn(),
    dom: {
      closest: (selector: string) =>
        selector === ".editor-scroll" ? scrollEl : null,
    },
  };
  const mockEditor = {
    action: (fn: (ctx: unknown) => void) =>
      fn({
        get: (key: unknown) => {
          if (key === editorViewCtx) return mockView;
          if (key === parserCtx)
            return (v: string) => ({ content: { size: v.length } });
          return null;
        },
      }),
  };
  return {
    mockEditor: mockEditor as never,
    mockView,
    mockTr,
    getSelectedHead: () => selectedHead,
  };
}

/** scrollEl 需要 instanceof HTMLElement 通过（实现里用该判断），属性可自由控制 */
function makeScrollEl(init: { scrollTop: number; scrollHeight: number }) {
  const el = { ...init, isConnected: true };
  Object.setPrototypeOf(el, HTMLElement.prototype);
  return el;
}

function seedTabMemory(path: string, cursorPos: number | null, scrollTop: number | null, content = "") {
  const tab: OpenTab = {
    path,
    content,
    dirty: false,
    lastSavedAt: null,
    cursorPos,
    scrollTop,
  };
  useWorkspace.setState({ openTabs: [tab], activeTabPath: path });
}

afterEach(() => {
  useWorkspace.setState({ openTabs: [], activeTabPath: null });
});

/* ---------- 方向 A：退出源码模式 ---------- */

describe("方向 A：退出源码模式的滚动/光标恢复（issue #136）", () => {
  const filePath = "/tmp/issue-136-exit.md";

  it("竞态回归：过期记忆让位，视口停在映射目标值且写回 tab 记忆（长文档底部光标）", () => {
    const raf = stubRaf();
    const value = makeLongMarkdown(PARA_COUNT);
    const lastSyncedRef = { current: value };
    const doc = makeLongDoc(PARA_COUNT);

    // 过期 tab 记忆：用户进入源码模式前停留在文档顶部（scrollTop 0）
    seedTabMemory(filePath, 2, 0, value);

    // PM 侧滚动容器：高度与 CM 不同（渲染视图 ≠ 源码文本）
    const scrollEl = makeScrollEl({ scrollTop: 0, scrollHeight: 12000 });
    const { mockEditor, mockView, getSelectedHead } = makeMockPmEditor(doc, scrollEl);

    // 源码会话里用户滚到了底部并编辑：CM 实时快照（非零）
    const cmCursor = value.length - 5;
    registerSourceModeScroll(filePath, {
      scrollToHeading: vi.fn(),
      getScrollAndCursor: () => ({
        cursor: cmCursor,
        scrollTop: 4500,
        scrollHeight: 5000,
      }),
    });

    try {
      // 两个写者同时在位：记忆钩子 + 过渡钩子（Editor.tsx 的真实组合）
      const { rerender } = renderHook(
        ({ sourceMode }: { sourceMode: boolean }) => {
          const transition = useSourceModeTransition({
            sourceMode,
            filePath,
            value,
            getEditor: () => mockEditor,
            lastSyncedRef,
          });
          useCursorMemoryRestore({
            filePath,
            loading: false,
            sourceMode,
            getEditor: () => mockEditor,
          });
          return transition;
        },
        { initialProps: { sourceMode: true } },
      );

      rerender({ sourceMode: false });
      raf.flush();

      // 1) 视口停在比例映射目标值：4500/5000 → 12000 的 90% = 10800（非过期的 0）
      const expected = mapScrollTop(4500, 5000, 12000);
      expect(expected).toBe(10800);
      expect(scrollEl.scrollTop).toBe(10800);

      // 2) 光标恢复到底部编辑处（文档后段），而不是被过期记忆拉回顶部
      const head = getSelectedHead();
      expect(head).not.toBeNull();
      expect(head!).toBeGreaterThan(doc.content.size * 0.8);

      // 3) 映射值写回 tab 记忆：下次切走再切回不会回到过期旧值
      const mem = useWorkspace.getState().getCursorStateFor(filePath);
      expect(mem.scrollTop).toBe(10800);
      expect(mem.pos).toBe(head);

      // 4) 内容替换与选区恢复真实发生
      expect(mockView.dispatch).toHaveBeenCalled();
    } finally {
      unregisterSourceModeScroll(filePath);
      raf.restore();
    }
  });

  it("无源码会话快照（snap 缺失）时不写回错误记忆", () => {
    const raf = stubRaf();
    const value = makeLongMarkdown(PARA_COUNT);
    const lastSyncedRef = { current: value };
    const doc = makeLongDoc(PARA_COUNT);
    seedTabMemory(filePath, 2, 0, value);
    const scrollEl = makeScrollEl({ scrollTop: 0, scrollHeight: 12000 });
    const { mockEditor } = makeMockPmEditor(doc, scrollEl);

    // 不注册 CM 滚动处理器，也无卸载快照 → snap 为 null
    const { rerender } = renderHook(
      ({ sourceMode }: { sourceMode: boolean }) =>
        useSourceModeTransition({
          sourceMode,
          filePath,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
        }),
      { initialProps: { sourceMode: true } },
    );
    rerender({ sourceMode: false });
    raf.flush();

    // 无快照时不做映射恢复，也不污染 tab 记忆
    const mem = useWorkspace.getState().getCursorStateFor(filePath);
    expect(mem.scrollTop).toBe(0);
    expect(mem.pos).toBe(2);
    raf.restore();
  });
});

/* ---------- 方向 A 对照组：切 tab/打开文件的记忆恢复不受影响（issue #30） ---------- */

describe("编辑位置记忆钩子：非模式翻转场景照常恢复", () => {
  it("打开文件/切 tab：按记忆值恢复光标与非零滚动", () => {
    const raf = stubRaf();
    const filePath = "/tmp/issue-136-tab.md";
    const doc = makeLongDoc(60);
    const scrollEl = makeScrollEl({ scrollTop: 0, scrollHeight: 6000 });
    const { mockEditor, getSelectedHead } = makeMockPmEditor(doc, scrollEl);
    seedTabMemory(filePath, 120, 620);

    renderHook(() =>
      useCursorMemoryRestore({
        filePath,
        loading: false,
        sourceMode: false,
        getEditor: () => mockEditor,
      }),
    );
    raf.flush();

    expect(scrollEl.scrollTop).toBe(620);
    // TextSelection.near 在块边界处可能 ±1 偏移，落在合法文本位置即可
    expect(Math.abs(getSelectedHead()! - 120)).toBeLessThanOrEqual(1);
    raf.restore();
  });

  it("源码模式中（未翻转）不恢复：避免与 CM 编辑会话互扰", () => {
    const raf = stubRaf();
    const filePath = "/tmp/issue-136-in-source.md";
    const doc = makeLongDoc(60);
    const scrollEl = makeScrollEl({ scrollTop: 0, scrollHeight: 6000 });
    const { mockEditor, mockView } = makeMockPmEditor(doc, scrollEl);
    seedTabMemory(filePath, 120, 620);

    renderHook(() =>
      useCursorMemoryRestore({
        filePath,
        loading: false,
        sourceMode: true,
        getEditor: () => mockEditor,
      }),
    );
    raf.flush();

    expect(scrollEl.scrollTop).toBe(0);
    expect(mockView.dispatch).not.toHaveBeenCalled();
    raf.restore();
  });
});

/* ---------- 方向 A 前置：进入快照采集源容器高度 ---------- */

describe("进入源码模式快照（方向 B 映射的输入）", () => {
  it("采集非零滚动位置与源容器高度，供 CM 侧按比例映射", () => {
    const filePath = "/tmp/issue-136-enter-snap.md";
    const value = makeLongMarkdown(PARA_COUNT);
    const lastSyncedRef = { current: value };
    const scrollEl = makeScrollEl({ scrollTop: 0, scrollHeight: 10000 });
    const doc = makeLongDoc(PARA_COUNT);
    const { mockEditor, mockView } = makeMockPmEditor(doc, scrollEl);
    // 光标置于文档中段，保证采集到的 markdown 偏移非零
    mockView.state.selection.head = Math.floor(doc.content.size / 2);
    seedTabMemory(filePath, null, null, value);

    const { result, rerender } = renderHook(
      ({ sourceMode }: { sourceMode: boolean }) =>
        useSourceModeTransition({
          sourceMode,
          filePath,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
          getWysiwygScrollTop: () => 4200,
        }),
      { initialProps: { sourceMode: false } },
    );

    expect(result.current.enterSnapshot).toBeNull();
    rerender({ sourceMode: true });

    expect(result.current.enterSnapshot).not.toBeNull();
    expect(result.current.enterSnapshot!.scrollTop).toBe(4200);
    expect(result.current.enterSnapshot!.scrollHeight).toBe(10000);
    expect(result.current.enterSnapshot!.cursor).toBeGreaterThan(0);
  });
});

/* ---------- 方向 B：进入源码模式的滚动收敛 ---------- */

describe("方向 B：进入源码模式的滚动收敛（issue #136）", () => {
  it("单次赋值被测量漂移钳制后，settle 循环收敛到比例映射目标（长文档、底部光标）", () => {
    const raf = stubRaf();
    const filePath = "/tmp/issue-136-enter.md";
    const longMd = makeLongMarkdown(800);

    const { unmount } = render(
      <SourceModeEditor
        filePath={filePath}
        value={longMd}
        onChange={() => {}}
        initialCursor={longMd.length - 10}
        initialScrollTop={8000}
        initialScrollHeight={10000}
        spellcheck={false}
      />,
    );

    try {
      const host = document.querySelector(
        ".source-mode-cm-host",
      ) as HTMLElement | null;
      expect(host).toBeTruthy();
      const cmView = CMView.findFromDOM(host!)!;
      expect(cmView).toBeTruthy();
      expect(cmView.state.selection.main.head).toBe(longMd.length - 10);
      const scroller = cmView.scrollDOM;

      // 模拟 CM6 挂载初期测量未收敛：估算高度偏小、scrollTop 被错误
      // maxScroll 钳制（单次赋值的失效现场——视口停在文章上部）
      let cmHeight = 4000;
      let maxScroll = 1000;
      let rawScrollTop = 0;
      Object.defineProperty(scroller, "scrollHeight", {
        get: () => cmHeight,
        configurable: true,
      });
      Object.defineProperty(scroller, "scrollTop", {
        get: () => rawScrollTop,
        set: (v: number) => {
          rawScrollTop = Math.max(0, Math.min(v, maxScroll));
        },
        configurable: true,
      });
      // 光标可视兜底在 happy-dom 下几何退化，显式 mock 为「可见」避免噪音
      vi.spyOn(cmView, "coordsAtPos").mockReturnValue({
        top: 100,
        bottom: 118,
        left: 0,
        right: 80,
      } as never);
      vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 600,
        left: 0,
        right: 800,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as never);

      // 测量收敛前：目标被钳制（旧实现会在这里放弃，视口停在文章上部）
      raf.flushUntil(() => scroller.scrollTop >= 1000);
      expect(scroller.scrollTop).toBe(1000);

      // CM 真实测量收敛：高度修正为 8000
      cmHeight = 8000;
      maxScroll = 7500;
      raf.flushUntil(() => scroller.scrollTop === 6400);

      // 收敛到比例映射目标：8000/10000 → 8000 的 80% = 6400
      const expected = mapScrollTop(8000, 10000, 8000);
      expect(expected).toBe(6400);
      expect(scroller.scrollTop).toBe(6400);
      // 阅读进度比例跨容器保留
      expect(scroller.scrollTop / cmHeight).toBeCloseTo(8000 / 10000, 2);
    } finally {
      unmount();
      raf.restore();
    }
  });

  it("收敛后光标越出可视区域时，兜底 dispatch scrollIntoView", () => {
    const raf = stubRaf();
    const filePath = "/tmp/issue-136-visible.md";
    const longMd = makeLongMarkdown(800);

    const { unmount } = render(
      <SourceModeEditor
        filePath={filePath}
        value={longMd}
        onChange={() => {}}
        initialCursor={longMd.length - 10}
        initialScrollTop={0}
        spellcheck={false}
      />,
    );

    try {
      const host = document.querySelector(
        ".source-mode-cm-host",
      ) as HTMLElement | null;
      const cmView = CMView.findFromDOM(host!)!;
      const scroller = cmView.scrollDOM;

      // 光标坐标在可视区域之下（底部光标 + 顶部视口的失配场景）
      vi.spyOn(cmView, "coordsAtPos").mockReturnValue({
        top: 5000,
        bottom: 5020,
        left: 0,
        right: 80,
      } as never);
      vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
        top: 0,
        bottom: 600,
        left: 0,
        right: 800,
        width: 800,
        height: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as never);
      const dispatchSpy = vi.spyOn(cmView, "dispatch");
      const hasScrollEffect = () =>
        dispatchSpy.mock.calls.some(
          ([arg]) => arg && (arg as { effects?: unknown }).effects,
        );

      raf.flushUntil(hasScrollEffect);

      // 兜底滚动效果真实 dispatch（携带 effects 的滚动请求）
      const scrollCalls = dispatchSpy.mock.calls.filter(
        ([arg]) => arg && (arg as { effects?: unknown }).effects,
      );
      expect(scrollCalls.length).toBeGreaterThan(0);
    } finally {
      unmount();
      raf.restore();
    }
  });
});

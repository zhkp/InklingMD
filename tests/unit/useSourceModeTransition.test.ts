import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSourceModeTransition } from "../../src/components/Editor/useSourceModeTransition";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { registerSourceModeScroll, unregisterSourceModeScroll } from "../../src/lib/source-mode-scroll";

describe("useSourceModeTransition", () => {
  it("enters source mode and captures non-zero cursor & scroll snapshot from WYSIWYG editor", () => {
    const filePath = "/tmp/test-enter.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    const mockView = {
      state: {
        selection: { head: 15 },
        doc: {
          textBetween: (_from: number, _to: number) => "# Title\n\nParagraph",
        },
      },
      dom: {
        closest: (selector: string) => {
          if (selector === ".editor-scroll") {
            return { scrollTop: 120, isConnected: true };
          }
          return null;
        },
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        const mockCtx = {
          get: (key: any) => {
            if (key === editorViewCtx) return mockView;
            return null;
          },
        };
        fn(mockCtx);
      },
    };

    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
          getWysiwygScrollTop: () => 120,
        }),
      {
        initialProps: { sourceMode: false },
      },
    );

    expect(result.current.enterSnapshot).toBeNull();

    // Switch to source mode
    rerender({ sourceMode: true });

    expect(result.current.enterSnapshot).not.toBeNull();
    expect(result.current.enterSnapshot?.cursor).toBeGreaterThan(0);
    expect(result.current.enterSnapshot?.scrollTop).toBe(120);
  });

  it("handles exit snapshot and restores PM selection & scroll position", async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };

    const filePath = "/tmp/test-exit.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    const mockScrollEl = { scrollTop: 0, isConnected: true, scrollHeight: 200 };
    Object.setPrototypeOf(mockScrollEl, HTMLElement.prototype);

    const mockTr = {
      replaceWith: vi.fn().mockReturnThis(),
      setSelection: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };

    const mockView = {
      state: {
        plugins: [],
        selection: { head: 18 },
        doc: {
          content: { size: 40 },
          resolve: vi.fn().mockReturnValue({ pos: 18 }),
          textBetween: () => "",
        },
        tr: mockTr,
      },
      dispatch: vi.fn(),
      dom: {
        closest: (selector: string) => {
          if (selector === ".editor-scroll") {
            return mockScrollEl;
          }
          return null;
        },
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        const mockCtx = {
          get: (key: any) => {
            if (key === editorViewCtx) return mockView;
            if (key === parserCtx) return (val: string) => ({ content: { size: val.length } });
            return null;
          },
        };
        fn(mockCtx);
      },
    };

    // 注册活跃 CodeMirror 滚动获取实例
    registerSourceModeScroll(filePath, {
      scrollToHeading: vi.fn(),
      getScrollAndCursor: () => ({
        cursor: 18,
        scrollTop: 50,
        scrollHeight: 100,
      }),
    });

    const { rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
        }),
      {
        initialProps: { sourceMode: true },
      },
    );

    // Switch back to WYSIWYG mode
    rerender({ sourceMode: false });

    // Flush all nested requestAnimationFrames
    while (rafCallbacks.length > 0) {
      const cb = rafCallbacks.shift();
      cb?.(0);
    }

    // Verify PM transaction replaced content and restored selection
    expect(mockTr.replaceWith).toHaveBeenCalled();
    expect(mockView.dispatch).toHaveBeenCalled();
    // 比例映射：source 50/100 → target 200 期望映射为 100
    expect(mockScrollEl.scrollTop).toBe(100);

    unregisterSourceModeScroll(filePath);
    window.requestAnimationFrame = originalRaf;
  });
});

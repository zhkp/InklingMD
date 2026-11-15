import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { useSourceModeTransition } from "../../src/components/Editor/useSourceModeTransition";
import { useWorkspace } from "../../src/store/workspace";

const OLD_PATH = "/tmp/transition-old.md";
const NEW_PATH = "/tmp/transition-new.md";
const VALUE = "# Old file\n\nParagraph";

function makeHarness() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;
  const originalRequestFrame = window.requestAnimationFrame;
  const originalCancelFrame = window.cancelAnimationFrame;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    callbacks.set(id, callback);
    return id;
  }) as typeof window.requestAnimationFrame;
  const cancelFrame = vi.fn((id: number) => {
    callbacks.delete(id);
  });
  window.cancelAnimationFrame = cancelFrame;

  const scrollEl = document.createElement("div");
  scrollEl.className = "editor-scroll";
  document.body.append(scrollEl);
  scrollEl.scrollTop = 0;
  Object.defineProperty(scrollEl, "scrollHeight", { value: 200, configurable: true });
  Object.defineProperty(scrollEl, "clientHeight", { value: 80, configurable: true });
  scrollEl.getBoundingClientRect = () => ({
    top: 0,
    height: 80,
    bottom: 80,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

  const transaction = {
    replaceWith: vi.fn().mockReturnThis(),
    setMeta: vi.fn().mockReturnThis(),
    setSelection: vi.fn().mockReturnThis(),
  };
  const view = {
    state: {
      plugins: [],
      doc: {
        content: { size: 40 },
        textBetween: () => "",
        resolve: () => ({ pos: 1 }),
      },
      selection: { head: 1 },
      tr: transaction,
    },
    dispatch: vi.fn(),
    coordsAtPos: () => ({ top: 0, bottom: 0 }),
    dom: {
      closest: (selector: string) => (selector === ".editor-scroll" ? scrollEl : null),
    },
  };
  const editor = {
    action: (callback: (ctx: { get: (key: unknown) => unknown }) => void) => {
      callback({
        get: (key) => {
          if (key === editorViewCtx) return view;
          if (key === parserCtx) return (markdown: string) => ({ content: { size: markdown.length } });
          return null;
        },
      });
    },
  };
  const getEditor = () => editor as never;
  const previousWorkspaceState = useWorkspace.getState();
  useWorkspace.setState({
    activeTabPath: OLD_PATH,
    currentFile: OLD_PATH,
    currentContent: VALUE,
    openTabs: [
      { path: OLD_PATH, content: VALUE, dirty: false, lastSavedAt: null, cursorPos: 3, scrollTop: 7 },
      { path: NEW_PATH, content: "# New file", dirty: false, lastSavedAt: null, cursorPos: 0, scrollTop: 0 },
    ],
  });
  const saveCursorState = vi.spyOn(useWorkspace.getState(), "saveCursorState");

  return {
    callbacks,
    cancelFrame,
    getEditor,
    originalCancelFrame,
    originalRequestFrame,
    previousWorkspaceState,
    saveCursorState,
    scrollEl,
    transaction,
    view,
  };
}

function runFirstPendingFrame(callbacks: Map<number, FrameRequestCallback>) {
  const first = callbacks.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
  if (!first) throw new Error("Expected a pending animation frame");
  callbacks.delete(first[0]);
  first[1](0);
}

describe("useSourceModeTransition pending restore lifecycle", () => {
  let harness: ReturnType<typeof makeHarness> | null = null;

  afterEach(() => {
    cleanup();
    if (harness) {
      harness.scrollEl.remove();
      harness.saveCursorState.mockRestore();
      useWorkspace.setState(harness.previousWorkspaceState, true);
      window.requestAnimationFrame = harness.originalRequestFrame;
      window.cancelAnimationFrame = harness.originalCancelFrame;
      harness = null;
    }
  });

  it.each([0, 1, 2])("switching files cancels pending restore at RAF stage %i", (stage) => {
    harness = makeHarness();
    const { result, rerender } = renderHook(
      ({ filePath, sourceMode }: { filePath: string; sourceMode: boolean }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value: VALUE,
          getEditor: harness!.getEditor,
          lastSyncedRef: { current: VALUE },
        }),
      { initialProps: { filePath: OLD_PATH, sourceMode: true } },
    );
    result.current.exitSnapshotRef.current = {
      cursor: 0,
      scrollTop: 0,
      scrollHeight: 100,
      anchorOffset: 0,
      cursorVisible: false,
    };
    rerender({ filePath: OLD_PATH, sourceMode: false });

    for (let i = 0; i < stage; i += 1) {
      runFirstPendingFrame(harness.callbacks);
    }
    const pending = harness.callbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    expect(pending).toBeDefined();
    const [pendingId, lateCallback] = pending!;

    rerender({ filePath: NEW_PATH, sourceMode: false });
    expect(harness.cancelFrame).toHaveBeenCalledWith(pendingId);
    const savesBeforeLateCallback = harness.saveCursorState.mock.calls.length;
    lateCallback(0);
    expect(harness.saveCursorState).toHaveBeenCalledTimes(savesBeforeLateCallback);
    expect(harness.callbacks.size).toBe(0);
  });

  it("unmounting after the second frame cancels settle and prevents stale cursor writes", () => {
    harness = makeHarness();
    const { result, rerender, unmount } = renderHook(
      ({ filePath, sourceMode }: { filePath: string; sourceMode: boolean }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value: VALUE,
          getEditor: harness!.getEditor,
          lastSyncedRef: { current: VALUE },
        }),
      { initialProps: { filePath: OLD_PATH, sourceMode: true } },
    );
    result.current.exitSnapshotRef.current = {
      cursor: 0,
      scrollTop: 0,
      scrollHeight: 100,
      anchorOffset: 0,
      cursorVisible: false,
    };
    rerender({ filePath: OLD_PATH, sourceMode: false });
    runFirstPendingFrame(harness.callbacks);
    runFirstPendingFrame(harness.callbacks);
    const pending = harness.callbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    expect(pending).toBeDefined();
    const [pendingId, lateCallback] = pending!;

    unmount();
    expect(harness.cancelFrame).toHaveBeenCalledWith(pendingId);
    const savesBeforeLateCallback = harness.saveCursorState.mock.calls.length;
    lateCallback(0);
    expect(harness.saveCursorState).toHaveBeenCalledTimes(savesBeforeLateCallback);
    expect(harness.callbacks.size).toBe(0);
  });
});

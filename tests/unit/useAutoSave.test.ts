import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAutoSave } from "../../src/lib/useAutoSave";
import { useWorkspace } from "../../src/store/workspace";
import { pathRevs } from "../../src/store/workspace/shared";

vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

function tab(path: string, dirty: boolean, extra: Record<string, unknown> = {}) {
  return {
    path,
    content: "",
    dirty,
    isUntitled: false,
    cursorPos: null,
    scrollTop: null,
    lastSavedAt: null,
    ...extra,
  };
}

describe("useAutoSave hook（#364 按 path 独立防抖）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // pathRevs 是模块级状态，用例之间必须清空
    pathRevs.clear();
    useWorkspace.setState({
      dirty: false,
      saving: false,
      currentFile: "/path/to/test.md",
      activeTabPath: "/path/to/test.md",
      openTabs: [tab("/path/to/test.md", false) as never],
      saveTab: vi.fn().mockResolvedValue(undefined) as never,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("should auto save after debounce when dirty becomes true for normal file", async () => {
    const saveTabMock = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ saveTab: saveTabMock as never });

    const { rerender } = renderHook(() => useAutoSave());

    useWorkspace.setState({ dirty: true, openTabs: [tab("/path/to/test.md", true) as never] });
    rerender();

    expect(saveTabMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1999);
    expect(saveTabMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(saveTabMock).toHaveBeenCalledTimes(1);
    expect(saveTabMock).toHaveBeenCalledWith("/path/to/test.md", { interactive: false });
  });

  it("should NOT auto save if active tab is untitled", async () => {
    const saveTabMock = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({
      saveTab: saveTabMock as never,
      activeTabPath: "untitled-1",
      currentFile: null,
      openTabs: [tab("untitled-1", true, { isUntitled: true }) as never],
      dirty: true,
    });

    renderHook(() => useAutoSave());
    vi.advanceTimersByTime(2500);

    expect(saveTabMock).not.toHaveBeenCalled();
  });

  it("should trigger immediate save on Ctrl+S", async () => {
    const saveTabMock = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ saveTab: saveTabMock as never });

    renderHook(() => useAutoSave());

    const event = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(saveTabMock).toHaveBeenCalledTimes(1);
    expect(saveTabMock).toHaveBeenCalledWith("/path/to/test.md", { interactive: true });
  });

  it("should pause auto save while conflictPending is true", async () => {
    const saveTabMock = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({
      saveTab: saveTabMock as never,
      dirty: true,
      openTabs: [tab("/path/to/test.md", true, { conflictPending: true }) as never],
    });

    const { rerender } = renderHook(() => useAutoSave());
    rerender();

    vi.advanceTimersByTime(10000);
    expect(saveTabMock).not.toHaveBeenCalled();

    useWorkspace.setState({ openTabs: [tab("/path/to/test.md", true) as never] });
    rerender();
    vi.advanceTimersByTime(2000);
    expect(saveTabMock).toHaveBeenCalledTimes(1);
    expect(saveTabMock).toHaveBeenCalledWith("/path/to/test.md", { interactive: false });
  });

  it("保存期间继续输入：即便没有任何其它事件，也必须再存一次（rev 变化重置防抖）", async () => {
    const saveTabMock = vi.fn(async () => {
      // 保存成功清 dirty（模拟真实 store），但下一次编辑会再次变脏
      useWorkspace.setState((state) => ({
        openTabs: state.openTabs.map((t) => ({ ...t, dirty: false })),
        dirty: false,
      }));
    });
    useWorkspace.setState({
      saveTab: saveTabMock as never,
      dirty: true,
      openTabs: [tab("/path/to/test.md", true) as never],
    });

    const { rerender } = renderHook(() => useAutoSave());
    rerender();

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(saveTabMock).toHaveBeenCalledTimes(1);

    // 保存期间/之后又编辑了一次：只有 rev 会变，dirty 可能已被保存清掉
    await act(async () => {
      useWorkspace.getState().setContent("第二次编辑");
      rerender();
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(saveTabMock).toHaveBeenCalledTimes(2);
  });

  it("should maintain exponential backoff per file, not globally", async () => {
    // 文件 A 恒失败（保持 dirty），文件 B 成功
    const saveTabMock = vi.fn(async (path: string) => {
      if (path === "/docs/a.md") {
        useWorkspace.setState((state) => ({
          openTabs: state.openTabs.map((t) => (t.path === path ? { ...t, dirty: true } : t)),
          dirty: true,
        }));
        return;
      }
      useWorkspace.setState((state) => ({
        openTabs: state.openTabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)),
        dirty: false,
      }));
    });
    useWorkspace.setState({
      saveTab: saveTabMock as never,
      dirty: true,
      currentFile: "/docs/a.md",
      activeTabPath: "/docs/a.md",
      openTabs: [tab("/docs/a.md", true) as never],
    });

    const { rerender } = renderHook(() => useAutoSave());
    rerender();

    // A：t=2s（fails=0）→ 失败；下一次按 4s 退避 → t=6s 再失败；12s 内共 2 次
    for (let round = 0; round < 4; round++) {
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
    }
    const callsAfterA = saveTabMock.mock.calls.length;
    expect(callsAfterA).toBe(2);

    // 切到 B：退避按 path 隔离 → B 仍以 2s 基线触发
    await act(async () => {
      useWorkspace.setState({
        dirty: true,
        currentFile: "/docs/b.md",
        activeTabPath: "/docs/b.md",
        openTabs: [
          tab("/docs/a.md", true) as never,
          tab("/docs/b.md", true) as never,
        ],
      });
      rerender();
    });
    await act(async () => {
      vi.advanceTimersByTime(1999);
    });
    expect(saveTabMock).toHaveBeenCalledTimes(callsAfterA);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(saveTabMock).toHaveBeenCalledTimes(callsAfterA + 1);
  });
});

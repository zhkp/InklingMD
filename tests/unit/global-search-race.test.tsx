import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GlobalSearchPanel } from "../../src/components/GlobalSearch/GlobalSearchPanel";
import { useWorkspace } from "../../src/store/workspace";
import * as fsApi from "../../src/lib/fs";

describe("GlobalSearchPanel race condition guards (Issue #126)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspace.setState({
      rootPath: "/test/workspace",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("ignores older in-flight search results when a newer search finishes", async () => {
    let resolveFirst: (value: any) => void = () => {};
    const firstPromise = new Promise<any>((resolve) => {
      resolveFirst = resolve;
    });

    let resolveSecond: (value: any) => void = () => {};
    const secondPromise = new Promise<any>((resolve) => {
      resolveSecond = resolve;
    });

    const searchMock = vi.spyOn(fsApi, "searchInWorkspace");
    searchMock.mockImplementation((_root: string, query: string) => {
      if (query === "first") return firstPromise;
      if (query === "second") return secondPromise;
      return Promise.resolve({ hits: [], truncated: false });
    });

    const onClose = vi.fn();
    const getEditor = vi.fn().mockReturnValue(null);

    render(<GlobalSearchPanel getEditor={getEditor} onClose={onClose} />);

    const input = screen.getByPlaceholderText("在工作区搜索…");

    // 1. Type "first"
    fireEvent.change(input, { target: { value: "first" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    // 搜索代次自 #241 起由 Rust 侧分配，前端只传工作区与查询参数
    expect(searchMock).toHaveBeenCalledWith("/test/workspace", "first", false, false);

    // 2. Type "second" quickly
    fireEvent.change(input, { target: { value: "second" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(searchMock).toHaveBeenCalledWith("/test/workspace", "second", false, false);

    // 3. Second promise resolves first with 1 hit
    await act(async () => {
      resolveSecond({
        hits: [
          {
            path: "/test/workspace/b.md",
            line: 1,
            column: 1,
            preview: "second match",
          },
        ],
        truncated: false,
      });
    });

    expect(screen.getByText("b.md")).toBeTruthy();
    expect(screen.getByText("second")).toBeTruthy();

    // 4. First promise resolves later with old hit
    await act(async () => {
      resolveFirst({
        hits: [
          {
            path: "/test/workspace/a.md",
            line: 1,
            column: 1,
            preview: "old stale match",
          },
        ],
        truncated: false,
      });
    });

    // Stale match must not overwrite the latest hits
    expect(screen.queryByText("a.md")).toBeNull();
    expect(screen.getByText("b.md")).toBeTruthy();
  });

  it("unmount 以空查询触发 fire-and-forget 取消在途扫描（评审非阻塞补强）", async () => {
    const searchMock = vi.spyOn(fsApi, "searchInWorkspace");
    searchMock.mockResolvedValue({ hits: [], truncated: false });

    const onClose = vi.fn();
    const getEditor = vi.fn().mockReturnValue(null);

    const { unmount } = render(
      <GlobalSearchPanel getEditor={getEditor} onClose={onClose} />,
    );

    const input = screen.getByPlaceholderText("在工作区搜索…");
    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(searchMock).toHaveBeenCalledWith("/test/workspace", "needle", false, false);

    unmount();

    // 卸载 cleanup 必须发起一次「空查询」搜索：命令入口分配新代次后空查询立即返回，
    // 在途旧扫描在检查点看到代次推进后提前退出（#163；代次由 Rust 侧分配，#241）
    const lastCall = searchMock.mock.calls[searchMock.mock.calls.length - 1];
    expect(lastCall).toEqual(["/test/workspace", "", false, false]);
  });
});

// 全局搜索截断可见性（#160）单元测试
// - 后端截断时面板状态栏必须展示「结果已截断」，未截断时不展示
// - 浏览器 mock 分支返回 { hits, truncated } 结构且能真实命中
// （搜索代次自 #241 起由 Rust 侧分配，前端不再有 nextGlobalSearchGeneration）

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GlobalSearchPanel } from "../../src/components/GlobalSearch/GlobalSearchPanel";
import { useWorkspace } from "../../src/store/workspace";
import * as fsApi from "../../src/lib/fs";

function renderPanel() {
  const onClose = vi.fn();
  const getEditor = vi.fn().mockReturnValue(null);
  render(<GlobalSearchPanel getEditor={getEditor} onClose={onClose} />);
  return screen.getByPlaceholderText("在工作区搜索…");
}

describe("全局搜索截断提示（#160）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspace.setState({ rootPath: "/test/workspace" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("truncated=true 时状态栏展示截断提示", async () => {
    const searchMock = vi.spyOn(fsApi, "searchInWorkspace");
    searchMock.mockResolvedValue({
      hits: Array.from({ length: 50 }, (_, i) => ({
        path: "/test/workspace/big.md",
        line: i + 1,
        column: 1,
        preview: "needle",
      })),
      truncated: true,
    });

    const input = renderPanel();
    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const status = screen.getByText(/处匹配/);
    expect(status.textContent).toContain("结果已截断");
    expect(status.textContent).toContain("5000");
  });

  it("truncated=false 时不展示截断提示", async () => {
    const searchMock = vi.spyOn(fsApi, "searchInWorkspace");
    searchMock.mockResolvedValue({
      hits: [
        { path: "/test/workspace/a.md", line: 1, column: 1, preview: "needle" },
      ],
      truncated: false,
    });

    const input = renderPanel();
    fireEvent.change(input, { target: { value: "needle" } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const status = screen.getByText(/处匹配/);
    expect(status.textContent).toBe("1 个文件，1 处匹配");
    expect(status.textContent).not.toContain("截断");
  });
});

describe("浏览器 mock 返回结构（#160）", () => {
  it("searchInWorkspace 浏览器 mock 返回 { hits, truncated } 且真实命中", async () => {
    const result = await fsApi.searchInWorkspace("/mock/workspace", "mock", false, false);
    expect(result.truncated).toBe(false);
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    for (const hit of result.hits) {
      expect(hit.line).toBeGreaterThanOrEqual(1);
      expect(hit.preview.toLowerCase()).toContain("mock");
    }
  });

  it("非法正则时浏览器 mock 返回空结果而非抛错", async () => {
    const result = await fsApi.searchInWorkspace("/mock/workspace", "(", false, true);
    expect(result).toEqual({ hits: [], truncated: false });
  });
});

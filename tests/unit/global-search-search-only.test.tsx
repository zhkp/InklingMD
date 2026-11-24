import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { GlobalSearchPanel } from "../../src/components/GlobalSearch/GlobalSearchPanel";
import { useWorkspace, type OpenTab } from "../../src/store/workspace";
import * as fsApi from "../../src/lib/fs";
import type { SearchResult } from "../../src/lib/fs";

const SEARCH_ONLY_GUIDANCE =
  "此面板仅支持工作区搜索；替换请打开对应文件使用查找替换。";

function dirtyTab(path: string, content: string): OpenTab {
  return {
    path,
    content,
    dirty: true,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
  };
}

describe("全局搜索面板的仅搜索说明（#381）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspace.setState({ rootPath: "/test/workspace", openTabs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("明确告知工作区面板只搜索，并将替换指向当前文件查找替换", () => {
    vi.spyOn(fsApi, "searchInWorkspace").mockResolvedValue({
      hits: [],
      truncated: false,
    });
    render(
      <GlobalSearchPanel getEditor={() => undefined} onClose={() => {}} />,
    );

    expect(screen.getByText(SEARCH_ONLY_GUIDANCE)).toBeTruthy();
    expect(screen.getByPlaceholderText("在工作区搜索…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /替换/ })).toBeNull();
  });

  it("输入后在搜索中及结果返回后仍显示仅搜索说明", async () => {
    let resolveSearch!: (result: SearchResult) => void;
    const searchPromise = new Promise<SearchResult>((resolve) => {
      resolveSearch = resolve;
    });
    const searchMock = vi
      .spyOn(fsApi, "searchInWorkspace")
      .mockReturnValue(searchPromise);

    render(
      <GlobalSearchPanel getEditor={() => undefined} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByPlaceholderText("在工作区搜索…"), {
      target: { value: "needle" },
    });

    expect(screen.getByText("搜索中…")).toBeTruthy();
    expect(screen.getByText(SEARCH_ONLY_GUIDANCE)).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(searchMock).toHaveBeenCalledWith(
      "/test/workspace",
      "needle",
      false,
      false,
    );
    expect(screen.getByText("搜索中…")).toBeTruthy();
    expect(screen.getByText(SEARCH_ONLY_GUIDANCE)).toBeTruthy();

    await act(async () => {
      resolveSearch({
        hits: [
          {
            path: "/test/workspace/notes.md",
            line: 1,
            column: 1,
            preview: "needle found",
          },
        ],
        truncated: false,
      });
      await searchPromise;
    });

    expect(screen.getByText("1 个文件，1 处匹配")).toBeTruthy();
    expect(screen.getByText(SEARCH_ONLY_GUIDANCE)).toBeTruthy();
  });

  it("未保存内容的正则能力警告与仅搜索说明可以同时显示", async () => {
    useWorkspace.setState({
      openTabs: [dirtyTab("/test/workspace/draft.md", "needle in draft")],
    });
    vi.spyOn(fsApi, "searchInWorkspace").mockResolvedValue({
      hits: [],
      truncated: false,
    });

    render(
      <GlobalSearchPanel getEditor={() => undefined} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByTitle("正则表达式").querySelector("input")!);
    fireEvent.change(screen.getByPlaceholderText("在工作区搜索…"), {
      target: { value: "(?i)needle" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(screen.getByText(/该正则在未保存内容中不受支持/)).toBeTruthy();
    expect(screen.getByText(SEARCH_ONLY_GUIDANCE)).toBeTruthy();
  });
});

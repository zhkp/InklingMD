// 全局搜索合并内存缓冲单测（issue #370）
//
// 锁定 GlobalSearchPanel 的合并语义：
// - dirty tab / 未命名草稿的内容在内存中搜索并标注「未保存」；
// - 这些文件的磁盘命中（旧版本）被排除，不与内存命中重复；
// - 干净文件的磁盘命中正常展示、不带徽标；
// - 搜索前 flush 发布器（防抖窗口内的输入可被搜到——通过调用断言锁定）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { GlobalSearchPanel } from "../../src/components/GlobalSearch/GlobalSearchPanel";
import { useWorkspace, type OpenTab } from "../../src/store/workspace";
import * as fsApi from "../../src/lib/fs";
import * as publisher from "../../src/components/Editor/markdown-publisher";

function tab(path: string, content: string, extra: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    content,
    dirty: false,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
    ...extra,
  };
}

describe("GlobalSearchPanel 未保存内容合并（#370）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkspace.setState({
      rootPath: "/test/workspace",
      activeTabPath: "/test/workspace/dirty.md",
      openTabs: [
        // dirty 文件：内存内容含关键词，磁盘旧版本也有（不同行）
        tab("/test/workspace/dirty.md", "# 脏文件\n\n刚输入的 needle 目标行。\n", {
          dirty: true,
          diskContent: "# 脏文件\n\n磁盘旧版本 needle（应被内存结果替换）\n",
        }),
        // 未命名草稿：不属于工作区文件，磁盘上不存在
        tab("untitled-1", "# 草稿\n\n草稿里的 needle 内容。\n", {
          dirty: true,
          isUntitled: true,
        }),
        // 干净文件：磁盘命中应正常展示
        tab("/test/workspace/clean.md", "# 干净文件\n", { dirty: false }),
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderPanel() {
    const onClose = vi.fn();
    const getEditor = vi.fn().mockReturnValue(null);
    const { container } = render(
      <GlobalSearchPanel getEditor={getEditor} onClose={onClose} />,
    );
    return {
      container,
      input: screen.getByPlaceholderText("在工作区搜索…"),
    };
  }

  it("未保存 tab 的内存命中可搜到并标注「未保存」，磁盘旧命中被排除不重复", async () => {
    const searchMock = vi.spyOn(fsApi, "searchInWorkspace").mockResolvedValue({
      hits: [
        // dirty 文件的磁盘旧版本命中（应被内存命中替换，不展示）
        {
          path: "/test/workspace/dirty.md",
          line: 3,
          column: 1,
          preview: "磁盘旧版本 needle（应被内存结果替换）",
        },
        // 干净文件的磁盘命中（应正常展示）
        {
          path: "/test/workspace/clean.md",
          line: 1,
          column: 1,
          preview: "干净文件 needle 命中",
        },
      ],
      truncated: false,
    });
    // 真实断言：搜索发起前必须先 flush 发布器（防抖窗口内的输入才能被搜到）
    const flushSpy = vi.spyOn(publisher, "flushAllMarkdownPublishers");

    const { container, input } = renderPanel();
    fireEvent.change(input, { target: { value: "needle" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(flushSpy).toHaveBeenCalled();
    expect(flushSpy.mock.invocationCallOrder[0]).toBeLessThan(
      searchMock.mock.invocationCallOrder[0],
    );

    // dirty 文件：展示的是内存版本（第 3 行的内存内容），不是磁盘旧版本
    // （预览文本会被 <mark> 拆分成多个节点，用整体 textContent 断言）
    expect(container.textContent).toContain("dirty.md");
    expect(container.textContent).not.toContain("磁盘旧版本");
    expect(container.textContent).toContain("刚输入的");

    // 未命名草稿：以「未命名 1」分组展示
    expect(container.textContent).toContain("未命名 1");
    expect(container.textContent).toContain("草稿里的");

    // 干净文件：磁盘命中正常展示
    expect(container.textContent).toContain("clean.md");
    expect(container.textContent).toContain("干净文件 needle 命中");

    // 「未保存」徽标只出现在 dirty / 草稿分组上（2 个），干净文件不带
    const badges = screen.getAllByText("未保存");
    expect(badges).toHaveLength(2);

    // 磁盘搜索仍按原参数发起（合并发生在前端）
    expect(searchMock).toHaveBeenCalledWith("/test/workspace", "needle", false, false);
  });

  it("冲突暂停自动保存（conflictPending + dirty）的内容同样可搜到", async () => {
    useWorkspace.setState({
      openTabs: [
        tab("/test/workspace/conflicted.md", "# 冲突文件\n\n冲突期间输入的 needle。\n", {
          dirty: true,
          conflictPending: true,
          diskContent: "# 冲突文件\n",
        }),
      ],
      activeTabPath: "/test/workspace/conflicted.md",
    });
    vi.spyOn(fsApi, "searchInWorkspace").mockResolvedValue({ hits: [], truncated: false });

    const { container, input } = renderPanel();
    fireEvent.change(input, { target: { value: "needle" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(container.textContent).toContain("冲突期间输入的");
    expect(screen.getAllByText("未保存")).toHaveLength(1);
  });

  it("Regex 在未保存内容中不受支持（Rust 合法但 JS 非法）时给出可见提示，不静默丢命中", async () => {
    useWorkspace.setState({
      rootPath: "/test/workspace",
      openTabs: [
        tab("/test/workspace/dirty.md", "# 脏文件\n\n刚输入的 NEEDLE 目标。\n", { dirty: true }),
      ],
      activeTabPath: "/test/workspace/dirty.md",
      currentFile: "/test/workspace/dirty.md",
      currentContent: "# 脏文件\n\n刚输入的 NEEDLE 目标。\n",
      dirty: true,
    });
    // 磁盘侧（Rust regex）接受 (?i) 内联标志并返回命中；JS 侧编译失败
    vi.spyOn(fsApi, "searchInWorkspace").mockResolvedValue({
      hits: [
        {
          path: "/test/workspace/clean.md",
          line: 1,
          column: 1,
          preview: "needle 磁盘命中",
        },
      ],
      truncated: false,
    });

    const { input } = renderPanel();
    // 勾选正则、输入 Rust 合法但 JS 不支持的模式
    fireEvent.click(screen.getByTitle("正则表达式").querySelector("input")!);
    fireEvent.change(input, { target: { value: "(?i)needle" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // 磁盘命中照常展示
    expect(screen.getByText("clean.md")).toBeTruthy();
    // 未保存内容的命中未被检索：必须显式提示，不得静默
    expect(screen.getByText(/该正则在未保存内容中不受支持/)).toBeTruthy();
  });
});

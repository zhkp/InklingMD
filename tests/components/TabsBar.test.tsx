// TabsBar 组件测试
// 验证：无 tab 不渲染、tab 显示文件名、同名文件显示最短目录后缀、
// 未命名 tab 显示「未命名 N」、未保存显示圆点、点击切换、关闭按钮、
// 中键关闭、未保存确认

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TabsBar } from "../../src/components/Tabs/TabsBar";
import { useWorkspace, type OpenTab } from "../../src/store/workspace";

function makeTab(overrides: Partial<OpenTab> = {}): OpenTab {
  return {
    path: "/test.md",
    content: "",
    cursorPos: null,
    scrollTop: 0,
    dirty: false,
    isUntitled: false,
    lastSavedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  useWorkspace.setState({
    openTabs: [],
    activeTabPath: null,
  });
});

describe("TabsBar", () => {
  it("无 tab 时不渲染", () => {
    const { container } = render(<TabsBar />);
    expect(container.firstChild).toBeNull();
  });

  it("显示文件名", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/docs/readme.md" })],
      activeTabPath: "/docs/readme.md",
    });
    render(<TabsBar />);
    expect(screen.getByText("readme.md")).toBeInTheDocument();
  });

  it("Windows 路径正确取文件名", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "C:\\Users\\test\\doc.md" })],
      activeTabPath: "C:\\Users\\test\\doc.md",
    });
    render(<TabsBar />);
    expect(screen.getByText("doc.md")).toBeInTheDocument();
  });

  it("不同文件名不显示目录说明", () => {
    useWorkspace.setState({
      openTabs: [
        makeTab({ path: "/docs/readme.md" }),
        makeTab({ path: "/examples/guide.md" }),
      ],
      activeTabPath: "/docs/readme.md",
    });
    const { container } = render(<TabsBar />);
    expect(container.querySelector(".tab-description")).toBeNull();
  });

  it("同名文件显示各自的直属父目录", () => {
    useWorkspace.setState({
      openTabs: [
        makeTab({ path: "/issues/006-unshare/ISSUE_zh.md" }),
        makeTab({ path: "/issues/007-protected/ISSUE_zh.md" }),
      ],
      activeTabPath: "/issues/006-unshare/ISSUE_zh.md",
    });
    render(<TabsBar />);
    expect(screen.getByText("…/006-unshare")).toBeInTheDocument();
    expect(screen.getByText("…/007-protected")).toBeInTheDocument();
  });

  it("直属父目录同名时显示最短可区分的多级后缀", () => {
    useWorkspace.setState({
      openTabs: [
        makeTab({ path: "/workspace/alpha/docs/readme.md" }),
        makeTab({ path: "/workspace/beta/docs/readme.md" }),
      ],
      activeTabPath: "/workspace/alpha/docs/readme.md",
    });
    render(<TabsBar />);
    expect(screen.getByText("…/alpha/docs")).toBeInTheDocument();
    expect(screen.getByText("…/beta/docs")).toBeInTheDocument();
  });

  it("同名文件的目录说明兼容 Windows 路径", () => {
    useWorkspace.setState({
      openTabs: [
        makeTab({ path: "C:\\work\\alpha\\notes.md" }),
        makeTab({ path: "C:\\work\\beta\\notes.md" }),
      ],
      activeTabPath: "C:\\work\\alpha\\notes.md",
    });
    render(<TabsBar />);
    expect(screen.getByText("…/alpha")).toBeInTheDocument();
    expect(screen.getByText("…/beta")).toBeInTheDocument();
  });

  it("未命名草稿显示「未命名 N」", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "untitled-3", isUntitled: true })],
      activeTabPath: "untitled-3",
    });
    render(<TabsBar />);
    expect(screen.getByText("未命名 3")).toBeInTheDocument();
  });

  it("未保存的 tab 显示圆点", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/test.md", dirty: true })],
      activeTabPath: "/test.md",
    });
    render(<TabsBar />);
    expect(screen.getByTitle("未保存")).toBeInTheDocument();
  });

  it("已保存的 tab 不显示圆点", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/test.md", dirty: false })],
      activeTabPath: "/test.md",
    });
    render(<TabsBar />);
    expect(screen.queryByTitle("未保存")).not.toBeInTheDocument();
  });

  it("点击 tab 调用 switchTab", () => {
    const switchTab = vi.fn();
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/a.md" }), makeTab({ path: "/b.md" })],
      activeTabPath: "/a.md",
      switchTab,
    });
    render(<TabsBar />);
    fireEvent.click(screen.getByText("b.md"));
    expect(switchTab).toHaveBeenCalledWith("/b.md");
  });

  it("关闭已保存 tab 直接调用 closeTab", () => {
    const closeTab = vi.fn();
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/test.md", dirty: false })],
      activeTabPath: "/test.md",
      closeTab,
    });
    render(<TabsBar />);
    fireEvent.click(screen.getByTitle("关闭"));
    expect(closeTab).toHaveBeenCalledWith("/test.md");
  });

  it("关闭未保存 tab 弹确认，取消则不关闭", () => {
    const closeTab = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/test.md", dirty: true })],
      activeTabPath: "/test.md",
      closeTab,
    });
    render(<TabsBar />);
    fireEvent.click(screen.getByTitle("关闭"));
    expect(confirmSpy).toHaveBeenCalled();
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("关闭未保存 tab 确认后关闭", async () => {
    const closeTab = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/test.md", dirty: true })],
      activeTabPath: "/test.md",
      closeTab,
    });
    render(<TabsBar />);
    await fireEvent.click(screen.getByTitle("关闭"));
    expect(closeTab).toHaveBeenCalledWith("/test.md");
  });

  it("滚轮按 deltaMode 归一化后横向滚动 tab 条", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/a.md" })],
      activeTabPath: "/a.md",
    });
    const { container } = render(<TabsBar />);
    const bar = container.querySelector(".tabs-bar") as HTMLElement;
    fireEvent.wheel(bar, { deltaY: 3, deltaMode: 1 });
    expect(bar.scrollLeft).toBe(96);
    fireEvent.wheel(bar, { deltaY: 100, deltaMode: 0 });
    expect(bar.scrollLeft).toBe(196);
  });

  it("当前激活 tab 有 tab-active 类", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/a.md" }), makeTab({ path: "/b.md" })],
      activeTabPath: "/b.md",
    });
    const { container } = render(<TabsBar />);
    const activeTab = container.querySelector(".tab-active");
    expect(activeTab).not.toBeNull();
    expect(activeTab?.textContent).toContain("b.md");
  });
});

describe("TabsBar 激活 tab 滚入视野 (#187)", () => {
  // jsdom 无布局引擎，给 scrollIntoView 装 spy，
  // 断言「哪个元素、以什么参数」被滚动（而非只查状态值的伪断言）
  const scrollIntoViewMock = vi.fn();

  beforeEach(() => {
    scrollIntoViewMock.mockClear();
    Element.prototype.scrollIntoView = scrollIntoViewMock;
  });

  it("挂载时把当前激活的 tab 滚入视野", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/a.md" }), makeTab({ path: "/b.md" })],
      activeTabPath: "/b.md",
    });
    render(<TabsBar />);

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    const tabB = screen.getByText("b.md").closest(".tab");
    expect(scrollIntoViewMock.mock.instances[0]).toBe(tabB);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      inline: "nearest",
      block: "nearest",
    });
  });

  it("切换激活 tab 后，新激活的 tab 元素滚入视野", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/a.md" }), makeTab({ path: "/b.md" })],
      activeTabPath: "/a.md",
    });
    render(<TabsBar />);
    scrollIntoViewMock.mockClear();

    act(() => {
      useWorkspace.setState({ activeTabPath: "/b.md" });
    });

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    const tabB = screen.getByText("b.md").closest(".tab");
    expect(scrollIntoViewMock.mock.instances[0]).toBe(tabB);
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      inline: "nearest",
      block: "nearest",
    });
  });

  it("激活未变化时不重复滚动（依赖仅 activeTabPath）", () => {
    useWorkspace.setState({
      openTabs: [makeTab({ path: "/a.md", dirty: false })],
      activeTabPath: "/a.md",
    });
    const { rerender } = render(<TabsBar />);
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);

    // 与激活无关的重渲染（如 dirty 标记变化）不触发额外滚动
    act(() => {
      useWorkspace.setState({
        openTabs: [makeTab({ path: "/a.md", dirty: true })],
      });
    });
    rerender(<TabsBar />);
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });
});

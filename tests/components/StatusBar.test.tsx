// StatusBar 组件测试
// 验证：无文件时不渲染、有文件时显示字数/字符/行数/阅读时长/缩放比例

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { StatusBar } from "../../src/components/StatusBar/StatusBar";
import { STATS_DEBOUNCE_MS } from "../../src/lib/useDeferredStats";
import { useWorkspace } from "../../src/store/workspace";
import { useSettings } from "../../src/store/settings";

beforeEach(() => {
  // 重置 store 状态
  useWorkspace.setState({
    currentFile: null,
    currentContent: "",
  });
  useSettings.getState().resetEditorZoom();
});

describe("StatusBar", () => {
  it("无当前文件时不渲染", () => {
    const { container } = render(<StatusBar />);
    expect(container.firstChild).toBeNull();
  });

  it("有文件时显示字数统计", () => {
    useWorkspace.setState({
      currentFile: "/test.md",
      currentContent: "hello world",
    });
    render(<StatusBar />);
    expect(screen.getByText(/字数 2/)).toBeInTheDocument();
    expect(screen.getByText(/字符 11/)).toBeInTheDocument();
    expect(screen.getByText(/行 1/)).toBeInTheDocument();
  });

  it("中文内容按字统计", () => {
    useWorkspace.setState({
      currentFile: "/test.md",
      currentContent: "你好世界",
    });
    render(<StatusBar />);
    expect(screen.getByText(/字数 4/)).toBeInTheDocument();
  });

  it("多行内容显示正确行数", () => {
    useWorkspace.setState({
      currentFile: "/test.md",
      currentContent: "line1\nline2\nline3",
    });
    render(<StatusBar />);
    expect(screen.getByText(/行 3/)).toBeInTheDocument();
  });

  it("内容变化后停笔防抖窗口结束刷新统计（#374）", () => {
    vi.useFakeTimers();
    try {
      useWorkspace.setState({
        currentFile: "/test.md",
        currentContent: "foo",
      });
      const { rerender } = render(<StatusBar />);
      expect(screen.getByText(/字数 1/)).toBeInTheDocument();

      act(() => {
        useWorkspace.setState({ currentContent: "foo bar baz" });
      });
      rerender(<StatusBar />);
      // 防抖窗口内保留旧值（状态栏不闪空），停笔后才刷新
      expect(screen.getByText(/字数 1/)).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(STATS_DEBOUNCE_MS);
      });
      expect(screen.getByText(/字数 3/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("默认显示 100% 缩放，调整后显示新比例", () => {
    useWorkspace.setState({ currentFile: "/test.md", currentContent: "" });
    render(<StatusBar />);
    expect(screen.getByText("100%")).toBeInTheDocument();
    act(() => {
      useSettings.getState().adjustEditorZoom(0.3); // 100% -> 130%
    });
    expect(screen.getByText("130%")).toBeInTheDocument();
  });

  it("点击缩放按钮重置为 100%", () => {
    useWorkspace.setState({ currentFile: "/test.md", currentContent: "" });
    useSettings.getState().setEditorZoom(1.5);
    render(<StatusBar />);
    const btn = screen.getByText("150%");
    fireEvent.click(btn);
    expect(useSettings.getState().editorZoom).toBe(1);
  });
});

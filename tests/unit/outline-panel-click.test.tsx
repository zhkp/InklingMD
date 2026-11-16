// 大纲面板点击的文件归属（#419 评审 B1）
//
// 元素缓存命中时复用同一个 React element，element 的 props 里带着创建时的
// `onClick` 闭包。大纲 id 是 `h-<index>-<slug>`、不含文件路径，两个同构文档
// 的 id/字段逐一相同；若命中判定不看回调身份，换文件后点击仍会走旧文件的
// 滚动处理器（旧文件处理器已注销 → 点了没反应）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { EditorOutlineSnapshot } from "../../src/lib/outline";

const scrollCalls: Array<{ file: string; heading: unknown }> = [];
const runSourceModeScrollToHeading = vi.fn(
  (file: string, heading: unknown): boolean => {
    scrollCalls.push({ file, heading });
    return true;
  },
);

vi.mock("../../src/lib/source-mode-scroll", () => ({
  runSourceModeScrollToHeading: (file: string, heading: unknown): boolean =>
    runSourceModeScrollToHeading(file, heading),
  // 其他导出保持可用（面板只用到上面这个）
  mapScrollTop: (v: number) => v,
}));

const { OutlinePanel } = await import("../../src/components/Outline/OutlinePanel");
const { useWorkspace } = await import("../../src/store/workspace");
const { useOutline } = await import("../../src/store/outline");

/** 两个文档的标题集逐字段同构（id 都是 h-<index>-<slug>，不含路径） */
function snapshot(): EditorOutlineSnapshot {
  return {
    headings: [
      { id: "h-0-a", index: 0, level: 1, text: "A", pos: 0, nodeId: null },
      { id: "h-1-b", index: 1, level: 2, text: "B", pos: 10, nodeId: null },
    ],
    activeIndex: 0,
  };
}

describe("OutlinePanel 点击归属", () => {
  beforeEach(() => {
    cleanup();
    runSourceModeScrollToHeading.mockClear();
    useOutline.setState({
      file: null,
      snapshot: { headings: [], activeIndex: null },
    });
    useWorkspace.setState({ currentFile: "/a.md", activeTabPath: "/a.md" });
  });

  it("同批切换 currentFile + 同构快照后，点击交给新文件（#419 评审 B1）", () => {
    act(() => {
      useOutline.getState().publish("/a.md", snapshot());
    });
    const { container } = render(<OutlinePanel getEditor={() => undefined} />);
    const items = container.querySelectorAll<HTMLButtonElement>(".outline-item");
    expect(items.length).toBe(2);

    items[0].click();
    expect(runSourceModeScrollToHeading).toHaveBeenLastCalledWith(
      "/a.md",
      expect.objectContaining({ id: "h-0-a" }),
    );

    // 关键场景：同一次提交里换文件 + 发布「逐字段同构」的快照。
    // 只按标题字段命中缓存时，元素会带着 /a.md 的闭包被复用。
    act(() => {
      useWorkspace.setState({ currentFile: "/b.md", activeTabPath: "/b.md" });
      useOutline.getState().publish("/b.md", snapshot());
    });

    const after = container.querySelectorAll<HTMLButtonElement>(".outline-item");
    expect(after.length).toBe(2);
    expect(after[0].textContent).toBe("A"); // 前提：两个文档确实同构
    after[0].click();
    expect(runSourceModeScrollToHeading).toHaveBeenLastCalledWith(
      "/b.md",
      expect.objectContaining({ id: "h-0-a" }),
    );
  });

  it("同文件重复渲染不重建 DOM（复用仍然生效）", () => {
    act(() => {
      useOutline.getState().publish("/a.md", snapshot());
    });
    const { container, rerender } = render(
      <OutlinePanel getEditor={() => undefined} />,
    );
    const firstNode = container.querySelectorAll(".outline-item")[0];

    // 发布内容完全相同的新对象数组：DOM 节点必须是同一个（未被卸载重建）
    act(() => {
      useOutline.getState().publish("/a.md", snapshot());
    });
    rerender(<OutlinePanel getEditor={() => undefined} />);
    expect(container.querySelectorAll(".outline-item")[0]).toBe(firstNode);
  });
});

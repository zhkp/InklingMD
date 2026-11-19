// 大纲面板的两条接线断言（#419 评审 B1 / 第二轮 N1）
//
// B1：元素缓存命中时复用同一个 React element，element 的 props 里带着创建时的
// `onClick` 闭包。大纲 id 是 `h-<index>-<slug>`、不含文件路径，两个同构文档的
// id/字段逐一相同；若命中判定不看回调身份，换文件后点击仍会走旧文件的滚动
// 处理器（旧处理器已注销 → 点了没反应）。
//
// N1：DOM 节点同一性**不能**证明元素复用——React 按 key + type 复用 DOM 与是否
// 复用 element 无关。这里改为包住真实实现做 spy，直接断言「第二次渲染
// `reuseOutlineItems` 收到的缓存非空、`create` 调用 0 次、返回的 element 与上次
// 同一引用」。若面板接线坏掉（缓存被改成每次 new Map / 复用调用被删），这些
// 断言必然失败。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import type { EditorOutlineSnapshot } from "../../src/lib/outline";
import type {
  CachedOutlineItem,
  OutlineItemCallbacks,
} from "../../src/components/Outline/outline-item-cache";

/** 记录每次 reuseOutlineItems 的入参与产出（vi.hoisted 保证 mock 工厂可用） */
const { reuseCalls } = vi.hoisted(() => ({
  reuseCalls: [] as Array<{
    prevSize: number;
    createCalls: number;
    elements: ReactElement[];
  }>,
}));

vi.mock("../../src/components/Outline/outline-item-cache", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/components/Outline/outline-item-cache")
    >();
  return {
    ...actual,
    reuseOutlineItems: (
      prev: ReadonlyMap<string, CachedOutlineItem>,
      headings: Parameters<typeof actual.reuseOutlineItems>[1],
      activeIndex: number | null,
      callbacks: OutlineItemCallbacks,
      create: (
        h: Parameters<typeof actual.reuseOutlineItems>[1][number],
        active: boolean,
        bound: OutlineItemCallbacks,
      ) => ReactElement,
    ) => {
      let createCalls = 0;
      const result = actual.reuseOutlineItems(
        prev,
        headings,
        activeIndex,
        callbacks,
        (heading, active, bound) => {
          createCalls += 1;
          return create(heading, active, bound);
        },
      );
      reuseCalls.push({
        prevSize: prev.size,
        createCalls,
        elements: result.elements,
      });
      return result;
    },
  };
});

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

/** 稳定的 getEditor 引用：同一文件内它不该变，否则 callbacks 变化会掩盖复用 */
const getEditor = (): undefined => undefined;

describe("OutlinePanel 接线", () => {
  beforeEach(() => {
    cleanup();
    reuseCalls.length = 0;
    scrollCalls.length = 0;
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
    const { container } = render(<OutlinePanel getEditor={getEditor} />);
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

  it("同文件重复发布：命中缓存、不新建元素（#419 评审 N1）", () => {
    act(() => {
      useOutline.getState().publish("/a.md", snapshot());
    });
    const view = render(<OutlinePanel getEditor={getEditor} />);
    const first = reuseCalls.at(-1);
    expect(first, "面板没有调用 reuseOutlineItems").toBeTruthy();
    expect(first?.createCalls).toBe(2);

    // 发布一份全新的对象数组（字段完全相同）：这才是「该命中缓存」的输入
    act(() => {
      useOutline.getState().publish("/a.md", snapshot());
    });
    view.rerender(<OutlinePanel getEditor={getEditor} />);

    const second = reuseCalls.at(-1);
    expect(second?.prevSize, "第二次渲染拿到的缓存是空的（复用被绕过）").toBe(2);
    expect(second?.createCalls, "同内容重新发布却重建了元素").toBe(0);
    expect(second?.elements[0]).toBe(first?.elements[0]);
    expect(second?.elements[1]).toBe(first?.elements[1]);
  });

  it("换文件：回调身份变化导致整表重建（一次性成本，B1 的另一面）", () => {
    act(() => {
      useOutline.getState().publish("/a.md", snapshot());
    });
    const view = render(<OutlinePanel getEditor={getEditor} />);
    const first = reuseCalls.at(-1);

    act(() => {
      useWorkspace.setState({ currentFile: "/b.md", activeTabPath: "/b.md" });
      useOutline.getState().publish("/b.md", snapshot());
    });
    view.rerender(<OutlinePanel getEditor={getEditor} />);

    const second = reuseCalls.at(-1);
    expect(second?.createCalls).toBe(2);
    expect(second?.elements[0]).not.toBe(first?.elements[0]);
  });
});

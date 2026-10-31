// 状态栏统计延迟刷新（issue #374）单测
//
// 锁住行为契约：
// 1. 输入期间不逐键统计，停顿 STATS_DEBOUNCE_MS 后只算一次，且用最新内容；
// 2. 旧结果保留显示（不闪空），刷新后数字与内容一致；
// 3. 切 tab 立即刷新，保存信号（flushOn）立即刷新待处理内容；
// 4. 卸载后不再触发统计。

import { act, render, renderHook } from "@testing-library/react";
import { createElement, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { countStatsMock } = vi.hoisted(() => ({ countStatsMock: vi.fn() }));

// 每次调用都委托真实实现：tests/setup.ts 的全局 restoreAllMocks 会清掉
// 通过 mockImplementation 安装的实现，委托真实实现则不受影响。
vi.mock("../../src/lib/stats", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/stats")>();
  return {
    ...actual,
    countStats: (text: string) => {
      countStatsMock(text);
      return actual.countStats(text);
    },
  };
});

import {
  STATS_DEBOUNCE_MS,
  useDeferredStats,
} from "../../src/lib/useDeferredStats";

interface Props {
  content: string;
  file: string | null;
  flushOn: boolean;
}

function renderStats(initialProps: Props) {
  return renderHook(
    ({ content, file, flushOn }: Props) =>
      useDeferredStats(content, file, flushOn),
    { initialProps },
  );
}

describe("useDeferredStats（#374）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    countStatsMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("首次渲染立即给出统计结果", () => {
    const { result } = renderStats({
      content: "hello world",
      file: "a.md",
      flushOn: false,
    });
    expect(result.current.words).toBe(2);
    expect(countStatsMock).toHaveBeenCalledTimes(1);
  });

  it("输入期间不统计，停顿后只按最新内容算一次", () => {
    const { result, rerender } = renderStats({
      content: "alpha",
      file: "a.md",
      flushOn: false,
    });
    expect(result.current.words).toBe(1);
    countStatsMock.mockClear();

    act(() => rerender({ content: "alpha beta", file: "a.md", flushOn: false }));
    act(() => vi.advanceTimersByTime(100));
    act(() =>
      rerender({ content: "alpha beta gamma", file: "a.md", flushOn: false }),
    );
    act(() => vi.advanceTimersByTime(STATS_DEBOUNCE_MS - 1));
    expect(countStatsMock).not.toHaveBeenCalled();
    // 旧结果保留（状态栏不闪空）
    expect(result.current.words).toBe(1);

    act(() => vi.advanceTimersByTime(1));
    expect(countStatsMock).toHaveBeenCalledTimes(1);
    expect(countStatsMock).toHaveBeenLastCalledWith("alpha beta gamma");
    expect(result.current.words).toBe(3);
  });

  it("切换文件立即刷新，不等防抖", () => {
    const { result, rerender } = renderStats({
      content: "alpha",
      file: "a.md",
      flushOn: false,
    });
    countStatsMock.mockClear();

    act(() => rerender({ content: "beta gamma", file: "b.md", flushOn: false }));
    expect(countStatsMock).toHaveBeenCalledTimes(1);
    expect(countStatsMock).toHaveBeenLastCalledWith("beta gamma");
    expect(result.current.words).toBe(2);
  });

  it("切文件在 layout 阶段就换掉旧统计，首帧不显示上一篇字数", () => {
    // 记录每次「布局阶段」能看到的统计调用与数字。hook 的 layout effect
    // 先于组件自身的 layout effect 执行：若 hook 用 passive effect，
    // 切文件后的首次布局阶段看到的仍是旧内容（0 次新调用）。
    const layoutLastCall: Array<string | undefined> = [];
    const layoutWords: string[] = [];

    function Harness({ content, file }: Props) {
      const stats = useDeferredStats(content, file, false);
      useLayoutEffect(() => {
        layoutLastCall.push(countStatsMock.mock.calls.at(-1)?.[0]);
        layoutWords.push(String(stats.words));
      });
      return createElement(
        "span",
        { "data-testid": "words" },
        String(stats.words),
      );
    }

    const { rerender, getByTestId } = render(
      createElement(Harness, {
        content: "alpha beta",
        file: "a.md",
        flushOn: false,
      }),
    );
    expect(layoutWords.at(-1)).toBe("2");

    countStatsMock.mockClear();
    layoutLastCall.length = 0;
    layoutWords.length = 0;

    act(() =>
      rerender(
        createElement(Harness, {
          content: "gamma",
          file: "b.md",
          flushOn: false,
        }),
      ),
    );

    expect(layoutLastCall[0]).toBe("gamma");
    expect(layoutWords.at(-1)).toBe("1");
    expect(getByTestId("words").textContent).toBe("1");
  });

  it("保存信号立即刷新待处理内容", () => {
    const { result, rerender } = renderStats({
      content: "alpha",
      file: "a.md",
      flushOn: false,
    });
    act(() =>
      rerender({ content: "alpha beta", file: "a.md", flushOn: false }),
    );
    expect(result.current.words).toBe(1);
    countStatsMock.mockClear();

    act(() => rerender({ content: "alpha beta", file: "a.md", flushOn: true }));
    expect(countStatsMock).toHaveBeenCalledTimes(1);
    expect(countStatsMock).toHaveBeenLastCalledWith("alpha beta");
    expect(result.current.words).toBe(2);
  });

  it("保存信号在 layout 阶段刷新，首帧不显示旧统计", () => {
    const layoutLastCall: Array<string | undefined> = [];
    const layoutWords: string[] = [];

    function Harness({ content, file, flushOn }: Props) {
      const stats = useDeferredStats(content, file, flushOn);
      useLayoutEffect(() => {
        layoutLastCall.push(countStatsMock.mock.calls.at(-1)?.[0]);
        layoutWords.push(String(stats.words));
      });
      return createElement(
        "span",
        { "data-testid": "words" },
        String(stats.words),
      );
    }

    const { rerender } = render(
      createElement(Harness, {
        content: "alpha",
        file: "a.md",
        flushOn: false,
      }),
    );
    countStatsMock.mockClear();
    layoutLastCall.length = 0;
    layoutWords.length = 0;

    act(() =>
      rerender(
        createElement(Harness, {
          content: "alpha beta",
          file: "a.md",
          flushOn: true,
        }),
      ),
    );

    expect(layoutLastCall[0]).toBe("alpha beta");
    expect(layoutWords.at(-1)).toBe("2");
  });

  it("卸载后不再触发统计", () => {
    const { rerender, unmount } = renderStats({
      content: "alpha",
      file: "a.md",
      flushOn: false,
    });
    act(() =>
      rerender({ content: "alpha beta", file: "a.md", flushOn: false }),
    );
    countStatsMock.mockClear();

    unmount();
    act(() => vi.advanceTimersByTime(STATS_DEBOUNCE_MS * 2));
    expect(countStatsMock).not.toHaveBeenCalled();
  });
});

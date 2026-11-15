// SourceModeEditor 挂载时初始滚动恢复测试（issue #136 方向 B）
// 内容锚点优先：提供 initialAnchorOffset 时，把该行滚到视口顶部，
// 比例映射输入仅作无锚点时的兜底（两容器密度不均，比例映射会落到不同内容）。
// 验证「立即设置 + 逐帧 settle」收敛机制：
// 模拟 CM6 长文档挂载初期 scrollHeight 来自估算（maxScroll 偏小），
// 首次赋值被钳制；随真实测量逐步撑开后，settle 循环应把 scrollTop
// 修正到目标值，而非停留在被钳制的错误位置（旧实现为单次赋值）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { SourceModeEditor } from "../../src/components/Editor/SourceModeEditor";
import { useSettings } from "../../src/store/settings";
import { mapScrollTop } from "../../src/lib/source-mode-cursor";

const LONG_TEXT = Array.from({ length: 400 }, (_, i) => `第 ${i + 1} 行内容`).join("\n");

describe("SourceModeEditor 初始滚动恢复（#136 方向 B）", () => {
  let rafQueue: FrameRequestCallback[];
  let originalRaf: typeof window.requestAnimationFrame;

  beforeEach(() => {
    rafQueue = [];
    originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return rafQueue.length;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = vi.fn();
    useSettings.setState({ codeBlockTheme: "none" });
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRaf;
    cleanup();
  });

  const flushFrame = () => {
    const cbs = rafQueue.splice(0, rafQueue.length);
    for (const cb of cbs) cb(0);
  };

  it("挂载初期的钳制会随高度撑开被逐帧修正到目标位置", () => {
    const { container } = render(
      <SourceModeEditor
        filePath="/tmp/scroll-test.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={500}
        spellcheck={false}
      />,
    );

    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    expect(scroller).not.toBeNull();

    // 接管 scrollTop：模拟 CM 高度估算逐步被真实测量修正（maxScroll 逐帧增长）
    let maxScroll = 100;
    let current = 0;
    Object.defineProperty(scroller, "scrollTop", {
      get: () => current,
      set: (v: number) => {
        current = Math.max(0, Math.min(v, maxScroll));
      },
      configurable: true,
    });

    // 挂载时立即设置过一次：被初期 maxScroll=100 钳制
    expect(current).toBeLessThan(500);

    // 第 1 帧：settle 发现未到位，重试；maxScroll 仍不足 → 依然钳制
    flushFrame();
    expect(current).toBe(100);

    // 高度估算修正：maxScroll 增长到 300 → 下一帧重试后到 300
    maxScroll = 300;
    flushFrame();
    expect(current).toBe(300);

    // 高度完全撑开：maxScroll=800 → 重试后到达目标 500，再下一帧确认收敛退出
    maxScroll = 800;
    flushFrame();
    expect(current).toBe(500);
    const framesBeforeConverge = rafQueue.length;
    flushFrame();
    expect(current).toBe(500);
    // 收敛后不再排新帧
    expect(rafQueue.length).toBeLessThanOrEqual(framesBeforeConverge);
  });

  it("initialScrollTop 为 0 时不启动 settle 循环（无需恢复）", () => {
    render(
      <SourceModeEditor
        filePath="/tmp/scroll-test-2.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={0}
        spellcheck={false}
      />,
    );
    // 只剩 focus 的一帧 rAF，没有滚动 settle 的持续排队
    flushFrame();
    expect(rafQueue.length).toBe(0);
  });

  it("提供 initialScrollHeight 时按高度比例映射，中段位置不钳底（#138 进入方向缺陷回归）", () => {
    // 实测场景：WYSIWYG 中段阅读进度 27605/55752（≈0.495），
    // CM 容器高度 24645。旧实现直接拷贝 27605 会被 maxScroll 钳到
    // 容器底部；比例映射应得到 ≈0.495 的对应位置
    const cmHeight = 24645;
    const clientHeight = 800;
    const maxScroll = cmHeight - clientHeight;

    const { container } = render(
      <SourceModeEditor
        filePath="/tmp/scroll-test-ratio.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={27605}
        initialScrollHeight={55752}
        spellcheck={false}
      />,
    );

    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    expect(scroller).not.toBeNull();

    let current = 0;
    Object.defineProperty(scroller, "scrollHeight", {
      get: () => cmHeight,
      configurable: true,
    });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => current,
      set: (v: number) => {
        current = Math.max(0, Math.min(v, maxScroll));
      },
      configurable: true,
    });

    const expected = mapScrollTop(27605, 55752, cmHeight);
    expect(expected).toBe(12203);
    // settle 首帧命中比例目标（高度已稳定，一次到位）
    flushFrame();
    expect(current).toBe(expected);
    // 未钳到容器底部（旧实现直接拷贝 27605 会停在 maxScroll=23845）
    expect(current).toBeLessThan(maxScroll);
    // 阅读进度比例跨容器保留
    expect(current / cmHeight).toBeCloseTo(27605 / 55752, 2);
    // 收敛后退出，不再排新帧
    flushFrame();
    expect(current).toBe(expected);
    expect(rafQueue.length).toBe(0);
  });

  it("CM 高度测量漂移时逐帧重算比例目标，跟随测量收敛", () => {
    // 挂载初期 CM6 高度估算偏小（4000），目标被错误 maxScroll 钳制；
    // 测量收敛到 8000 后，settle 用最新高度重算目标并到位
    let cmHeight = 4000;
    let maxScroll = 1000;
    let current = 0;

    const { container } = render(
      <SourceModeEditor
        filePath="/tmp/scroll-test-drift.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={8000}
        initialScrollHeight={10000}
        spellcheck={false}
      />,
    );

    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    Object.defineProperty(scroller, "scrollHeight", {
      get: () => cmHeight,
      configurable: true,
    });
    Object.defineProperty(scroller, "scrollTop", {
      get: () => current,
      set: (v: number) => {
        current = Math.max(0, Math.min(v, maxScroll));
      },
      configurable: true,
    });

    // settle 首帧：目标 8000/10000×4000=3200，被初期 maxScroll=1000 钳制
    flushFrame();
    expect(current).toBe(1000);

    // 测量收敛：高度修正为 8000 → 目标 6400 可达
    cmHeight = 8000;
    maxScroll = 7500;
    flushFrame();
    expect(current).toBe(mapScrollTop(8000, 10000, 8000));
    expect(current).toBe(6400);

    // 下一帧确认收敛后退出，不再排新帧
    flushFrame();
    expect(current).toBe(6400);
    expect(rafQueue.length).toBe(0);
  });

  it("提供内容锚点时优先把锚点行滚到视口顶部，忽略比例映射输入（#136 密度不均根因修复）", () => {
    // 实测缺陷场景：混排文档（代码块/标题/段落密度不均）下比例映射保住
    // 百分比却落到不同内容。锚点指向第 201 行起始偏移（1892），必须把
    // 该行滚到视口顶部；比例输入（10/100）刻意给一个极小目标作对照
    const anchorOffset = 1892;

    const { container } = render(
      <SourceModeEditor
        filePath="/tmp/scroll-test-anchor.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={10}
        initialScrollHeight={100}
        initialAnchorOffset={anchorOffset}
        spellcheck={false}
      />,
    );

    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    expect(scroller).not.toBeNull();

    let current = 0;
    Object.defineProperty(scroller, "scrollTop", {
      get: () => current,
      set: (v: number) => {
        current = Math.max(0, v);
      },
      configurable: true,
    });

    flushFrame();
    // 锚点行（第 201 行）到视口顶部：200 行 × 估算行高（12~30px）之间。
    // 若误走比例映射（10/100），目标不超过容器高度的一成，绝到不了这里
    expect(current).toBeGreaterThanOrEqual(200 * 12);
    expect(current).toBeLessThanOrEqual(200 * 30);

    // 收敛后退出，不再排新帧
    flushFrame();
    expect(current).toBeGreaterThanOrEqual(200 * 12);
    expect(rafQueue.length).toBe(0);
  });

  it("脱链卸载时用最后可信 scrollTop 判光标可见性（#375 评审 R5-5）", () => {
    const onUnmountSnapshot = vi.fn();
    const { container, unmount } = render(
      <SourceModeEditor
        filePath="/tmp/detach-cursor.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={0}
        spellcheck={false}
        onUnmountSnapshot={onUnmountSnapshot}
      />,
    );
    const scroller = container.querySelector(".cm-scroller") as HTMLElement;
    expect(scroller).not.toBeNull();

    // 在线且布局可信：视口 [500,1100]，光标仍在首行（top≈0）→ 不可见。
    // 先让 refreshCursorVisible 把 clientHeight/scrollTop 缓存下来。
    let clientHeight = 600;
    Object.defineProperty(scroller, "clientHeight", {
      get: () => clientHeight,
      configurable: true,
    });
    Object.defineProperty(scroller, "scrollHeight", {
      get: () => 2000,
      configurable: true,
    });
    scroller.scrollTop = 500;
    scroller.dispatchEvent(new Event("scroll"));
    flushFrame();

    // 模拟容器脱链：现场 clientHeight / scrollTop 都归 0
    clientHeight = 0;
    scroller.scrollTop = 0;
    unmount();

    const snap = onUnmountSnapshot.mock.calls.at(-1)?.[0] as
      | { scrollTop: number; cursorVisible: boolean }
      | undefined;
    expect(snap, "cleanup 没有回传卸载快照").toBeTruthy();
    // 现场读数 0 不能覆盖缓存；下游 caretPos 门控也不能被重新打开
    expect(snap?.scrollTop).toBe(500);
    expect(snap?.cursorVisible).toBe(false);
  });

  it("切文件后忽略已取消但迟到的旧 focus rAF", () => {
    const cancelFrame = vi.fn();
    const focus = vi
      .spyOn(EditorView.prototype, "focus")
      .mockImplementation(() => {});
    let staleView: EditorView | null = null;
    const originalDestroy = EditorView.prototype.destroy;
    const destroy = vi
      .spyOn(EditorView.prototype, "destroy")
      .mockImplementation(function (this: EditorView) {
        staleView = this;
        originalDestroy.call(this);
      });
    window.cancelAnimationFrame = cancelFrame;
    const { rerender } = render(
      <SourceModeEditor
        filePath="/tmp/focus-frame-old.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={0}
        spellcheck={false}
      />,
    );
    const focusFrame = rafQueue.length;
    const lateCallback = rafQueue.at(-1);
    expect(lateCallback).toBeDefined();

    rerender(
      <SourceModeEditor
        filePath="/tmp/focus-frame-new.md"
        value={LONG_TEXT}
        onChange={() => {}}
        initialCursor={0}
        initialScrollTop={0}
        spellcheck={false}
      />,
    );

    expect(cancelFrame).toHaveBeenCalledWith(focusFrame);
    expect(staleView).not.toBeNull();
    // 模拟 view 已失效但其 DOM 仍被其他 owner 保留的情况，确保断言检验
    // isCurrentView，而非仅由 `view.dom.isConnected` 短路。
    Object.defineProperty(staleView!.dom, "isConnected", {
      configurable: true,
      get: () => true,
    });
    lateCallback?.(0);
    expect(focus).not.toHaveBeenCalled();
    destroy.mockRestore();
    focus.mockRestore();
  });
});

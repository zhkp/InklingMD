// outlineTrackerPlugin 滚动跟踪测试（v2.3.3 重写契约）
//
// v2.3.3 起滚动采样不再调用 posAtCoords（万行文档上线性扫描子节点
// rect 单次 50ms+，是滚动掉帧主因），改为缓存标题元素在滚动坐标系
// 中的位置 + 二分比较。本文件验证：
// 1. 采样只依赖 scrollTop 与缓存位置，绝不调用 posAtCoords
// 2. 缓存失效（滚动总高变化）时批量重建
// 3. 滚动事件按动画帧合并
// 4. doc 变更防抖重算与销毁清理（沿袭原契约）

import { describe, expect, it, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { outlineTrackerPlugin } from "../../src/components/Editor/outline-tracker";

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockDocument(): ProseMirrorNode {
  const positions = [0, 100, 200];
  const headings = positions.map((_, index) => ({
    type: { name: "heading" },
    attrs: { level: 2, id: `heading-${index}` },
    descendants: (callback: (child: unknown) => void) => {
      callback({ isText: true, text: `标题 ${index + 1}` });
    },
  }));
  return {
    descendants: (callback: (node: unknown, pos: number) => void) => {
      headings.forEach((heading, index) => callback(heading, positions[index]));
    },
  } as unknown as ProseMirrorNode;
}

interface ScrollHarness {
  scroller: HTMLElement;
  editorDom: HTMLElement;
  setScrollTop: (top: number) => void;
  setScrollHeight: (height: number) => void;
  setHeadingPos: (index: number, pos: number) => void;
  headingEls: HTMLElement[];
}

/** 构造滚动容器 + 3 个标题元素（滚动坐标 0 / 300 / 600px，rect 跟随 scrollTop） */
function makeHarness(): ScrollHarness {
  const scroller = document.createElement("div");
  scroller.className = "editor-scroll";
  const editorDom = document.createElement("div");
  scroller.append(editorDom);
  document.body.append(scroller);
  scroller.getBoundingClientRect = () => rect(0, 100, 600, 500);

  const scrollState = { top: 0, height: 1000, width: 600 };
  Object.defineProperty(scroller, "scrollTop", {
    get: () => scrollState.top,
    configurable: true,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    get: () => scrollState.height,
    configurable: true,
  });
  Object.defineProperty(scroller, "clientWidth", {
    get: () => scrollState.width,
    configurable: true,
  });

  // 标题在滚动坐标系中的位置；getBoundingClientRect 按 scrollTop 换算，
  // 模拟真实浏览器中元素随滚动移动
  const headingPos = [0, 300, 600];
  const headingEls = headingPos.map((_, i) => {
    const el = document.createElement("h2");
    Object.defineProperty(el, "getBoundingClientRect", {
      value: () => {
        const viewportTop = 100 + headingPos[i] - scrollState.top;
        return rect(100, viewportTop, 500, viewportTop + 40);
      },
      configurable: true,
    });
    editorDom.append(el);
    return el;
  });

  return {
    scroller,
    editorDom,
    setScrollTop: (top) => {
      scrollState.top = top;
    },
    setScrollHeight: (height) => {
      scrollState.height = height;
    },
    setHeadingPos: (index, pos) => {
      headingPos[index] = pos;
    },
    headingEls,
  };
}

function makeView(harness: ScrollHarness) {
  const state = {
    doc: mockDocument(),
    selection: { head: 1 },
  };
  const posAtCoords = vi.fn();
  const nodeDOM = vi.fn((pos: number) =>
    ({ 0: harness.headingEls[0], 100: harness.headingEls[1], 200: harness.headingEls[2] })[
      pos
    ] ?? null,
  );
  const view = {
    dom: harness.editorDom,
    state,
    posAtCoords,
    nodeDOM,
  } as unknown as EditorView & { nodeDOM: typeof nodeDOM };
  return { view, posAtCoords, nodeDOM };
}

describe("outlineTrackerPlugin 视口跟踪（缓存位置 + 二分）", () => {
  it("采样只用 scrollTop 与缓存位置，不调用 posAtCoords", async () => {
    const harness = makeHarness();
    const { view, posAtCoords, nodeDOM } = makeView(harness);
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);

    let pendingFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((callback: (time: number) => void) => {
      pendingFrame = callback;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((callback: (time: number) => void) => {
      pendingFrame = callback;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);
    const pluginView = plugin.spec.view?.(view);
    // 初始按选区发布 activeIndex 0
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 0 }),
    );
    onChange.mockClear();

    // #212：几何刷新（失效检测 + 批量重建）不在滚动帧上，而在滚动停歇
    // 200ms 后。首次滚动排定停歇刷新，期间缓存尚未建立、不发布高亮。
    harness.scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 260));
    // 顶部滚动：scrollTop=0，probe=12 ≥ 第一个标题位置 0 → 仍是 0，不发布
    expect(onChange).not.toHaveBeenCalled();
    // 核心契约：绝不进入 posAtCoords 路径
    expect(posAtCoords).not.toHaveBeenCalled();
    // 停歇刷新批量重建读取标题元素位置（单次）
    expect(nodeDOM).toHaveBeenCalledTimes(3);

    // 滚到 650：probe=662 ≥ 第三个标题位置 600 → 当前章节为标题 3。
    // 缓存已就绪，滚动路径纯二分；第二次采样落在 120ms 节流窗口内，
    // 由尾随定时器在窗口结束后执行
    harness.setScrollTop(650);
    harness.scroller.dispatchEvent(new Event("scroll"));
    (pendingFrame as ((time: number) => void) | null)?.(0);
    await new Promise((r) => setTimeout(r, 160));
    expect(posAtCoords).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 2 }),
    );

    pluginView?.destroy?.();
    vi.restoreAllMocks();
    harness.scroller.remove();
  });

  it("滚动总高变化（图表渲染等）触发停歇重建并按新位置定位", async () => {
    const harness = makeHarness();
    const { view, nodeDOM } = makeView(harness);
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);

    plugin.spec.view?.(view);
    onChange.mockClear();

    // 等待节流窗口过去，保证后续滚动立即采样
    await new Promise((r) => setTimeout(r, 150));
    // 第三个标题位置下移到 900（上方内容长高），文档总高变化
    harness.setHeadingPos(2, 900);
    harness.setScrollHeight(1200);
    harness.setScrollTop(650);
    harness.scroller.dispatchEvent(new Event("scroll"));
    // #212：滚动路径不现场重建（不读 scrollHeight / 不批量读 rect——
    // 那会在滚动帧上强制布局）；停歇 200ms 后几何刷新批量重建并定位
    await new Promise((r) => setTimeout(r, 260));
    // probe=662：重建后位置 0/300/900 中最后一个 ≤662 的是第二个标题
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 1 }),
    );
    // 停歇重建批量读取全部 3 个标题位置（单次强制布局）
    expect(nodeDOM).toHaveBeenCalledTimes(3);

    vi.restoreAllMocks();
    harness.scroller.remove();
  });

  it("切 tab 重灌文档：防抖窗口内采样跳过，重算后按 scrollTop 定位（v2.3.4）", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const { view } = makeView(harness);
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);
    const pluginView = plugin.spec.view?.(view);
    onChange.mockClear();

    // 模拟切 tab：doc 重灌（选区钳到文档头）+ 滚动位置恢复到 650。
    // scroll 事件落在防抖窗口内——旧文档的标题集/位置缓存不可用，
    // 采样必须被跳过（stale），不能发布错误高亮
    const prev = view.state;
    view.state = {
      doc: mockDocument(),
      selection: { head: 1, eq: () => true },
    } as unknown as typeof view.state;
    pluginView?.update?.(view, prev as never);
    harness.setScrollTop(650);
    harness.scroller.dispatchEvent(new Event("scroll"));
    expect(onChange).not.toHaveBeenCalled();

    // 防抖结束后重算 + 按当前 scrollTop=650 定位（probe 662 ≥ 第三
    // 个标题位置 600），不依赖被钳到文档头的选区
    vi.advanceTimersByTime(160);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 2 }),
    );

    pluginView?.destroy?.();
    vi.useRealTimers();
    harness.scroller.remove();
  });

  it("文档顶部采样点在首标题之上时归到首标题，不清空高亮", async () => {
    const harness = makeHarness();
    const { view } = makeView(harness);
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);

    let pendingFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((callback: (time: number) => void) => {
      pendingFrame = callback;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((callback: (time: number) => void) => {
      pendingFrame = callback;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);
    plugin.spec.view?.(view);
    onChange.mockClear();

    // 首标题位于滚动坐标 56（模拟 .milkdown 2.5rem 顶部 padding +
    // h2 margin-top），未挂载占位/前言段落都在它之上
    harness.setHeadingPos(0, 56);
    // #212：先滚动一次并等待停歇几何刷新建立缓存（位置 56/300/600）
    harness.setScrollTop(650);
    harness.scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 260));
    // 滚到深处：probe=662 落在第三个标题（600）→ activeIndex 2
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 2 }),
    );
    onChange.mockClear();

    // 让出 120ms 节流窗口后回到顶部：probe = 4 + 12 = 16 < 56，
    // 二分找不到标题时必须归到首标题（0），不能发布 null 清空高亮
    await new Promise((r) => setTimeout(r, 160));
    harness.setScrollTop(4);
    harness.scroller.dispatchEvent(new Event("scroll"));
    (pendingFrame as ((time: number) => void) | null)?.(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 0 }),
    );

    vi.restoreAllMocks();
    harness.scroller.remove();
  });

  it("按动画帧合并正文滚动，并在销毁时移除监听", () => {
    const harness = makeHarness();
    const { view } = makeView(harness);
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);

    let pendingFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((callback: (time: number) => void) => {
      pendingFrame = callback;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        pendingFrame = callback;
        return 17;
      });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const pluginView = plugin.spec.view?.(view);
    expect(pluginView).toBeDefined();
    onChange.mockClear();

    harness.scroller.dispatchEvent(new Event("scroll"));
    harness.scroller.dispatchEvent(new Event("scroll"));
    // 同帧多次 scroll 只请求一个动画帧（另一次为创建时的初始采样）
    expect(requestFrame).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();

    (pendingFrame as ((time: number) => void) | null)?.(0);
    expect(onChange).not.toHaveBeenCalled(); // 顶部仍在标题 1 内

    harness.scroller.dispatchEvent(new Event("scroll"));
    expect(requestFrame).toHaveBeenCalledTimes(3);
    pluginView?.destroy?.();
    expect(cancelFrame).toHaveBeenCalledWith(17);
    harness.scroller.dispatchEvent(new Event("scroll"));
    expect(requestFrame).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
    harness.scroller.remove();
  });
});

describe("outlineTrackerPlugin 编辑防抖", () => {
  function makeView(doc: ProseMirrorNode) {
    const editorDom = document.createElement("div");
    document.body.append(editorDom);
    const view = {
      dom: editorDom,
      state: { doc, selection: { head: 1, eq: () => true } },
      // v2.3.3：doc 变更后会重建标题位置缓存（nodeDOM 允许返回 null）
      nodeDOM: () => null,
    } as unknown as EditorView & {
      state: { doc: ProseMirrorNode; selection: { head: number; eq: () => boolean } };
    };
    return { view, editorDom };
  }

  it("连续 doc 变更防抖 150ms 后只发布一次", () => {
    vi.useFakeTimers();
    const { view, editorDom } = makeView(mockDocument());
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);
    const pluginView = plugin.spec.view?.(view as unknown as EditorView);
    onChange.mockClear();

    // 连续三次 doc 变更：A→B→C，选区视为未变（eq 恒真）
    const sel = { head: 250, eq: () => true };
    const sA = view.state;
    const sB = { doc: mockDocument(), selection: sel } as unknown as typeof view.state;
    const sC = { doc: mockDocument(), selection: sel } as unknown as typeof view.state;
    view.state = sB;
    pluginView?.update?.(view as unknown as EditorView, sA as never);
    view.state = sC;
    pluginView?.update?.(view as unknown as EditorView, sB as never);
    // 防抖窗口内不发布，避免每键全文遍历标题
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(160);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 2 }),
    );

    pluginView?.destroy?.();
    vi.useRealTimers();
    editorDom.remove();
  });

  it("销毁后不再发布待定提取", () => {
    vi.useFakeTimers();
    const { view, editorDom } = makeView(mockDocument());
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);
    const pluginView = plugin.spec.view?.(view as unknown as EditorView);
    onChange.mockClear();

    const prev = view.state;
    view.state = { doc: mockDocument(), selection: { head: 1, eq: () => false } } as unknown as typeof view.state;
    pluginView?.update?.(view as unknown as EditorView, prev as never);
    pluginView?.destroy?.();
    vi.advanceTimersByTime(300);
    expect(onChange).not.toHaveBeenCalled();

    vi.useRealTimers();
    editorDom.remove();
  });
});

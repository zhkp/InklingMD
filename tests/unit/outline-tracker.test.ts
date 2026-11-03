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
import { Schema, type Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import {
  markOutlineImmediateRefresh,
  outlineTrackerPlugin,
} from "../../src/components/Editor/outline-tracker";
import {
  extractEditorOutline,
  type EditorOutlineSnapshot,
} from "../../src/lib/outline";

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

// #375 评审（PR #400）：退出源码模式的首个可见帧不得是替换前的旧快照。
// 这条契约的唯一实现是「整文档替换事务带 markOutlineImmediateRefresh 」，
// 状态机有四个易错点（清旧防抖 / stale 交接 / 索引保值 / 序号判定），
// 只靠 E2E 抽样浏览器帧不够确定，这里用真实 EditorState 直接锁。
describe("outlineTrackerPlugin 整文档替换的同步刷新（#375 首帧）", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      heading: {
        content: "inline*",
        group: "block",
        defining: true,
        attrs: { level: { default: 1 } },
        parseDOM: [{ tag: "h1", attrs: { level: 1 } }],
        toDOM: () => ["h1", 0],
      },
      paragraph: {
        content: "inline*",
        group: "block",
        parseDOM: [{ tag: "p" }],
        toDOM: () => ["p", 0],
      },
      text: { group: "inline" },
    },
  });

  function makeDoc(titles: string[]): ProseMirrorNode {
    return schema.node(
      "doc",
      null,
      titles.map((t) =>
        schema.node("heading", { level: 1 }, [schema.text(t)]),
      ),
    );
  }

  it("重复标题按出现次序重映射（同名标题不能都指第一项）", () => {
    // 源码侧的「按行号定位」允许同名标题（SM9 就在测）；重映射必须同样
    // 按出现次序消歧，否则「小结 → 小结」这类文档的首帧高亮会跳到第一处。
    const harness = makeHarness();
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);
    const initial = EditorState.create({
      schema,
      doc: makeDoc(["小结", "正文", "小结"]),
      plugins: [plugin],
    });
    const nodeDOM = vi.fn(() => null);
    const asView = (state: EditorState) =>
      ({
        dom: harness.editorDom,
        state,
        nodeDOM,
      }) as unknown as EditorView;

    const pluginView = plugin.spec.view?.(asView(initial));
    onChange.mockClear();

    // 旧快照：高亮第二处「小结」（index 2）；新文档在开头再插一个标题
    const exitHeadings = extractEditorOutline(initial.doc);
    const replaced = makeDoc(["前言", "小结", "正文", "小结"]);
    const tr = markOutlineImmediateRefresh(
      initial.tr.replaceWith(0, initial.doc.content.size, replaced.content),
      { active: { headings: exitHeadings, activeIndex: 2 } },
    );
    const next = initial.apply(tr);
    pluginView?.update?.(asView(next), initial as never);

    const snapshot = onChange.mock.calls.at(-1)?.[0] as {
      headings: { text: string }[];
      activeIndex: number | null;
    };
    expect(snapshot.headings.map((h) => h.text)).toEqual([
      "前言",
      "小结",
      "正文",
      "小结",
    ]);
    expect(snapshot.activeIndex).toBe(3); // 第二处「小结」，不是第一处（1）

    vi.restoreAllMocks();
    harness.scroller.remove();
  });

  it("带标记的替换同帧发布：索引按标题身份重映射、不重建几何、丢弃旧防抖", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);

    const initial = EditorState.create({
      schema,
      doc: makeDoc(["一级标题", "二级标题", "三级标题"]),
      plugins: [plugin],
    });
    // 几何读取一律返回 null（等价于「标题元素还没挂载」），
    // 让采样结果与 DOM 细节无关，只验证「是否/何时发生重建」
    const nodeDOM = vi.fn(() => null);
    const asView = (state: EditorState) =>
      ({
        dom: harness.editorDom,
        state,
        nodeDOM,
      }) as unknown as EditorView;

    let pendingFrame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((
      callback: (time: number) => void,
    ) => {
      pendingFrame = callback;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);

    const pluginView = plugin.spec.view?.(asView(initial));
    onChange.mockClear();
    nodeDOM.mockClear();

    // ① 先来一次普通编辑：挂上 150ms 提取防抖（这就是退出时可能还挂在队列上的那条）
    const edited = initial.apply(initial.tr.insertText("x", 2));
    pluginView?.update?.(asView(edited), initial as never);
    expect(onChange).not.toHaveBeenCalled();

    // ② 整文档替换 + 同步刷新标记。源码侧快照是「旧结构 + 高亮三级标题」：
    //    新文档在开头插入了标题，三级标题的索引从 2 位移到 3。直接吃索引会错位，
    //    必须按 level + 文本重映射。
    const exitHeadings = extractEditorOutline(edited.doc);
    const replaced = makeDoc(["新增标题", "一级标题", "二级标题", "三级标题"]);
    const tr = markOutlineImmediateRefresh(
      edited.tr.replaceWith(0, edited.doc.content.size, replaced.content),
      {
        active: {
          headings: exitHeadings,
          activeIndex: exitHeadings.findIndex((h) => h.text === "三级标题"),
        },
      },
    );
    const next = edited.apply(tr);
    pluginView?.update?.(asView(next), edited as never);

    // 同帧发布：不等任何定时器/帧
    expect(onChange).toHaveBeenCalledTimes(1);
    const snapshot = onChange.mock.calls[0][0] as {
      headings: { text: string }[];
      activeIndex: number | null;
    };
    expect(snapshot.headings.map((h) => h.text)).toEqual([
      "新增标题",
      "一级标题",
      "二级标题",
      "三级标题",
    ]);
    // 高亮跟着标题身份走（3 = 位移后的三级标题），不是照抄旧索引，也不闪回首标题
    expect(snapshot.activeIndex).toBe(3);
    // 退出帧不做几何重建（N 次 getBoundingClientRect 会把首帧继续推后）
    expect(nodeDOM).not.toHaveBeenCalled();

    // ③ 被丢弃的旧防抖不得再回写替换前的标题集
    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(1);

    // ④ 滚动帧仍不重建（#212：滚动帧零几何读取），只跳过采样
    harness.setScrollTop(650);
    harness.scroller.dispatchEvent(new Event("scroll"));
    (pendingFrame as ((time: number) => void) | null)?.(0);
    expect(nodeDOM).not.toHaveBeenCalled();

    // ⑤ 停歇 200ms 后由几何刷新一次性重建并重新定位
    vi.advanceTimersByTime(200);
    expect(nodeDOM).toHaveBeenCalledTimes(4); // 4 个标题，一次批量重建

    pluginView?.destroy?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    harness.scroller.remove();
  });

  it("没有标记的整文档替换仍走 150ms 防抖（按键路径不退化）", () => {
    vi.useFakeTimers();
    const harness = makeHarness();
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);
    const initial = EditorState.create({
      schema,
      doc: makeDoc(["一", "二"]),
      plugins: [plugin],
    });
    const asView = (state: EditorState) =>
      ({
        dom: harness.editorDom,
        state,
        nodeDOM: () => null,
      }) as unknown as EditorView;

    const pluginView = plugin.spec.view?.(asView(initial));
    onChange.mockClear();

    const replaced = makeDoc(["一", "二", "三"]);
    const next = initial.apply(
      initial.tr.replaceWith(0, initial.doc.content.size, replaced.content),
    );
    pluginView?.update?.(asView(next), initial as never);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(160);
    expect(onChange).toHaveBeenCalledTimes(1);

    pluginView?.destroy?.();
    vi.useRealTimers();
    harness.scroller.remove();
  });

  // ---- 重映射的兜底分支（#375 评审第三轮）：每条都得单独锁，否则改错不会红 ----

  function setup(titles: string[]) {
    const harness = makeHarness();
    const onChange = vi.fn();
    const plugin = outlineTrackerPlugin(onChange);
    const state = EditorState.create({
      schema,
      doc: makeDoc(titles),
      plugins: [plugin],
    });
    // 真实几何映射：按文档里标题节点的位置取 harness 的标题元素
    const positions: number[] = [];
    state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") positions.push(pos);
      return true;
    });
    const asView = (s: EditorState) =>
      ({
        dom: harness.editorDom,
        state: s,
        nodeDOM: (pos: number) =>
          harness.headingEls[positions.indexOf(pos)] ?? null,
      }) as unknown as EditorView;
    const pluginView = plugin.spec.view?.(asView(state));
    onChange.mockClear();
    return { harness, onChange, asView, pluginView, state };
  }

  /** 整文档替换 + 可选快照，返回本次发布的大纲 */
  function replaceWith(
    ctx: ReturnType<typeof setup>,
    titles: string[],
    active?: EditorOutlineSnapshot | null,
  ) {
    const replaced = makeDoc(titles);
    const tr = markOutlineImmediateRefresh(
      ctx.state.tr.replaceWith(0, ctx.state.doc.content.size, replaced.content),
      active === undefined ? {} : { active },
    );
    const next = ctx.state.apply(tr);
    ctx.pluginView?.update?.(ctx.asView(next), ctx.state as never);
    const call = ctx.onChange.mock.calls.at(-1)?.[0] as
      | { headings: { text: string }[]; activeIndex: number | null }
      | undefined;
    return call;
  }

  it("标题被改名/删除：退回原索引并钳进新列表（不返回 null）", () => {
    const ctx = setup(["甲", "乙", "丙"]);
    const exitHeadings = extractEditorOutline(ctx.state.doc);
    // 新列表里没有任何同名标题（全部改名），原索引 2 落回 2
    const published = replaceWith(ctx, ["A", "B", "C"], {
      headings: exitHeadings,
      activeIndex: 2,
    });
    expect(published?.headings.map((h) => h.text)).toEqual(["A", "B", "C"]);
    expect(published?.activeIndex).toBe(2);
  });

  it("标题被删除且新列表更短：钳到最后一项而不是越界", () => {
    const ctx = setup(["甲", "乙", "丙"]);
    const exitHeadings = extractEditorOutline(ctx.state.doc);
    const published = replaceWith(ctx, ["A"], {
      headings: exitHeadings,
      activeIndex: 2,
    });
    expect(published?.headings).toHaveLength(1);
    expect(published?.activeIndex).toBe(0);
  });

  it("行内公式的标题按归一化文本匹配（markdown 与 PM 文本来源不同）", () => {
    // 源码侧标题文本带 `$a^2$`（markdown 原文），PM 侧只有「公式」：
    // 不归一化就会匹配失败、退回索引 0，位移场景仍错位
    const ctx = setup(["公式 $a^2$", "正文"]);
    const exitHeadings = extractEditorOutline(
      // 用 markdown 侧形态的标题文本构造快照
      ctx.state.doc,
    );
    const published = replaceWith(ctx, ["前言", "公式"], {
      headings: [{ ...exitHeadings[0], text: "公式 $a^2$" }],
      activeIndex: 0,
    });
    expect(published?.headings.map((h) => h.text)).toEqual(["前言", "公式"]);
    expect(published?.activeIndex).toBe(1); // 按身份命中第 2 项，不是索引 0
  });

  it("没有快照的调用方：沿用 tracker 自己的索引", () => {
    vi.useFakeTimers();
    const ctx = setup(["一", "二", "三"]);
    let frame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((
      cb: (time: number) => void,
    ) => {
      frame = cb;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);

    // 滚动到第三项，让 tracker 自己的 activeIndex = 2
    ctx.harness.setScrollTop(650);
    ctx.harness.scroller.dispatchEvent(new Event("scroll"));
    (frame as ((time: number) => void) | null)?.(0);
    vi.advanceTimersByTime(220); // 停歇刷新：重建几何并按 scrollTop 定位
    expect(ctx.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 2 }),
    );
    ctx.onChange.mockClear();

    const published = replaceWith(ctx, ["新的甲", "新的乙", "新的丙"]);
    expect(published?.activeIndex).toBe(2); // 沿用 tracker 索引（无快照可用）

    ctx.pluginView?.destroy?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    ctx.harness.scroller.remove();
  });

  it("快照属于别的文件（空快照）：不沿用旧索引，退回选区推导", () => {
    vi.useFakeTimers();
    const ctx = setup(["一", "二", "三"]);
    let frame: ((time: number) => void) | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(((
      cb: (time: number) => void,
    ) => {
      frame = cb;
      return 17;
    }) as unknown as typeof window.requestAnimationFrame);

    ctx.harness.setScrollTop(650);
    ctx.harness.scroller.dispatchEvent(new Event("scroll"));
    (frame as ((time: number) => void) | null)?.(0);
    vi.advanceTimersByTime(220);
    expect(ctx.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ activeIndex: 2 }),
    );
    ctx.onChange.mockClear();

    // 空快照 = 面板没有可用的活动项（例如切到了别的文件）：此时若沿用
    // tracker 自己的 2，就把退出前章节的高亮串了过来。必须退回选区推导——
    // 整文档替换会把选区映射到替换内容末尾，5 个标题时即第 5 项（索引 4），
    // 与「沿用旧索引 2」可区分。
    const published = replaceWith(ctx, ["甲", "乙", "丙", "丁", "戊"], {
      headings: [],
      activeIndex: null,
    });
    expect(published?.activeIndex).toBe(4);

    ctx.pluginView?.destroy?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    ctx.harness.scroller.remove();
  });
});

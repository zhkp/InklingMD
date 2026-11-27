import { describe, expect, it, vi } from "vitest";
import { render, renderHook } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { useSourceModeTransition } from "../../src/components/Editor/useSourceModeTransition";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/kit/prose/model";
import { markdownOffsetToProsePos } from "../../src/lib/source-mode-cursor";
import { useWorkspace } from "../../src/store/workspace";
import {
  EMPTY_EDITOR_OUTLINE,
  type EditorOutlineSnapshot,
} from "../../src/lib/outline";
import { useOutline } from "../../src/store/outline";
import * as dialogs from "../../src/lib/dialogs";

describe("切 tab 时 enterSnapshot 在子编辑器挂载前就绪（#431 评审）", () => {
  it("两个源码模式 tab 直切：新 tab 用自己的光标初始化，不继承上一个 tab", () => {
    const A = "/tmp/source-a.md";
    const B = "/tmp/source-b.md";
    useWorkspace.setState({
      activeTabPath: A,
      currentFile: A,
      openTabs: [
        {
          path: A,
          content: "",
          dirty: false,
          lastSavedAt: null,
          cursorPos: 111,
          scrollTop: 10,
          sourceMode: true,
        },
        {
          path: B,
          content: "",
          dirty: false,
          lastSavedAt: null,
          cursorPos: 222,
          scrollTop: 20,
          sourceMode: true,
        },
      ] as never,
    });

    // Probe 模拟 SourceModeEditor：只在挂载 layout effect 里读一次 initial*
    const mounts: Array<{ filePath: string; cursor: number }> = [];
    function Probe({ filePath, cursor }: { filePath: string; cursor: number }) {
      useLayoutEffect(() => {
        mounts.push({ filePath, cursor });
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    }
    function Harness({ filePath }: { filePath: string }) {
      const lastSyncedRef = useRef("");
      const { enterSnapshot } = useSourceModeTransition({
        filePath,
        sourceMode: true,
        value: "",
        getEditor: () => undefined,
        lastSyncedRef,
      });
      if (!enterSnapshot) return null;
      return (
        <Probe key={filePath} filePath={filePath} cursor={enterSnapshot.cursor} />
      );
    }

    const { rerender } = render(<Harness filePath={A} />);
    expect(mounts).toEqual([{ filePath: A, cursor: 0 }]);

    rerender(<Harness filePath={B} />);
    // 旧实现：B 的 Probe 会先用 A 的快照（cursor 0）挂载，父级 layout effect
    // 再更新 enterSnapshot 已无法影响已创建的 CM 实例
    expect(mounts).toEqual([
      { filePath: A, cursor: 0 },
      { filePath: B, cursor: 222 },
    ]);
  });
});

describe("useSourceModeTransition", () => {
  it("enters source mode: captures non-zero scroll snapshot and content anchor from WYSIWYG", () => {
    const filePath = "/tmp/test-enter.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    const mockView = {
      state: {
        selection: { head: 15 },
        doc: {
          content: { size: 40 },
          textBetween: (_from: number, _to: number) => "# Title\n\nParagraph",
        },
      },
      dom: {
        closest: (selector: string) => {
          if (selector === ".editor-scroll") {
            return { scrollTop: 120, isConnected: true };
          }
          return null;
        },
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        const mockCtx = {
          get: (key: any) => {
            if (key === editorViewCtx) return mockView;
            return null;
          },
        };
        fn(mockCtx);
      },
    };

    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
          getWysiwygScrollTop: () => 120,
          // 视口顶部内容的持续缓存位置（内容锚点输入）
          getWysiwygTopPos: () => 15,
        }),
      {
        initialProps: { sourceMode: false },
      },
    );

    expect(result.current.enterSnapshot).toBeNull();

    // Switch to source mode
    rerender({ sourceMode: true });

    expect(result.current.enterSnapshot).not.toBeNull();
    expect(result.current.enterSnapshot?.scrollTop).toBe(120);
    // 锚点 = "# Title\n\nParagraph"（18 字符）在 markdown 中命中 → 偏移 18；
    // 光标跟随阅读位置，与锚点一致（#136 内容锚点映射）
    expect(result.current.enterSnapshot?.anchorOffset).toBe(18);
    expect(result.current.enterSnapshot?.cursor).toBe(18);
  });

  it("exit restores PM selection at content anchor and scrolls anchor content to viewport top", async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };

    const filePath = "/tmp/test-exit.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    // 布局高 200 / 可视高 80 / zoom=1（rect.height=clientHeight），maxScroll=120
    const mockScrollEl = {
      scrollTop: 0,
      isConnected: true,
      scrollHeight: 200,
      clientHeight: 80,
      getBoundingClientRect: () => ({ top: 20, height: 80 }),
    };
    Object.setPrototypeOf(mockScrollEl, HTMLElement.prototype);

    const mockTr = {
      replaceWith: vi.fn().mockReturnThis(),
      setSelection: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };

    // 锚点内容布局偏移固定 100：视口坐标随实际滚动联动
    // （真实 PM 中 coordsAtPos 反映当前滚动，此处同构模拟）
    const anchorLayoutOffset = 100;
    const mockView = {
      state: {
        plugins: [],
        doc: {
          content: { size: 40 },
          resolve: vi.fn().mockReturnValue({ pos: 18 }),
          textBetween: () => "",
        },
        selection: { head: 18 },
        tr: mockTr,
      },
      dispatch: vi.fn(),
      coordsAtPos: () => ({
        top: 20 + (anchorLayoutOffset - mockScrollEl.scrollTop),
        bottom: 21 + (anchorLayoutOffset - mockScrollEl.scrollTop),
      }),
      dom: {
        closest: (selector: string) => {
          if (selector === ".editor-scroll") {
            return mockScrollEl;
          }
          return null;
        },
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        const mockCtx = {
          get: (key: any) => {
            if (key === editorViewCtx) return mockView;
            if (key === parserCtx) return (val: string) => ({ content: { size: val.length } });
            return null;
          },
        };
        fn(mockCtx);
      },
    };

    // 注入退出快照（走 onUnmountSnapshot 的真实路径）：锚点偏移 20 与光标 5
    // 刻意不同，验证退出恢复以视口顶部内容锚点为准（阅读位置优先），而非光标。
    // 注：不 mock registerSourceModeScroll —— 真实退出时子组件 cleanup 先于
    // 父级 layout effect，liveCmScroll 必然为 null，快照走 exitSnapshotRef。
    const exitSnap = {
      cursor: 5,
      scrollTop: 50,
      scrollHeight: 100,
      anchorOffset: 20,
      // 光标不可见：退出恢复跳过可见性微调，滚动停在锚点（100）
      cursorVisible: false,
    };

    // 预置 tab 记忆（含进入源码模式前的旧值），验证退出后写回覆盖
    useWorkspace.setState({
      openTabs: [
        { path: filePath, content: value, dirty: false, lastSavedAt: null, cursorPos: 3, scrollTop: 0 },
      ],
    });

    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
        }),
      {
        initialProps: { sourceMode: true },
      },
    );

    // 真实路径：由 onUnmountSnapshot 注入到 exitSnapshotRef
    result.current.exitSnapshotRef.current = exitSnap;

    // 退出瞬间面板上的大纲快照（#375）：源码模式最后一次发布的结果，
    // 必须随退出事务带给 tracker——它自己手里的索引停在进入源码模式那一刻
    const exitOutline: EditorOutlineSnapshot = {
      headings: [
        { index: 0, level: 1, text: "Title", pos: 0, nodeId: null, id: "标题" },
      ],
      activeIndex: 0,
    };
    useOutline.setState({ file: filePath, snapshot: exitOutline });

    // Switch back to WYSIWYG mode
    rerender({ sourceMode: false });

    // Flush all nested requestAnimationFrames
    while (rafCallbacks.length > 0) {
      const cb = rafCallbacks.shift();
      cb?.(0);
    }

    // Verify PM transaction replaced content and restored selection
    expect(mockTr.replaceWith).toHaveBeenCalled();
    expect(mockView.dispatch).toHaveBeenCalled();

    // 退出事务必须挂「同帧刷新大纲」标记（#375），负载含面板快照 +
    // 源码视口锚点换算到新文档的 PM 位置（#375 评审 R4）。少了后者，
    // 「活动项前插入同身份标题」时首帧高亮无法消歧。
    const outlineMeta = mockTr.setMeta.mock.calls.find((call) =>
      String((call[0] as { key?: string })?.key ?? call[0]).startsWith(
        "inkling-outline-tracker",
      ),
    );
    expect(outlineMeta, "退出事务没有携带大纲同步刷新标记").toBeTruthy();
    expect(outlineMeta?.[1]).toEqual({
      active: exitOutline,
      anchorPos: expect.any(Number),
      // exitSnap.cursorVisible=false（只滚动未编辑）：不能拿陈旧光标拽偏首帧
      caretPos: null,
    });

    useOutline.setState({ file: null, snapshot: EMPTY_EDITOR_OUTLINE });
    // 内容锚点映射：锚点内容（布局偏移 100）滚到视口顶部 → scrollTop=100。
    // 与旧比例映射（50/100×200=100）数值巧合相同，但锚点偏移 20 ≠ 光标 5
    // 决定了选区与记忆位置，证明取的是视口顶部内容而非光标/比例
    expect(mockScrollEl.scrollTop).toBe(anchorLayoutOffset);

    // 退出恢复后写回 tab 记忆（#136 单一事实源）：光标为锚点对应的 PM pos
    const expectedPos = markdownOffsetToProsePos(40, value, 20);
    const saved = useWorkspace.getState().getCursorStateFor(filePath);
    expect(saved.pos).toBe(expectedPos);
    expect(saved.scrollTop).toBe(anchorLayoutOffset);

    window.requestAnimationFrame = originalRaf;
  });

  it("exit anchor target converts viewport coords with effective zoom (editorZoom != 100%)", async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };

    const filePath = "/tmp/test-exit-zoom.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    // zoom=1.25（rect.height=1000 / clientHeight=800）：视口坐标是布局坐标的 1.25 倍
    const mockScrollEl = {
      scrollTop: 0,
      isConnected: true,
      scrollHeight: 2000,
      clientHeight: 800,
      getBoundingClientRect: () => ({ top: 50, height: 1000 }),
    };
    Object.setPrototypeOf(mockScrollEl, HTMLElement.prototype);

    const mockTr = {
      replaceWith: vi.fn().mockReturnThis(),
      setSelection: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };

    // 锚点内容布局偏移固定 600，视口坐标按 1.25 缩放并随滚动联动
    const anchorLayoutOffset = 600;
    const mockView = {
      state: {
        plugins: [],
        doc: {
          content: { size: 40 },
          resolve: vi.fn().mockReturnValue({ pos: 18 }),
          textBetween: () => "",
        },
        selection: { head: 18 },
        tr: mockTr,
      },
      dispatch: vi.fn(),
      coordsAtPos: () => ({
        top: 50 + (anchorLayoutOffset - mockScrollEl.scrollTop) * 1.25,
        bottom: 51 + (anchorLayoutOffset - mockScrollEl.scrollTop) * 1.25,
      }),
      dom: {
        closest: (selector: string) => {
          if (selector === ".editor-scroll") {
            return mockScrollEl;
          }
          return null;
        },
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        const mockCtx = {
          get: (key: any) => {
            if (key === editorViewCtx) return mockView;
            if (key === parserCtx) return (val: string) => ({ content: { size: val.length } });
            return null;
          },
        };
        fn(mockCtx);
      },
    };

    useWorkspace.setState({
      openTabs: [
        { path: filePath, content: value, dirty: false, lastSavedAt: null, cursorPos: 3, scrollTop: 0 },
      ],
    });

    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
        }),
      {
        initialProps: { sourceMode: true },
      },
    );

    // 真实路径：onUnmountSnapshot 注入 exitSnapshotRef
    result.current.exitSnapshotRef.current = {
      cursor: 18,
      scrollTop: 250,
      scrollHeight: 1000,
      anchorOffset: 18,
      cursorVisible: false,
    };

    rerender({ sourceMode: false });

    while (rafCallbacks.length > 0) {
      const cb = rafCallbacks.shift();
      cb?.(0);
    }

    // 锚点内容布局偏移 600 → 目标 scrollTop=600。若未除以有效 zoom
    // 换算坐标系，会把视口偏移 750（=600×1.25）当布局偏移，得到 750
    expect(mockScrollEl.scrollTop).toBe(600);
    const saved = useWorkspace.getState().getCursorStateFor(filePath);
    expect(saved.scrollTop).toBe(600);

    window.requestAnimationFrame = originalRaf;
  });

  it("exit nudges viewport to keep a visible CM cursor in view after anchor scroll (#136)", async () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    };

    const filePath = "/tmp/test-exit-nudge.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    // 布局高 200 / 可视高 50 / zoom=1，maxScroll=150
    const mockScrollEl = {
      scrollTop: 0,
      isConnected: true,
      scrollHeight: 200,
      clientHeight: 50,
      getBoundingClientRect: () => ({ top: 20, height: 50 }),
    };
    Object.setPrototypeOf(mockScrollEl, HTMLElement.prototype);

    const mockTr = {
      replaceWith: vi.fn().mockReturnThis(),
      setSelection: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };

    // 锚点内容布局偏移 100；光标内容布局偏移 160~170（锚点滚动到顶后
    // 光标行落在视口 [100,150] 之下，模拟「底部编辑后退出」）
    const anchorLayoutOffset = 100;
    const cursorTopOffset = 160;
    // 光标偏移 30 经权重法兜底映射出的 PM pos（textBetween 为空，
    // 精确匹配必然退回该值）
    const cursorProsePos = markdownOffsetToProsePos(40, value, 30);
    const mockView = {
      state: {
        plugins: [],
        doc: {
          content: { size: 40 },
          resolve: vi.fn().mockReturnValue({ pos: 18 }),
          textBetween: () => "",
        },
        selection: { head: 18 },
        tr: mockTr,
      },
      dispatch: vi.fn(),
      coordsAtPos: (pos: number) =>
        pos === cursorProsePos
          ? {
              top: 20 + (cursorTopOffset - mockScrollEl.scrollTop),
              bottom: 30 + (cursorTopOffset - mockScrollEl.scrollTop),
            }
          : {
              top: 20 + (anchorLayoutOffset - mockScrollEl.scrollTop),
              bottom: 21 + (anchorLayoutOffset - mockScrollEl.scrollTop),
            },
      dom: {
        closest: (selector: string) =>
          selector === ".editor-scroll" ? mockScrollEl : null,
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        fn({
          get: (key: any) => {
            if (key === editorViewCtx) return mockView;
            if (key === parserCtx)
              return (val: string) => ({ content: { size: val.length } });
            return null;
          },
        });
      },
    };

    useWorkspace.setState({
      openTabs: [
        { path: filePath, content: value, dirty: false, lastSavedAt: null, cursorPos: 3, scrollTop: 0 },
      ],
    });

    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
        }),
      { initialProps: { sourceMode: true } },
    );

    // 真实路径：onUnmountSnapshot 注入 exitSnapshotRef
    result.current.exitSnapshotRef.current = {
      cursor: 30,
      scrollTop: 50,
      scrollHeight: 100,
      anchorOffset: 20,
      // 退出时光标在源码视口内 → 允许可见性微调
      cursorVisible: true,
    };

    rerender({ sourceMode: false });

    while (rafCallbacks.length > 0) {
      const cb = rafCallbacks.shift();
      cb?.(0);
    }

    // 锚点先滚到顶（100），随后微调把光标行（160~170）拉回视口：
    // scrollTop = 170 + 8(margin) - 50(clientHeight) = 128。
    // 无门控/无微调的旧行为会停在 100，刚编辑的内容落在可视区外
    expect(mockScrollEl.scrollTop).toBe(128);
    const saved = useWorkspace.getState().getCursorStateFor(filePath);
    expect(saved.scrollTop).toBe(128);
    // 记忆光标仍以锚点偏移为准（阅读位置），不被微调改写语义
    expect(saved.pos).toBe(markdownOffsetToProsePos(40, value, 20));

    window.requestAnimationFrame = originalRaf;
  });

  it("enter snapshot captures source container height (比例映射兜底输入)", () => {
    const filePath = "/tmp/test-enter-height.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    // 持续缓存提供 scrollTop；scrollHeight 无缓存 → 退回现场读取（10000）
    const mockScrollEl = { scrollTop: 0, isConnected: true, scrollHeight: 10000 };
    Object.setPrototypeOf(mockScrollEl, HTMLElement.prototype);

    const mockView = {
      state: {
        selection: { head: 15 },
        doc: {
          content: { size: 40 },
          textBetween: () => "# Title\n\nParagraph",
        },
      },
      dom: {
        closest: (selector: string) =>
          selector === ".editor-scroll" ? mockScrollEl : null,
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        fn({
          get: (key: any) => (key === editorViewCtx ? mockView : null),
        });
      },
    };

    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
          getWysiwygScrollTop: () => 4200,
          getWysiwygTopPos: () => 15,
        }),
      { initialProps: { sourceMode: false } },
    );

    rerender({ sourceMode: true });

    expect(result.current.enterSnapshot).not.toBeNull();
    expect(result.current.enterSnapshot!.scrollTop).toBe(4200);
    expect(result.current.enterSnapshot!.scrollHeight).toBe(10000);
    expect(result.current.enterSnapshot!.anchorOffset).toBe(18);
    expect(result.current.enterSnapshot!.cursor).toBe(18);
  });

  it("enter snapshot prefers cached scroll values over collapsed live reads (display:none 塌陷)", () => {
    // 现场：切换瞬间 .md-editor-wysiwyg 已塌陷，现场读到的
    // scrollTop=0 / scrollHeight≈clientHeight 均不可信，缓存值必须胜出
    const filePath = "/tmp/test-enter-collapsed.md";
    const value = "# Title\n\nParagraph 1\n\nParagraph 2";
    const lastSyncedRef = { current: value };

    const mockScrollEl = { scrollTop: 0, isConnected: true, scrollHeight: 542 };
    Object.setPrototypeOf(mockScrollEl, HTMLElement.prototype);

    const mockView = {
      state: {
        selection: { head: 15 },
        doc: {
          content: { size: 40 },
          textBetween: () => "# Title\n\nParagraph",
        },
      },
      dom: {
        closest: (selector: string) =>
          selector === ".editor-scroll" ? mockScrollEl : null,
      },
    };

    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => {
        fn({
          get: (key: any) => (key === editorViewCtx ? mockView : null),
        });
      },
    };

    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor,
          lastSyncedRef,
          getWysiwygScrollTop: () => 31452,
          getWysiwygScrollHeight: () => 63446,
          getWysiwygTopPos: () => 15,
        }),
      { initialProps: { sourceMode: false } },
    );

    rerender({ sourceMode: true });

    // 缓存值胜出：塌陷的现场值（0/542）被忽略；旧实现拿 31452/542
    // 做映射会把目标算成天文数字、被钳到容器底部
    expect(result.current.enterSnapshot!.scrollTop).toBe(31452);
    expect(result.current.enterSnapshot!.scrollHeight).toBe(63446);
    expect(result.current.enterSnapshot!.anchorOffset).toBe(18);
    expect(result.current.enterSnapshot!.cursor).toBe(18);
  });

  it("restores source mode, snapshot, and content protection when parsing malformed markdown fails", () => {
    const filePath = "/tmp/malformed.md";
    const malformed = "# still mine\n\n<broken % markdown";
    const lastSyncedRef = { current: "previous rendered value" };
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const messageSpy = vi.spyOn(dialogs, "showMessage").mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});

    useWorkspace.setState({
      activeTabPath: filePath,
      currentFile: filePath,
      currentContent: malformed,
      openTabs: [{
        path: filePath,
        content: malformed,
        dirty: true,
        lastSavedAt: null,
        cursorPos: null,
        scrollTop: null,
        sourceMode: true,
      }],
    });

    let parseShouldFail = true;
    const parserMock = vi.fn(() => {
      if (parseShouldFail) throw new Error("parse exploded");
      return { content: { size: malformed.length } };
    });
    const mockTr = {
      replaceWith: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };
    const dispatch = vi.fn();
    const mockEditor: any = {
      action: (fn: (ctx: any) => void) => fn({
        get: (key: any) => {
          if (key === editorViewCtx) return {
            state: { tr: mockTr, plugins: [], doc: { content: { size: 1 } } },
            dispatch,
          };
          if (key === parserCtx) return parserMock;
          return null;
        },
      }),
    };

    const { result, rerender } = renderHook(
      ({ sourceMode }) => useSourceModeTransition({
        filePath,
        sourceMode,
        value: malformed,
        getEditor: () => mockEditor,
        lastSyncedRef,
      }),
      { initialProps: { sourceMode: true } },
    );
    result.current.exitSnapshotRef.current = {
      cursor: 17,
      scrollTop: 240,
      scrollHeight: 900,
      anchorOffset: 11,
      cursorVisible: true,
    };

    rerender({ sourceMode: false });

    expect(clipboardWrite).toHaveBeenCalledWith(malformed);
    expect(messageSpy).toHaveBeenCalledWith(
      expect.stringContaining("当前 Markdown 仍保留"),
      { title: "解析失败", kind: "error" },
    );
    expect(useWorkspace.getState().getTabSourceMode(filePath)).toBe(true);
    expect(result.current.enterSnapshot).toEqual({
      cursor: 17,
      scrollTop: 240,
      scrollHeight: 900,
      anchorOffset: 11,
    });
    expect(lastSyncedRef.current).toBe("previous rendered value");
    expect(useWorkspace.getState().openTabs[0].content).toBe(malformed);

    // Complete the real prop round-trip, then prove the failure latch clears
    // and a corrected document can leave source mode normally.
    rerender({ sourceMode: true });
    expect(parserMock).toHaveBeenCalledTimes(1);
    parseShouldFail = false;
    useWorkspace.getState().setTabSourceMode(false, filePath);
    rerender({ sourceMode: false });

    expect(parserMock).toHaveBeenCalledTimes(2);
    expect(mockTr.replaceWith).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalled();
    expect(result.current.enterSnapshot).toBeNull();
    expect(lastSyncedRef.current).toBe(malformed);
  });

  // ---- #375 评审 R4 验收 F1/F6：首帧位置信息的两条护栏 ----

  /**
   * 真实 PM doc（#375 评审 R5-3）：`resolveAnchorProsePos` 依赖
   * `doc.textBetween(0, pos, "\n", "\n")` 做候选行文本匹配 + 二分，
   * 用假 doc 会让它必然走 fallback，精确换算路径一次都跑不到。
   */
  const anchorSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      heading: {
        content: "inline*",
        group: "block",
        attrs: { level: { default: 1 } },
      },
      paragraph: { content: "inline*", group: "block" },
      text: { group: "inline" },
    },
  });
  const EXIT_VALUE = "# 标题\n\n正文锚点行\n\n## 第二节";
  const makeAnchorDoc = (value: string) =>
    anchorSchema.node(
      "doc",
      null,
      value.split("\n").map((line) => {
        if (line.trim() === "") return anchorSchema.node("paragraph", null, []);
        if (line.startsWith("#")) {
          return anchorSchema.node("heading", { level: 1 }, [
            anchorSchema.text(line.replace(/^#+\s*/, "")),
          ]);
        }
        return anchorSchema.node("paragraph", null, [anchorSchema.text(line)]);
      }),
    );

  /** 最小退出事务 harness，只取 setMeta 的大纲负载 */
  function exitMetaFor(
    filePath: string,
    snap: {
      cursor: number;
      scrollTop: number;
      anchorOffset?: number;
      cursorVisible?: boolean;
    } | null,
    opts: { value?: string } = {},
  ) {
    const value = opts.value ?? EXIT_VALUE;
    const parsedDoc = makeAnchorDoc(value);
    const mockTr = {
      replaceWith: vi.fn().mockReturnThis(),
      setSelection: vi.fn().mockReturnThis(),
      setMeta: vi.fn().mockReturnThis(),
    };
    const mockScrollEl = {
      scrollTop: 0,
      isConnected: true,
      scrollHeight: 200,
      clientHeight: 80,
      getBoundingClientRect: () => ({ top: 20, height: 80 }),
    };
    Object.setPrototypeOf(mockScrollEl, HTMLElement.prototype);
    const mockView = {
      state: {
        plugins: [],
        doc: {
          content: { size: 40 },
          resolve: vi.fn().mockReturnValue({ pos: 18 }),
          textBetween: () => "",
        },
        selection: { head: 18 },
        tr: mockTr,
      },
      dispatch: vi.fn(),
      coordsAtPos: () => ({ top: 20, bottom: 21 }),
      dom: {
        closest: (s: string) => (s === ".editor-scroll" ? mockScrollEl : null),
      },
    };
    const mockEditor = {
      action: (fn: (ctx: { get: (k: unknown) => unknown }) => void) =>
        fn({
          get: (key: unknown) => {
            if (key === editorViewCtx) return mockView;
            if (key === parserCtx) {
              return (v: string) => (v === value ? parsedDoc : makeAnchorDoc(v));
            }
            return null;
          },
        }),
    };
    useWorkspace.setState({
      activeTabPath: filePath,
      currentFile: filePath,
      currentContent: value,
      openTabs: [
        {
          path: filePath,
          content: value,
          dirty: false,
          lastSavedAt: null,
          cursorPos: null,
          scrollTop: null,
        },
      ],
    });
    const { result, rerender } = renderHook(
      ({ sourceMode }) =>
        useSourceModeTransition({
          filePath,
          sourceMode,
          value,
          getEditor: () => mockEditor as never,
          lastSyncedRef: { current: value },
        }),
      { initialProps: { sourceMode: true } },
    );
    if (snap) result.current.exitSnapshotRef.current = snap;
    rerender({ sourceMode: false });
    const call = mockTr.setMeta.mock.calls.find((c) =>
      String((c[0] as { key?: string })?.key ?? c[0]).startsWith(
        "inkling-outline-tracker",
      ),
    );
    return {
      meta: call?.[1] as
        | {
            active: unknown;
            anchorPos: number | null;
            caretPos: number | null;
          }
        | undefined,
      value,
      docSize: parsedDoc.content.size,
      textBefore(pos: number): string {
        return parsedDoc.textBetween(0, pos, "\n", "\n");
      },
    };
  }

  it("光标在源码视口内时才传 caretPos（只滚动未编辑不能用陈旧光标）", () => {
    const visible = exitMetaFor("/tmp/r4-caret-visible.md", {
      cursor: 18,
      scrollTop: 100,
      anchorOffset: 3,
      cursorVisible: true,
    });
    expect(visible.meta?.anchorPos).toEqual(expect.any(Number));
    expect(visible.meta?.caretPos).toEqual(expect.any(Number));

    const hidden = exitMetaFor("/tmp/r4-caret-hidden.md", {
      cursor: 18,
      scrollTop: 100,
      anchorOffset: 3,
      cursorVisible: false,
    });
    expect(hidden.meta?.anchorPos).toEqual(expect.any(Number));
    // 与 source-mode-editor-initial-scroll.test.tsx 的脱链卸载用例构成完整链：
    // 那里断言卸载快照 cursorVisible===false，这里断言下游 caretPos 保持 null，
    // 陈旧光标不会经 Math.max(anchorPos, caretPos) 钉住首帧高亮。
    expect(hidden.meta?.caretPos).toBeNull();
  });

  it("没有卸载快照时两个位置都不传（让身份兜底生效，不钉在首章）", () => {
    const { meta } = exitMetaFor("/tmp/r4-no-snap.md", null);
    expect(meta?.anchorPos).toBeNull();
    expect(meta?.caretPos).toBeNull();
    expect(meta?.active).toEqual({ headings: [], activeIndex: null });
  });

  // ---- #375 评审 R5-3：精确换算必须真的执行，且退化路径可验证 ----

  it("精确换算命中锚点行：二分定位到该行首字，不是权重比例 fallback（反向锁）", () => {
    const anchorOffset = EXIT_VALUE.indexOf("正文锚点行");
    const { meta, value, docSize, textBefore } = exitMetaFor(
      "/tmp/r5-precise.md",
      { cursor: 0, scrollTop: 0, anchorOffset, cursorVisible: false },
    );
    const fallback = markdownOffsetToProsePos(docSize, value, anchorOffset);
    expect(meta?.anchorPos).toEqual(expect.any(Number));
    // 反向锁：把 resolveAnchorProsePos 改成恒 fallback 时这条必须红
    expect(
      meta?.anchorPos,
      "精确换算没有命中正文锚点行，退化成了权重比例 fallback",
    ).not.toBe(fallback);
    // 精确结果必须让「正文锚点行」的首字刚好进入 textBetween(0, pos)
    const pos = meta?.anchorPos as number;
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(docSize);
    const prefix = textBefore(pos);
    expect(prefix.endsWith("正"), `prefix=${JSON.stringify(prefix)}`).toBe(true);
    expect(textBefore(pos - 1).endsWith("正")).toBe(false);
  });

  it("纯标记行（分隔线/空引用/表格分隔）匹配不到时退回权重比例 fallback", () => {
    // markdownNormLine 对这些行都返回 []，候选行收集为空 → 精确换算必须
    // 走 fallback，且不能抛异常或给出文档外位置。
    const value = [
      "---",
      "***",
      "___",
      "> ",
      "| --- | --- |",
      "",
      "---",
      "***",
      "___",
      "---",
      "***",
      "---",
    ].join("\n");
    const anchorOffset = value.indexOf("> ");
    const { meta, docSize, textBefore } = exitMetaFor(
      "/tmp/r5-fallback.md",
      { cursor: 0, scrollTop: 0, anchorOffset, cursorVisible: false },
      { value },
    );
    const fallback = markdownOffsetToProsePos(docSize, value, anchorOffset);
    expect(meta?.anchorPos).toBe(fallback);
    expect(meta?.anchorPos).toBeGreaterThanOrEqual(0);
    expect(meta?.anchorPos).toBeLessThanOrEqual(docSize);
    expect(() => textBefore(meta?.anchorPos as number)).not.toThrow();
  });

  it("锚点偏移超界与空文档都不抛，位置仍钳在文档内", () => {
    const over = exitMetaFor("/tmp/r5-over.md", {
      cursor: 0,
      scrollTop: 0,
      anchorOffset: 10_000,
      cursorVisible: false,
    });
    expect(over.meta?.anchorPos).toBeGreaterThanOrEqual(0);
    expect(over.meta?.anchorPos).toBeLessThanOrEqual(over.docSize);
    const empty = exitMetaFor(
      "/tmp/r5-empty.md",
      { cursor: 0, scrollTop: 0, anchorOffset: 0, cursorVisible: false },
      { value: "" },
    );
    expect(empty.meta?.anchorPos).toBeGreaterThanOrEqual(0);
    expect(empty.meta?.anchorPos).toBeLessThanOrEqual(empty.docSize);
  });
});

// 切 tab 编辑器状态缓存与分片水合（issue #426）
//
// 覆盖四类真实行为（真实 ProseMirror 状态/视图 + 真实插件，不用空实现）：
// 1. LRU 缓存的失效条件（revision / content 不匹配即失效）、淘汰与按打开 tab 裁剪；
// 2. 分片水合：首片同步挂载、尾部按宏任务追加、末片带 done 标记、取消后不再追加；
// 3. 高度占位：水合期间撑住容器高度，完成/取消后清除；
// 4. 配套插件在水合事务上不做多余工作（markdown 发布、光标落盘、块拖拽手柄）。

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection, type Plugin } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import {
  createTabEditorCache,
  flushActiveHydration,
  hasActiveHydration,
  hydrationMetaKey,
  startDocHydration,
  type HydrationMeta,
  type TabEditorSnapshot,
} from "../../src/components/Editor/tab-editor-cache";
import { markdownPublisherPlugin } from "../../src/components/Editor/markdown-publisher";
import { cursorSaverPlugin } from "../../src/components/Editor/cursor-saver";
import { blockDragKey, blockDragPlugin } from "../../src/components/Editor/block-drag";

function makeSchema() {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        group: "block",
        content: "text*",
        toDOM: () => ["p", 0],
        parseDOM: [{ tag: "p" }],
      },
      text: { group: "inline" },
    },
  });
}

const schema = makeSchema();

function makeDoc(count: number) {
  return schema.nodes.doc.create(
    null,
    Array.from({ length: count }, (_, i) =>
      schema.nodes.paragraph.create(null, schema.text(`block-${i}`)),
    ),
  );
}

interface Mounted {
  view: EditorView;
  /** 依次记录每个事务携带的水合元信息（断言分片顺序与 done 标记） */
  metas: HydrationMeta[];
}

function mountView(
  blocks: number,
  extraPlugins: Plugin[] = [],
  doc: ReturnType<typeof makeDoc> = makeDoc(blocks),
): Mounted {
  const metas: HydrationMeta[] = [];
  const root = document.createElement("div");
  document.body.appendChild(root);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
    plugins: extraPlugins,
  });
  const view = new EditorView(root, { state });
  const originalDispatch = view.dispatch.bind(view);
  view.dispatch = ((tr: Parameters<EditorView["dispatch"]>[0]) => {
    const meta = tr.getMeta(hydrationMetaKey) as HydrationMeta | undefined;
    if (meta) metas.push(meta);
    originalDispatch(tr);
  }) as EditorView["dispatch"];
  return { view, metas };
}

function makeSnapshot(overrides: Partial<TabEditorSnapshot> = {}): TabEditorSnapshot {
  return {
    filePath: "/docs/note.md",
    revision: 0,
    cachedContent: "# body",
    fullDoc: makeDoc(10),
    selection: { anchor: 3, head: 3 },
    historyState: undefined,
    lastSynced: "# body",
    outlineSnapshot: null,
    totalHeight: 0,
    ...overrides,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("TabEditorCache（#426）", () => {
  it("命中会刷新 LRU 次序：刚切回过的 tab 不会被下一次插入淘汰", () => {
    const cache = createTabEditorCache(2);
    cache.set(makeSnapshot({ filePath: "/a.md", cachedContent: "a" }));
    cache.set(makeSnapshot({ filePath: "/b.md", cachedContent: "b" }));
    // 命中 /a.md（最旧项）→ 触碰到最新端
    expect(cache.get("/a.md", 0, "a")).not.toBeNull();
    // 再插入 /c.md：应淘汰 /b.md（现最旧），/a.md 必须存活
    cache.set(makeSnapshot({ filePath: "/c.md", cachedContent: "c" }));
    expect(cache.get("/a.md", 0, "a")).not.toBeNull();
    expect(cache.get("/c.md", 0, "c")).not.toBeNull();
    expect(cache.get("/b.md", 0, "b")).toBeNull();
  });

  it("revision 变化同样使缓存失效（同路径重载不得复用旧 doc）", () => {
    const cache = createTabEditorCache();
    cache.set(makeSnapshot({ filePath: "/a.md", revision: 3, cachedContent: "a" }));
    expect(cache.get("/a.md", 4, "a")).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it("按打开 tab 集合裁剪：关闭的 tab 立即释放缓存", () => {
    const cache = createTabEditorCache();
    cache.set(makeSnapshot({ filePath: "/a.md" }));
    cache.set(makeSnapshot({ filePath: "/b.md" }));
    cache.prune(new Set(["/b.md"]));
    expect(cache.size()).toBe(1);
    expect(cache.get("/a.md", 0, "# body")).toBeNull();
    expect(cache.get("/b.md", 0, "# body")).not.toBeNull();
  });
});

describe("分片水合（#426）", () => {
  it("首片同步挂载、尾部按宏任务追加，末片带 done 并恢复选区", async () => {
    const { view, metas } = mountView(40);
    const task = startDocHydration({
      view,
      fullDoc: makeDoc(40),
      fromCache: true,
      selection: { anchor: 5, head: 5 },
      historyState: undefined,
      chunkSize: 8,
    });

    // 首片：只有 8 块，且 done=false（尾部还没到）
    expect(view.state.doc.childCount).toBe(8);
    expect(metas[0].hydrating).toBe(true);
    expect(metas[0].done).toBe(false);

    // 等一个宏任务：尾部继续追加（具体片数取决于宏任务调度，只锁「按块递增」）
    await waitForMacrotask();
    await waitForMacrotask();
    const progressed = view.state.doc.childCount;
    expect(progressed).toBeGreaterThan(8);
    expect(progressed).toBeLessThanOrEqual(40);
    expect(progressed % 8).toBe(0);
    // 追加片带「新增起始块索引 / 旧末尾位置」，供插件做 O(chunk) 增量处理
    expect(metas[1].appendFromIndex).toBe(8);
    expect(typeof metas[1].appendFromPos).toBe("number");
    expect(metas[1].done).toBe(false);

    // flush 补齐剩余分片（交互前的同步补齐），末片 done=true 且恢复缓存选区
    flushActiveHydration();
    expect(view.state.doc.childCount).toBe(40);
    expect(task.isActive()).toBe(false);
    expect(metas[metas.length - 1].done).toBe(true);
    expect(view.state.selection.from).toBe(5);
    expect(view.state.selection.to).toBe(5);
    view.destroy();
  });

  it("取消后不再追加任何分片", async () => {
    const { view } = mountView(40);
    const task = startDocHydration({
      view,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    expect(view.state.doc.childCount).toBe(8);
    task.cancel();
    await waitForMacrotask();
    await new Promise((r) => setTimeout(r, 20));
    expect(view.state.doc.childCount).toBe(8);
    // 取消后再 flush 也不能继续（否则切 tab 后旧文档会写进新 tab）
    flushActiveHydration();
    expect(view.state.doc.childCount).toBe(8);
    view.destroy();
  });

  it("高度占位：水合期间撑住容器高度，完成后清除", () => {
    const { view } = mountView(40);
    const holder = document.createElement("div");
    const task = startDocHydration({
      view,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
      heightPlaceholder: { el: holder, height: 12345 },
    });
    expect(holder.style.minHeight).toBe("12345px");
    // 占位生效时估算高度直接取占位值（不再外推）
    expect(task.estimateFullHeight()).toBe(12345);

    flushActiveHydration();
    expect(holder.style.minHeight).toBe("");
    view.destroy();
  });

  it("取消也会清除高度占位（切走时不能把旧高度留在新 tab 上）", () => {
    const { view } = mountView(40);
    const holder = document.createElement("div");
    const task = startDocHydration({
      view,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
      heightPlaceholder: { el: holder, height: 999 },
    });
    expect(holder.style.minHeight).toBe("999px");
    task.cancel();
    expect(holder.style.minHeight).toBe("");
    view.destroy();
  });

  it("首开中途估算完整高度：按已水合块的平均高度外推", () => {
    const { view } = mountView(40);
    const task = startDocHydration({
      view,
      fullDoc: makeDoc(40),
      fromCache: false,
      chunkSize: 8,
    });
    const scroller = document.createElement("div");
    Object.defineProperty(scroller, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(view, "scrollDOM", { value: scroller, configurable: true });
    // 已挂载 8 / 共 40 块，实测高度 2000 → 完整高度 ≈ 10000
    expect(task.estimateFullHeight()).toBe(10000);
    task.cancel();
    view.destroy();
  });

  it("水合注册表按 view 隔离：分屏水合不应让主编辑器误判自己在水合（#426 评审 S5）", () => {
    const main = mountView(40);
    const split = mountView(40);
    expect(hasActiveHydration(main.view)).toBe(false);
    const task = startDocHydration({
      view: split.view,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    expect(hasActiveHydration(split.view)).toBe(true);
    // 主编辑器不因为分屏侧在��合而被当成「自己在水合」
    expect(hasActiveHydration(main.view)).toBe(false);
    // 只 flush 指定 view：分屏补齐，主编辑器不受影响
    flushActiveHydration(split.view);
    expect(split.view.state.doc.childCount).toBe(40);
    expect(hasActiveHydration(split.view)).toBe(false);
    task?.cancel();
    main.view.destroy();
    split.view.destroy();
  });
});

describe("水合事务不触发多余工作（#426）", () => {
  it("markdown 发布插件跳过水合事务，普通编辑仍照常发布（对照）", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const serialize = vi.fn(() => "md-x");
    const plugin = markdownPublisherPlugin({
      serialize,
      getLastSynced: () => "md-0",
      setLastSynced: () => {},
      onChange,
    });
    const state = EditorState.create({
      doc: makeDoc(3),
      plugins: [plugin],
    });
    const root2 = document.createElement("div");
    document.body.appendChild(root2);
    const view2 = new EditorView(root2, { state });
    serialize.mockClear();

    view2.dispatch(
      view2.state.tr
        .insertText("x", 1)
        .setMeta(hydrationMetaKey, { hydrating: true, done: false }),
    );
    vi.advanceTimersByTime(600);
    expect(serialize).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    // 对照：普通编辑必须照常序列化并发布（证明上一条不是恒真）
    view2.dispatch(view2.state.tr.insertText("y", 1));
    vi.advanceTimersByTime(200);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    view2.destroy();
  });

  it("光标插件跳过水合事务，普通编辑仍照常排落盘（对照）", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const plugin = cursorSaverPlugin("/docs/note.md", () => save);
    const doc = makeDoc(3);
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, {
      state: EditorState.create({ doc, plugins: [plugin] }),
    });

    view.dispatch(
      view.state.tr
        .insertText("x", 1)
        .setMeta(hydrationMetaKey, { hydrating: true, done: false }),
    );
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();

    view.dispatch(view.state.tr.insertText("y", 1));
    vi.advanceTimersByTime(400);
    expect(save).toHaveBeenCalledTimes(1);
    const [savedPath, savedPos, savedScrollTop] = save.mock.calls[0];
    expect(savedPath).toBe("/docs/note.md");
    expect(savedPos).toBe(view.state.selection.head);
    expect(typeof savedScrollTop).toBe("number");
    view.destroy();
  });

  it("markdown 发布插件也跳过 heading-id 补写事务，普通编辑仍照常发布", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const serialize = vi.fn(() => "md-y");
    const plugin = markdownPublisherPlugin({
      serialize,
      getLastSynced: () => "md-0",
      setLastSynced: () => {},
      onChange,
    });
    const state = EditorState.create({ doc: makeDoc(3), plugins: [plugin] });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });
    serialize.mockClear();

    // 上游 syncHeadingIdPlugin 用 PluginKey("MILKDOWN_HEADING_ID") 派发补 id 事务：
    // 该事务只改 heading 的 id attr，不影响 Markdown 序列化结果，不应再跑一次全文序列化。
    // 真实 key 形如 `MILKDOWN_HEADING_ID$N`（上游首个 key 不带后缀），这里沿用前缀匹配口径。
    const headingIdKey = "MILKDOWN_HEADING_ID";
    view.dispatch(
      view.state.tr
        .setNodeMarkup(0, undefined, {})
        .setMeta(headingIdKey, true),
    );
    vi.advanceTimersByTime(600);
    expect(serialize).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    view.dispatch(view.state.tr.insertText("z", 1));
    vi.advanceTimersByTime(200);
    expect(serialize).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it("块拖拽手柄在追加分片上只给新增块建手柄，旧块实例复用", () => {
    const { view } = mountView(8, [blockDragPlugin()]);
    const handles = () => {
      const s = blockDragKey.getState(view.state) as unknown as {
        decos: {
          find: (
            f: undefined,
            t: undefined,
            pred: (spec: unknown) => boolean,
          ) => { from: number; type: unknown }[];
        };
      };
      return s.decos.find(
        undefined,
        undefined,
        (spec) => (spec as { handle?: boolean }).handle === true,
      );
    };
    // 首片整体替换 8 块 → 8 个手柄
    startDocHydration({
      view,
      fullDoc: makeDoc(12),
      fromCache: true,
      chunkSize: 8,
    });
    const afterFirst = handles();
    expect(afterFirst).toHaveLength(8);

    // 追加分片：只给 4 个新块建手柄，前 8 个实例引用保持不变
    flushActiveHydration();
    const afterAll = handles();
    expect(afterAll).toHaveLength(12);
    for (let i = 0; i < 8; i += 1) {
      expect(afterAll[i].type).toBe(afterFirst[i].type);
    }
    view.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// #431 评审：交互路径的水合补齐必须按 view 作用域，缓存内容必须取 flush 后的值
// ═══════════════════════════════════════════════════════════════════════

describe("水合补齐的作用域（#431 评审）", () => {
  it("flushActiveHydration(view) 只补齐该编辑器，分屏另一侧仍在分片", () => {
    const a = mountView(40);
    const b = mountView(40);
    const taskA = startDocHydration({
      view: a.view,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    const taskB = startDocHydration({
      view: b.view,
      fullDoc: makeDoc(40),
      fromCache: true,
      chunkSize: 8,
    });
    expect(hasActiveHydration(a.view)).toBe(true);
    expect(hasActiveHydration(b.view)).toBe(true);

    flushActiveHydration(a.view);

    // A 被补齐，B 不能被动跟着插完——否则一次点击就重建长任务
    expect(a.view.state.doc.childCount).toBe(40);
    expect(taskA.isActive()).toBe(false);
    expect(b.view.state.doc.childCount).toBe(8);
    expect(hasActiveHydration(b.view)).toBe(true);
    expect(taskB.isActive()).toBe(true);

    taskB.cancel();
    a.view.destroy();
    b.view.destroy();
  });

  it("交互/点击/锚点三条路径都按当前 view 补齐（源码接线锁）", () => {
    const editor = readFileSync("src/components/Editor/Editor.tsx", "utf8");

    // 1) 分片水合期间的交互监听：传 view
    const flushStart = editor.indexOf("const flushOnInteraction");
    expect(flushStart).toBeGreaterThan(-1);
    const flushSeg = editor.slice(flushStart, flushStart + 900);
    expect(flushSeg).toContain("flushActiveHydration(view)");
    expect(flushSeg).not.toContain("flushActiveHydration();");

    // 2) 根容器点击：水合补齐移进 placeCursorForRootClick，自身不再无参 flush
    const clickStart = editor.indexOf("const handleRootMouseDown");
    expect(clickStart).toBeGreaterThan(-1);
    expect(editor.slice(clickStart, clickStart + 400)).not.toContain(
      "flushActiveHydration();",
    );
    const rootClick = readFileSync(
      "src/components/Editor/editor-root-click.ts",
      "utf8",
    );
    expect(rootClick).toContain("flushActiveHydration(view)");

    // 3) 打开文件后的锚点滚动：在 action 内按 view 补齐
    const anchorStart = editor.indexOf("scrollToAnchorInView(view, fragment)");
    expect(anchorStart).toBeGreaterThan(-1);
    expect(editor.slice(anchorStart - 400, anchorStart)).toContain(
      "flushActiveHydration(view)",
    );
  });

  it("进入源码模式只补齐自己的编辑器（#431 评审）", () => {
    const src = readFileSync(
      "src/components/Editor/useSourceModeTransition.ts",
      "utf8",
    );
    expect(src).toContain("flushActiveHydration(ctx.get(editorViewCtx))");
    // 不允许残留无参调用（那会顺带把分屏另一侧的水合同步做完）
    expect(src).not.toMatch(/flushActiveHydration\(\s*\)/);
  });

  it("切走时缓存内容取 flush 之后的值，不用 flush 前的 prop（#431 评审）", () => {
    const editor = readFileSync("src/components/Editor/Editor.tsx", "utf8");
    expect(editor).toContain("cachedContent: flushedContent");
    expect(editor).not.toContain("cachedContent: prev.value");
    // 取值必须发生在 flush 之后：换 tab 时 flush 才把最新内容写进 store
    const flushIdx = editor.indexOf("flushAllMarkdownPublishers();");
    const resolveIdx = editor.indexOf("const flushedContent =");
    expect(flushIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(flushIdx);
  });
});

function waitForMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

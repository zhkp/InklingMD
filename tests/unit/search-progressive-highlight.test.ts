// #427：搜索结果渐进高亮（分批写 DOM）行为测试
//
// 背景：5k 行文档命中 1170 处时，`searchPlugin` 一次性为全部匹配创建 inline
// decoration，首次写入 DOM 的任务在 prod + uncapped 下达到 53–78ms，超过 Epic
// #387 的「单次 Long Task ≤ 50ms」。修复：首次只写一批（含 current），其余由
// 插件用 0ms 任务分批补齐。
//
// 这里用真实 EditorView 断言行为不变量（不是计时）：
// - 首次 set 只写一批，后续定时器补齐全部，且不重复写入同一区间
// - clear / 新搜索会丢弃未完成的分批，不残留旧高亮
// - 分批未完成时 next/prev 只移动 current 高亮，不重建全量装饰
// - 分批未完成时编辑文档仍走增量扫描，最终装饰与匹配一一对应（允许中间空洞）

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView, Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import {
  searchKey,
  searchPlugin,
  type SearchOpts,
} from "../../src/components/Editor/search";

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

const plainOpts = (find: string): SearchOpts => ({
  find,
  caseSensitive: false,
  useRegex: false,
});

function makeView(
  paragraphs: string[],
  plugin = searchPlugin(),
): { view: EditorView; plugin: ReturnType<typeof searchPlugin> } {
  const schema = makeSchema();
  const doc = schema.nodes.doc.create(
    null,
    paragraphs.map((t) => schema.nodes.paragraph.create(null, schema.text(t))),
  );
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
    plugins: [plugin],
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const view = new EditorView(root, { state });
  return { view, plugin };
}

function setSearch(view: EditorView, opts: SearchOpts) {
  view.dispatch(view.state.tr.setMeta(searchKey, { type: "set", opts }));
}

function decorateAllPending(view: EditorView) {
  // 每次分片是一个 0ms 定时器；runAllTimers 会把「回调里再 setTimeout」的
  // 后续分片一并跑完（而不是只跑当前队列里的那一个）。
  vi.runAllTimers();
  expect(view.isDestroyed).toBe(false);
}

function decosOf(view: EditorView, plugin: ReturnType<typeof searchPlugin>): Decoration[] {
  const decorations = plugin.props.decorations as (s: EditorState) => DecorationSet;
  return decorations(view.state).find();
}

function classOf(d: Decoration): string | undefined {
  return (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class;
}

function decoratedCount(view: EditorView): number {
  return searchKey.getState(view.state)!.decorated.filter(Boolean).length;
}

function paraTextStart(view: EditorView, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i += 1) pos += view.state.doc.child(i).nodeSize;
  return pos + 1;
}

const PARAS = Array.from({ length: 400 }, (_, i) => `para ${i} NEEDLE end`);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("#427 搜索高亮分批写入", () => {
  it("首次搜索只写首批装饰，定时器补齐全部且不重复", () => {
    const { view, plugin } = makeView(PARAS);
    setSearch(view, plainOpts("NEEDLE"));

    const state = searchKey.getState(view.state)!;
    expect(state.matches).toHaveLength(400);
    expect(state.decorated).toHaveLength(400);
    // 首批（160）立即写入，其余留待分批
    expect(decoratedCount(view)).toBe(160);
    expect(state.current).toBe(0);
    const initial = decosOf(view, plugin);
    expect(initial).toHaveLength(160);
    expect(initial.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);

    decorateAllPending(view);

    const final = decosOf(view, plugin);
    expect(decoratedCount(view)).toBe(400);
    // 每个匹配恰好一个装饰：重复写入会让数量超过匹配数
    expect(final).toHaveLength(400);
    expect(final.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);
    expect(final.filter((d) => classOf(d) === "search-match")).toHaveLength(399);
    // 装饰区间与匹配区间一一对应
    const matchKey = (from: number, to: number) => `${from}:${to}`;
    const expected = new Set(state.matches.map((m) => matchKey(m.from, m.to)));
    for (const d of final) expect(expected.has(matchKey(d.from, d.to))).toBe(true);
    view.destroy();
  });

  it("分批未完成时 clear 取消剩余批次，不残留高亮", () => {
    const { view, plugin } = makeView(PARAS);
    setSearch(view, plainOpts("NEEDLE"));
    expect(decoratedCount(view)).toBe(160);

    view.dispatch(view.state.tr.setMeta(searchKey, { type: "clear" }));
    expect(decosOf(view, plugin)).toHaveLength(0);

    // clear 之后即使定时器触发也不得重新写回高亮
    decorateAllPending(view);
    expect(searchKey.getState(view.state)!.matches).toHaveLength(0);
    expect(decosOf(view, plugin)).toHaveLength(0);
    view.destroy();
  });

  it("新搜索取代未完成的分批，不混入旧关键词的装饰", () => {
    const paragraphs = [
      ...Array.from({ length: 400 }, (_, i) => `foo ${i} NEEDLE end`),
      ...Array.from({ length: 300 }, (_, i) => `bar ${i} OTHER end`),
    ];
    const { view, plugin } = makeView(paragraphs);
    setSearch(view, plainOpts("foo"));
    expect(decoratedCount(view)).toBe(160);

    setSearch(view, plainOpts("bar"));
    const state = searchKey.getState(view.state)!;
    expect(state.matches).toHaveLength(300);
    expect(decoratedCount(view)).toBe(160);

    decorateAllPending(view);

    const final = decosOf(view, plugin);
    expect(final).toHaveLength(300);
    // 旧关键词 foo 的装饰不得残留：所有装饰都必须落在 bar 的匹配区间上
    const barRanges = new Set(state.matches.map((m) => `${m.from}:${m.to}`));
    for (const d of final) expect(barRanges.has(`${d.from}:${d.to}`)).toBe(true);
    view.destroy();
  });

  it("分批未完成时 next/prev 只移动当前高亮，不重建全量装饰", () => {
    const { view, plugin } = makeView(PARAS);
    setSearch(view, plainOpts("NEEDLE"));
    const classByRange = () =>
      new Map(
        decosOf(view, plugin).map((d) => [`${d.from}:${d.to}`, classOf(d)] as const),
      );
    const before = classByRange();

    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));

    const state = searchKey.getState(view.state)!;
    expect(state.current).toBe(1);
    expect(decoratedCount(view)).toBe(160);
    const after = decosOf(view, plugin);
    expect(after).toHaveLength(160);
    // 只有两个端点的高亮类变化（旧 current → 普通、新 current → current），其余原样
    const changed = [...classByRange()].filter(([range, cls]) => before.get(range) !== cls);
    expect(changed).toHaveLength(2);
    expect(after.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);
    expect(after.find((d) => classOf(d) === "search-match-current")!.from).toBe(
      state.matches[1].from,
    );

    // 越过分批边界继续导航：未写入的匹配不报错，写完后仍只有它一个 current
    for (let i = 0; i < 200; i += 1) {
      view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    }
    expect(searchKey.getState(view.state)!.current).toBe(201);
    decorateAllPending(view);
    const final = decosOf(view, plugin);
    expect(final).toHaveLength(400);
    expect(final.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);
    expect(final.find((d) => classOf(d) === "search-match-current")!.from).toBe(
      searchKey.getState(view.state)!.matches[201].from,
    );
    view.destroy();
  });

  it("相邻匹配在 next/prev 换类时不会被误删（#427 评审阻塞项）", () => {
    // "####" 搜 "#"：4 个首尾相接的匹配。DecorationSet.find 是「含边界相交」
    // 语义，若按区间摘除会连带删掉相邻匹配的装饰，且位图仍为 true 不会补回。
    const { view, plugin } = makeView(["####"]);
    setSearch(view, plainOpts("#"));
    expect(searchKey.getState(view.state)!.matches).toHaveLength(4);
    expect(decosOf(view, plugin)).toHaveLength(4);

    for (let i = 0; i < 3; i += 1) {
      view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    }
    for (let i = 0; i < 2; i += 1) {
      view.dispatch(view.state.tr.setMeta(searchKey, { type: "prev" }));
    }

    const state = searchKey.getState(view.state)!;
    expect(state.current).toBe(1);
    const decos = decosOf(view, plugin);
    expect(decoratedCount(view)).toBe(4);
    // 位图与装饰集必须一致：任何一处相邻匹配被误删都会让数量对不上
    expect(decos).toHaveLength(4);
    expect(decos.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);
    expect(decos.filter((d) => classOf(d) === "search-match")).toHaveLength(3);
    const ranges = new Set(decos.map((d) => `${d.from}:${d.to}`));
    for (const m of state.matches) expect(ranges.has(`${m.from}:${m.to}`)).toBe(true);
    view.destroy();
  });

  it("编辑删减前序匹配后导航：装饰数与匹配数一致、恰一个 current（#427 评审）", () => {
    // 增量编辑会平移 matches 下标。若按「匹配下标」而不是「精确区间」摘除，
    // 删除第一处命中后 keptAfter 的下标失效，next 会留下两个 current。
    const { view, plugin } = makeView(["foo one", "two foo", "three foo"]);
    setSearch(view, plainOpts("foo"));
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    expect(searchKey.getState(view.state)!.current).toBe(2);

    // 单步删除第一段中的命中：匹配 3 → 2，current 按区间跟踪到原第三段
    const first = searchKey.getState(view.state)!.matches[0];
    view.dispatch(view.state.tr.delete(first.from, first.to));
    expect(searchKey.getState(view.state)!.matches).toHaveLength(2);
    expect(searchKey.getState(view.state)!.current).toBe(1);

    // 再 next：旧 current（原第三段）必须降级，不能保留两个 current
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));

    const state = searchKey.getState(view.state)!;
    const decos = decosOf(view, plugin);
    expect(state.current).toBe(0);
    expect(decoratedCount(view)).toBe(2);
    expect(decos).toHaveLength(2);
    expect(decos.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);
    expect(decos.find((d) => classOf(d) === "search-match-current")!.from).toBe(
      state.matches[0].from,
    );
    expect(decos.filter((d) => classOf(d) === "search-match")).toHaveLength(1);
    view.destroy();
  });

  it("编辑使窗口匹配数 +1 后穿越相邻匹配：不丢不重（#427 评审）", () => {
    // 第一段编辑新增一处命中（窗口 1→2），会平移后续匹配下标；
    // 第二段两个命中首尾相接，正好同时考验「下标漂移」与「边界相交」。
    const { view, plugin } = makeView(["a# z", "##"]);
    setSearch(view, plainOpts("#"));
    const first = searchKey.getState(view.state)!.matches[0];
    view.dispatch(view.state.tr.insertText(" b#", first.to));
    expect(searchKey.getState(view.state)!.matches).toHaveLength(4);

    for (let i = 0; i < 4; i += 1) {
      view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
      const state = searchKey.getState(view.state)!;
      const decos = decosOf(view, plugin);
      expect(decoratedCount(view)).toBe(state.matches.length);
      expect(decos).toHaveLength(state.matches.length);
      expect(decos.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);
      expect(decos.find((d) => classOf(d) === "search-match-current")!.from).toBe(
        state.matches[state.current].from,
      );
    }
    view.destroy();
  });

  it("分批未完成时编辑文档：保持增量扫描，补齐后装饰与匹配一一对应", () => {
    const { view, plugin } = makeView(PARAS);
    setSearch(view, plainOpts("NEEDLE"));
    expect(decoratedCount(view)).toBe(160);

    // 只跑一批，仍有未写入的匹配（模拟用户在分批窗口内输入）
    vi.advanceTimersByTime(0);
    expect(decoratedCount(view)).toBe(320);

    const execSpy = vi.spyOn(RegExp.prototype, "exec");
    // 编辑第 350 段（位于已写入前缀之外，也会改变窗口的索引分布）
    view.dispatch(view.state.tr.insertText("XYZ", paraTextStart(view, 350) + 5));

    // 增量路径仍然成立：扫描只触及变更文本块，不全文重扫
    expect(execSpy.mock.calls.length).toBeLessThan(20);
    const mid = searchKey.getState(view.state)!;
    expect(mid.matches).toHaveLength(400);
    expect(mid.decorated).toHaveLength(400);
    // 窗口内重扫的匹配已写入装饰（允许中间空洞），但不得出现重复装饰
    const midDecos = decosOf(view, plugin);
    expect(midDecos).toHaveLength(decoratedCount(view));
    expect(midDecos.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);

    decorateAllPending(view);

    const state = searchKey.getState(view.state)!;
    const final = decosOf(view, plugin);
    expect(decoratedCount(view)).toBe(400);
    expect(final).toHaveLength(400);
    const expected = new Set(state.matches.map((m) => `${m.from}:${m.to}`));
    for (const d of final) expect(expected.has(`${d.from}:${d.to}`)).toBe(true);
    expect(final.filter((d) => classOf(d) === "search-match-current")).toHaveLength(1);
    view.destroy();
  });
});

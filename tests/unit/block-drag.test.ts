// block-drag 装饰集性能测试
// 验证：手柄 widget 跨 transaction 增量映射复用同一实例（视图层据此复用 DOM，
// 万行文档输入不再每键重建全部手柄，issue #31）、新增块补手柄、指示器增删

import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { Schema } from "@milkdown/kit/prose/model";
import type { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { blockDragKey, blockDragPlugin } from "../../src/components/Editor/block-drag";
import { hydrationMetaKey } from "../../src/components/Editor/tab-editor-cache";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "text*" },
    blockquote: { group: "block", content: "block+" },
    text: {},
  },
});

function createState(paras: string[]) {
  const doc = schema.node(
    "doc",
    null,
    paras.map((t) => schema.node("paragraph", null, t ? schema.text(t) : undefined)),
  );
  return EditorState.create({ doc, plugins: [blockDragPlugin()] });
}

interface BlockDragState {
  dropIndex: number | null;
  decos: DecorationSet;
}

function handles(state: EditorState): Decoration[] {
  const s = blockDragKey.getState(state) as unknown as BlockDragState;
  return s.decos.find(
    undefined,
    undefined,
    (spec) => (spec as { handle?: boolean }).handle === true,
  );
}

function indicators(state: EditorState): Decoration[] {
  const s = blockDragKey.getState(state) as unknown as BlockDragState;
  return s.decos.find(
    undefined,
    undefined,
    (spec) => (spec as { indicator?: boolean }).indicator === true,
  );
}

describe("blockDragPlugin 装饰集增量更新", () => {
  it("初始为每个顶层块创建一个手柄", () => {
    const state = createState(["a", "b", "c"]);
    const hs = handles(state);
    expect(hs).toHaveLength(3);
    expect(hs.map((h) => h.from)).toEqual([0, 3, 6]);
  });

  it("文本编辑复用既有手柄 widget 实例（位置随映射平移）", () => {
    const initial = createState(["a", "b", "c"]);
    const before = handles(initial);
    let state = initial.apply(initial.tr.insertText("xx", 1));
    const after = handles(state);
    expect(after).toHaveLength(3);
    // 实例同一 → WidgetType.eq 命中 → 视图层复用 DOM 而非销毁重建
    after.forEach((deco, i) => {
      expect((deco as unknown as { type: unknown }).type).toBe((before[i] as unknown as { type: unknown }).type);
    });
    // 首个块起点不变，后续块因插入 2 字符右移
    expect(after.map((h) => h.from)).toEqual([0, 5, 8]);
  });

  it("新增顶层块只为其补建手柄，旧块复用实例", () => {
    const initial = createState(["a", "b"]);
    const before = handles(initial);
    let state = initial;
    const newPara = schema.node("paragraph", null, schema.text("n"));
    state = state.apply(state.tr.insert(3, newPara));
    const after = handles(state);
    expect(after).toHaveLength(3);
    expect(after.map((h) => h.from)).toEqual([0, 3, 6]);
    // 旧手柄随映射平移到新块起点，实例复用；仅新增块补建手柄
    expect((after[0] as unknown as { type: unknown }).type).toBe((before[0] as unknown as { type: unknown }).type);
    expect((after[1] as unknown as { type: unknown }).type).toBe((before[1] as unknown as { type: unknown }).type);
  });

  it("结构事务包裹块后清除映射到非顶层位置的旧手柄", () => {
    const initial = createState(["a", "b"]);
    // 两个段落整体包进 blockquote：旧手柄被映射到嵌套位置，不再是顶层块
    const quote = schema.node("blockquote", null, [
      schema.node("paragraph", null, schema.text("a")),
      schema.node("paragraph", null, schema.text("b")),
    ]);
    const state = initial.apply(
      initial.tr.replaceWith(0, initial.doc.content.size, quote),
    );
    const hs = handles(state);
    expect(hs).toHaveLength(1);
    expect(hs[0].from).toBe(0);
  });

  it("dropIndex 放置指示器，clear 移除且不影响手柄", () => {
    let state = createState(["a", "b"]);
    state = state.apply(state.tr.setMeta(blockDragKey, { dropIndex: 1 }));
    expect(indicators(state)).toHaveLength(1);
    expect(indicators(state)[0].from).toBe(3);
    expect(handles(state)).toHaveLength(2);

    state = state.apply(state.tr.setMeta(blockDragKey, { clear: true }));
    expect(indicators(state)).toHaveLength(0);
    expect(handles(state)).toHaveLength(2);
  });

  it("纯选区移动直接复用缓存装饰集", () => {
    let state = createState(["a", "b"]);
    const decosBefore = (blockDragKey.getState(state) as unknown as BlockDragState).decos;
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, 1)),
    );
    const decosAfter = (blockDragKey.getState(state) as unknown as BlockDragState).decos;
    expect(decosAfter).toBe(decosBefore);
  });

  it("追加分片水合保留拖拽目标：dropIndex 不重置、指示器跟随（#431 评审）", () => {
    // 场景：大文档拖拽中，dragover 已设定目标（插到第 3 块之前），
    // drop 之前恰有分片水合到达——目标索引不得被清成 null（否则 drop 回退到 0，块被移到文首）
    let state = createState(["a", "b", "c"]);
    state = state.apply(state.tr.setMeta(blockDragKey, { dropIndex: 2 }));
    expect(indicators(state)[0].from).toBe(6);

    const appendFromPos = state.doc.content.size;
    state = state.apply(
      state.tr
        .insert(appendFromPos, schema.node("paragraph", null, schema.text("d")))
        .setMeta(hydrationMetaKey, {
          hydrating: true,
          done: false,
          fromCache: true,
          appendFromIndex: 3,
          appendFromPos,
        }),
    );

    const s = blockDragKey.getState(state) as unknown as BlockDragState;
    expect(s.dropIndex).toBe(2);
    expect(indicators(state)).toHaveLength(1);
    expect(indicators(state)[0].from).toBe(6);
    // 追加块补手柄，已有手柄位置不变
    expect(handles(state).map((h) => h.from)).toEqual([0, 3, 6, 9]);
  });
});

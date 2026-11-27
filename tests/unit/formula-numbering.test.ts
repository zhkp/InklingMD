import { describe, it, expect, vi } from "vitest";
import { Schema, Node as PMNode } from "@milkdown/kit/prose/model";
import { formulaNumberingPlugin, formulaNumberingKey } from "../../src/components/Editor/formula-numbering";
import { useSettings } from "../../src/store/settings";
import { EditorState, Transaction } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { startDocHydration } from "../../src/components/Editor/tab-editor-cache";
import { markdownPublisherPlugin } from "../../src/components/Editor/markdown-publisher";

describe("Formula Numbering Plugin", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
      math_display: {
        group: "block",
        atom: true,
        attrs: { value: { default: "" }, number: { default: null } },
        toDOM: () => ["div", { class: "math-display" }],
      },
      text: { inline: true },
    },
  });

  function createDoc(nodes: PMNode[]) {
    return schema.nodes.doc.create({}, nodes);
  }

  function createMathNode(value: string, number: number | null = null) {
    return schema.nodes.math_display.create({ value, number });
  }

  it("should auto-number unnumbered math_display nodes sequentially when enabled", () => {
    useSettings.setState({ formulaAutoNumber: true });

    // 未编号的 math 节点 (number: 999 模拟错误编号)
    const doc = createDoc([
      createMathNode("E=mc^2", 999),
      schema.nodes.paragraph.create({}, schema.text("Middle paragraph")),
      createMathNode("a^2 + b^2 = c^2", 888),
    ]);

    const plugin = formulaNumberingPlugin();
    const state = EditorState.create({
      schema,
      doc,
      plugins: [plugin],
    });

    // 构造一个有文本变更且对 newState 生效的 transaction
    const tr = state.tr.insertText(" extra text", 15);
    expect(tr.docChanged).toBe(true);

    // 验证 collectFixes 针对 state.doc 能检测出不匹配
    const appendTr = plugin.spec.appendTransaction?.([tr], state, state);

    expect(appendTr).not.toBeNull();
    const finalState = state.apply(appendTr as Transaction);

    const mathNodes: PMNode[] = [];
    finalState.doc.descendants((node) => {
      if (node.type.name === "math_display") {
        mathNodes.push(node);
      }
    });

    expect(mathNodes.length).toBe(2);
    expect(mathNodes[0].attrs.number).toBe(1);
    expect(mathNodes[1].attrs.number).toBe(2);
  });

  it("should clear number attributes when formulaAutoNumber is disabled and numbers exist", () => {
    useSettings.setState({ formulaAutoNumber: false });

    const doc = createDoc([
      createMathNode("E=mc^2", 1),
      createMathNode("a^2 + b^2 = c^2", 2),
    ]);

    const plugin = formulaNumberingPlugin();
    const state = EditorState.create({
      schema,
      doc,
      plugins: [plugin],
    });

    // 通过 recalc meta 触发重算
    const tr = state.tr.setMeta(formulaNumberingKey, { recalc: true });
    const appendTr = plugin.spec.appendTransaction?.([tr], state, state);

    expect(appendTr).not.toBeNull();
    const finalState = state.apply(appendTr as Transaction);

    const mathNodes: PMNode[] = [];
    finalState.doc.descendants((node) => {
      if (node.type.name === "math_display") {
        mathNodes.push(node);
      }
    });

    expect(mathNodes.length).toBe(2);
    expect(mathNodes[0].attrs.number).toBeNull();
    expect(mathNodes[1].attrs.number).toBeNull();
  });

  it("should return null if numbers are already up to date", () => {
    useSettings.setState({ formulaAutoNumber: true });

    const doc = createDoc([
      createMathNode("E=mc^2", 1),
      createMathNode("a^2 + b^2 = c^2", 2),
    ]);

    const plugin = formulaNumberingPlugin();
    const state = EditorState.create({
      schema,
      doc,
      plugins: [plugin],
    });

    const tr = state.tr.setMeta(formulaNumberingKey, { recalc: true });
    const appendTr = plugin.spec.appendTransaction?.([tr], state, state.apply(tr));
    expect(appendTr).toBeNull();
  });

  it("should return null if no math_display exists in document", () => {
    useSettings.setState({ formulaAutoNumber: true });
    const doc = createDoc([schema.nodes.paragraph.create({}, schema.text("Hello world"))]);

    const plugin = formulaNumberingPlugin();
    const state = EditorState.create({
      schema,
      doc,
      plugins: [plugin],
    });

    const tr = state.tr.insertText("!", 1);
    const appendTr = plugin.spec.appendTransaction?.([tr], state, state.apply(tr));
    expect(appendTr).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// #431 评审 B3：缓存命中的水合末片按当前设置校正编号
// ═══════════════════════════════════════════════════════════════════════

describe("Formula Numbering × 缓存水合（#431 评审 B3）", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { group: "block", content: "text*", toDOM: () => ["p", 0] },
      math_display: {
        group: "block",
        atom: true,
        attrs: { value: { default: "" }, number: { default: null } },
        toDOM: () => ["div", { class: "math-display" }],
      },
      text: { inline: true },
    },
  });

  function mathDoc(numbers: Array<number | null>): PMNode {
    return schema.nodes.doc.create(
      null,
      numbers.map((number, i) =>
        schema.nodes.math_display.create({ value: `x_${i}`, number }),
      ),
    );
  }

  function mounted(numbers: Array<number | null>, renumberFormulas: boolean) {
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("init")),
      ),
      plugins: [formulaNumberingPlugin()],
    });
    const root = document.createElement("div");
    document.body.append(root);
    const view = new EditorView(root, { state });
    startDocHydration({
      view,
      fullDoc: mathDoc(numbers),
      fromCache: true,
      renumberFormulas,
    });
    return view;
  }

  function numbersOf(view: EditorView): Array<number | null> {
    const out: Array<number | null> = [];
    view.state.doc.descendants((node) => {
      if (node.type.name === "math_display") out.push(node.attrs.number);
      return true;
    });
    return out;
  }

  it("缓存里没有编号、当前开启自动编号 → 末片补上 1,2", () => {
    useSettings.setState({ formulaAutoNumber: true });
    const view = mounted([null, null], true);
    expect(numbersOf(view)).toEqual([1, 2]);
    view.destroy();
  });

  it("缓存里是旧编号、当前关闭自动编号 → 末片清成 null", () => {
    useSettings.setState({ formulaAutoNumber: false });
    const view = mounted([7, 8], true);
    expect(numbersOf(view)).toEqual([null, null]);
    view.destroy();
  });

  it("开关未变时信任缓存编号，不做多余重算", () => {
    useSettings.setState({ formulaAutoNumber: true });
    const view = mounted([1, 2], false);
    expect(numbersOf(view)).toEqual([1, 2]);
    view.destroy();
  });

  it("编号校正只改运行时 attr，不触发全文序列化", () => {
    vi.useFakeTimers();
    useSettings.setState({ formulaAutoNumber: true });
    const onChange = vi.fn();
    const serialize = vi.fn(() => "md");
    const state = EditorState.create({
      schema,
      doc: schema.nodes.doc.create(
        null,
        schema.nodes.paragraph.create(null, schema.text("init")),
      ),
      plugins: [
        formulaNumberingPlugin(),
        markdownPublisherPlugin({
          serialize,
          getLastSynced: () => "md",
          setLastSynced: () => {},
          getFilePath: () => "/docs/a.md",
          onChange,
        }),
      ],
    });
    const root = document.createElement("div");
    document.body.append(root);
    const view = new EditorView(root, { state });
    serialize.mockClear();

    startDocHydration({
      view,
      fullDoc: mathDoc([null, null]),
      fromCache: true,
      renumberFormulas: true,
    });
    expect(numbersOf(view)).toEqual([1, 2]);

    vi.advanceTimersByTime(400);
    expect(serialize).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    view.destroy();
    vi.useRealTimers();
  });
});

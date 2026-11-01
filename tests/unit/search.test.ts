// search 插件单元测试
// 覆盖：全部替换/替换当前的正确性、空替换串删除匹配（#178）、
// DecorationSet 缓存行为（#151）、clear 元信息清空搜索状态（#185 插件侧）

import { describe, it, expect } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView, Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import {
  searchKey,
  searchPlugin,
  replaceAll,
  replaceCurrent,
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

/** 构造带 search 插件的 EditorView，并预设查找选项（触发一次全文匹配）
 *  文档根必须是 doc 节点（ProseMirror 的真实形状）：#371 起匹配以文本块为边界，
 *  裸 paragraph 当根会让 nodesBetween 访问不到任何文本块。 */
function makeViewWithSearch(
  text: string,
  opts: SearchOpts,
  plugin = searchPlugin(),
): EditorView {
  const schema = makeSchema();
  const paragraph = schema.nodes.paragraph.create(null, schema.text(text));
  const doc = schema.nodes.doc.create(null, [paragraph]);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
    plugins: [plugin],
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const view = new EditorView(root, { state });
  view.dispatch(view.state.tr.setMeta(searchKey, { type: "set", opts }));
  return view;
}

const plainOpts = (find: string): SearchOpts => ({
  find,
  caseSensitive: false,
  useRegex: false,
});

/** 取插件的 decorations 函数（props.decorations 在 Plugin 上是原样保留的函数） */
function decorationsOf(plugin: ReturnType<typeof searchPlugin>) {
  return plugin.props.decorations as (state: EditorState) => DecorationSet;
}

/** Decoration.inline(from, to, attrs, spec) 的 class 在 attrs 上，不在 spec 上；
 * type 是内部字段，公开类型未导出，需经 unknown 断言访问 */
function decoClass(d: Decoration): string | undefined {
  return (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class;
}

describe("replaceAll 全部替换", () => {
  it("替换所有匹配项并返回正确数量", () => {
    const view = makeViewWithSearch("foo bar foo baz foo", plainOpts("foo"));
    const n = replaceAll(view, "FOO");
    expect(n).toBe(3);
    expect(view.state.doc.textContent).toBe("FOO bar FOO baz FOO");
    view.destroy();
  });

  it("从后往前替换避免位置偏移（多匹配位置正确）", () => {
    const view = makeViewWithSearch("a a a a a", plainOpts("a"));
    const n = replaceAll(view, "bb");
    expect(n).toBe(5);
    // 替换为更长的字符串，验证位置没有错乱
    expect(view.state.doc.textContent).toBe("bb bb bb bb bb");
    view.destroy();
  });

  it("无匹配时返回 0 且文档不变", () => {
    const view = makeViewWithSearch("hello world", plainOpts("xyz"));
    const original = view.state.doc.textContent;
    const n = replaceAll(view, "ABC");
    expect(n).toBe(0);
    expect(view.state.doc.textContent).toBe(original);
    view.destroy();
  });

  it("大小写敏感模式正确替换", () => {
    const view = makeViewWithSearch("Foo foo FOO foo", {
      find: "foo",
      caseSensitive: true,
      useRegex: false,
    });
    const n = replaceAll(view, "X");
    expect(n).toBe(2);
    expect(view.state.doc.textContent).toBe("Foo X FOO X");
    view.destroy();
  });

  it("正则模式替换", () => {
    const view = makeViewWithSearch("a1 b2 c3 d4", {
      find: "\\d",
      caseSensitive: false,
      useRegex: true,
    });
    const n = replaceAll(view, "0");
    expect(n).toBe(4);
    expect(view.state.doc.textContent).toBe("a0 b0 c0 d0");
    view.destroy();
  });
});

describe("空替换串（#178：删除全部匹配而不是抛 RangeError）", () => {
  it("replaceAll 空串删除所有匹配，返回删除数量", () => {
    const view = makeViewWithSearch("foo bar foo baz foo", plainOpts("foo"));
    let n = 0;
    // 修复前：schema.text("") 抛 RangeError: Empty text nodes are not allowed
    expect(() => {
      n = replaceAll(view, "");
    }).not.toThrow();
    expect(n).toBe(3);
    expect(view.state.doc.textContent).toBe(" bar  baz ");
    view.destroy();
  });

  it("replaceAll 空串多匹配位置不错乱", () => {
    const view = makeViewWithSearch("a a a a a", plainOpts("a"));
    const n = replaceAll(view, "");
    expect(n).toBe(5);
    expect(view.state.doc.textContent).toBe("    ");
    view.destroy();
  });

  it("replaceCurrent 空串只删除当前匹配", () => {
    const view = makeViewWithSearch("foo foo foo", plainOpts("foo"));
    expect(() => replaceCurrent(view, "")).not.toThrow();
    expect(view.state.doc.textContent).toBe(" foo foo");
    view.destroy();
  });
});

describe("replaceCurrent 替换当前匹配", () => {
  it("仅替换当前选中的匹配项，其余保留", () => {
    const view = makeViewWithSearch("foo foo foo", plainOpts("foo"));
    replaceCurrent(view, "BAR");
    // 默认 current=0，替换第一个
    expect(view.state.doc.textContent).toBe("BAR foo foo");
    view.destroy();
  });
});

describe("DecorationSet 缓存（#151：无关 transaction 不重建装饰）", () => {
  it("同一搜索状态重复取装饰返回同一实例", () => {
    const plugin = searchPlugin();
    const view = makeViewWithSearch("foo foo foo", plainOpts("foo"), plugin);
    const decorations = decorationsOf(plugin);
    const d1 = decorations(view.state);
    const d2 = decorations(view.state);
    expect(d1).toBe(d2);
    expect(d1).not.toBe(DecorationSet.empty);
    view.destroy();
  });

  it("与搜索无关的选区变化复用缓存（不重建）", () => {
    const plugin = searchPlugin();
    const view = makeViewWithSearch("hello world foo", plainOpts("foo"), plugin);
    const decorations = decorationsOf(plugin);
    const before = decorations(view.state);
    // 仅移动选区：不改文档、不触发搜索元信息
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 3)));
    const after = decorations(view.state);
    expect(after).toBe(before);
    view.destroy();
  });

  it("文档变化后重建装饰并反映新位置", () => {
    const plugin = searchPlugin();
    const view = makeViewWithSearch("foo foo", plainOpts("foo"), plugin);
    const decorations = decorationsOf(plugin);
    const before = decorations(view.state);
    // 在段首插入文本，匹配位置整体后移（doc 根下 paragraph 的正文从位置 1 起）
    view.dispatch(view.state.tr.insertText("xx ", 1));
    const after = decorations(view.state);
    expect(after).not.toBe(before);
    const found = after.find();
    expect(found.length).toBe(2);
    expect(found[0].from).toBe(4);
    expect(found[0].to).toBe(7);
    expect(decoClass(found[0])).toBe("search-match-current");
    expect(found[1].from).toBe(8);
    expect(found[1].to).toBe(11);
    expect(decoClass(found[1])).toBe("search-match");
    view.destroy();
  });

  it("next 导航改变当前匹配后重建装饰（当前高亮移动）", () => {
    const plugin = searchPlugin();
    const view = makeViewWithSearch("foo foo", plainOpts("foo"), plugin);
    const decorations = decorationsOf(plugin);
    const before = decorations(view.state);
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    const after = decorations(view.state);
    expect(after).not.toBe(before);
    // current 从第 1 个匹配（位置 1）移到第 2 个（位置 5）
    const current = after
      .find()
      .filter((d) => decoClass(d) === "search-match-current")
      .map((d) => d.from);
    expect(current).toEqual([5]);
    view.destroy();
  });

  it("clear 后装饰为空（#185 插件侧）", () => {
    const plugin = searchPlugin();
    const view = makeViewWithSearch("foo foo", plainOpts("foo"), plugin);
    const decorations = decorationsOf(plugin);
    expect(decorations(view.state)).not.toBe(DecorationSet.empty);
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "clear" }));
    expect(decorations(view.state)).toBe(DecorationSet.empty);
    view.destroy();
  });
});

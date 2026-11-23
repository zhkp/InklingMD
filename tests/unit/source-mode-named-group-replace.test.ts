// 源码模式替换引用口径（issue #428）
// CM 的 RegExpQuery.getReplacement 只认 `$n` / `$&` / `$$`，`$<name>` 整串原样返回，
// 于是同一份文档、同一个查找正则与替换串，源码模式与 WYSIWYG 结果不同。
// 这里用真实 CM EditorView + 真实 CM 替换命令（面板按钮 / Mod-r 走的同一条路径）
// 验证源码模式与 WYSIWYG 逐字一致。

import { describe, it, expect, afterEach } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  getSearchQuery,
  replaceAll as cmReplaceAll,
  replaceNext as cmReplaceNext,
  search,
  setSearchQuery,
} from "@codemirror/search";
import { Schema } from "@milkdown/kit/prose/model";
import {
  EditorState as PmEditorState,
  TextSelection,
} from "@milkdown/kit/prose/state";
import {
  EditorView as PmEditorView,
} from "@milkdown/kit/prose/view";
import {
  searchKey,
  searchPlugin,
  replaceAll as wysiwygReplaceAll,
  replaceCurrent as wysiwygReplaceCurrent,
} from "../../src/components/Editor/search";
import { namedGroupReplacementSupport } from "../../src/lib/source-mode-search";

interface SourceQuery {
  search: string;
  replace: string;
  regexp?: boolean;
  caseSensitive?: boolean;
}

/** 带命名组替换扩展的源码模式编辑器（等价于 createSourceModeExtensions 的搜索部分） */
function makeSourceView(doc: string, query: SourceQuery): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [search(), namedGroupReplacementSupport()],
    }),
  });
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery(query)) });
  return view;
}

/** WYSIWYG 侧同构视图（与 tests/unit/search.test.ts 的脚手架一致） */
function makeWysiwygView(doc: string, query: SourceQuery): PmEditorView {
  const schema = new Schema({
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
  const paragraph = schema.nodes.paragraph.create(null, schema.text(doc));
  const root = schema.nodes.doc.create(null, [paragraph]);
  const state = PmEditorState.create({
    doc: root,
    selection: TextSelection.create(root, 1),
    plugins: [searchPlugin()],
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new PmEditorView(host, { state });
  view.dispatch(
    view.state.tr.setMeta(searchKey, {
      type: "set",
      opts: {
        find: query.search,
        caseSensitive: query.caseSensitive ?? false,
        useRegex: query.regexp ?? false,
      },
    }),
  );
  return view;
}

const NAMED: SourceQuery = {
  search: "(?<word>\\w+)-(?<num>\\d+)",
  regexp: true,
  replace: "$<num>:$<word>",
};

/** issue 表格里的原始场景：源码模式必须得到 `12:alpha`，不能是字面量 */
describe("源码模式命名组替换（#428）", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("全部替换把 $<name> 展开为捕获文本", () => {
    const view = makeSourceView("alpha-12 beta-34", NAMED);
    expect(cmReplaceAll(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("12:alpha 34:beta");
    view.destroy();
  });

  it("替换当前把 $<name> 展开为捕获文本", () => {
    const view = makeSourceView("alpha-12 beta-34", NAMED);
    // 选中首个匹配，replaceNext 才会就地替换（与面板「replace」按钮同路径）
    view.dispatch({ selection: EditorSelection.range(0, 8) });
    expect(cmReplaceNext(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("12:alpha beta-34");
    view.destroy();
  });

  it("面板回显不被改写：state 里的 replace 仍是用户输入的 $<name>", () => {
    const view = makeSourceView("alpha-12", NAMED);
    expect(getSearchQuery(view.state).replace).toBe("$<num>:$<word>");
    expect(getSearchQuery(view.state).search).toBe(NAMED.search);
    view.destroy();
  });

  it("$$<name> 得到字面量 $<name>，不二次展开", () => {
    const view = makeSourceView("alpha-12", { ...NAMED, replace: "$$<num>" });
    cmReplaceAll(view);
    expect(view.state.doc.toString()).toBe("$<num>");
    view.destroy();
  });

  it("已定义但未参与匹配的命名组展开为空串", () => {
    const view = makeSourceView("b", {
      search: "(?<name>a)?b",
      regexp: true,
      replace: "[$<name>]",
    });
    cmReplaceAll(view);
    expect(view.state.doc.toString()).toBe("[]");
    view.destroy();
  });

  it("未知命名组与原型链名称保留字面量", () => {
    const view = makeSourceView("a", {
      search: "(?<name>a)",
      regexp: true,
      replace: "$<missing>|$<toString>|$<constructor>|$<__proto__>|$<name>",
    });
    cmReplaceAll(view);
    expect(view.state.doc.toString()).toBe(
      "$<missing>|$<toString>|$<constructor>|$<__proto__>|a",
    );
    view.destroy();
  });

  it("正则无命名组时 $<name> 保持字面量，$1/$&/$$ 口径不变", () => {
    const view = makeSourceView("foo", {
      search: "foo",
      regexp: true,
      replace: "$1-$&-$$-$2-$01-$<name>",
    });
    cmReplaceAll(view);
    expect(view.state.doc.toString()).toBe("$1-foo-$-$2-$01-$<name>");
    view.destroy();
  });

  it("非正则查找不展开任何 $ 引用（与原口径一致）", () => {
    const view = makeSourceView("foo", {
      search: "foo",
      regexp: false,
      replace: "$<name>-$&",
    });
    cmReplaceAll(view);
    expect(view.state.doc.toString()).toBe("$<name>-$&");
    view.destroy();
  });

  it("替换串里的 \\n 转义仍被解成换行", () => {
    const view = makeSourceView("alpha-12", { ...NAMED, replace: "$<num>\\nX" });
    cmReplaceAll(view);
    expect(view.state.doc.toString()).toBe("12\nX");
    view.destroy();
  });
});

/** 验收标准：同一场景两模式逐字一致 */
describe("两模式替换结果逐字一致（#428 验收）", () => {
  const CASES: Array<{ doc: string; query: SourceQuery; label: string }> = [
    {
      doc: "alpha-12 beta-34",
      query: NAMED,
      label: "命名组交叉引用",
    },
    {
      doc: "alpha-12",
      query: { ...NAMED, replace: "$$<num>-$<missing>-$&" },
      label: "转义与未知名称混合",
    },
    {
      doc: "ab b",
      query: { search: "(?<name>a)?b", regexp: true, replace: "[$<name>]" },
      label: "命名组未参与匹配",
    },
    {
      doc: "ab b",
      query: { search: "(?<name>a)?b", regexp: true, replace: "$<name>" },
      label: "展开为空串时删除匹配",
    },
    {
      doc: "foo bar",
      query: { search: "foo", regexp: true, replace: "$1-$<n>-$&" },
      label: "无命名组的正则",
    },
  ];

  for (const { doc, query, label } of CASES) {
    it(label, () => {
      const source = makeSourceView(doc, query);
      cmReplaceAll(source);
      const sourceText = source.state.doc.toString();
      source.destroy();

      const wysiwyg = makeWysiwygView(doc, query);
      wysiwygReplaceAll(wysiwyg, query.replace);
      const wysiwygText = wysiwyg.state.doc.textContent;
      wysiwyg.destroy();

      expect(sourceText).toBe(wysiwygText);
    });
  }
});

/** 替换当前与 WYSIWYG replaceCurrent 对齐（首个匹配） */
describe("替换当前与 WYSIWYG 对齐（#428）", () => {
  it("首个匹配两模式一致", () => {
    const query: SourceQuery = { ...NAMED, replace: "$<word>/$<num>" };

    const source = makeSourceView("alpha-12 beta-34", query);
    source.dispatch({ selection: EditorSelection.range(0, 8) });
    cmReplaceNext(source);
    const sourceText = source.state.doc.toString();
    source.destroy();

    const wysiwyg = makeWysiwygView("alpha-12 beta-34", query);
    wysiwygReplaceCurrent(wysiwyg, query.replace);
    const wysiwygText = wysiwyg.state.doc.textContent;
    wysiwyg.destroy();

    expect(sourceText).toBe(wysiwygText);
  });
});

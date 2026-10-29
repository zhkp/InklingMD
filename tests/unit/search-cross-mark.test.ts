// #371 跨行内样式（跨 mark）查找与替换测试
//
// 背景：ProseMirror 按 mark 边界把一段连续文字切成多个文本节点，
// 旧实现逐文本节点跑正则，`**Hello** world` 搜 `Hello world` 找不到。
// 修复后：以**文本块**为单位把相邻文本节点拼成 run 再匹配，
// 行内原子节点（图片/硬换行）与块级节点都是匹配边界。
//
// 验证口径：不只看匹配数量，还断言文档位置、textBetween 实际文本、
// Decoration 区间与类名、替换后的文本与 mark 结构、增量更新与全量重算等价。

import { describe, it, expect, vi, afterEach } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView, Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import {
  searchKey,
  searchPlugin,
  replaceAll,
  replaceCurrent,
  type SearchOpts,
} from "../../src/components/Editor/search";

/** 带 mark 与行内原子节点的 schema（贴近真实 Milkdown 结构的最小可用子集） */
function makeSchema() {
  return new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: {
        group: "block",
        content: "inline*",
        toDOM: () => ["p", 0],
        parseDOM: [{ tag: "p" }],
      },
      heading: {
        group: "block",
        content: "inline*",
        toDOM: () => ["h1", 0],
        parseDOM: [{ tag: "h1" }],
      },
      blockquote: {
        group: "block",
        content: "block+",
        toDOM: () => ["blockquote", 0],
        parseDOM: [{ tag: "blockquote" }],
      },
      image: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { src: { default: "" } },
        toDOM: () => ["img"],
        parseDOM: [{ tag: "img" }],
      },
      hard_break: {
        group: "inline",
        inline: true,
        atom: true,
        toDOM: () => ["br"],
        parseDOM: [{ tag: "br" }],
      },
      text: { group: "inline" },
    },
    marks: {
      strong: { toDOM: () => ["strong", 0], parseDOM: [{ tag: "strong" }] },
      em: { toDOM: () => ["em", 0], parseDOM: [{ tag: "em" }] },
      link: {
        attrs: { href: { default: "" } },
        toDOM: (m) => ["a", { href: m.attrs.href }, 0],
        parseDOM: [{ tag: "a" }],
      },
      code: { toDOM: () => ["code", 0], parseDOM: [{ tag: "code" }] },
    },
  });
}

type TestSchema = ReturnType<typeof makeSchema>;

/** 文本节点；marks 传 mark 名（link 自动带 href） */
function t(schema: TestSchema, text: string, ...marks: string[]): PMNode {
  return schema.text(
    text,
    marks.map((m) =>
      m === "link" ? schema.marks.link.create({ href: "https://example.com" }) : schema.marks[m].create(),
    ),
  );
}

function para(schema: TestSchema, ...children: PMNode[]): PMNode {
  return schema.nodes.paragraph.create(null, children);
}

function heading(schema: TestSchema, ...children: PMNode[]): PMNode {
  return schema.nodes.heading.create(null, children);
}

function quote(schema: TestSchema, ...blocks: PMNode[]): PMNode {
  return schema.nodes.blockquote.create(null, blocks);
}

function makeView(doc: PMNode, opts: SearchOpts, plugin = searchPlugin()): EditorView {
  // 不显式给 selection：块级容器（blockquote）开头没有合法文本位置，
  // 交给 EditorState 默认 Selection.atStart(doc) 自行定位
  const state = EditorState.create({ doc, plugins: [plugin] });
  const root = document.createElement("div");
  document.body.appendChild(root);
  const view = new EditorView(root, { state });
  view.dispatch(view.state.tr.setMeta(searchKey, { type: "set", opts }));
  return view;
}

const plainOpts = (find: string): SearchOpts => ({ find, caseSensitive: false, useRegex: false });
const csOpts = (find: string): SearchOpts => ({ find, caseSensitive: true, useRegex: false });
const reOpts = (find: string): SearchOpts => ({ find, caseSensitive: false, useRegex: true });

function matchesOf(view: EditorView) {
  return searchKey.getState(view.state)!.matches;
}

function decorationsOf(plugin: ReturnType<typeof searchPlugin>) {
  return plugin.props.decorations as (state: EditorState) => DecorationSet;
}

function decoClass(d: Decoration): string | undefined {
  return (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class;
}

/** 段落文本 + mark 结构快照：[[文本, mark 名集合], ...]，用于断言替换没吃掉无关样式 */
function markStructure(block: PMNode): [string, string[]][] {
  const out: [string, string[]][] = [];
  block.forEach((child) => {
    if (!child.isText) {
      out.push([`<${child.type.name}>`, []]);
      return;
    }
    out.push([child.text ?? "", child.marks.map((m) => m.type.name).sort()]);
  });
  return out;
}

/**
 * 测试内独立实现的全量扫描（与插件代码路径无关），作为地面真值：
 * 按文本块拼接相邻文本节点为 run，非文本行内节点与块级节点都是边界。
 */
function groundTruth(doc: PMNode, opts: SearchOpts): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let pattern = opts.find;
  if (!opts.useRegex) pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(pattern, opts.caseSensitive ? "g" : "gi");

  const scanBlock = (block: PMNode, blockPos: number) => {
    let text = "";
    let runPos = -1;
    const flush = () => {
      if (runPos < 0) return;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        out.push({ from: runPos + m.index, to: runPos + m.index + m[0].length });
      }
      text = "";
      runPos = -1;
    };
    block.forEach((child, offset) => {
      if (child.isText) {
        if (runPos < 0) runPos = blockPos + 1 + offset;
        text += child.text;
      } else {
        flush();
      }
    });
    flush();
  };

  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (!node.isTextblock) return true;
    scanBlock(node, pos);
    return false;
  });
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#371 跨 mark 匹配（issue 原始复现）", () => {
  it("`**Hello** world` 搜 `Hello world`：命中 1 处，位置与实际文本正确", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "Hello", "strong"), t(s, " world"))]),
      plainOpts("Hello world"),
    );
    const ms = matchesOf(view);
    expect(ms).toHaveLength(1);
    // 段落正文从位置 1 起：**Hello** 占 1..6，" world" 占 6..12
    expect(ms[0]).toEqual({ from: 1, to: 12 });
    expect(view.state.doc.textBetween(ms[0].from, ms[0].to)).toBe("Hello world");
    view.destroy();
  });

  it("跨越 3 个以上 mark 边界仍能命中（strong/em/link 混排）", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "a", "strong"), t(s, "b", "em"), t(s, "c"), t(s, "d", "link"), t(s, "e", "strong")),
      ]),
      plainOpts("abcde"),
    );
    const ms = matchesOf(view);
    expect(ms).toHaveLength(1);
    expect(view.state.doc.textBetween(ms[0].from, ms[0].to)).toBe("abcde");
    expect(ms).toEqual(groundTruth(view.state.doc, plainOpts("abcde")));
    view.destroy();
  });

  it("行内代码（code mark）不是边界：`Hello` world 搜 `Hello world` 命中", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "Hello", "code"), t(s, " world"))]),
      plainOpts("Hello world"),
    );
    const ms = matchesOf(view);
    expect(ms).toHaveLength(1);
    expect(view.state.doc.textBetween(ms[0].from, ms[0].to)).toBe("Hello world");
    view.destroy();
  });

  it("同一 mark 名多次交替（**foo** bar **foo**）：整串与单词各自命中数正确", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "foo", "strong"), t(s, " bar "), t(s, "foo", "strong"), t(s, " baz")),
    ]);
    const whole = makeView(doc, plainOpts("foo bar foo"));
    expect(matchesOf(whole)).toHaveLength(1);
    expect(whole.state.doc.textBetween(matchesOf(whole)[0].from, matchesOf(whole)[0].to)).toBe(
      "foo bar foo",
    );
    whole.destroy();

    const word = makeView(doc, plainOpts("foo"));
    expect(matchesOf(word)).toHaveLength(2);
    expect(matchesOf(word)).toEqual(groundTruth(doc, plainOpts("foo")));
    word.destroy();
  });

  it("大小写开关跨 mark 生效：不敏感命中、敏感不命中", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "HeLLo", "strong"), t(s, " WoRLD")),
    ]);
    const insensitive = makeView(doc, plainOpts("hello world"));
    expect(matchesOf(insensitive)).toHaveLength(1);
    expect(insensitive.state.doc.textBetween(matchesOf(insensitive)[0].from, matchesOf(insensitive)[0].to)).toBe(
      "HeLLo WoRLD",
    );
    insensitive.destroy();

    const sensitive = makeView(doc, csOpts("hello world"));
    expect(matchesOf(sensitive)).toHaveLength(0);
    sensitive.destroy();

    const sensitiveHit = makeView(doc, csOpts("HeLLo WoRLD"));
    expect(matchesOf(sensitiveHit)).toHaveLength(1);
    sensitiveHit.destroy();
  });

  it("正则跨 mark 生效（含贪婪匹配跨过 mark 边界）", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "Hel", "strong"), t(s, "lo12 xyz"))]),
      reOpts("Hel.*12"),
    );
    const ms = matchesOf(view);
    expect(ms).toHaveLength(1);
    expect(view.state.doc.textBetween(ms[0].from, ms[0].to)).toBe("Hello12");
    view.destroy();
  });

  it("嵌套容器（blockquote 内段落）内部照样跨 mark 命中", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [quote(s, para(s, t(s, "Hello", "em"), t(s, " world")))]),
      plainOpts("Hello world"),
    );
    const ms = matchesOf(view);
    expect(ms).toHaveLength(1);
    expect(view.state.doc.textBetween(ms[0].from, ms[0].to)).toBe("Hello world");
    view.destroy();
  });

  it("Decoration 覆盖整个跨 mark 区间，当前匹配带 current 类", () => {
    const s = makeSchema();
    const plugin = searchPlugin();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "Hello", "strong"), t(s, " world"))]),
      plainOpts("Hello world"),
      plugin,
    );
    const decos = decorationsOf(plugin)(view.state).find();
    expect(decos).toHaveLength(1);
    expect(decos[0].from).toBe(1);
    expect(decos[0].to).toBe(12);
    expect(decoClass(decos[0])).toBe("search-match-current");
    view.destroy();
  });

  it("跨 mark 匹配不产生重复/重叠计数（与独立全量扫描逐一相等）", () => {
    const s = makeSchema();
    const opts = plainOpts("o w");
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "foo", "strong"), t(s, " world")),
      heading(s, t(s, "foo", "em"), t(s, " world")),
      para(s, t(s, "no match here")),
      quote(s, para(s, t(s, "foo", "link"), t(s, " world"))),
    ]);
    const view = makeView(doc, opts);
    expect(matchesOf(view)).toHaveLength(3);
    expect(matchesOf(view)).toEqual(groundTruth(doc, opts));
    for (const m of matchesOf(view)) {
      expect(view.state.doc.textBetween(m.from, m.to)).toBe("o w");
    }
    view.destroy();
  });
});

describe("#371 边界：块级节点是匹配边界（不跨段落/标题/引用）", () => {
  it("相邻两段 `Hello` / `world` 不合成 `Hello world`", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [para(s, t(s, "Hello")), para(s, t(s, "world"))]);
    const view = makeView(doc, plainOpts("Hello world"));
    expect(matchesOf(view)).toHaveLength(0);
    view.destroy();
    // 各自仍能命中
    const hello = makeView(doc, plainOpts("Hello"));
    expect(matchesOf(hello)).toHaveLength(1);
    hello.destroy();
    const world = makeView(doc, plainOpts("world"));
    expect(matchesOf(world)).toHaveLength(1);
    world.destroy();
  });

  it("标题与段落之间不跨界匹配", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [heading(s, t(s, "Hello")), para(s, t(s, "world"))]);
    const view = makeView(doc, plainOpts("Hello world"));
    expect(matchesOf(view)).toHaveLength(0);
    view.destroy();
  });

  it("引用块内外不跨界匹配", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [quote(s, para(s, t(s, "Hello"))), para(s, t(s, "world"))]);
    const view = makeView(doc, plainOpts("Hello world"));
    expect(matchesOf(view)).toHaveLength(0);
    view.destroy();
  });

  it("跨块拼接文本不会误命中（textContent 相连但文档上不相邻）", () => {
    const s = makeSchema();
    // textContent 为 "Hello world"，但分属两个文本块
    const doc = s.nodes.doc.create(null, [para(s, t(s, "Hello ")), para(s, t(s, "world"))]);
    expect(doc.textContent).toBe("Hello world");
    const view = makeView(doc, plainOpts("Hello world"));
    expect(matchesOf(view)).toHaveLength(0);
    view.destroy();
  });
});

describe("#371 边界：行内原子节点打断连续文本", () => {
  it("图片两侧的文字不被拼成一个匹配", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "Hello"), s.nodes.image.create({ src: "a.png" }), t(s, "world")),
    ]);
    const view = makeView(doc, plainOpts("Hello world"));
    expect(matchesOf(view)).toHaveLength(0);
    view.destroy();
    // 两侧各自可命中
    const hello = makeView(doc, plainOpts("Hello"));
    expect(matchesOf(hello)).toHaveLength(1);
    hello.destroy();
    const world = makeView(doc, plainOpts("world"));
    expect(matchesOf(world)).toHaveLength(1);
    world.destroy();
  });

  it("硬换行两侧的文字不被拼成一个匹配", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "Hello"), s.nodes.hard_break.create(), t(s, "world")),
    ]);
    const joined = makeView(doc, plainOpts("Hello world"));
    expect(matchesOf(joined)).toHaveLength(0);
    joined.destroy();
    const halves = makeView(doc, reOpts("Hello|world"));
    expect(matchesOf(halves)).toHaveLength(2);
    halves.destroy();
  });

  it("原子节点在前时，其后跨 mark 匹配的位置映射仍正确", () => {
    const s = makeSchema();
    // 段内：image(nodeSize 1) + **Hello** + " world" → run 首字符在位置 2
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, s.nodes.image.create({ src: "a.png" }), t(s, "Hello", "strong"), t(s, " world")),
      ]),
      plainOpts("Hello world"),
    );
    const ms = matchesOf(view);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toEqual({ from: 2, to: 13 });
    expect(view.state.doc.textBetween(ms[0].from, ms[0].to)).toBe("Hello world");
    view.destroy();
  });

  it("原子节点夹在 mark 之间时前后两段各自成 run", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "ab", "strong"), t(s, "cd"), s.nodes.image.create(), t(s, "ef", "em"), t(s, "gh")),
    ]);
    const view = makeView(doc, plainOpts("abcd"));
    expect(matchesOf(view)).toHaveLength(1);
    expect(view.state.doc.textBetween(matchesOf(view)[0].from, matchesOf(view)[0].to)).toBe("abcd");
    view.destroy();

    const view2 = makeView(doc, plainOpts("efgh"));
    expect(matchesOf(view2)).toHaveLength(1);
    expect(view2.state.doc.textBetween(matchesOf(view2)[0].from, matchesOf(view2)[0].to)).toBe("efgh");
    view2.destroy();

    // 跨越图片的 cdef 不命中
    const view3 = makeView(doc, plainOpts("cdef"));
    expect(matchesOf(view3)).toHaveLength(0);
    view3.destroy();
  });
});

describe("#371 跨 mark 替换", () => {
  it("replaceCurrent 跨 mark 替换：文本被替换，段落结构保留", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "Hello", "strong"), t(s, " world"))]),
      plainOpts("Hello world"),
    );
    replaceCurrent(view, "Hi");
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("Hi");
    expect(markStructure(view.state.doc.child(0))).toEqual([["Hi", []]]);
    view.destroy();
  });

  it("替换不丢失匹配区间之外的 mark（em 前缀 / link 后缀原样保留）", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "前缀 ", "em"), t(s, "Hello", "strong"), t(s, " world"), t(s, " 后缀", "link")),
      ]),
      plainOpts("Hello world"),
    );
    expect(matchesOf(view)).toHaveLength(1);
    replaceCurrent(view, "Hi");
    expect(view.state.doc.child(0).textContent).toBe("前缀 Hi 后缀");
    expect(markStructure(view.state.doc.child(0))).toEqual([
      ["前缀 ", ["em"]],
      ["Hi", []],
      [" 后缀", ["link"]],
    ]);
    view.destroy();
  });

  it("匹配完全落在一段 mark 内：替换串不带 mark，前后原文样式不动（文档化的继承规则）", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "Hello", "strong"), t(s, " world", "em"))]),
      plainOpts("ell"),
    );
    expect(matchesOf(view)).toHaveLength(1);
    replaceCurrent(view, "X");
    expect(view.state.doc.child(0).textContent).toBe("HXo world");
    // 被替换掉的中段随原文一起消失，替换串按无 mark 插入；区间外样式不受影响
    expect(markStructure(view.state.doc.child(0))).toEqual([
      ["H", ["strong"]],
      ["X", []],
      ["o", ["strong"]],
      [" world", ["em"]],
    ]);
    view.destroy();
  });

  it("replaceAll 只替换命中文本，同一块内其余文本的 mark 原样保留", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "前缀", "strong"), t(s, "foo", "em"), t(s, "后缀", "strong")),
      ]),
      plainOpts("foo"),
    );
    expect(replaceAll(view, "Q")).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("前缀Q后缀");
    expect(markStructure(view.state.doc.child(0))).toEqual([
      ["前缀", ["strong"]],
      ["Q", []],
      ["后缀", ["strong"]],
    ]);
    view.destroy();
  });

  it("替换只影响命中的那一段，其余段落文本与结构不变", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "keep ", "strong"), t(s, "me")),
        para(s, t(s, "Hello", "strong"), t(s, " world")),
        para(s, t(s, "tail ", "em"), t(s, "here")),
      ]),
      plainOpts("Hello world"),
    );
    replaceCurrent(view, "Hi");
    expect(view.state.doc.childCount).toBe(3);
    expect(markStructure(view.state.doc.child(0))).toEqual([["keep ", ["strong"]], ["me", []]]);
    expect(markStructure(view.state.doc.child(1))).toEqual([["Hi", []]]);
    expect(markStructure(view.state.doc.child(2))).toEqual([["tail ", ["em"]], ["here", []]]);
    view.destroy();
  });

  it("replaceAll 跨 mark 多匹配：全部替换且返回数量", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "foo", "strong"), t(s, " bar")),
        para(s, t(s, "foo", "em"), t(s, " bar")),
        para(s, t(s, "untouched")),
      ]),
      plainOpts("foo bar"),
    );
    expect(matchesOf(view)).toHaveLength(2);
    const n = replaceAll(view, "Q");
    expect(n).toBe(2);
    expect(view.state.doc.child(0).textContent).toBe("Q");
    expect(view.state.doc.child(1).textContent).toBe("Q");
    expect(view.state.doc.child(2).textContent).toBe("untouched");
    view.destroy();
  });

  it("replaceAll 跨 mark 替换为更长文本时位置不错乱", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "a", "strong"), t(s, "b")),
        para(s, t(s, "a", "strong"), t(s, "b")),
        para(s, t(s, "a", "strong"), t(s, "b")),
      ]),
      plainOpts("ab"),
    );
    const n = replaceAll(view, "XYZ");
    expect(n).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(view.state.doc.child(i).textContent).toBe("XYZ");
      expect(markStructure(view.state.doc.child(i))).toEqual([["XYZ", []]]);
    }
    view.destroy();
  });

  it("空串跨 mark 删除（#178 语义在跨 mark 下同样成立）", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "Hello", "strong"), t(s, " world"))]),
      plainOpts("Hello world"),
    );
    expect(() => replaceCurrent(view, "")).not.toThrow();
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.child(0).textContent).toBe("");
    view.destroy();
  });

  it("replaceAll 空串跨 mark 删除全部匹配", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "x", "strong"), t(s, "y")),
        para(s, t(s, "x", "em"), t(s, "y")),
      ]),
      plainOpts("xy"),
    );
    const n = replaceAll(view, "");
    expect(n).toBe(2);
    expect(view.state.doc.child(0).textContent).toBe("");
    expect(view.state.doc.child(1).textContent).toBe("");
    view.destroy();
  });

  it("正则跨 mark 替换（替换串按字面插入，不做 $1 展开——#380 不在本 Epic 范围）", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "ab", "strong"), t(s, "cd"))]),
      reOpts("(ab)(cd)"),
    );
    expect(matchesOf(view)).toHaveLength(1);
    replaceCurrent(view, "$1");
    expect(view.state.doc.child(0).textContent).toBe("$1");
    view.destroy();
  });

  it("替换后搜索状态与新文档同步（跨 mark 匹配被消费掉）", () => {
    const s = makeSchema();
    const view = makeView(
      s.nodes.doc.create(null, [para(s, t(s, "foo", "strong"), t(s, " bar"))]),
      plainOpts("foo bar"),
    );
    replaceCurrent(view, "Q");
    expect(matchesOf(view)).toHaveLength(0);
    expect(searchKey.getState(view.state)!.current).toBe(-1);
    view.destroy();
  });
});

describe("#371 导航与当前高亮（跨 mark）", () => {
  it("next/prev 在跨 mark 匹配间循环，current 装饰区间等于 matches[current]", () => {
    const s = makeSchema();
    const plugin = searchPlugin();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "foo", "strong"), t(s, " bar")),
        para(s, t(s, "foo", "em"), t(s, " bar")),
      ]),
      plainOpts("foo bar"),
      plugin,
    );
    const decorations = decorationsOf(plugin);
    expect(matchesOf(view)).toHaveLength(2);

    const currentFrom = () =>
      decorations(view.state)
        .find()
        .filter((d) => decoClass(d) === "search-match-current")
        .map((d) => [d.from, d.to]);

    expect(currentFrom()).toEqual([[matchesOf(view)[0].from, matchesOf(view)[0].to]]);
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    expect(searchKey.getState(view.state)!.current).toBe(1);
    expect(currentFrom()).toEqual([[matchesOf(view)[1].from, matchesOf(view)[1].to]]);
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    expect(searchKey.getState(view.state)!.current).toBe(0);
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "prev" }));
    expect(searchKey.getState(view.state)!.current).toBe(1);
    view.destroy();
  });
});

describe("#371 增量更新（#192 优化在跨 mark 下仍成立）", () => {
  /** 第 index 个段落正文起始位置（每段 nodeSize = 1 + 6 + 5 + 1 = 13） */
  const paraTextStart = (index: number) => 1 + index * 13;

  it("200 段跨 mark 文档中段内输入：正则扫描只触及变更块，不全文重扫", () => {
    const s = makeSchema();
    const blocks = Array.from({ length: 200 }, () =>
      para(s, t(s, "NEEDLE", "strong"), t(s, " tail")),
    );
    const plugin = searchPlugin();
    const view = makeView(s.nodes.doc.create(null, blocks), plainOpts("NEEDLE tail"), plugin);
    expect(matchesOf(view)).toHaveLength(200);

    const execSpy = vi.spyOn(RegExp.prototype, "exec");
    // 在第 100 段的 " tail" 里插入字符：单步事务走增量路径
    view.dispatch(view.state.tr.insertText("XYZ", paraTextStart(100) + 8));

    // 窗口只扩到该文本块：exec 调用次数与文档规模解耦（全文重扫为 200+ 次）
    expect(execSpy.mock.calls.length).toBeLessThan(20);
    expect(matchesOf(view)).toHaveLength(199);
    view.destroy();
  });

  it("跨 mark 匹配的增量结果与全量重算逐一相等（插入/删除/跨 mark 边界编辑）", () => {
    const s = makeSchema();
    const build = () =>
      s.nodes.doc.create(null, [
        para(s, t(s, "foo", "strong"), t(s, " bar")),
        para(s, t(s, "plain text")),
        para(s, t(s, "foo", "em"), t(s, " bar baz")),
      ]);
    const opts = plainOpts("foo bar");

    // 基线
    const base = makeView(build(), opts);
    expect(matchesOf(base)).toEqual(groundTruth(build(), opts));
    expect(matchesOf(base)).toHaveLength(2);
    base.destroy();

    // 在第 2 段插入文本（窗外匹配平移，跨 mark 匹配不受影响）
    // 段 1 nodeSize = 1+3+4+1 = 9 → 段 2 正文从位置 10 起
    const v1 = makeView(build(), opts);
    v1.dispatch(v1.state.tr.insertText("zz ", 13));
    expect(matchesOf(v1)).toEqual(groundTruth(v1.state.doc, opts));
    expect(matchesOf(v1)).toHaveLength(2);
    v1.destroy();

    // 在跨 mark 边界处插入字符，使第一个匹配失效
    const v2 = makeView(build(), opts);
    const m0 = matchesOf(v2)[0];
    v2.dispatch(v2.state.tr.insertText("X", m0.from + 2));
    expect(v2.state.doc.child(0).textContent).toBe("foXo bar");
    expect(matchesOf(v2)).toEqual(groundTruth(v2.state.doc, opts));
    expect(matchesOf(v2)).toHaveLength(1);
    v2.destroy();

    // 删除跨 mark 匹配的后半段
    const v3 = makeView(build(), opts);
    const m1 = matchesOf(v3)[1];
    v3.dispatch(v3.state.tr.delete(m1.from, m1.to));
    expect(matchesOf(v3)).toEqual(groundTruth(v3.state.doc, opts));
    expect(matchesOf(v3)).toHaveLength(1);
    v3.destroy();
  });

  it("同一段内两处跨 mark 匹配、编辑其一：窗口按文本块整体重扫，不产生重复匹配", () => {
    const s = makeSchema();
    const plugin = searchPlugin();
    // 单段内两处 `foo bar`，第一处前半带 strong。
    // 若增量窗口只扩到**变更的文本节点**（插入点所在的 "foo"），第二处匹配
    // 会同时作为「窗外」被平移保留、又作为「窗内」被重扫出来 → 重复计数与重叠装饰。
    const doc = s.nodes.doc.create(null, [para(s, t(s, "foo", "strong"), t(s, " bar foo bar"))]);
    const view = makeView(doc, plainOpts("foo bar"), plugin);
    expect(matchesOf(view)).toEqual([
      { from: 1, to: 8 },
      { from: 9, to: 16 },
    ]);

    // 在第一处匹配的 strong run 内插入一个字符：第一处失效，第二处仅平移
    view.dispatch(view.state.tr.insertText("X", 2));
    expect(view.state.doc.child(0).textContent).toBe("fXoo bar foo bar");

    const ms = matchesOf(view);
    expect(ms).toHaveLength(1);
    expect(ms).toEqual(groundTruth(view.state.doc, plainOpts("foo bar")));
    expect(ms[0]).toEqual({ from: 10, to: 17 });
    expect(
      decorationsOf(plugin)(view.state)
        .find()
        .map((d) => [d.from, d.to]),
    ).toEqual([[10, 17]]);
    view.destroy();
  });

  it("在当前匹配之前新增一处命中：current 跟着区间走，不会高亮到相邻的另一处", () => {
    const s = makeSchema();
    const plugin = searchPlugin();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "foo", "strong"), t(s, " bar")),
        para(s, t(s, "foo", "em"), t(s, " bar")),
      ]),
      plainOpts("foo bar"),
      plugin,
    );
    expect(matchesOf(view)).toHaveLength(2);
    // 当前匹配切到第 2 处（索引 1）
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    expect(searchKey.getState(view.state)!.current).toBe(1);
    const target = matchesOf(view)[1];
    expect(view.state.doc.textBetween(target.from, target.to)).toBe("foo bar");

    // 在第 1 段开头插入新的 `foo bar `：块内命中数从 1 变 2，
    // 原当前匹配整体后移，索引必须变成 2（沿用旧下标 1 会指到第 1 段的新命中）。
    view.dispatch(view.state.tr.insertText("foo bar ", 1));
    const state = searchKey.getState(view.state)!;
    expect(state.matches).toEqual(groundTruth(view.state.doc, plainOpts("foo bar")));
    expect(state.current).toBe(2);
    expect(state.matches[state.current]).toEqual({ from: 18, to: 25 });
    const currents = decorationsOf(plugin)(view.state)
      .find()
      .filter((d) => decoClass(d) === "search-match-current");
    expect(currents.map((d) => [d.from, d.to])).toEqual([[18, 25]]);
    view.destroy();
  });

  it("多步事务回退全量重算，跨 mark 结果正确", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "foo", "strong"), t(s, " bar")),
      para(s, t(s, "foo", "em"), t(s, " bar")),
    ]);
    const view = makeView(doc, plainOpts("foo bar"));
    // 一个事务内两步插入（非按键形态）→ 回退全量重算。
    // 第二个坐标已计入第一步插入的 1 个字符：段 1 nodeSize 9 → 段 2 正文起点 1+9+1=11
    const p0 = 1;
    const p1 = 1 + doc.child(0).nodeSize + 1;
    view.dispatch(view.state.tr.insertText("X", p0).insertText("Y", p1));
    expect(view.state.doc.child(0).textContent).toBe("Xfoo bar");
    expect(view.state.doc.child(1).textContent).toBe("Yfoo bar");
    expect(matchesOf(view)).toEqual(groundTruth(view.state.doc, plainOpts("foo bar")));
    expect(matchesOf(view)).toHaveLength(2);
    view.destroy();
  });

  it("增量修补路径下当前高亮类不丢失（跨 mark 当前匹配在窗外）", () => {
    const s = makeSchema();
    const plugin = searchPlugin();
    const view = makeView(
      s.nodes.doc.create(null, [
        para(s, t(s, "lead in text")),
        para(s, t(s, "foo", "strong"), t(s, " bar")),
      ]),
      plainOpts("foo bar"),
      plugin,
    );
    expect(matchesOf(view)).toHaveLength(1);
    // 在第 1 段（窗外）插入文本：增量修补路径
    view.dispatch(view.state.tr.insertText("zz ", 1));
    const decos = decorationsOf(plugin)(view.state).find();
    const currents = decos.filter((d) => decoClass(d) === "search-match-current");
    expect(currents).toHaveLength(1);
    const m = matchesOf(view)[0];
    expect(currents[0].from).toBe(m.from);
    expect(currents[0].to).toBe(m.to);
    expect(view.state.doc.textBetween(m.from, m.to)).toBe("foo bar");
    view.destroy();
  });

  it("整段删除（无文本块被窗口命中）不产生重复或幽灵匹配", () => {
    const s = makeSchema();
    const doc = s.nodes.doc.create(null, [
      para(s, t(s, "foo", "strong"), t(s, " bar")),
      para(s, t(s, "foo", "em"), t(s, " bar")),
    ]);
    const view = makeView(doc, plainOpts("foo bar"));
    expect(matchesOf(view)).toHaveLength(2);
    // 删除第 1 段整块（含块结束标记）
    view.dispatch(view.state.tr.delete(0, doc.child(0).nodeSize));
    expect(view.state.doc.childCount).toBe(1);
    expect(matchesOf(view)).toHaveLength(1);
    expect(matchesOf(view)).toEqual(groundTruth(view.state.doc, plainOpts("foo bar")));
    view.destroy();
  });
});

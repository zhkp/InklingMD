// #192 搜索增量更新测试
//
// 背景：searchPlugin 在 docChanged 时对全文重扫 + DecorationSet.create 全量
// 重建，大文档连续输入每键双倍全文开销。
// 修复后：单步事务（按键形态）走增量路径——窗外匹配经 tr.mapping 平移，
// 仅变更触及的文本节点重扫，装饰集经 DecorationSet.map 平移后局部修补。
//
// 验证：
// - 增量性：大文档（200 段、每段含匹配）中局部编辑时，正则扫描只触及
//   变更窗口（RegExp.prototype.exec 计数与文档规模解耦）
// - 正确性：插入/删除/跨段落编辑后匹配与装饰同全量重算结果一致
// - 多步事务回退全量、当前高亮类在增量修补中不丢失

import { describe, it, expect, vi, afterEach } from "vitest";
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
  opts: SearchOpts,
  plugin = searchPlugin(),
): EditorView {
  const schema = makeSchema();
  const doc = schema.nodes.doc.create(
    null,
    paragraphs.map((t) => schema.nodes.paragraph.create(null, t ? schema.text(t) : [])),
  );
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

function decorationsOf(plugin: ReturnType<typeof searchPlugin>) {
  return plugin.props.decorations as (state: EditorState) => DecorationSet;
}

function decoClass(d: Decoration): string | undefined {
  return (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#192 增量性：局部编辑不触发全文重扫", () => {
  it("200 段文档中段内输入，正则扫描只触及变更窗口", () => {
    // 每段一个 NEEDLE 匹配，共 200 个匹配；全文重扫会逐段执行正则
    const paras = Array.from({ length: 200 }, (_, i) => `para ${i} NEEDLE end`);
    const plugin = searchPlugin();
    const view = makeView(paras, plainOpts("NEEDLE"), plugin);
    expect(searchKey.getState(view.state)?.matches).toHaveLength(200);

    const execSpy = vi.spyOn(RegExp.prototype, "exec");
    // 在第 100 段（文档中部）插入几个字符：单步事务走增量路径
    view.dispatch(view.state.tr.insertText("XYZ", paraTextStart(view, 100) + 5));

    // 增量路径：扫描仅发生在变更段（~4 次以内：窗口文本节点的匹配迭代）；
    // 全文重扫则 ~200+ 次。用 20 作界，与文档规模解耦
    expect(execSpy.mock.calls.length).toBeLessThan(20);

    // 结果正确性不受增量影响：仍是 200 个匹配
    expect(searchKey.getState(view.state)?.matches).toHaveLength(200);
    view.destroy();
  });
});

/** 测试内独立实现的全量扫描（与插件代码路径无关），作为地面真值 */
function groundTruth(doc: EditorView["state"]["doc"], find: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const text = node.text ?? "";
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({ from: pos + m.index, to: pos + m.index + m[0].length });
    }
    return false;
  });
  return out;
}

/** 第 index 个段落内文本的起始文档位置（跳过块级开标记） */
function paraTextStart(view: EditorView, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += view.state.doc.child(i).nodeSize;
  return pos + 1;
}

describe("#192 增量更新正确性（增量结果 ≡ 全量重算）", () => {
  it("插入文本后窗外匹配平移、窗内匹配重扫", () => {
    const plugin = searchPlugin();
    const view = makeView(["foo one", "two foo", "three foo"], plainOpts("foo"), plugin);
    // 在第二段文本开头插入 "bar "
    view.dispatch(view.state.tr.insertText("bar ", paraTextStart(view, 1)));

    const s = searchKey.getState(view.state)!;
    expect(view.state.doc.textContent).toBe("foo onebar two foothree foo");
    expect(s.matches).toEqual(groundTruth(view.state.doc, "foo"));
    expect(s.matches).toHaveLength(3);
    // 装饰与匹配同构
    const decos = decorationsOf(plugin)(view.state).find();
    expect(decos).toHaveLength(3);
    view.destroy();
  });

  it("删除含匹配的文本后匹配消失，其余平移", () => {
    const view = makeView(["aa foo bb", "cc foo dd"], plainOpts("foo"));
    // 删除第一段中的 "foo "：位置从该段第一个匹配推导
    const m0 = searchKey.getState(view.state)!.matches[0];
    view.dispatch(view.state.tr.delete(m0.from, m0.to + 1));

    const s = searchKey.getState(view.state)!;
    expect(view.state.doc.textContent).toBe("aa bbcc foo dd");
    expect(s.matches).toEqual(groundTruth(view.state.doc, "foo"));
    expect(s.matches).toHaveLength(1);
    view.destroy();
  });

  it("在匹配中间输入使该匹配失效，补回文本产生新匹配也能捕获", () => {
    const view = makeView(["hello NEEDLE world"], plainOpts("NEEDLE"));
    expect(searchKey.getState(view.state)?.matches).toHaveLength(1);
    // 在第一个匹配内部插入 "X"：NEEDXLE 不再匹配
    const m0 = searchKey.getState(view.state)!.matches[0];
    view.dispatch(view.state.tr.insertText("X", m0.from + 2));
    expect(searchKey.getState(view.state)!.matches).toEqual(
      groundTruth(view.state.doc, "NEEDLE"),
    );
    expect(searchKey.getState(view.state)?.matches).toHaveLength(0);
    // 再补一个完整 NEEDLE：新匹配被捕获
    view.dispatch(view.state.tr.insertText("NEEDLE", m0.from + 3));
    const s = searchKey.getState(view.state)!;
    expect(s.matches).toEqual(groundTruth(view.state.doc, "NEEDLE"));
    expect(s.matches).toHaveLength(1);
    view.destroy();
  });

  it("多步事务回退全量重算，结果正确", () => {
    const view = makeView(["foo a", "b foo"], plainOpts("foo"));
    // 一个事务内两步插入（非按键形态），应回退全量重算
    const p0 = paraTextStart(view, 0);
    const p1 = paraTextStart(view, 1);
    view.dispatch(view.state.tr.insertText("X", p0).insertText("Y", p1));

    const s = searchKey.getState(view.state)!;
    expect(view.state.doc.textContent).toBe("Xfoo aYb foo");
    expect(s.matches).toEqual(groundTruth(view.state.doc, "foo"));
    expect(s.matches).toHaveLength(2);
    view.destroy();
  });

  it("当前匹配在窗外时增量修补保持高亮类不丢失", () => {
    const plugin = searchPlugin();
    const view = makeView(["one foo", "two foo", "three foo"], plainOpts("foo"), plugin);
    // current 移到第 3 个匹配（第三段）
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    expect(searchKey.getState(view.state)?.current).toBe(2);

    // 在第一段（远离当前匹配）插入文本：增量修补路径
    view.dispatch(view.state.tr.insertText("zz ", paraTextStart(view, 0)));

    const decos = decorationsOf(plugin)(view.state).find();
    const currents = decos.filter((d) => decoClass(d) === "search-match-current");
    // 恰好一个当前高亮，且位于平移后的第三个匹配上
    expect(currents).toHaveLength(1);
    const s = searchKey.getState(view.state)!;
    expect(s.matches).toEqual(groundTruth(view.state.doc, "foo"));
    expect(currents[0].from).toBe(s.matches[2].from);
    expect(currents[0].to).toBe(s.matches[2].to);
    // 其余两个是普通匹配类
    expect(decos.filter((d) => decoClass(d) === "search-match")).toHaveLength(2);
    view.destroy();
  });

  it("编辑使匹配数减少到 current 越界时收敛到合法值", () => {
    const view = makeView(["foo foo foo"], plainOpts("foo"));
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
    expect(searchKey.getState(view.state)?.current).toBe(2);
    // 删除第三个 foo（单段落文档：位置即文本偏移）
    const m2 = searchKey.getState(view.state)!.matches[2];
    view.dispatch(view.state.tr.delete(m2.from, m2.to));
    const s = searchKey.getState(view.state)!;
    expect(s.matches).toEqual(groundTruth(view.state.doc, "foo"));
    expect(s.matches).toHaveLength(2);
    expect(s.current).toBe(0); // 越界收敛
    view.destroy();
  });

  it("匹配为空后编辑不报错，重新出现匹配能恢复（不自动选中，保持既有语义）", () => {
    const view = makeView(["nothing here"], plainOpts("foo"));
    expect(searchKey.getState(view.state)?.matches).toHaveLength(0);
    view.dispatch(view.state.tr.insertText("foo", paraTextStart(view, 0) + 8));
    const s = searchKey.getState(view.state)!;
    expect(s.matches).toEqual(groundTruth(view.state.doc, "foo"));
    expect(s.matches).toHaveLength(1);
    expect(s.current).toBe(-1); // 与既有语义一致：无选中时不自动选中
    view.destroy();
  });
});

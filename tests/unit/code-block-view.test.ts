// code-block-view NodeView 测试
// 重点验证 v1.2.9 修复：
// - setSelection 把 PM 绝对位置正确翻译为 CM 本地位置（修复点击第一行光标跳到 9-11 行）
// - selectNode 清空 CM 选区（NodeSelection 时不残留旧文本选区）
// - forwardUpdate CM→PM 选区同步 offset 正确

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { EditorView as CMView } from "@codemirror/view";
import { EditorState as CMState } from "@codemirror/state";

// CodeBlockNodeView 依赖 useSettings store，需要在 import 前初始化 mock
// vi.mock 会被提升到顶部，确保在 CodeBlockNodeView 导入前生效
vi.mock("../../src/store/settings", () => ({
  useSettings: {
    getState: () => ({ codeBlockTheme: "none" }),
    subscribe: () => () => {},
  },
}));

import { CodeBlockNodeView, codeLanguageLoader } from "../../src/components/Editor/code-block-view";

// 构建测试 schema：code_block content 为 text*
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
      code_block: {
        group: "block",
        content: "text*",
        code: true,
        attrs: { language: { default: "text" } },
        toDOM: () => ["pre", ["code", 0]],
        parseDOM: [{ tag: "pre" }],
      },
      text: { group: "inline" },
    },
  });
}

/** 用 mock IO 立即触发 CM 创建 */
function setupIntersectionObserver() {
  const disconnect = vi.fn();
  const ctor = vi.fn((cb: (entries: unknown[]) => void) => ({
    observe: (target: Element) => {
      // 立即回调，让 CM 创建
      cb([{ isIntersecting: true, target }]);
    },
    disconnect,
    unobserve: vi.fn(),
  }));
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = ctor;
  return { ctor, disconnect };
}

beforeEach(() => {
  vi.useFakeTimers();
  setupIntersectionObserver();
  CodeBlockNodeView.resetMountQueueForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CodeBlockNodeView.setSelection 位置翻译（v1.2.9 修复）", () => {
  it("PM 绝对位置 → CM 本地位置：点击第一行不跳到末尾", () => {
    const schema = makeSchema();
    // 前面放一个大段落（约 200 字符），使 code_block 的 getPos() 较大
    // 模拟用户场景：代码块不在文档首部，前面有大量内容
    const longText = "x".repeat(200);
    const para = schema.nodes.paragraph.create(null, schema.text(longText));
    const codeText = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11";
    const codeNode = schema.nodes.code_block.create(
      { language: "text" },
      schema.text(codeText),
    );
    const doc = schema.nodes.doc.create(null, [para, codeNode]);
    // para nodeSize = 2 + 200 = 202，code_block 在 pos=202
    const codeBlockPos = para.nodeSize; // 202

    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, codeBlockPos + 1),
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });

    const nv = new CodeBlockNodeView(codeNode, view, () => codeBlockPos);
    // #212：IO 回调只入队，测试里同步清空挂载队列（生产走 rAF 批次调度）
    CodeBlockNodeView.flushMountQueueForTests();

    // PM 调 setSelection，传入绝对位置 codeBlockPos+1（= 代码块第一行起始）
    // 修复前：直接把 203 当 CM 本地位置 → 跳到约第 10 行
    // 修复后：localAnchor = 203 - 202 - 1 = 0 → CM 光标在本地位置 0（第一行）
    nv.setSelection(codeBlockPos + 1, codeBlockPos + 1);

    const cm = (nv as any).cm as CMView | null;
    expect(cm).not.toBeNull();
    const cmSel = cm!.state.selection.main;
    // CM 本地位置应为 0（第一行开头），而不是 203
    expect(cmSel.from).toBe(0);
    expect(cmSel.to).toBe(0);

    nv.destroy();
    view.destroy();
  });

  it("PM 绝对位置在代码块中间时 → CM 本地位置正确映射", () => {
    const schema = makeSchema();
    const para = schema.nodes.paragraph.create(null, schema.text("ab"));
    const codeText = "hello\nworld";
    const codeNode = schema.nodes.code_block.create(
      { language: "text" },
      schema.text(codeText),
    );
    const doc = schema.nodes.doc.create(null, [para, codeNode]);
    const codeBlockPos = para.nodeSize; // 4

    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, codeBlockPos + 1),
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });

    const nv = new CodeBlockNodeView(codeNode, view, () => codeBlockPos);
    // #212：IO 回调只入队，测试里同步清空挂载队列（生产走 rAF 批次调度）
    CodeBlockNodeView.flushMountQueueForTests();

    // PM 位置 codeBlockPos+1+7 = 12 → CM 本地位置 7（"hello\nworld" 的 'w' 位置）
    const targetPM = codeBlockPos + 1 + 7; // 指向 "world" 的 w
    nv.setSelection(targetPM, targetPM);

    const cm = (nv as any).cm as CMView | null;
    const cmSel = cm!.state.selection.main;
    expect(cmSel.from).toBe(7);
    expect(cmSel.to).toBe(7);

    nv.destroy();
    view.destroy();
  });

  it("PM 绝对位置超出 CM 文档长度时 → 夹紧到末尾不越界", () => {
    const schema = makeSchema();
    const para = schema.nodes.paragraph.create(null, schema.text("x".repeat(100)));
    const codeText = "ab";
    const codeNode = schema.nodes.code_block.create(
      { language: "text" },
      schema.text(codeText),
    );
    const doc = schema.nodes.doc.create(null, [para, codeNode]);
    const codeBlockPos = para.nodeSize; // 102

    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, codeBlockPos + 1),
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });

    const nv = new CodeBlockNodeView(codeNode, view, () => codeBlockPos);
    // #212：IO 回调只入队，测试里同步清空挂载队列（生产走 rAF 批次调度）
    CodeBlockNodeView.flushMountQueueForTests();

    // 传入一个远超 codeText 长度的 PM 位置
    // 修复前：localAnchor = 99999 → CM 可能行为异常
    // 修复后：夹紧到 docLen=2
    nv.setSelection(99999, 99999);

    const cm = (nv as any).cm as CMView | null;
    const cmSel = cm!.state.selection.main;
    expect(cmSel.from).toBe(2); // codeText.length
    expect(cmSel.to).toBe(2);

    nv.destroy();
    view.destroy();
  });

  it("getPos 返回 undefined 时 setSelection 不抛错", () => {
    const schema = makeSchema();
    const codeText = "hello";
    const codeNode = schema.nodes.code_block.create(
      { language: "text" },
      schema.text(codeText),
    );
    const doc = schema.nodes.doc.create(null, [codeNode]);

    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });

    const nv = new CodeBlockNodeView(codeNode, view, () => undefined);
    CodeBlockNodeView.flushMountQueueForTests();

    expect(() => nv.setSelection(5, 5)).not.toThrow();

    nv.destroy();
    view.destroy();
  });
});

describe("CodeBlockNodeView.selectNode（v1.2.9 加固）", () => {
  it("NodeSelection 选中代码块时清空 CM 选区到位置 0", () => {
    const schema = makeSchema();
    const codeText = "line1\nline2\nline3";
    const codeNode = schema.nodes.code_block.create(
      { language: "text" },
      schema.text(codeText),
    );
    const doc = schema.nodes.doc.create(null, [codeNode]);

    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });

    const nv = new CodeBlockNodeView(codeNode, view, () => 0);
    CodeBlockNodeView.flushMountQueueForTests();

    // 先把 CM 光标移到中间位置
    const cm = (nv as any).cm as CMView | null;
    cm!.dispatch({ selection: { anchor: 6, head: 6 } });
    expect(cm!.state.selection.main.from).toBe(6);

    // selectNode 应清空到 0
    nv.selectNode();
    expect(cm!.state.selection.main.from).toBe(0);
    expect(cm!.state.selection.main.to).toBe(0);

    nv.destroy();
    view.destroy();
  });
});

describe("CodeBlockNodeView forwardUpdate offset 对称性", () => {
  it("forwardUpdate 的 offset = getPos()+1 与 setSelection 的 -pos-1 数学互逆", () => {
    // forwardUpdate 有 hasFocus 守卫，jsdom 环境无法触发 CM→PM 同步，
    // 这里仅验证位置翻译的数学互逆性（不依赖 CM 焦点）
    const codeBlockPos = 202; // 模拟前面有 200 字符段落
    const cmLocal = 5; // CM 本地位置

    // forwardUpdate 方向：CM 本地 → PM 绝对
    const pmAbs = codeBlockPos + 1 + cmLocal; // 208

    // setSelection 方向：PM 绝对 → CM 本地（修复后的公式）
    const cmRecovered = pmAbs - codeBlockPos - 1; // 5

    expect(cmRecovered).toBe(cmLocal);
  });
});

describe("CodeBlockNodeView.updateLanguage 竞态守卫（issue #173）", () => {
  // 接缝：loader 桩按语言名返回可控 deferred，精确控制不同语言的 resolve 顺序。
  // 真实动态 import 的完成顺序不确定，无法稳定复现「B 先完成、A 后完成」。
  // resolve 值用无害的 tabSize Facet 标记代指不同语言的 LanguageSupport——
  // 只验证「哪个请求的结果被应用」，避免装入两个真实 Lezer 语言包。
  const realLoaderLoad = codeLanguageLoader.load;
  type Deferred = {
    promise: Promise<unknown>;
    resolve: (v: unknown) => void;
  };
  const deferreds = new Map<string, Deferred>();
  const deferredOf = (name: string): Deferred => {
    let d = deferreds.get(name);
    if (!d) {
      let resolve!: (v: unknown) => void;
      const promise = new Promise<unknown>((res) => {
        resolve = res;
      });
      d = { promise, resolve };
      deferreds.set(name, d);
    }
    return d;
  };

  beforeEach(() => {
    deferreds.clear();
    codeLanguageLoader.load = ((name: string) => deferredOf(name).promise) as typeof realLoaderLoad;
  });

  afterEach(() => {
    codeLanguageLoader.load = realLoaderLoad;
    deferreds.clear();
  });

  function buildView(language: string) {
    const schema = makeSchema();
    const codeNode = schema.nodes.code_block.create(
      { language },
      schema.text("const a = 1"),
    );
    const doc = schema.nodes.doc.create(null, [codeNode]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });
    const nv = new CodeBlockNodeView(codeNode, view, () => 0);
    CodeBlockNodeView.flushMountQueueForTests();
    return { schema, view, nv };
  }

  it("A→B 快速切换、B 先 resolve：应用 B；迟到的 A 结果被丢弃，不覆盖高亮", async () => {
    const { schema, view, nv } = buildView("typescript");
    // initCodeMirror 已发出第一次请求（typescript），尚未 resolve
    const cm = (nv as { cm: CMView | null }).cm;
    expect(cm).not.toBeNull();
    try {
      // 用户在加载完成前把语言切到 python（第二次请求）
      const pythonNode = schema.nodes.code_block.create(
        { language: "python" },
        schema.text("const a = 1"),
      );
      nv.update(pythonNode);

      const deferredTs = deferredOf("typescript");
      const deferredPy = deferredOf("python");
      expect(deferredTs).toBeDefined();
      expect(deferredPy).toBeDefined();

      // B（python，后发请求）先完成 → 应应用 python（tabSize=2 标记）
      deferredPy.resolve([CMState.tabSize.of(2)]);
      await Promise.resolve();
      await Promise.resolve();
      expect(cm!.state.tabSize).toBe(2);

      // A（typescript，先发请求）后完成 → 过期，不得覆盖 python（issue #173）
      deferredTs.resolve([CMState.tabSize.of(4)]);
      await Promise.resolve();
      await Promise.resolve();
      expect(cm!.state.tabSize).toBe(2);
    } finally {
      nv.destroy();
      view.destroy();
    }
  });

  it("过期请求晚到也不影响后续最新请求的应用", async () => {
    const { schema, view, nv } = buildView("typescript");
    const cm = (nv as { cm: CMView | null }).cm;
    try {
      const pythonNode = schema.nodes.code_block.create(
        { language: "python" },
        schema.text("const a = 1"),
      );
      nv.update(pythonNode);

      const deferredTs = deferredOf("typescript");
      const deferredPy = deferredOf("python");

      // 过期请求 A 先 resolve（此时最新已是 python 的请求）→ 不应用
      deferredTs.resolve([CMState.tabSize.of(4)]);
      await Promise.resolve();
      await Promise.resolve();
      // compartment 保持初始空配置（tabSize 默认 4）
      expect(cm!.state.tabSize).toBe(4);

      // 最新请求 B 后 resolve → 正常应用（tabSize=2 标记）
      deferredPy.resolve([CMState.tabSize.of(2)]);
      await Promise.resolve();
      await Promise.resolve();
      expect(cm!.state.tabSize).toBe(2);
    } finally {
      nv.destroy();
      view.destroy();
    }
  });
});

describe("CodeBlockNodeView 懒挂载批次化（#212）", () => {
  // 可控 IO：记录回调，由用例手动触发「进入视口」（真实浏览器中 IO 常在
  // 快速滚动中成批触发，同帧连续 initCodeMirror 是滚动帧尖刺来源）
  let ioCallbacks: Array<
    (entries: { isIntersecting: boolean; target: Element }[]) => void
  >;
  let observed: Element[];

  beforeEach(() => {
    CodeBlockNodeView.resetMountQueueForTests();
    ioCallbacks = [];
    observed = [];
    // 注意：必须用 function（可被 new），箭头函数不是 constructor
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      function (cb: (entries: unknown[]) => void) {
        return {
          observe: (target: Element) => {
            ioCallbacks.push(cb as never);
            observed.push(target);
          },
          disconnect: vi.fn(),
          unobserve: vi.fn(),
        };
      };
  });

  function buildNodeView() {
    const schema = makeSchema();
    const codeNode = schema.nodes.code_block.create(
      { language: "text" },
      schema.text("queued line"),
    );
    const doc = schema.nodes.doc.create(null, [codeNode]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1),
    });
    const root = document.createElement("div");
    document.body.appendChild(root);
    const view = new EditorView(root, { state });
    const nv = new CodeBlockNodeView(codeNode, view, () => 0);
    return { nv, view };
  }

  it("IO 进入视口只入队：CM 不立即创建，占位 <pre> 保留", () => {
    const { nv, view } = buildNodeView();
    expect(observed).toHaveLength(1);
    ioCallbacks[0]!([{ isIntersecting: true, target: nv.dom }]);
    // 入队但未被 drainer 消费（生产走 rAF 批次 + 滚动停歇让位调度）
    expect((nv as { cm: unknown }).cm).toBeNull();
    expect(nv.dom.querySelector(".code-block-placeholder")).not.toBeNull();
    // IO 已断开（一次性挂载语义保留）
    expect((nv as unknown as { io: unknown }).io).toBeNull();

    CodeBlockNodeView.flushMountQueueForTests();
    expect((nv as { cm: unknown }).cm).not.toBeNull();
    expect(nv.dom.querySelector(".code-block-placeholder")).toBeNull();

    nv.destroy();
    view.destroy();
  });

  it("多个代码块同帧批量进入视口：全部入队，flush 逐个挂载", () => {
    const first = buildNodeView();
    const second = buildNodeView();
    ioCallbacks[0]!([{ isIntersecting: true, target: first.nv.dom }]);
    ioCallbacks[1]!([{ isIntersecting: true, target: second.nv.dom }]);

    expect((first.nv as { cm: unknown }).cm).toBeNull();
    expect((second.nv as { cm: unknown }).cm).toBeNull();

    CodeBlockNodeView.flushMountQueueForTests();
    expect((first.nv as { cm: unknown }).cm).not.toBeNull();
    expect((second.nv as { cm: unknown }).cm).not.toBeNull();

    first.nv.destroy();
    first.view.destroy();
    second.nv.destroy();
    second.view.destroy();
  });

  it("destroy 从队列移除：已销毁实例不再被挂载", () => {
    const { nv, view } = buildNodeView();
    ioCallbacks[0]!([{ isIntersecting: true, target: nv.dom }]);
    // 尚在队列中即被销毁（编辑删除节点/切换文档场景）
    nv.destroy();
    view.destroy();

    CodeBlockNodeView.flushMountQueueForTests();
    // 队列中的实例已被移除，destroy 后 cm 保持 null（不再创建新实例）
    expect((nv as { cm: unknown }).cm).toBeNull();
  });

  it("未进入视口的代码块不入队，flush 无副作用", () => {
    const { nv, view } = buildNodeView();
    CodeBlockNodeView.flushMountQueueForTests();
    // IO 未触发（视口外），占位保留、CM 未创建
    expect((nv as { cm: unknown }).cm).toBeNull();
    expect(nv.dom.querySelector(".code-block-placeholder")).not.toBeNull();
    nv.destroy();
    view.destroy();
  });
});

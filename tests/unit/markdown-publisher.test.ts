// markdown-publisher 插件测试
// 验证：序列化防抖合并、doc 未变不触发、idle flush 跳过、
// 与 lastSynced 相同不回调、blur/销毁立即 flush、pending 不因模式丢弃
//
// 用真实 ProseMirror EditorState/EditorView 驱动：插件的去抖判定依赖
// 「本批是否含用户文档变更」的插件状态（issue #431 评审 P1），
// 伪 view 无法模拟 EditorState.apply 的插件状态推进。

import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema, type Node as PMNode } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import {
  flushAllMarkdownPublishers,
  flushMarkdownPublisherFor,
  markdownPublisherPlugin,
} from "../../src/components/Editor/markdown-publisher";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: {
      content: "text*",
      toDOM: () => ["p", 0],
      parseDOM: [{ tag: "p" }],
    },
    text: { group: "inline" },
  },
});

function makeDoc(text = ""): PMNode {
  return schema.nodes.doc.create(
    null,
    schema.nodes.paragraph.create(null, text ? schema.text(text) : null),
  );
}

const views: EditorView[] = [];

function setup(options?: { initialSynced?: string; initialText?: string; filePath?: string }) {
  let lastSynced = options?.initialSynced ?? "md-0";
  const onChange = vi.fn();
  let serializeImpl: (doc: PMNode) => string = (doc) => `md-${doc.textContent}`;
  const serialize = vi.fn((doc: PMNode) => serializeImpl(doc));
  const plugin = markdownPublisherPlugin({
    serialize,
    getLastSynced: () => lastSynced,
    setLastSynced: (md) => {
      lastSynced = md;
    },
    getFilePath: () => options?.filePath ?? "/docs/note.md",
    onChange,
  });
  const dom = document.createElement("div");
  document.body.append(dom);
  const view = new EditorView(dom, {
    state: EditorState.create({ doc: makeDoc(options?.initialText), plugins: [plugin] }),
  });
  views.push(view);
  // view 创建时插件会用「当前 doc 的序列化结果」初始化同步基线
  // （修复 E2E 关 tab 误判 dirty 的改动）。这里清掉这次基线调用的计数，
  // 并按测试意图复位 lastSynced，让后续断言聚焦 flush/防循环行为本身。
  serialize.mockClear();
  if (options?.initialSynced !== undefined) lastSynced = options.initialSynced;

  return {
    onChange,
    serialize,
    view,
    dom,
    /** 在光标处输入文本（真实事务） */
    edit(text: string) {
      view.dispatch(view.state.tr.insertText(text, view.state.selection.from));
    },
    /** 覆盖序列化结果（用于「与外部同步值相同」等场景） */
    setSerialize(impl: (doc: PMNode) => string) {
      serializeImpl = impl;
    },
    destroy() {
      view.destroy();
      const idx = views.indexOf(view);
      if (idx >= 0) views.splice(idx, 1);
    },
  };
}

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("markdownPublisherPlugin", () => {
  it("连续 doc 变更在防抖窗口内只序列化并发布一次", () => {
    vi.useFakeTimers();
    const { onChange, serialize, edit } = setup();
    edit("a");
    edit("b");
    edit("c");
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(160);
    // 只取最新 doc 序列化一次
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith(expect.objectContaining({ textContent: "abc" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-abc");
  });

  it("doc 未变化的 transaction 不触发序列化", () => {
    vi.useFakeTimers();
    const { onChange, serialize, view } = setup();
    // 纯选区事务：doc 未变化
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    vi.advanceTimersByTime(300);
    expect(serialize).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("序列化结果与外部同步值相同时不回调（防循环）", () => {
    vi.useFakeTimers();
    const { onChange, setSerialize, edit } = setup({ initialSynced: "md-fixed" });
    setSerialize(() => "md-fixed");
    edit("x");
    vi.advanceTimersByTime(160);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("待发编辑的 flush 不受模式影响（进入源码模式不得丢弃 pending）", () => {
    // 回归：旧 isSourceMode 守卫会在进入源码模式的 flush 中清掉 timer
    // 且不发布，丢失窗口内编辑。源码模式下 PM doc 不变，timer 非空即
    // 进入前的待发编辑，必须发布；源码模式期间的保护由 idle 守卫承担
    vi.useFakeTimers();
    const { onChange, serialize, edit } = setup();
    edit("1");
    vi.advanceTimersByTime(160);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-1");
  });

  it("blur 立即 flush 待定序列化", () => {
    vi.useFakeTimers();
    const { onChange, view, edit } = setup();
    edit("7");
    // 监听器挂在 ProseMirror 自己的 view.dom 上（mount 容器不会代收 blur）
    view.dom.dispatchEvent(new Event("blur"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-7");
  });

  it("保存路径 flush 跳过 idle 编辑器，不重跑全文序列化", () => {
    // 自动保存每 2s 触发一次 flush：idle 编辑器不得重复全文序列化（PR #34 P2）
    vi.useFakeTimers();
    const { serialize, edit } = setup();
    flushAllMarkdownPublishers();
    expect(serialize).not.toHaveBeenCalled();

    edit("1");
    flushAllMarkdownPublishers();
    expect(serialize).toHaveBeenCalledTimes(1);

    // 发布后回到 idle：再次 flush 不重复序列化
    flushAllMarkdownPublishers();
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it("按 view flush 只发布该编辑器的待发编辑（#431 评审）", () => {
    // 切 tab / 进源码模式是单编辑器交互：分屏侧仍停在自己的文件上，
    // 不能被顺带做一次全文序列化（大文档就是一次长任务）。
    vi.useFakeTimers();
    const a = setup();
    const b = setup();
    a.edit("1");
    b.edit("2");

    flushMarkdownPublisherFor(a.view);
    expect(a.onChange).toHaveBeenCalledTimes(1);
    expect(a.onChange).toHaveBeenCalledWith("md-1");
    expect(b.onChange).not.toHaveBeenCalled();
    expect(b.serialize).not.toHaveBeenCalled();

    flushAllMarkdownPublishers();
    expect(b.onChange).toHaveBeenCalledTimes(1);
    expect(b.onChange).toHaveBeenCalledWith("md-2");

    a.destroy();
    b.destroy();
  });

  it("销毁时 flush 待定序列化", () => {
    vi.useFakeTimers();
    const { onChange, edit, destroy } = setup();
    edit("9");
    destroy();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-9");
  });
});

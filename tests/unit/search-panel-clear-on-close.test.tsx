// SearchPanel 关闭后清除搜索高亮（#185）
// 用真实 ProseMirror view + searchPlugin 验证：面板卸载时 dispatch clear，
// 搜索状态清空、装饰集变为 empty（高亮不再残留）。

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView, DecorationSet } from "@milkdown/kit/prose/view";
import { SearchPanel } from "../../src/components/Editor/SearchPanel";
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

const FIND_OPTS: SearchOpts = { find: "foo", caseSensitive: false, useRegex: false };

function makeViewWithSearch(text: string) {
  const schema = makeSchema();
  // 文档根必须是 doc 节点（ProseMirror 真实形状）：#371 起匹配以文本块为边界，
  // 裸 paragraph 当根会让 nodesBetween 访问不到任何文本块
  const paragraph = schema.nodes.paragraph.create(null, schema.text(text));
  const doc = schema.nodes.doc.create(null, [paragraph]);
  const plugin = searchPlugin();
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

function wrapEditor(view: EditorView) {
  return {
    action: (fn: (ctx: { get: (key: unknown) => EditorView }) => void) =>
      fn({ get: () => view }),
  };
}

describe("SearchPanel 关闭清除搜索高亮（#185）", () => {
  it("卸载面板时 dispatch clear，搜索状态与高亮全部清空", () => {
    const { view, plugin } = makeViewWithSearch("foo bar foo");
    const decorations = plugin.props.decorations as (s: EditorState) => DecorationSet;

    // 模拟用户已输入查找词：两个匹配、高亮存在
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "set", opts: FIND_OPTS }));
    expect(searchKey.getState(view.state)?.matches.length).toBe(2);
    expect(decorations(view.state)).not.toBe(DecorationSet.empty);

    const { unmount } = render(
      <SearchPanel
        getEditor={() => wrapEditor(view) as never}
        onClose={vi.fn()}
        showReplace={false}
        onShowReplaceChange={vi.fn()}
      />,
    );

    // 挂载时面板以空查找词 dispatch 过一次 clear，这里重新建立活动搜索再关闭
    view.dispatch(view.state.tr.setMeta(searchKey, { type: "set", opts: FIND_OPTS }));
    expect(searchKey.getState(view.state)?.matches.length).toBe(2);
    expect(decorations(view.state)).not.toBe(DecorationSet.empty);

    unmount();

    const s = searchKey.getState(view.state);
    expect(s?.opts).toBeNull();
    expect(s?.matches.length).toBe(0);
    expect(s?.current).toBe(-1);
    expect(decorations(view.state)).toBe(DecorationSet.empty);
    view.destroy();
  });

  it("无活动搜索时关闭面板不产生多余 dispatch", () => {
    const { view } = makeViewWithSearch("hello world");
    const { unmount } = render(
      <SearchPanel
        getEditor={() => wrapEditor(view) as never}
        onClose={vi.fn()}
        showReplace={false}
        onShowReplaceChange={vi.fn()}
      />,
    );
    const dispatchSpy = vi.spyOn(view, "dispatch");
    unmount();
    expect(dispatchSpy).not.toHaveBeenCalled();
    view.destroy();
  });

  it("编辑器已销毁（getEditor 返回 undefined）时卸载不抛错", () => {
    const { unmount } = render(
      <SearchPanel
        getEditor={() => undefined}
        onClose={vi.fn()}
        showReplace={false}
        onShowReplaceChange={vi.fn()}
      />,
    );
    expect(() => unmount()).not.toThrow();
  });
});

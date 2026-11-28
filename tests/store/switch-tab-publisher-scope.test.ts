// store 切 tab 的 Markdown 发布 flush 必须按 departing path 收敛（#431 评审 B7）
//
// 真实 publisher 插件 + 真实 EditorState/EditorView + store.switchTab：
// 主面板切 tab 时，只应发布即将切离的文档；分屏仍停在自己的文件上，
// 其待发编辑不得被本次切 tab 同步序列化。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { markdownPublisherPlugin } from "../../src/components/Editor/markdown-publisher";
import { useWorkspace } from "../../src/store/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  convertFileSrc: (path: string) => path,
}));

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

const views: EditorView[] = [];

function registerPublisher(filePath: string) {
  const onChange = vi.fn();
  let markdown = `${filePath}#0`;
  const serialize = vi.fn(() => markdown);
  const plugin = markdownPublisherPlugin({
    serialize,
    getLastSynced: () => `${filePath}#0`,
    setLastSynced: () => {},
    getFilePath: () => filePath,
    onChange,
  });
  const dom = document.createElement("div");
  document.body.append(dom);
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create());
  const view = new EditorView(dom, {
    state: EditorState.create({ doc, plugins: [plugin] }),
  });
  views.push(view);
  serialize.mockClear();
  const bump = (id: number) => {
    markdown = `${filePath}#${id}`;
    // 真实用户编辑：产生 doc 变更事务，进入发布防抖窗口
    view.dispatch(view.state.tr.insertText("x", view.state.selection.from));
  };
  return { onChange, serialize, view, bump };
}

beforeEach(() => {
  vi.useFakeTimers();
  useWorkspace.setState({
    openTabs: [
      { path: "/docs/a.md", docId: "doc-a", content: "A", dirty: false },
      { path: "/docs/b.md", docId: "doc-b", content: "B", dirty: false },
      { path: "/docs/split.md", docId: "doc-split", content: "S", dirty: false },
    ] as never,
    activeTabPath: "/docs/a.md",
    currentFile: "/docs/a.md",
    currentContent: "A",
  } as never);
});

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("switchTab 的 publisher flush 作用域（#431 评审 B7）", () => {
  it("只发布 departing 文档，分屏的待发编辑不被同步序列化", () => {
    const main = registerPublisher("/docs/a.md");
    const split = registerPublisher("/docs/split.md");
    main.bump(1);
    split.bump(1);

    useWorkspace.getState().switchTab("/docs/b.md");

    // 即将切离的 A 被立即发布；分屏 S 不参与本次切 tab
    expect(main.onChange).toHaveBeenCalledTimes(1);
    expect(main.onChange).toHaveBeenCalledWith("/docs/a.md#1");
    expect(split.onChange).not.toHaveBeenCalled();
    expect(split.serialize).not.toHaveBeenCalled();

    // 分屏的待发编辑仍在自己的防抖窗口内，随后正常发布
    vi.advanceTimersByTime(200);
    expect(split.onChange).toHaveBeenCalledTimes(1);
    expect(split.onChange).toHaveBeenCalledWith("/docs/split.md#1");
  });
});

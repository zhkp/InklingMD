// #431 评审：SearchPanel 的水合补齐必须限定在搜索目标编辑器
//
// 回归点：查找词生效时调用无参 `flushActiveHydration()` 会遍历所有活跃水合任务，
// 分屏另一侧的大文档会被一次查找同步插完，重新造出分片水合想避免的长任务。
// 本测试断言传给 flush 的正是当前 editor 的 view。

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { searchPlugin } from "../../src/components/Editor/search";

const { flushSpy } = vi.hoisted(() => ({ flushSpy: vi.fn() }));

vi.mock("../../src/components/Editor/tab-editor-cache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/Editor/tab-editor-cache")>();
  return { ...actual, flushActiveHydration: flushSpy };
});

import { SearchPanel } from "../../src/components/Editor/SearchPanel";

function makeView(): EditorView {
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
  const doc = schema.nodes.doc.create(
    null,
    schema.nodes.paragraph.create(null, schema.text("foo bar foo")),
  );
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
    plugins: [searchPlugin()],
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  return new EditorView(root, { state });
}

function wrapEditor(view: EditorView) {
  return {
    action: (fn: (ctx: { get: (key: unknown) => EditorView }) => void) =>
      fn({ get: () => view }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  flushSpy.mockReset();
  document.body.innerHTML = "";
});

describe("#431 评审：SearchPanel 水合补齐按 view 作用域", () => {
  it("查找词生效时只传当前编辑器 view，不做无参全局补齐", () => {
    vi.useFakeTimers();
    const view = makeView();
    const { unmount } = render(
      <SearchPanel
        getEditor={() => wrapEditor(view) as never}
        onClose={vi.fn()}
        showReplace={false}
        onShowReplaceChange={vi.fn()}
      />,
    );
    const input = document.querySelector(".search-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "foo" } });
    act(() => {
      vi.advanceTimersByTime(130);
    });

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(flushSpy).toHaveBeenCalledWith(view);

    unmount();
    view.destroy();
  });
});

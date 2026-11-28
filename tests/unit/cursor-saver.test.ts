// cursor-saver 切 tab 落盘（#431 评审 B2 / B5）
//
// 真实 EditorView + cursorSaverPlugin：
// - 切到源码模式 tab 时编辑器 DOM 已隐藏（getClientRects 为空），落盘必须用
//   滚动时缓存的 scrollTop，不能是塌陷后的现场 0；
// - lastPos/scheduledFile 属于上一个 tab 时，切走新 tab 只重置不写，
//   不能把旧 tab 的光标位置串写进新 tab 的记忆。

import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import {
  cursorSaverPlugin,
  flushCursorSaverForTabSwitch,
} from "../../src/components/Editor/cursor-saver";

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

interface Saved {
  path: string;
  pos: number;
  scrollTop: number;
}

function mount() {
  const doc = schema.nodes.doc.create(
    null,
    schema.nodes.paragraph.create(null, schema.text("0123456789")),
  );
  const scroller = document.createElement("div");
  scroller.className = "editor-scroll";
  let liveScrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => liveScrollTop,
    set: (value: number) => {
      liveScrollTop = value;
    },
  });
  document.body.append(scroller);
  const mountPoint = document.createElement("div");
  scroller.append(mountPoint);

  let currentPath = "/docs/a.md";
  const saved: Saved[] = [];
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
    plugins: [
      cursorSaverPlugin(
        () => currentPath,
        () => (path, pos, scrollTop) => saved.push({ path, pos, scrollTop }),
      ),
    ],
  });
  const view = new EditorView(mountPoint, { state });
  return {
    view,
    saved,
    scroller,
    setPath(path: string) {
      currentPath = path;
    },
  };
}

function setScroll(view: EditorView, scroller: HTMLElement, value: number): void {
  scroller.scrollTop = value;
  scroller.dispatchEvent(new Event("scroll"));
  // 触发一次 selection transaction，让 lastPos/scheduledFile 绑定到当前路径
  view.dispatch(
    view.state.tr.setSelection(TextSelection.create(view.state.doc, 5)),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("cursor-saver 切 tab 落盘（#431 评审）", () => {
  it("塌陷的源码模式切走：scrollTop 取滚动缓存，不取现场 0", () => {
    const { view, saved, scroller } = mount();
    setScroll(view, scroller, 300);
    expect(saved).toHaveLength(0);

    // 切入源码模式 tab：commit 阶段编辑器 DOM 已 display:none，
    // 内容塌陷把现场 scrollTop 钳回 0
    view.dom.getClientRects = () => [] as never;
    scroller.scrollTop = 0;
    flushCursorSaverForTabSwitch(view, "/docs/a.md");

    expect(saved).toEqual([
      { path: "/docs/a.md", pos: 5, scrollTop: 300 },
    ]);
    view.destroy();
  });

  it("DOM 可见时使用现场 scrollTop（缓存只作兜底）", () => {
    const { view, saved, scroller } = mount();
    setScroll(view, scroller, 300);
    // 可见：返回非空渲染盒，现场值可信
    view.dom.getClientRects = () => [document.createRange().getBoundingClientRect()] as never;
    scroller.scrollTop = 250;

    flushCursorSaverForTabSwitch(view, "/docs/a.md");
    expect(saved).toEqual([{ path: "/docs/a.md", pos: 5, scrollTop: 250 }]);
    view.destroy();
  });

  it("源码模式 tab 切走后再切新 tab：不把旧 tab 的 lastPos 串写进新 tab", () => {
    const { view, saved, setPath } = mount();
    // A：光标 5 产生 lastPos/scheduledFile=/docs/a.md
    setScroll(view, (view.dom.closest(".editor-scroll") as HTMLElement), 120);
    expect(saved).toHaveLength(0);

    // A 进入源码模式后切到 B：Editor 不会为源码模式 tab 调 resetter，
    // lastPos/scheduledFile 仍指向 A；B 无交互就再次切走
    setPath("/docs/b.md");
    flushCursorSaverForTabSwitch(view, "/docs/b.md");
    expect(saved).toHaveLength(0);

    // 对照：B 发生交互后切走，正常落盘 B 的位置
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 9)),
    );
    flushCursorSaverForTabSwitch(view, "/docs/b.md");
    expect(saved).toEqual([{ path: "/docs/b.md", pos: 9, scrollTop: 120 }]);
    view.destroy();
  });
});

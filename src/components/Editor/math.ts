// KaTeX 数学公式节点
// 行内公式 $...$ 和块级公式 $$...$$ 通过 remark-math 解析为 mdast 节点，
// 再映射到 ProseMirror 的 atom 节点，渲染交给 KaTeX NodeView。
// markdown 源码保持原始 LaTeX 文本（$...$ / $$...$$），便于迁移。

import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import type { NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import remarkMath from "remark-math";

// issue #168：KaTeX 懒加载——首次遇到公式节点才动态导入（JS + 样式 + mhchem），
// 复用 code-block-view 语言的既有范式；~822KB vendor_katex 不再进入启动加载图。
// Promise 缓存，后续渲染复用。
type KatexModule = typeof import("katex").default;
let katexPromise: Promise<KatexModule> | null = null;
function loadKatex(): Promise<KatexModule> {
  if (!katexPromise) {
    katexPromise = (async () => {
      const [katexMod] = await Promise.all([
        import("katex"),
        import("katex/dist/katex.min.css"),
        // mhchem 扩展：支持 \ce{} 等化学方程式（副作用模块，须在渲染前加载）
        // @ts-ignore - contrib 模块无类型声明
        import("katex/dist/contrib/mhchem.js"),
      ]);
      return katexMod.default;
    })();
  }
  return katexPromise;
}

/**
 * 行内数学节点 math_inline
 * 对应 remark-math 的 mdast 节点 { type: "inlineMath", value }
 */
export const mathInlineSchema = $nodeSchema("math_inline", () => ({
  inline: true,
  group: "inline",
  atom: true,
  marks: "",
  selectable: true,
  draggable: false,
  defining: true,
  attrs: {
    value: { default: "", validate: "string" },
  },
  parseDOM: [
    {
      tag: "span[data-math-inline]",
      getAttrs: (dom: HTMLElement) => ({
        value: dom.getAttribute("data-value") ?? dom.textContent ?? "",
      }),
    },
  ],
  toDOM: (node: Node) => [
    "span",
    {
      class: "math-inline",
      "data-math-inline": "",
      "data-value": node.attrs.value as string,
    },
    node.attrs.value as string,
  ],
  parseMarkdown: {
    match: (node) => node.type === "inlineMath",
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? "" });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_inline",
    runner: (state, node) => {
      state.addNode("inlineMath", undefined, node.attrs.value as string);
    },
  },
}));

/**
 * 块级显示数学节点 math_display
 * 对应 remark-math 的 mdast 节点 { type: "math", value }
 */
export const mathDisplaySchema = $nodeSchema("math_display", () => ({
  group: "block",
  atom: true,
  marks: "",
  selectable: true,
  defining: true,
  attrs: {
    value: { default: "", validate: "string" },
    // 公式自动编号：运行时由 formula-numbering 插件设置，不参与 markdown 序列化
    number: { default: null },
  },
  parseDOM: [
    {
      tag: "div[data-math-display]",
      getAttrs: (dom: HTMLElement) => ({
        value: dom.getAttribute("data-value") ?? dom.textContent ?? "",
        number: null,
      }),
    },
  ],
  toDOM: (node: Node) => [
    "div",
    {
      class: "math-display",
      "data-math-display": "",
      "data-value": node.attrs.value as string,
    },
    node.attrs.value as string,
  ],
  parseMarkdown: {
    match: (node) => node.type === "math",
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? "" });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "math_display",
    runner: (state, node) => {
      state.addNode("math", undefined, node.attrs.value as string);
    },
  },
}));

/** 注册 remark-math：产生 inlineMath / math mdast 节点 */
export const remarkMathPlugin = $remark("remarkMath", () => remarkMath);

/** 用 KaTeX 渲染数学节点的 NodeView 工厂。双击节点可内联编辑 LaTeX 源码。
 * 导出供单测直接构造（issue #168 懒加载行为验证） */
export function createMathView(displayMode: boolean): NodeViewConstructor {
  return (node: Node, view: PMView, getPos: () => number | undefined): NodeView => {
    const dom = document.createElement(displayMode ? "div" : "span");
    dom.className = displayMode ? "math-display" : "math-inline";
    dom.setAttribute(displayMode ? "data-math-display" : "data-math-inline", "");
    dom.title = "双击编辑公式";

    let current = node;
    let editing = false;
    let editor: HTMLTextAreaElement | null = null;

    // issue #168：katex 改为异步加载，render 以 seq 守卫发射——
    // 加载返回时若已有更新的 render（节点值快速变化），丢弃旧结果
    let renderSeq = 0;
    const render = (value: string, number: number | null) => {
      const seq = ++renderSeq;
      dom.setAttribute("data-value", value);
      // 空公式：显示占位提示，避免 KaTeX 渲染空字符串导致节点不可见
      if (!value) {
        dom.classList.add("math-empty");
        dom.innerHTML = displayMode
          ? '<span class="math-placeholder">双击编辑公式</span>'
          : '<span class="math-placeholder">公式</span>';
        return;
      }
      dom.classList.remove("math-empty");
      void loadKatex().then((katex) => {
        if (seq !== renderSeq) return; // 已被后续渲染取代
        // display 公式启用自动编号时追加 \tag{n}（用户手写 \tag 时不覆盖）
        let expr = value;
        if (displayMode && number != null && !/\\tag\b/.test(value)) {
          expr = `${value} \\tag{${number}}`;
        }
        try {
          dom.innerHTML = katex.renderToString(expr, {
            displayMode,
            throwOnError: false,
            output: "html",
          });
        } catch {
          dom.textContent = value;
        }
      });
    };
    render(current.attrs.value as string, displayMode ? (current.attrs.number as number | null) : null);

    const startEdit = () => {
      if (editing) return;
      editing = true;
      editor = document.createElement("textarea");
      editor.className = "math-editor";
      editor.value = current.attrs.value as string;
      editor.spellcheck = false;
      editor.rows = displayMode ? 3 : 1;
      editor.placeholder = displayMode ? "输入 LaTeX 公式（如 a^2 + b^2 = c^2）" : "输入行内公式";
      dom.innerHTML = "";
      dom.appendChild(editor);
      requestAnimationFrame(() => editor?.focus());
    };

    const commitEdit = () => {
      if (!editing || !editor) return;
      const newVal = editor.value;
      editor = null;
      editing = false;
      render(newVal, displayMode ? (current.attrs.number as number | null) : null);
      if (newVal !== (current.attrs.value as string)) {
        const pos = getPos();
        if (pos != null) {
          view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, { value: newVal }),
          );
        }
      }
    };

    dom.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startEdit();
    });

    // 失焦提交：捕获阶段监听 focusout，判断焦点是否离开了 editor
    dom.addEventListener(
      "focusout",
      (e) => {
        if (!editing) return;
        const fe = e as FocusEvent;
        const related = fe.relatedTarget as HTMLElement | null;
        if (editor && related !== editor && !dom.contains(related)) {
          commitEdit();
        }
      },
      true,
    );

    return {
      dom,
      update: (next: Node) => {
        if (
          next.type.name !== (displayMode ? "math_display" : "math_inline")
        ) {
          return false;
        }
        // 编辑中不覆盖，避免打断输入
        if (editing) {
          current = next;
          return true;
        }
        if (
          next.attrs.value === current.attrs.value &&
          next.attrs.number === current.attrs.number
        ) {
          current = next;
          return true;
        }
        current = next;
        render(
          next.attrs.value as string,
          displayMode ? (next.attrs.number as number | null) : null,
        );
        return true;
      },
      // 编辑中拦截事件避免 ProseMirror 抢焦点
      stopEvent: () => editing,
      ignoreMutation: () => true,
    };
  };
}

export const mathInlineView = $view(mathInlineSchema.node, () =>
  createMathView(false),
);
export const mathDisplayView = $view(mathDisplaySchema.node, () =>
  createMathView(true),
);

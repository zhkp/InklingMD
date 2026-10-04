// YAML Front Matter 节点
// 文档顶部的 --- 围栏块通过 remark-frontmatter 解析为 mdast 的 { type: "yaml", value } 节点，
// 再映射到 ProseMirror 的 atom 块节点 frontmatter，渲染为带标签的代码块视图。
// markdown 源码保持原始 YAML 文本，便于静态站点生成器（Hugo/Hexo 等）直接消费。

import { $nodeSchema, $remark, $view } from "@milkdown/kit/utils";
import type { NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { NodeSelection } from "@milkdown/kit/prose/state";
import { EditorView, lineNumbers, highlightSpecialChars } from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  StreamLanguage,
  LanguageSupport,
} from "@codemirror/language";
import { yaml as yamlLegacy } from "@codemirror/legacy-modes/mode/yaml";
import remarkFrontmatter from "remark-frontmatter";

// 提前实例化 YAML 语言支持，避免每个 frontmatter 节点重复创建
const yamlSupport = new LanguageSupport(StreamLanguage.define(yamlLegacy));

/**
 * frontmatter 块节点
 * 对应 remark-frontmatter 的 mdast 节点 { type: "yaml", value }
 */
export const frontmatterSchema = $nodeSchema("frontmatter", () => ({
  group: "block",
  atom: true,
  marks: "",
  selectable: true,
  draggable: false,
  defining: true,
  isolating: true,
  attrs: {
    value: { default: "", validate: "string" },
  },
  parseDOM: [
    {
      tag: "div[data-frontmatter]",
      getAttrs: (dom: HTMLElement) => ({
        value: dom.getAttribute("data-value") ?? "",
      }),
    },
  ],
  toDOM: (node: Node) => [
    "div",
    {
      class: "frontmatter-block",
      "data-frontmatter": "",
      "data-value": node.attrs.value as string,
    },
  ],
  parseMarkdown: {
    match: (node) => node.type === "yaml",
    runner: (state, node, type) => {
      state.addNode(type, { value: (node.value as string) ?? "" });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === "frontmatter",
    runner: (state, node) => {
      state.addNode("yaml", undefined, node.attrs.value as string);
    },
  },
}));

/**
 * 注册 remark-frontmatter：识别文档首部 --- 围栏块为 yaml 节点。
 *
 * 必须显式传入 "yaml" 作为 initialOptions：
 * $remark 内部会执行 unified.use(plugin, options)，options 默认是 {} 空对象。
 * remark-frontmatter 内部用 `options || 'yaml'` 取 settings，但 {} 是 truthy，
 * 会让 settings 变成 {}，最终 frontmatter({}) 抛 "Missing `type` in matter `{}`"，
 * 导致 editor.create() 失败、ProseMirror 不渲染、整页白屏。
 */
export const remarkFrontmatterPlugin = $remark(
  "remarkFrontmatter",
  () => remarkFrontmatter,
  "yaml",
);

/** CodeMirror 宿主主题：与正文代码块风格保持一致 */
const cmTheme = EditorView.theme({
  "&": { fontSize: "0.82rem", backgroundColor: "transparent" },
  "&.cm-editor": { backgroundColor: "transparent" },
  ".cm-scroller": {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--text-muted)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-content": { padding: "0.4rem 0" },
});

/**
 * frontmatter 节点视图：内嵌 CodeMirror 编辑 YAML，编辑同步回 ProseMirror。
 * atom 节点，结构上不会被拆散到段落里。
 */
function createFrontmatterView(): NodeViewConstructor {
  return (node: Node, view: PMView, getPos: () => number | undefined): NodeView => {
    const dom = document.createElement("div");
    dom.className = "frontmatter-block";
    dom.setAttribute("data-frontmatter", "");
    dom.setAttribute("data-value", (node.attrs.value as string) ?? "");

    const label = document.createElement("div");
    label.className = "frontmatter-label";
    label.textContent = "YAML Front Matter";
    dom.appendChild(label);

    const cmHost = document.createElement("div");
    cmHost.className = "frontmatter-cm";
    dom.appendChild(cmHost);

    let updating = false;
    const cm = new EditorView({
      doc: (node.attrs.value as string) ?? "",
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        syntaxHighlighting(defaultHighlightStyle),
        yamlSupport,
        cmTheme,
        EditorView.updateListener.of((u) => {
          if (updating || !u.docChanged) return;
          const pos = getPos();
          if (pos == null) return;
          view.dispatch(
            view.state.tr.setNodeAttribute(
              pos,
              "value",
              cm.state.doc.toString(),
            ),
          );
        }),
      ],
    });
    cmHost.appendChild(cm.dom);

    // 点击 frontmatter 任意区域（含 CodeMirror 内部）时，先设置 NodeSelection
    // 选中整个 frontmatter 节点，再让 CodeMirror 接管编辑焦点。
    // 否则「删除块」按钮拿到的 selection 仍是文档其他位置，会误删别的块。
    const onMouseDown = (e: MouseEvent) => {
      const pos = getPos();
      if (pos == null) return;
      // 仅左键触发选中，右键留给上下文菜单
      if (e.button !== 0) return;
      try {
        const sel = NodeSelection.create(view.state.doc, pos);
        view.dispatch(view.state.tr.setSelection(sel));
      } catch {
        // 位置无效时静默失败
      }
    };
    dom.addEventListener("mousedown", onMouseDown, true);

    return {
      dom,
      ignoreMutation: () => true,
      // 仅当事件发生在 CodeMirror 内部时拦截（让 CM 接管键盘输入）；
      // 点击标签/边框等外部区域不拦截，使节点可被选中后用 Backspace/Delete 删除
      stopEvent: (event: Event) => {
        const target = event.target as HTMLElement | null;
        return !!target && cmHost.contains(target);
      },
      selectNode: () => cm.focus(),
      deselectNode: () => {},
      setSelection: () => cm.focus(),
      update: (next: Node) => {
        if (next.type.name !== "frontmatter") return false;
        const newVal = (next.attrs.value as string) ?? "";
        dom.setAttribute("data-value", newVal);
        if (newVal === cm.state.doc.toString()) return true;
        updating = true;
        cm.dispatch({
          changes: { from: 0, to: cm.state.doc.length, insert: newVal },
        });
        updating = false;
        return true;
      },
      destroy: () => {
        dom.removeEventListener("mousedown", onMouseDown, true);
        cm.destroy();
      },
    };
  };
}

/** frontmatter 节点视图注册 */
export const frontmatterView = $view(frontmatterSchema.node, () =>
  createFrontmatterView(),
);

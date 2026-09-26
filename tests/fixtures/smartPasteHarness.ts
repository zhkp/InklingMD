// Smart Paste 单测驱动（#219 / #229 / #220）
//
// 复用 tests/unit/source-mode-roundtrip.test.ts 的无头 Milkdown 范式：与 Editor.tsx
// 同款 schema / remark 插件 + history，装配真实的 smartPastePlugin / imageUploadPlugin /
// remoteImagePlugin，并通过在 view.dom 上派发 paste 事件走完整的 ProseMirror 粘贴链路
// （editHandlers.paste → parseFromClipboard → clipboardTextParser → handlePaste → dispatch）。

import type { Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Plugin } from "@milkdown/kit/prose/state";
import { TextSelection } from "@milkdown/kit/prose/state";
import { redo, undo } from "@milkdown/kit/prose/history";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  prosePluginsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { remarkMathPlugin, mathInlineSchema, mathDisplaySchema } from "../../src/components/Editor/math";
import { remarkFrontmatterPlugin, frontmatterSchema } from "../../src/components/Editor/frontmatter";
import { remarkTocPlugin, tocSchema } from "../../src/components/Editor/toc";
import { remarkCalloutPlugin, calloutSchema } from "../../src/components/Editor/callout";

export interface HarnessOptions {
  /** 初始 Markdown */
  markdown?: string;
  /**
   * 额外 ProseMirror 插件工厂（拿到 parse 以便构造 smartPastePlugin）。
   * 不传即「未装配 Smart Paste 的基线编辑器」，用于对照「行为与现在一致」。
   */
  plugins?: (parse: (md: string) => PMNode) => Plugin[];
}

export interface Harness {
  view: EditorView;
  parse: (md: string) => PMNode;
  serialize: (doc: PMNode) => string;
  markdown: () => string;
  /** 在 view.dom 上派发 paste 事件，返回事件是否被 preventDefault */
  paste: (data: Record<string, string>, files?: File[]) => boolean;
  undo: () => boolean;
  redo: () => boolean;
  /** 把光标放到文档末尾（最后一个文本块内） */
  cursorToEnd: () => void;
  /** 键盘输入文本（走 handleTextInput 之外的直接插入，模拟普通打字事务） */
  type: (text: string) => void;
  destroy: () => Promise<void>;
}

export function makePasteEvent(data: Record<string, string>, files: File[] = []): ClipboardEvent {
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => data[type] ?? "",
      types: Object.keys(data),
      files,
      items: [],
    },
  });
  return event;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const host = document.createElement("div");
  document.body.append(host);
  let parseRef: ((md: string) => PMNode) | null = null;
  const parseProxy = (md: string) => parseRef!(md);
  const editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, host);
      ctx.set(defaultValueCtx, options.markdown ?? "");
      if (options.plugins) {
        ctx.update(prosePluginsCtx, (ps) => [...ps, ...options.plugins!(parseProxy)]);
      }
    })
    .use(commonmark)
    .use(gfm)
    .use(remarkMathPlugin)
    .use(mathInlineSchema)
    .use(mathDisplaySchema)
    .use(remarkFrontmatterPlugin)
    .use(frontmatterSchema)
    .use(remarkTocPlugin)
    .use(tocSchema)
    .use(remarkCalloutPlugin)
    .use(calloutSchema)
    .use(history)
    .create();
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  const parse = editor.action((ctx) => ctx.get(parserCtx));
  const serialize = editor.action((ctx) => ctx.get(serializerCtx));
  parseRef = parse;

  return {
    view,
    parse,
    serialize,
    markdown: () => serialize(view.state.doc),
    paste(data, files = []) {
      const event = makePasteEvent(data, files);
      view.dom.dispatchEvent(event);
      return event.defaultPrevented;
    },
    undo: () => undo(view.state, view.dispatch),
    redo: () => redo(view.state, view.dispatch),
    cursorToEnd() {
      const end = TextSelection.atEnd(view.state.doc);
      view.dispatch(view.state.tr.setSelection(end));
    },
    type(text) {
      view.dispatch(view.state.tr.insertText(text));
    },
    destroy: async () => {
      await editor.destroy();
      host.remove();
    },
  };
}

/** 深度优先收集节点类型序列（结构等价比较用，忽略纯文本差异之外的 attrs） */
export function structure(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isText) {
      const marks = n.marks.map((m) => m.type.name).sort().join("+");
      out.push(marks ? `text[${marks}]` : "text");
    } else {
      const attrs: string[] = [];
      if (n.type.name === "heading") attrs.push(`level=${n.attrs.level}`);
      if (n.type.name === "code_block") attrs.push(`lang=${n.attrs.language ?? ""}`);
      if (n.type.name === "list_item" && n.attrs.checked != null) attrs.push(`checked=${n.attrs.checked}`);
      out.push(attrs.length ? `${n.type.name}(${attrs.join(",")})` : n.type.name);
    }
    return true;
  });
  return out;
}

/** 找第一个指定类型的节点 */
export function findNode(doc: PMNode, type: string): PMNode | undefined {
  let found: PMNode | undefined;
  doc.descendants((n) => {
    if (found) return false;
    if (n.type.name === type) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

/** 统计指定类型节点数 */
export function countNodes(doc: PMNode, type: string): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.type.name === type) n++;
    return true;
  });
  return n;
}

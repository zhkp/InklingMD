// Smart Paste（#217 Epic：#219）
//
// 网页/富文本 HTML：sanitizeHTML（粘贴模式）清洗 → htmlToMarkdown 结构映射 →
// 「Markdown 文本 → Milkdown parser → Slice」。**清洗必须在结构映射之前**：粘贴路径是
// 本特性最大的攻击面。Markdown 解析出口与「粘贴 Markdown 源码」（#229）共用。
//
// 不转换的情形（保持 ProseMirror 默认行为）：
// - 纯文本粘贴
// - 编辑器内部复制（HTML 带 data-pm-slice，默认路径能无损还原）
// - 代码编辑器 / IDE 复制的无结构着色 HTML（结构信息在 text/plain 里）
// - 光标在代码块内（默认路径按纯文本插入）；表格内（交给 prosemirror-tables 的粘贴逻辑）
// - 「粘贴为纯文本」（mod+shift+v，可在快捷键设置中自定义）
// - 源码模式（CodeMirror）本就只收纯文本，不经过本插件
//
// 一次粘贴 = 一个撤销步：粘贴事务前后都 closeHistory，不与相邻输入合并成同一撤销组。

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { Fragment, Slice, type Node as PMNode, type ResolvedPos, type Schema } from "@milkdown/kit/prose/model";
import { Transform } from "@milkdown/kit/prose/transform";
import { closeHistory } from "@milkdown/kit/prose/history";
import { isSafeUrl, sanitizeHTML } from "./html-view";
import { htmlToMarkdown } from "./html-to-markdown";
import { matchBinding, useShortcuts } from "../../store/shortcuts";

/** HTML 元素数上限：超出整体降级为纯文本（大内容粘贴的主线程保护） */
export const MAX_PASTE_HTML_ELEMENTS = 5000;

export interface SmartPasteDeps {
  /** Milkdown 的 Markdown 解析器（parserCtx），与打开文件用的是同一个 */
  parseMarkdown: (markdown: string) => PMNode | null | undefined;
}

export const smartPasteKey = new PluginKey("inkling-smart-paste");

/** 起始标签计数：DOM 解析之前的廉价上限估计 */
export function countHtmlElements(html: string): number {
  return html.match(/<[a-zA-Z]/g)?.length ?? 0;
}

/** 剥掉解析结果里不安全的链接/图片地址（javascript: 等），相对路径保留 */
function stripUnsafeUrls(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  doc.descendants((node, pos) => {
    if (node.type.name === "image" && !isSafeUrl(String(node.attrs.src ?? ""), true)) {
      const from = tr.mapping.map(pos);
      tr.delete(from, from + node.nodeSize);
      return false;
    }
    for (const mark of node.marks) {
      if (mark.type.name === "link" && !isSafeUrl(String(mark.attrs.href ?? ""), true)) {
        tr.removeMark(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize), mark);
      }
    }
    return true;
  });
  return tr.doc;
}

/** Markdown 文本 → 文档节点（解析失败或结果为空时返回 null） */
export function parsePastedMarkdown(
  markdown: string,
  parse: SmartPasteDeps["parseMarkdown"],
): PMNode | null {
  let doc: PMNode | null | undefined;
  try {
    doc = parse(markdown);
  } catch (e) {
    console.warn("Smart Paste：Markdown 解析失败，回退默认粘贴：", e);
    return null;
  }
  if (!doc || doc.childCount === 0 || (!doc.textContent && !hasLeafContent(doc))) return null;
  return stripUnsafeUrls(doc);
}

function hasLeafContent(doc: PMNode): boolean {
  let found = false;
  doc.descendants((n) => {
    if (found) return false;
    if (n.isAtom || (n.isLeaf && !n.isText)) found = n.type.name !== "hardbreak";
    return !found;
  });
  return found;
}

/**
 * 代码编辑器 / IDE 源码视图判定：清洗后只含 div/span/p/br 与无语言标识 pre/code 的 HTML。
 * VS Code、JetBrains 等复制时 text/html 只是一堆带颜色的 span，结构信息全在 text/plain 里。
 */
function isSourceLikeHtml(fragment: Node): boolean {
  const SOURCE_TAGS = new Set(["div", "span", "p", "br", "pre", "code"]);
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_ELEMENT);
  for (let el = walker.nextNode() as Element | null; el; el = walker.nextNode() as Element | null) {
    if (!SOURCE_TAGS.has(el.tagName.toLowerCase())) return false;
    if (/(?:^|\s)(?:language|lang|highlight-source)-/i.test(el.getAttribute("class") ?? "")) return false;
  }
  return true;
}

export type HtmlPasteRoute =
  /** 交还 ProseMirror 默认处理 */
  | { kind: "default" }
  /** 元素过多，整体降级为纯文本 */
  | { kind: "plain-text" }
  /** 转换得到的中间态 Markdown */
  | { kind: "convert"; markdown: string };

/** HTML 粘贴路由判定（纯函数，便于单测） */
export function routeHtmlPaste(html: string, types: readonly string[] = []): HtmlPasteRoute {
  if (!html.trim()) return { kind: "default" };
  // 编辑器内部复制：ProseMirror 自带的序列化能无损还原，不做二次转换
  if (/data-pm-slice/.test(html)) return { kind: "default" };
  if (types.includes("vscode-editor-data")) return { kind: "default" };
  if (countHtmlElements(html) > MAX_PASTE_HTML_ELEMENTS) return { kind: "plain-text" };
  // 安全：先清洗，结构映射只处理清洗后的 DOM
  const fragment = sanitizeHTML(html, { mode: "paste" });
  if (isSourceLikeHtml(fragment)) return { kind: "default" };
  const markdown = htmlToMarkdown(fragment);
  if (!markdown.trim()) return { kind: "default" };
  return { kind: "convert", markdown };
}

/**
 * 解析结果 → 待插入的 Slice。只有首/尾块是段落时才「打开」该端，让它与光标所在段落
 * 合并（行内粘贴的自然语义）；标题、列表、代码块、表格等保持闭合、作为独立块插入——
 * 否则 Slice.maxOpen 会把首个标题的文字并进当前段落，标题语义丢失。
 */
export function sliceForInsertion(content: Fragment): Slice {
  const max = Slice.maxOpen(content, false);
  const openStart = content.firstChild?.type.name === "paragraph" ? max.openStart : 0;
  const openEnd = content.lastChild?.type.name === "paragraph" ? max.openEnd : 0;
  return new Slice(content, openStart, openEnd);
}

function plainTextSlice(schema: Schema, text: string): Slice {
  const paragraphs = text.split(/(?:\r\n?|\n)+/).map((line) =>
    schema.nodes.paragraph.create(null, line ? schema.text(line) : null),
  );
  return Slice.maxOpen(Fragment.fromArray(paragraphs));
}

interface PreparedHtmlPaste {
  slice: Slice;
}

/** 按路由结果准备待插入内容；返回 null 表示交还 ProseMirror 默认处理 */
function prepareHtmlPaste(
  route: HtmlPasteRoute,
  html: string,
  text: string,
  schema: Schema,
  parse: SmartPasteDeps["parseMarkdown"],
): PreparedHtmlPaste | null {
  switch (route.kind) {
    case "default":
      return null;
    case "plain-text":
      return { slice: plainTextSlice(schema, text || htmlToText(html)) };
    case "convert": {
      const doc = parsePastedMarkdown(route.markdown, parse);
      return doc ? { slice: sliceForInsertion(doc.content) } : null;
    }
  }
}

function htmlToText(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

function inTableOrCode($pos: ResolvedPos): boolean {
  if ($pos.parent.type.spec.code) return true;
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.spec.tableRole) return true;
  }
  return false;
}

/** 以单个撤销步插入 slice（与 ProseMirror doPaste 一致的插入语义） */
function dispatchPaste(view: EditorView, slice: Slice): { from: number; to: number } {
  const from = view.state.selection.from;
  const single =
    slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
      ? slice.content.firstChild
      : null;
  const tr = closeHistory(view.state.tr);
  if (single) tr.replaceSelectionWith(single, false);
  else tr.replaceSelection(slice);
  tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste");
  const start = tr.mapping.map(from, -1);
  const end = tr.selection.to;
  view.dispatch(tr);
  // 收口：粘贴后紧接着的输入另起撤销组
  view.dispatch(closeHistory(view.state.tr));
  return { from: start, to: end };
}

async function readClipboardText(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? "";
  } catch {
    return "";
  }
}

/** 浏览器原生就会把 mod+shift+v 作为「粘贴为纯文本」派发 paste 事件的组合 */
const NATIVE_PLAIN_PASTE_BINDING = "mod+shift+v";

export const smartPastePlugin = (deps: SmartPasteDeps) => {
  // 「粘贴为纯文本」快捷键已按下，等待本次 paste 事件
  let plainArmed = false;
  // 兜底读取剪贴板后，吞掉紧随其后的原生 paste，防止重复粘贴
  let swallowPasteUntil = 0;
  // 当前 paste 事件（handleDOMEvents 记录、transformPastedHTML 消费）
  let pasteEvent: ClipboardEvent | null = null;
  // transformPastedHTML 接管后准备好的插入内容，由同一次 doPaste 内的 handlePaste 派发
  let pendingHtml: PreparedHtmlPaste | null = null;

  const pastePlain = (view: EditorView, text: string) => {
    if (!text || view.isDestroyed) return;
    view.focus();
    view.pasteText(text);
  };

  return new Plugin({
    key: smartPasteKey,
    props: {
      handleKeyDown(view, event) {
        const binding = useShortcuts.getState().getBinding("pastePlainText");
        if (!binding || !matchBinding(binding, event)) return false;
        if (binding !== NATIVE_PLAIN_PASTE_BINDING) {
          // 自定义组合不会触发原生粘贴：直接读剪贴板
          void readClipboardText().then((text) => pastePlain(view, text));
          return true;
        }
        // 默认组合：Chromium 系 WebView 会原生派发 paste 事件，交给 handleDOMEvents 处理；
        // 不派发的平台（macOS WKWebView）由下面的兜底读剪贴板
        plainArmed = true;
        setTimeout(() => {
          if (!plainArmed) return;
          plainArmed = false;
          swallowPasteUntil = Date.now() + 500;
          void readClipboardText().then((text) => pastePlain(view, text));
        }, 50);
        return false;
      },
      handleDOMEvents: {
        paste(view, event) {
          pendingHtml = null;
          pasteEvent = null;
          if (Date.now() < swallowPasteUntil) {
            event.preventDefault();
            return true;
          }
          if (plainArmed) {
            plainArmed = false;
            event.preventDefault();
            pastePlain(view, event.clipboardData?.getData("text/plain") ?? "");
            return true;
          }
          // 记下本次粘贴事件：transformPastedHTML 也会在拖放时被调用，要靠它区分
          pasteEvent = event;
          return false;
        },
        drop() {
          pasteEvent = null;
          pendingHtml = null;
          return false;
        },
      },
      // HTML 路径在这里接管：ProseMirror 随后会对返回的 HTML 做 readHTML（含内联 <style>
      // 规则）与 parseSlice。接管时返回空串，让默认解析零成本——5000 元素的主线程保护
      // 必须在这一步之前生效，否则保护形同虚设
      transformPastedHTML(html, view) {
        const event = pasteEvent;
        pasteEvent = null;
        if (!event || inTableOrCode(view.state.selection.$from)) return html;
        const data = event.clipboardData;
        const text = data?.getData("text/plain") ?? "";
        try {
          const prepared = prepareHtmlPaste(
            routeHtmlPaste(html, Array.from(data?.types ?? [])),
            html,
            text,
            view.state.schema,
            deps.parseMarkdown,
          );
          if (!prepared) return html;
          pendingHtml = prepared;
          return "";
        } catch (e) {
          console.warn("Smart Paste：HTML 转换失败，回退默认粘贴：", e);
          return html;
        }
      },
      handlePaste(view) {
        const prepared = pendingHtml;
        pendingHtml = null;
        pasteEvent = null;
        if (!prepared) return false;
        dispatchPaste(view, prepared.slice);
        return true;
      },
    },
  });
};

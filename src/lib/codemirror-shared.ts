// CodeMirror 6 共享主题与扩展工厂
// 供代码块 NodeView 与源代码模式编辑器复用

import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { replaceNext, search, searchKeymap } from "@codemirror/search";
import type { CodeBlockTheme } from "../store/settings";

/** CodeMirror 基础主题：编辑器外观、行号、字体 */
export const sharedCodeMirrorBaseTheme = EditorView.theme({
  "&": {
    fontSize: "0.85rem",
    backgroundColor: "transparent",
    color: "var(--code-block-text, var(--text, #1f2328))",
  },
  "&.cm-editor": {
    backgroundColor: "transparent",
  },
  ".cm-scroller": {
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    lineHeight: "1.5",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--code-block-muted, var(--text-muted, #6e7681))",
    border: "none",
    borderRight: "1px solid var(--code-block-gutter-border, var(--border, #d0d7de))",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(175, 184, 193, 0.15)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(175, 184, 193, 0.1)",
  },
  ".cm-content": {
    padding: "0.4rem 0",
    caretColor: "var(--code-block-focus, #528bff)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--code-block-focus, #528bff)",
  },
});

/** 根据主题名返回 CodeMirror 主题扩展 */
export function codeThemeExt(name: CodeBlockTheme): Extension[] {
  switch (name) {
    case "oneDark":
      return [oneDark];
    case "light":
      return [syntaxHighlighting(defaultHighlightStyle)];
    case "none":
      return [];
  }
}

/** 源码模式用的 GFM Markdown 语言支持 */
export function createMarkdownLanguageSupport() {
  return markdown();
}

export interface SourceModeExtensionOpts {
  codeBlockTheme: CodeBlockTheme;
  /** 是否只读（fallback 不用这个函数） */
  readOnly?: boolean;
  /** 是否启用浏览器拼写检查 */
  spellcheck?: boolean;
}

/** 源代码模式 CodeMirror 扩展组合 */
export function createSourceModeExtensions(opts: SourceModeExtensionOpts): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    highlightActiveLine(),
    bracketMatching(),
    indentOnInput(),
    history(),
    // defaultKeymap 提供标准导航/编辑键（Ctrl+Home/End、方向键、词移动等）；
    // 此前仅绑定 historyKeymap + indentWithTab，源码模式下这些键全部无效
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    // 内置查找替换（issue #29）：源码模式下 Ctrl+F / Ctrl+R 使用 CM 面板，
    // 与 WYSIWYG 的 SearchPanel 互斥（App.tsx 在源码模式把快捷键路由到这里）。
    // 新版 @codemirror/search 已把替换框内建进搜索面板，Mod-r 用 replaceNext
    // （未选中匹配时打开面板，选中匹配时逐个替换）。
    search({ top: true }),
    keymap.of([...searchKeymap, { key: "Mod-r", run: replaceNext }]),
    sharedCodeMirrorBaseTheme,
    createMarkdownLanguageSupport(),
    EditorView.lineWrapping,
  ];
  exts.push(...codeThemeExt(opts.codeBlockTheme));
  if (opts.readOnly) {
    exts.push(EditorView.editable.of(false));
  }
  if (opts.spellcheck) {
    exts.push(EditorView.contentAttributes.of({ spellcheck: "true" }));
  }
  return exts;
}

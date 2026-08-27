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
  type KeyBinding,
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

/**
 * defaultKeymap 提供标准导航/编辑键（Ctrl+Home/End、方向键、词移动等）；
 * 此前仅绑定 historyKeymap + indentWithTab，源码模式下这些键全部无效。
 *
 * 过滤与应用级全局快捷键冲突的绑定（issue #136 review 问题 2）：
 * CM keymap 命中后只 preventDefault、不 stopPropagation，事件继续冒泡到
 * window 级全局处理器造成双重触发。
 * - "Mod-/"（toggleComment）与全局 showShortcuts（默认 mod+/）冲突
 * - "Ctrl-n"（cursorLineDown）与硬编码 Ctrl+N 新建草稿冲突；
 *   defaultKeymap 内嵌的 emacsStyleKeymap 同时以 key 与 mac 两种形态存在，
 *   两者都要过滤，否则 macOS 上 mac 变体仍会命中
 * 过滤后应用级语义在两种模式下一致（帮助面板 / 新建草稿）。
 */
const sourceModeDefaultKeymap = defaultKeymap.filter(
  (b) => b.key !== "Mod-/" && b.key !== "Ctrl-n" && b.mac !== "Ctrl-n",
);

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
    keymap.of([...sourceModeDefaultKeymap, ...historyKeymap, indentWithTab]),
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

/**
 * 把 CM 键位记法转成应用绑定格式（如 "Mod-Shift-z" → "mod+shift+z"）。
 * 无 Ctrl/Cmd 修饰键的组合（如 "Alt-A"、"F3"）不在自定义捕获范围内，返回 null。
 */
export function cmKeyToBinding(key: string | undefined): string | null {
  if (!key) return null;
  const parts = key.split("-").map((p) => p.toLowerCase());
  const hasMod = parts.some((p) => p === "mod" || p === "cmd" || p === "ctrl");
  if (!hasMod) return null;
  const hasShift = parts.includes("shift");
  const hasAlt = parts.includes("alt");
  const main = parts[parts.length - 1];
  if (["mod", "cmd", "ctrl", "shift", "alt"].includes(main)) return null;
  const out = ["mod"];
  if (hasShift) out.push("shift");
  if (hasAlt) out.push("alt");
  out.push(main);
  return out.join("+");
}

/**
 * 源码模式下 CM 内建 keymap 实际处理的全部 mod 组合（应用绑定格式）。
 * 供快捷键自定义的冲突检测使用：这些组合已被源码编辑器占用，把应用级
 * 快捷键绑到上面会在源码模式双重触发（issue #136 review 补盲点）。
 * 数据直接从启用的 keymap 数组派生，避免手工维护清单漂移。
 */
export function getSourceModeConflictBindings(): string[] {
  const out: string[] = [];
  const bindings: KeyBinding[] = [
    ...sourceModeDefaultKeymap,
    ...historyKeymap,
    ...searchKeymap,
    { key: "Mod-r" },
  ];
  for (const b of bindings) {
    for (const variant of [b.key, b.mac, b.win, b.linux]) {
      if (!variant) continue;
      // KeyBinding.shift 隐式追加一条 Shift- 前缀绑定
      const keys = b.shift ? [variant, `Shift-${variant}`] : [variant];
      for (const k of keys) {
        const binding = cmKeyToBinding(k);
        if (binding && !out.includes(binding)) out.push(binding);
      }
    }
  }
  return out;
}

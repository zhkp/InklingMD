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

/**
 * 与 App.css `.code-block-placeholder` 保持一致的等宽字体族。
 * 两处必须同步修改：占位文本在 CodeMirror 挂载前渲染，字体不同会造成可见跳变。
 */
export const MONO_FONT_FAMILY =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

/**
 * CM 宿主主题工厂（#310 评审阻塞项 1）。
 *
 * 为什么这些声明必须由 CM theme（style-mod 运行时注入）承载、不能写在 App.css：
 * CodeMirror 的样式由 style-mod 在运行时以「未分层」<style> 注入到 <head> 首位
 * （`node_modules/style-mod/src/style-mod.js:100,136-138`）。按级联层规则，同源普通
 * 声明中未分层恒胜分层——与特异性无关。所以 #224 把 18 个样式入口放进 @layer base
 * 之后，App.css 里任何 `.cm-*` 覆盖规则都会**必然失效**（字体、行号栏底色/颜色/右边框
 * 全部反转）。故 CM 宿主的一切外观只允许经由本主题交付。
 *
 * 为什么部分选择器要自提特异性（`&.cm-editor …`）：
 * CM 把主题模块按 `styleModules.concat(baseTheme).reverse()` 挂载，同特异性规则的
 * 先后由**数组位置**决定；代码块宿主的扩展数组把高亮主题放在最前，于是高亮主题
 * （oneDark 等）反而比宿主主题后挂载、优先级更高（`.cm-gutters { color: #7d8799 }`
 * 会压掉应用的 `--code-block-muted: #5c6370`）。App.css 时代这些属性靠优先级胜出，
 * 迁进主题后必须显式提升到 0-3-0 才能与迁移前逐项一致，而不是依赖挂载顺序。
 * 仅「原由 App.css 覆盖」的属性做提升；`.cm-activeLine` / 光标 / 内边距等保持默认
 * 特异性，继续让高亮主题按原有关系覆盖。
 *
 * 颜色一律走 `--code-block-*` 元素级 token + 兜底：代码块宿主（`.code-block` 上定义了
 * 这些 token）取主题配色；源代码模式 / frontmatter 等无该 token 的宿主自动回退全局值。
 */
function cmHostTheme(
  fontFamily: string,
  rootExtra: Record<string, string> = {},
): Extension {
  return EditorView.theme({
    "&": {
      fontSize: "0.85rem",
      backgroundColor: "transparent",
      // 双宿主复用：代码块内有 --code-block-* 元素级作用域；源代码模式下无，
      // 回退到全局 --text（故最内层 hex 已随 #223 回退值清理移除）
      color: "var(--code-block-text, var(--text))",
      ...rootExtra,
    },
    // 代码块容器底色（App.css `.code-block` 提供 --code-block-bg）；
    // 无该 token 的宿主（源代码模式）保持透明
    "&.cm-editor": {
      backgroundColor: "var(--code-block-bg, transparent)",
    },
    "&.cm-editor .cm-scroller": {
      fontFamily,
      lineHeight: "1.5",
      overflow: "auto",
    },
    // 行号栏：底色 / 文字色 / 右边框在迁移前都是应用级覆盖（#223 令牌落点），
    // 必须压过任意代码高亮主题
    "&.cm-editor .cm-gutters": {
      backgroundColor: "var(--code-block-gutter-bg, transparent)",
      color: "var(--code-block-muted, var(--text-muted))",
      border: "none",
      borderRight: "1px solid var(--code-block-gutter-border, var(--border))",
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
}

/** 代码块宿主的共享基础主题（等宽字体） */
export const sharedCodeMirrorBaseTheme = cmHostTheme(MONO_FONT_FAMILY);

/**
 * 源代码模式宿主主题：字体跟随 `--editor-font`（#223 新增的字体落点，供 #306 主题字体映射）。
 * `height: 100%` 原为 App.css `.source-mode-cm-host .cm-editor`，随本批迁入以保持
 * 「应用样式全在层内」。
 */
export const sourceModeCodeMirrorTheme = cmHostTheme("var(--editor-font)", {
  height: "100%",
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
 * 过滤与应用级全局快捷键冲突的绑定（issue #136 review 补盲点）：
 * CM keymap 命中后只 preventDefault、不 stopPropagation，事件继续冒泡到
 * window 级全局处理器造成双重触发。
 * - "Mod-/"（toggleComment）与全局 showShortcuts（默认 mod+/）冲突
 * - "Ctrl-n"（cursorLineDown）与硬编码 Ctrl+N 新建草稿冲突；
 *   defaultKeymap 里它是内嵌 emacsStyleKeymap 的 mac 变体（仅 mac: "Ctrl-n"，
 *   无 key: "Ctrl-n"），因此 b.key 过滤不命中、需按 mac 过滤才生效，
 *   否则 macOS 上 mac 变体仍会命中（b.key 过滤为无害死代码，保留以防依赖升级）
 * - "Ctrl-p"（cursorLineUp，shift 变体为 selectLineUp）与全局 quickOpen
 *   （默认 mod+p，#228）冲突：同属内嵌 emacsStyleKeymap，此处是 key: "Ctrl-p"
 *   的常规变体；不过滤则源码模式下 Ctrl+P 会「先上移一行、再弹出快速打开」。
 *   两个变体一起过滤，故 mod+p 与 mod+shift+p 都不再被 CM 占用。
 * 过滤后应用级语义在两种模式下一致（帮助面板 / 新建草稿 / 快速打开）。
 */
const sourceModeDefaultKeymap = defaultKeymap.filter(
  (b) =>
    b.key !== "Mod-/" &&
    b.key !== "Ctrl-n" &&
    b.mac !== "Ctrl-n" &&
    b.key !== "Ctrl-p" &&
    b.mac !== "Ctrl-p",
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
    // 源码模式用带 --editor-font 的宿主主题；顺序无所谓（见 cmHostTheme 注释）
    sourceModeCodeMirrorTheme,
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

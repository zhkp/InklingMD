/**
 * #225 §4.2 / §4.3：主题与自定义 CSS 的注入管线。
 *
 * 冻结口径（issue #225「设计补充」C1/§4.2 + 契约 G5/G6/G10/N3/N5/N8/N11-2）：
 * - 主题注入 `<style id="inkling-theme">`，内容包 `@layer theme { … }`；
 *   自定义 CSS 注入 `<style id="inkling-custom-theme">`，内容包 `@layer user { … }`（最高层，**不剥 `!important`**）；
 * - **N8**：主题 `<style>` 推迟到**一个微任务**注入 —— 静态 import 的模块图求值同步，微任务时
 *   `base` 层块（App.css / 组件 / vendor）已就绪 → 即使 `@layer` statement 被 CSP 拦 / 被误删 /
 *   被 Vite 重排，层序自然仍是 `base → theme → user`；`data-theme` 仍在模块顶层**同步写**（反 FOUC 不受影响）；
 * - **N5**：不引入 `#inkling-style-host` 与 `MutationObserver`；插入协议 = 注入到 `<head>` 末尾；
 * - **N11-2（安全）**：主题 CSS 是不可信输入 → **必须 `textContent`**（禁止 `innerHTML` / 字符串拼接进 HTML）。
 */
import type { ThemeMode } from "./typora/metadata";

/** 元素 id（与 `tests/fixtures/theme-entries.json` 的登记一致，S13/S15/S16 按此断言） */
export const THEME_STYLE_ID = "inkling-theme";
export const USER_STYLE_ID = "inkling-custom-theme";
export const LAYER_STATEMENT_ID = "inkling-layer-statement";

export const THEME_LAYER = "theme";
export const USER_LAYER = "user";

/** 主题样式在 `<head>` 中的顺序观测量（S7 冒烟用） */
export const INJECTION_ORDER = [LAYER_STATEMENT_ID, THEME_STYLE_ID, USER_STYLE_ID] as const;

/** 同一次同步写落盘：`themeId` 权威、`data-theme` 派生（§3.2/C3） */
export function writeThemeAttributes(themeId: string, mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  root.setAttribute("data-theme-id", themeId);
}

export function clearThemeAttributes(): void {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute("data-theme-id");
}

export function readThemeIdAttribute(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement.getAttribute("data-theme-id");
}

/** 把 CSS 包进指定 layer（内容原样，仅首尾包裹；`textContent` 写入） */
export function wrapInLayer(css: string, layer: string): string {
  return `@layer ${layer} {\n${css.trim()}\n}`;
}

/**
 * 拆分表首 `@import`（N11-2 之外的实测细节）：`@import` 属于「表首限定」，
 * 放进 `@layer { }` 块内会被浏览器忽略 → 提到 layer 包裹之前原样保留。
 *
 * ⚠️ 「合法表首」不等于「只有空白/注释」：按 Cascade 5，`@import` 必须前于所有规则，
 * **`@charset` 与 `@layer <names>;` 语句除外**。所以表首 trivia 还要吃掉这两类语句
 * （资源头部常见 `@charset "utf-8";`；用户 CSS 也常用 `@layer a, b;` 声明层序），
 * 否则它们会挡住 `@import` 外提 → `@import` 落进 layer 块内被浏览器**静默忽略**（回归）。
 */
export function splitLeadingImports(css: string): { imports: string[]; rest: string } {
  const imports: string[] = [];
  let rest = css.replace(/^\uFEFF/, "");
  // 目标形态：`@import "x.css"` / `'x.css'` / `url(x.css)` / `url("x.css")`（后接媒体条件也可）
  const importHead = /@import\s+(?:url\(\s*(?:"[^"]*"|'[^']*'|[^)\s]+)\s*\)|"[^"]*"|'[^']*')/i;
  // 表首 trivia = 空白 / 注释 / `@charset …;` / `@layer …;` 语句（可任意重复与混排）
  const leadingTrivia = /^(?:\s+|\/\*[\s\S]*?\*\/|@charset\s+[^;{}]*;|@layer\s+[^;{}]*;)*/i;
  for (;;) {
    const trivia = leadingTrivia.exec(rest)![0];
    const tail = rest.slice(trivia.length);
    const m = importHead.exec(tail);
    if (!m || m.index !== 0) break;
    const end = tail.indexOf(";", m[0].length);
    if (end < 0) break;
    // 连同其前的 trivia（注释 / `@charset` / `@layer` 语句）一起外提：
    // 它们同属「表首限定」允许的前置内容，外提后仍位于样式表最前，且不丢用户内容。
    imports.push(rest.slice(0, trivia.length + end + 1).trim());
    rest = rest.slice(trivia.length + end + 1);
  }
  return { imports, rest: rest.trim() };
}

function styleElement(id: string): HTMLStyleElement {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLStyleElement) return existing;
  existing?.remove();
  const el = document.createElement("style");
  el.id = id;
  return el;
}

/**
 * 写入/移除一个样式元素（**唯一写 CSS 的函数**；`textContent` 写入，S15 函数级断言的登记点）。
 * 内容为空则移除元素，不留空样式表。
 */
function writeStyle(id: string, css: string | null): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(id);
  if (css === null || css.trim() === "") {
    el?.remove();
    return;
  }
  const style = styleElement(id);
  // 幂等：内容相同则不触碰 DOM（避免无谓的样式重算与 S7 顺序观测抖动）
  if (style.textContent === css && style.parentNode === document.head) return;
  style.textContent = css;
  if (style.parentNode !== document.head) document.head.appendChild(style);
}

// ── 主题样式（微任务注入，N8） ───────────────────────────────────────────────

let pendingThemeCss: string | null = null;
let themeFlushScheduled = false;

function flushThemeCss(): void {
  themeFlushScheduled = false;
  const css = pendingThemeCss;
  writeStyle(THEME_STYLE_ID, css === null ? null : wrapInLayer(css, THEME_LAYER));
}

/**
 * 注入主题 CSS（`@layer theme`）。`null` = 卸载（内置基线没有独立样式表）。
 * 真正的 DOM 写入推迟到一个微任务（N8）；多次调用只保留最后一次。
 */
export function injectThemeCss(css: string | null): void {
  pendingThemeCss = css;
  if (themeFlushScheduled) return;
  themeFlushScheduled = true;
  queueMicrotask(flushThemeCss);
}

/** 同步冲刷待注入的主题样式（E2E / 单测需要确定性时序时使用；产品路径不需要） */
export function flushThemeInjection(): void {
  if (themeFlushScheduled) flushThemeCss();
}

/** 已注入的主题 CSS（含 layer 包裹；断言/调试用） */
export function readInjectedThemeCss(): string | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(THEME_STYLE_ID)?.textContent ?? null;
}

// ── 自定义 CSS（`@layer user`，最高层；N3：不剥 !important） ────────────────

/**
 * 自定义 CSS 的**最终文本**（纯函数，便于 E2E/单测对同一产物做真实浏览器验证）：
 * 表首 `@import`（及其前置的注释 / `@charset` / `@layer …;` 语句）外提到 `@layer user` 之外，
 * 其余规则包进 `@layer user { … }`。
 */
export function buildUserCss(css: string): string {
  const { imports, rest } = splitLeadingImports(css);
  const body = wrapInLayer(rest, USER_LAYER);
  return imports.length > 0 ? `${imports.join("\n")}\n${body}` : body;
}

export function injectUserCss(css: string | null): void {
  if (css === null || css.trim() === "") {
    writeStyle(USER_STYLE_ID, null);
    return;
  }
  writeStyle(USER_STYLE_ID, buildUserCss(css));
}

export function readInjectedUserCss(): string | null {
  if (typeof document === "undefined") return null;
  return document.getElementById(USER_STYLE_ID)?.textContent ?? null;
}

/** 测试用：清空所有注入状态（不动 DOM） */
export function resetInjectionStateForTests(): void {
  pendingThemeCss = null;
  themeFlushScheduled = false;
}

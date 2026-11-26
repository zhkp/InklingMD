import { describe, it, expect } from "vitest";
import {
  balancedBlock,
  expandEntries,
  maskComments,
  readFixture,
  readSrc,
  referencedTokens,
} from "../helpers/theme-css";

/**
 * 判定一行（注释已剥）是否**命中 CodeMirror 的生成类/文档类名**（S17 守卫的唯一判据）。
 *
 * 抽成导出函数是为了让「逃逸写法表」直接对它做表驱动负例。上一版把正则内联在用例里、
 * 且要求 `cm-` 后**紧跟小写字母**，于是 `[class*="cm-"]`（一条属性选择器即命中**所有** CM 元素）
 * 等写法全部逃逸，而注释却声称覆盖 —— PR #324 复核阻塞项。改模式必须同时让下面那张表继续全绿。
 */
export function looksLikeCmSelector(line: string): boolean {
  // ① 类选择器 `.cm-x`
  if (/\.cm-[a-z]/.test(line)) return true;
  // ② 属性选择器：`[class…` 里出现 `cm-`。**不要求后续字母** —— 否则 `[class*="cm-"]` /
  //    `[class^="cm-"]` / `[class|="cm-"]` / `[class$="-dark"]` 全部逃逸。
  if (/\[class[^\]]*cm-/.test(line)) return true;
  // ③ 属性选择器：不含连字符的 `cm` 形态（`[class^="cm"]` / `[class="cm"]` / `[class*="cm"]`）
  if (/\[class[~^|*$]?=\s*["']?cm\b/.test(line)) return true;
  return false;
}

/**
 * 逃逸写法表（必须全部拦下）：新增写法先进这张表，再改 `looksLikeCmSelector`。
 *
 * 边界（有意不拦）：不含 `cm` 词元的属性选择器（如 `[class$="-dark"]`、`[class*="editor"]`）。
 * 判据只能锚在「命中 CodeMirror 的类名词元」上 —— 这类写法无法归因到 CM，硬拦会误伤应用自有类
 * （`-dark` 这类后缀在应用里很常见）。S17 的职责是「不许在分层 CSS 里**指向 CM 的类**」，
 * 不是「禁止一切属性选择器」。（PR #324 复核列出的 `[class$="-dark"]` 属前者，故不入表。）
 */
const CM_SELECTOR_ESCAPES: string[] = [
  ".cm-content { color: red }",
  '[class~="cm-content"] { color: red }',
  '[class*="cm-"] { color: red }',
  '[class^="cm-"] { color: red }',
  '[class|="cm-"] { color: red }',
  "[class*='cm-'] { color: red }",
  '[class^="cm"] { color: red }',
  '[class="cm"] { color: red }',
  ".foo[class*='cm-'] { color: red }",
];

/** 反例（不许误报）：应用自有类名里含 `cm` 字样，但都不是 CodeMirror 的类。 */
const NON_CM_SELECTORS: string[] = [
  ".my-cm-thing { color: red }",
  ".cmx-content { color: red }",
  "--content-cm-foo: 1px;",
  '[class*="frontmatter"] { color: red }',
  ".editor-scroll .milkdown .mermaid-toolbar button { color: var(--text) }",
];

// #224 S17（#310 评审阻塞项 1 的防复发断言）。
//
// 背景：CodeMirror 的样式由 style-mod 在运行时以「未分层」<style> 注入到 <head> 首位
// （node_modules/style-mod/src/style-mod.js:100,136-138）。按 CSS 级联层规则，同源普通
// 声明中**未分层恒胜分层**，与特异性无关 —— 所以 #224 把 18 个样式入口放进 @layer base
// 之后，App.css 里任何 `.cm-*` 覆盖声明都会静默失效（源码模式字体、代码块行号栏的
// 底色/文字色/右边框全部反转，CI 看不见）。
//
// 结论：CM 宿主的一切外观只允许由 `EditorView.theme`（→ 同样走 style-mod，天然同层竞争）
// 交付。本文件把这条约束固定成静态断言。
describe("S17 CM 宿主外观只能由 EditorView.theme 交付", () => {
  const fixture = readFixture();

  it("应用样式入口（App.css + 15 组件 CSS）中不存在 .cm-* 选择器", () => {
    const offenders: string[] = [];
    for (const rel of expandEntries(fixture.tokenDefinitionFiles)) {
      maskComments(readSrc(rel))
        .split("\n")
        .forEach((line, i) => {
          // 类选择器 `.cm-x`，以及**属性选择器**写法（`[class~="cm-content"]` / `[class*="cm-"]`）——
          // 后者同样能命中 CodeMirror 的生成类/文档类名，但逃过 `/\.cm-[a-z]/`（#313 附带项）。
          if (looksLikeCmSelector(line)) {
            offenders.push(`${rel}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      `这些声明在入层后必然被 CodeMirror 运行时样式压掉，请移入 cmHostTheme：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // PR #324 复核阻塞项：把判据抽成函数 + 用逃逸写法表固化（含 `[class*="cm-"]` 这类
  // 「一条规则命中所有 CM 元素」的写法）。改回窄模式会立刻让这两条失败。
  it.each(CM_SELECTOR_ESCAPES)("守卫拦下 CM 选择器的逃逸写法：%s", (line) => {
    expect(looksLikeCmSelector(line)).toBe(true);
  });

  it.each(NON_CM_SELECTORS)("守卫不误报非 CM 选择器：%s", (line) => {
    expect(looksLikeCmSelector(line)).toBe(false);
  });

  it("从 App.css 搬走的 token 仍由 CM 宿主主题消费（防「只删声明、不留落点」）", () => {
    const referenced = new Set(
      fixture.cmHostTheme.files.flatMap((f) => referencedTokens(readSrc(f))),
    );
    const missing = fixture.cmHostTheme.requiredRefs.filter((t) => !referenced.has(t));
    expect(missing, "CM 宿主主题必须继续消费这些 token（否则 token 变死代码）").toEqual([]);
  });

  it("源码模式字体落点是 --editor-font，而非硬编码字体族", () => {
    const src = readSrc("src/lib/codemirror-shared.ts");
    expect(src).toContain("var(--editor-font)");
  });

  it("懒挂载占位字体与 MONO_FONT_FAMILY 逐字符一致（避免挂载瞬间布局跳变）", () => {
    const { cssFile, selector, tsFile, tsConst } = fixture.cmHostTheme.placeholderFont;
    const block = balancedBlock(maskComments(readSrc(cssFile)), selector);
    expect(block, `${cssFile} 缺少 ${selector}`).not.toBeNull();
    const decl = /font-family:\s*([^;]+);/.exec(block!)![1].trim();
    const ts = readSrc(tsFile);
    const m = new RegExp(`${tsConst}\\s*=\\s*\\n?\\s*(['"])([\\s\\S]*?)\\1;`).exec(ts);
    expect(m, `${tsFile} 缺少常量 ${tsConst}`).not.toBeNull();
    expect(decl).toBe(m![2]);
  });
});

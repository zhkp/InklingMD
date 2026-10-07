import { describe, expect, it } from "vitest";
import { rewriteWithReport, themePrefix } from "../../src/theme/typora/rewrite";
import { EDITOR_PREFIX } from "../../src/theme/typora/selector";
import { hashThemeCss, normalizeThemeCss } from "../../src/theme/typora/normalize";
import type { ThemeDiagnostic, ThemeRewriteContext } from "../../src/theme/typora/types";

/** Windows 形态的 convertFileSrc 期望值基准（台账 #4 实测：`http://asset.localhost/<encodeURIComponent(path)>`） */
const toAssetUrl = (abs: string) => `http://asset.localhost/${encodeURIComponent(abs)}`;

const THEME_DIR = "C:\\Users\\x\\AppData\\Roaming\\inklingmd\\themes\\demo";

function ctx(overrides: Partial<ThemeRewriteContext> = {}): ThemeRewriteContext {
  return {
    themeId: "user:demo",
    themeDir: THEME_DIR,
    toAssetUrl,
    ...overrides,
  };
}

function run(css: string, overrides: Partial<ThemeRewriteContext> = {}) {
  const diags: ThemeDiagnostic[] = [];
  const result = rewriteWithReport(css, ctx({ onDiagnostic: (d) => diags.push(d), ...overrides }));
  return { ...result, diagnostics: [...diags] };
}

/** assetProtocol.scope 的实际根（$APPDATA）：`../` 指向同包资源时仍可加载 */
const ASSET_ROOT = "C:\\Users\\x\\AppData\\Roaming\\inklingmd";

describe("#306 流水线第 0 步：规范化与内容哈希（N11-1 / N12）", () => {
  it("剥 BOM + 剥表首 @charset + 统一 LF", () => {
    const raw = "\uFEFF@charset \"UTF-8\";\r\n#write h1 { color: red; }\r\n";
    const { css, diagnostics } = normalizeThemeCss(raw);
    expect(css.startsWith("\uFEFF")).toBe(false);
    expect(css).not.toContain("@charset");
    expect(css).not.toContain("\r");
    expect(diagnostics.map((d) => d.kind)).toEqual(
      expect.arrayContaining(["normalize-bom", "normalize-charset", "normalize-eol"]),
    );
  });

  it("带 BOM / 不带 BOM 的同一主题得到**同一个 hash**（G9 快照一致性）", () => {
    const a = normalizeThemeCss("\uFEFF#write h1 { color: red; }\n").css;
    const b = normalizeThemeCss("#write h1 { color: red; }\r\n").css;
    expect(hashThemeCss(a)).toBe(hashThemeCss(b));
  });

  it("hash 对内容敏感（不同主题不得同 key）", () => {
    expect(hashThemeCss("a{}")).not.toBe(hashThemeCss("b{}"));
  });
});

describe("#306 C7 解析失败 → 整包拒绝", () => {
  it("未闭合块：返回空串 + parse-error 诊断（不注入半解析产物）", () => {
    const { css, rejected, diagnostics } = run("#write h1 { color: red;");
    expect(rejected).toBe(true);
    expect(css).toBe("");
    expect(diagnostics.some((d) => d.kind === "parse-error")).toBe(true);
  });
});

describe("#306 §C3（G8）：变量白名单拒绝 + 私有变量作用域收敛", () => {
  const css = `:root {
  --shell-bg: #000;      /* 外壳层：拒绝 */
  --text: #fff;          /* 基础变量：拒绝 */
  --my-private: #0f0;    /* 主题私有：保留 */
}
#write p { color: var(--my-private); background: var(--shell-bg); }`;

  it("拒绝集内的声明被删除，私有变量声明保留（四种输入形态）", () => {
    const { css: out, diagnostics } = run(css);
    expect(out).toContain("--my-private");
    expect(out).not.toContain("--shell-bg:");
    expect(out).not.toContain("--text:");
    const rejected = diagnostics.filter((d) => d.kind === "rejected-token").map((d) => d.target);
    expect(rejected).toEqual(expect.arrayContaining(["--shell-bg", "--text"]));
  });

  it("只引用未声明（跨规则引用）时不做引用侧改写：var() 保留，交由应用基线兜底", () => {
    const { css: out } = run(`#write p { color: var(--shell-bg, #123456); }`);
    expect(out).toContain("var(--shell-bg, #123456)");
  });

  it("既声明又被同规则引用：声明删除、引用保留（落到应用基线值）", () => {
    const { css: out } = run(`:root { --shell-bg: #000; } #write p { color: var(--shell-bg); }`);
    expect(out).not.toContain("--shell-bg:");
    expect(out).toContain("var(--shell-bg)");
  });

  it("私有变量被登记为「作用域收敛」，且声明落在编辑区前缀下", () => {
    const { css: out, diagnostics } = run(css);
    // :root 被收敛为编辑区前缀（2 段），私有变量声明在该块内
    const blocks = out.split("}");
    const scopedRoot = blocks.find((b) => b.includes(EDITOR_PREFIX) && b.includes("--my-private"));
    expect(scopedRoot).toBeTruthy();
    expect(diagnostics.some((d) => d.kind === "private-token-scoped" && d.target === "--my-private")).toBe(
      true,
    );
  });

  it("--content-* 允许覆盖（G4），且不会被拒绝", () => {
    const { css: out, diagnostics } = run(":root { --content-link: #f00; }");
    expect(out).toContain("--content-link: #f00");
    expect(diagnostics.some((d) => d.kind === "rejected-token")).toBe(false);
  });
});

describe("#306 §C4（G12）：仅 theme 层剥 !important", () => {
  it("剥离主题的 !important 并登记为已知差异", () => {
    const { css: out, diagnostics } = run("#write h1 { color: red !important; }");
    expect(out).not.toContain("!important");
    expect(diagnostics.filter((d) => d.kind === "stripped-important")).toHaveLength(1);
  });
});

describe("#306 §C9（G7-b）：资源 url() 重写 + @import 内联", () => {
  it("相对路径按**主题目录**解析并重写为 asset 绝对 URL；data/http/绝对路径不重写", () => {
    const { css: out, diagnostics } = run(
      `#write p {
  background: url("img/bg.png");
  border-image: url('../up.png') 30;
  cursor: url(icons/cur.cur), auto;
  list-style-image: url(/abs.png);
  mask: url(data:image/png;base64,AAA);
  background-image: image-set(url("img/a.png") 1x, url("img/b.png") 2x);
}`,
      { assetRoot: ASSET_ROOT },
    );
    expect(out).toContain(`url("${toAssetUrl(`${THEME_DIR}\\img\\bg.png`)}")`);
    // `../up.png` 解析到同包（$APPDATA 内）→ 仍重写，可加载（原文单引号形态保留）
    expect(out).toContain(`url('${toAssetUrl("C:\\Users\\x\\AppData\\Roaming\\inklingmd\\themes\\up.png")}')`);
    // 裸 url() 形态保持裸写（convertFileSrc 产物已编码，无空格/括号）
    expect(out).toContain(`url(${toAssetUrl(`${THEME_DIR}\\icons\\cur.cur`)})`);
    expect(out).toContain("url(/abs.png)"); // 绝对路径不重写（§C9 边界）
    expect(out).toContain("url(data:image/png;base64,AAA)"); // data: 不重写
    expect(out).toContain(`url("${toAssetUrl(`${THEME_DIR}\\img\\a.png`)}")`); // image-set 多候选
    expect(out).toContain(`url("${toAssetUrl(`${THEME_DIR}\\img\\b.png`)}")`);
    expect(diagnostics.some((d) => d.kind === "rewritten-url")).toBe(true);
  });

  it("越出 asset 根的相对路径降级（登记 dropped-url，不重写为 asset URL）", () => {
    const { css: out, diagnostics } = run("#write p { background: url('../../../../secret.png'); }", {
      assetRoot: ASSET_ROOT,
    });
    expect(diagnostics.some((d) => d.kind === "dropped-url")).toBe(true);
    expect(out).not.toContain(toAssetUrl("C:\\Users\\x\\secret.png"));
  });

  it("@font-face 的多候选 src 与 format() 保留，local() 永不重写", () => {
    const { css: out } = run(`@font-face {
  font-family: "DemoFont";
  src: local("DemoFont"), url("fonts/demo.woff2") format("woff2"), url("fonts/demo.woff") format("woff");
}`);
    expect(out).toContain('local("DemoFont")');
    expect(out).toContain('format("woff2")');
    expect(out).toContain(`url("${toAssetUrl(`${THEME_DIR}\\fonts\\demo.woff2`)}") format("woff2")`);
    expect(out).toContain(`url("${toAssetUrl(`${THEME_DIR}\\fonts\\demo.woff`)}") format("woff")`);
  });

  it("本地 @import 读取并内联（不得重写为 asset URL，P1-6）", () => {
    const importPath = `${THEME_DIR}\\part.css`;
    const sources = new Map<string, string>([[importPath, "@import \"nested.css\";\n#write h2 { color: blue; }"]]);
    const nestedPath = `${THEME_DIR}\\nested.css`;
    sources.set(nestedPath, "#write h3 { color: green; }");
    const { css: out, diagnostics } = run('@import "part.css";\n#write h1 { color: red; }', {
      importSources: sources,
    });
    expect(out).not.toContain("@import");
    expect(out).not.toContain("http://asset.localhost");
    expect(out).toContain(`${EDITOR_PREFIX} h2`);
    expect(out).toContain(`${EDITOR_PREFIX} h3`); // 递归内联
    expect(diagnostics.filter((d) => d.kind === "inlined-import")).toHaveLength(2);
  });

  it("远程 @import 丢弃并登记", () => {
    const { css: out, diagnostics } = run('@import url("https://fonts.googleapis.com/css?family=X");');
    expect(out).not.toContain("fonts.googleapis.com");
    expect(diagnostics.some((d) => d.kind === "dropped-import")).toBe(true);
  });

  it("@import 循环引用被拦截（不成环）", () => {
    const a = `${THEME_DIR}\\a.css`;
    const b = `${THEME_DIR}\\b.css`;
    const sources = new Map<string, string>([
      [a, '@import "b.css";\n#write h2 { color: blue; }'],
      [b, '@import "a.css";\n#write h3 { color: green; }'],
    ]);
    const { css: out, diagnostics } = run('@import "a.css";', { importSources: sources });
    expect(out).toContain(`${EDITOR_PREFIX} h2`);
    expect(out).toContain(`${EDITOR_PREFIX} h3`);
    expect(diagnostics.some((d) => d.kind === "dropped-import" && d.reason.includes("循环"))).toBe(true);
  });

  it("@import 递归深度上限生效", () => {
    const sources = new Map<string, string>();
    for (let i = 0; i < 10; i++) {
      sources.set(`${THEME_DIR}\\d${i}.css`, `@import "d${i + 1}.css";\n#write h2 { color: blue; }`);
    }
    const { diagnostics } = run('@import "d0.css";', { importSources: sources, maxImportDepth: 3 });
    expect(diagnostics.some((d) => d.kind === "dropped-import" && d.reason.includes("深度"))).toBe(true);
  });
});

describe("#306 §C10（I3/N9/N10）：全局名称前缀化 + 引用重写", () => {
  const prefix = themePrefix("user:demo");
  const css = `@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes cube-spin { from { transform: none } }
@counter-style demo-dots { system: cyclic; symbols: "•"; }
@property --demo-prop { syntax: "<color>"; inherits: false; initial-value: #000; }
@font-face { font-family: "DemoFont"; src: local("DemoFont"), url("f.woff2"); }
#write h1 { animation: 2s fade-in, 1s cube-spin; font-family: "DemoFont", "Segoe UI", sans-serif; font: 12px/1.4 DemoFont, serif; }
#write h2 { animation: 2s menu-in; font-family: "Segoe UI", serif; }`;

  it("keyframes / counter-style / font-face family 加前缀，@property 整个丢弃", () => {
    const { css: out, diagnostics } = run(css);
    expect(out).toContain(`@keyframes ${prefix}-fade-in`);
    expect(out).toContain(`@keyframes ${prefix}-cube-spin`);
    expect(out).toContain(`@counter-style ${prefix}-demo-dots`);
    expect(out).not.toContain("@property");
    expect(out).toContain(`font-family: "${prefix}-DemoFont"`);
    expect(diagnostics.some((d) => d.kind === "dropped-at-rule" && d.target.includes("@property"))).toBe(true);
  });

  it("负例①：回退链里的通用族/系统族名不被改名", () => {
    const { css: out } = run(css);
    expect(out).toContain('"Segoe UI"');
    expect(out).toContain("sans-serif");
    expect(out).toContain("serif");
    expect(out).not.toContain(`"${prefix}-Segoe UI"`);
  });

  it("负例②：引用未声明的 keyframes（复用应用侧）不被改名", () => {
    const { css: out } = run(css);
    // menu-in 是应用侧动画（主题未声明）→ 必须原样保留，否则动画静默消失
    expect(out).toContain("animation: 2s menu-in");
    expect(out).not.toContain(`${prefix}-menu-in`);
  });

  it("负例③：local() 里的字体名不被改名（系统字体名不属主题命名空间）", () => {
    const { css: out } = run(css);
    expect(out).toContain('local("DemoFont")');
    expect(out).not.toContain(`local("${prefix}-DemoFont")`);
  });

  it("animation 简写与逗号列表里的主题 keyframes 都同步改名", () => {
    const { css: out, diagnostics } = run(css);
    expect(out).toContain(`animation: 2s ${prefix}-fade-in, 1s ${prefix}-cube-spin`);
    expect(diagnostics.filter((d) => d.kind === "rewritten-ref").length).toBeGreaterThanOrEqual(3);
  });

  it("诊断区分「声明侧重命名」与「引用侧重写」（矩阵列口径）", () => {
    const { diagnostics } = run(css);
    // 声明侧（@font-face family / @keyframes / @counter-style）→ prefixed-name
    const declared = diagnostics.filter((d) => d.kind === "prefixed-name").map((d) => d.target);
    expect(declared).toContain("@font-face font-family: DemoFont");
    expect(declared).toContain("fade-in");
    expect(declared).toContain("cube-spin");
    expect(declared).toContain("demo-dots");
    // 引用侧（font-family / font / animation 用法）→ rewritten-ref，两列互不混淆
    const referenced = diagnostics.filter((d) => d.kind === "rewritten-ref").map((d) => d.target);
    expect(referenced.some((t) => t.startsWith("font-family: DemoFont"))).toBe(true);
    expect(referenced).not.toContain("@font-face font-family: DemoFont");
  });

  it("font 简写里的族名同样改名", () => {
    const { css: out } = run(css);
    expect(out).toContain(`font: 12px/1.4 "${prefix}-DemoFont", serif`);
  });
});

describe("#306 §C2：条件规则递归 + Typora 专有 at-rule", () => {
  it("@media 内部规则同样前缀化（含 @media print）", () => {
    const { css: out } = run("@media print { #write h1 { color: red; } }");
    expect(out).toContain("@media print");
    expect(out).toContain(`${EDITOR_PREFIX} h1`);
  });

  it("@include-when-export 翻译为 @media print 并递归改写（真实主题实测存在）", () => {
    const { css: out, diagnostics } = run("@include-when-export { #write code { color: red; } }");
    expect(out).toContain("@media print");
    expect(out).toContain(`${EDITOR_PREFIX} code`);
    expect(diagnostics.some((d) => d.target === "@include-when-export")).toBe(true);
  });

  it("@layer 丢弃（防止注入应用的层命名空间）；未知 at-rule 保守丢弃", () => {
    const { css: out, diagnostics } = run("@layer base { #write h1 { color: red } } @weird x { a: b }");
    expect(out).not.toContain("@layer");
    expect(out).not.toContain("@weird");
    expect(diagnostics.filter((d) => d.kind === "dropped-at-rule").length).toBeGreaterThanOrEqual(2);
  });

  it("@keyframes 内部的步进选择器（0% / from）不被前缀化", () => {
    const { css: out } = run("@keyframes dice { 0% { opacity: 0 } 100% { opacity: 1 } }");
    expect(out).toContain("0%");
    expect(out).toContain("100%");
    expect(out).not.toContain(`${EDITOR_PREFIX} 0%`);
  });
});

describe("#306 G1 + 作用域隔离：CM5 类与 Typora 窗口级 UI 规则被丢弃", () => {
  it("主题里的 .cm-* / .CodeMirror-* 规则一律丢弃（语法高亮归 codeBlockTheme）", () => {
    const { css: out, diagnostics } = run(
      ".cm-s-inner { color: red; } .CodeMirror-gutters { background: #000; } #write h1 { color: blue; }",
    );
    expect(out).not.toContain(".cm-");
    expect(out).not.toContain(".CodeMirror");
    expect(out).toContain(`${EDITOR_PREFIX} h1`);
    expect(diagnostics.filter((d) => d.kind === "dropped-selector").length).toBeGreaterThanOrEqual(2);
  });

  it("裸标签选择器被加前缀（隔离失效的常见来源）", () => {
    const { css: out } = run("table { border-collapse: collapse } img { border-radius: 4px }");
    expect(out).toContain(`${EDITOR_PREFIX} table`);
    expect(out).toContain(`${EDITOR_PREFIX} img`);
  });
});

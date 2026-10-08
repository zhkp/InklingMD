/**
 * #306 第三轮评审（PR #314）修复的断言载体：边界与条件语义。
 * 逐条对应评审批次：阻塞 2（§C9 越界判据）、阻塞 3（条件 `@import`）、
 * 阻塞 4（大小写 slug 冲突去重）、N1（私有变量值里的名称）、N2（UNC 归一化）。
 */
import { describe, expect, it } from "vitest";
import { rewriteWithReport, themePrefix } from "../../src/theme/typora/rewrite";
import { isWithinRoot, normalizePath, resolvePath } from "../../src/theme/typora/path";
import { scanThemesInDirectory } from "../../src/theme/typora/metadata";
import { parseThemeCandidate } from "../../src/theme/typora/metadata";
import type { ThemeDiagnostic, ThemeRewriteContext } from "../../src/theme/typora/types";

/** Windows 形态的 convertFileSrc 期望值基准（台账 #4 实测） */
const toAssetUrl = (abs: string) => `http://asset.localhost/${encodeURIComponent(abs)}`;

/** 主题目录与「同前缀兄弟目录」的父目录（评审复现实验的形态） */
const THEME_DIR = "C:\\themes\\dark";

function ctx(overrides: Partial<ThemeRewriteContext> = {}): ThemeRewriteContext {
  return { themeId: "user:dark", themeDir: THEME_DIR, toAssetUrl, ...overrides };
}

function run(css: string, overrides: Partial<ThemeRewriteContext> = {}) {
  const diags: ThemeDiagnostic[] = [];
  const result = rewriteWithReport(css, ctx({ onDiagnostic: (d) => diags.push(d), ...overrides }));
  return { ...result, diagnostics: [...diags] };
}

describe("#306 评审阻塞 2：§C9 越界判据用路径边界比较（不是字符串前缀）", () => {
  it("同前缀兄弟目录必须降级：`../dark-extra/evil.png` 不在根 `C:\\themes\\dark` 内", () => {
    const { css, diagnostics } = run(`#write h1 { background: url("../dark-extra/evil.png"); }`);
    expect(css).not.toContain("asset.localhost");
    expect(diagnostics.some((d) => d.kind === "dropped-url")).toBe(true);
    expect(diagnostics.some((d) => d.kind === "rewritten-url")).toBe(false);
  });

  it("根内相对路径仍重写，且 `../` 回到同包（assetRoot 放宽）也重写", () => {
    expect(run(`#write h1 { background: url("img/a.png"); }`).css).toContain("asset.localhost");
    const fn = (abs: string) => `http://asset.localhost/${encodeURIComponent(abs)}`;
    const { css, diagnostics } = run(`#write h1 { background: url("../shared/a.png"); }`, {
      toAssetUrl: fn,
      assetRoot: "C:\\themes",
    });
    expect(css).toContain("asset.localhost");
    expect(diagnostics.some((d) => d.kind === "rewritten-url" && d.target.includes("../shared"))).toBe(
      true,
    );
  });

  it("越界负例（无公共前缀）仍然降级", () => {
    const { css, diagnostics } = run(`#write h1 { background: url("../../../../secret.png"); }`);
    expect(css).not.toContain("asset.localhost");
    expect(diagnostics.some((d) => d.kind === "dropped-url")).toBe(true);
  });

  it("大小写口径按路径形态判定（Windows 语义不敏感 / POSIX 语义敏感），与运行平台无关", () => {
    expect(isWithinRoot("C:\\themes\\DARK\\a.png", "C:\\themes\\dark")).toBe(true);
    expect(isWithinRoot("c:/themes/dark/a.png", "C:\\themes\\dark")).toBe(true);
    expect(isWithinRoot("/themes/Dark/a.png", "/themes/dark")).toBe(false);
    expect(isWithinRoot("/themes/dark/a.png", "/themes/dark")).toBe(true);
    // 边界本身：相同路径、以及根目录本身都算「在根内」
    expect(isWithinRoot("C:\\themes\\dark", "C:\\themes\\dark")).toBe(true);
    expect(isWithinRoot("C:\\themes\\dark-extra", "C:\\themes\\dark")).toBe(false);
  });
});

describe("#306 评审阻塞 3：条件 @import 的语义保全", () => {
  const sources = new Map<string, string>([
    ["c:\\themes\\dark\\print.css", `#write h1 { color: print-only; }`],
    ["c:\\themes\\dark\\phone.css", `#write h2 { color: narrow; }`],
    ["c:\\themes\\dark\\grid.css", `#write h3 { display: grid; }`],
    ["c:\\themes\\dark\\util.css", `#write h4 { color: util; }`],
  ]);

  it("媒体条件包回 `@media`（不再是无条件泄漏进编辑区视图）", () => {
    const { css, diagnostics } = run(`@import "print.css" print;`, { importSources: sources });
    expect(css).toContain("@media print");
    expect(css).toMatch(/@media print\s*\{[\s\S]*color: print-only/);
    expect(diagnostics.some((d) => d.kind === "inlined-import" && d.reason.includes("@media"))).toBe(
      true,
    );
  });

  it("复合媒体条件（`screen and (min-width: …)`）同样包回", () => {
    const { css } = run(`@import url("phone.css") screen and (min-width: 600px);`, {
      importSources: sources,
    });
    expect(css).toContain("@media screen and (min-width: 600px)");
    expect(css).toMatch(/@media screen and \(min-width: 600px\)\s*\{[\s\S]*color: narrow/);
  });

  it("`supports()` 条件包回 `@supports`", () => {
    const { css } = run(`@import "grid.css" supports(display: grid);`, { importSources: sources });
    expect(css).toContain("@supports (display: grid)");
    expect(css).toMatch(/@supports \(display: grid\)\s*\{[\s\S]*display: grid/);
  });

  it("`layer()` 无法保留但必须登记（整包主题统一进 @layer theme）", () => {
    const { css, diagnostics } = run(`@import "util.css" layer(basics);`, { importSources: sources });
    expect(css).toContain("color: util");
    expect(css).not.toContain("layer(basics)");
    expect(diagnostics.some((d) => d.kind === "inlined-import" && d.reason.includes("layer(basics)"))).toBe(
      true,
    );
  });

  it("无条件的 @import 不产生多余包裹（回归保护）", () => {
    const { css } = run(`@import "util.css";`, { importSources: sources });
    expect(css).toContain("color: util");
    expect(css).not.toContain("@media");
    expect(css).not.toContain("@supports");
  });
});

describe("#306 评审阻塞 4：归一化名冲突取先出现者（不再产出重复 themeId）", () => {
  it("大小写冲突：只保留先出现者，并在目录级 issues 里登记", () => {
    const { themes, issues } = scanThemesInDirectory(["Vue.css", "vue.css"], [], "user");
    expect(themes).toHaveLength(1);
    expect(themes[0].fileName).toBe("Vue.css");
    expect(themes[0].themeId).toBe("user:vue");
    expect(issues.some((i) => i.includes("主题 ID 冲突") && i.includes("vue.css"))).toBe(true);
  });

  it("保留下来的描述符自身仍带冲突说明（单文件解析口径不变）", () => {
    const d = parseThemeCandidate({
      fileName: "Vue.css",
      siblings: ["Vue.css", "vue.css"],
      dirNames: [],
      source: "user",
    });
    expect(d.issues.some((i) => i.includes("归一化名冲突"))).toBe(true);
  });

  it("不冲突的文件全部保留（顺序不变）", () => {
    const { themes, issues } = scanThemesInDirectory(
      ["vue.css", "vue-dark.css", "night.css"],
      ["vue"],
      "user",
    );
    expect(themes.map((t) => t.fileName)).toEqual(["vue.css", "vue-dark.css", "night.css"]);
    expect(issues.filter((i) => i.includes("主题 ID 冲突"))).toHaveLength(0);
  });
});

describe("#306 评审 N1：私有变量值里的主题字体族/动画名同步改名（变量名不变）", () => {
  const css = [
    `@font-face { font-family: "DemoFont"; src: url("f.woff2"); }`,
    `@keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }`,
    `:root { --my-font: "DemoFont", sans-serif; --my-anim: fade-in 2s ease; }`,
    `#write h1 { font-family: var(--my-font); animation: var(--my-anim); }`,
  ].join("\n");

  it("私有变量名原样保留（P0-5），但字体族引用不再指向未加前缀的名字", () => {
    const { css: out } = run(css);
    const prefix = themePrefix("user:dark");
    expect(out).toContain("--my-font:"); // 变量名不变
    expect(out).toContain(`"${prefix}-DemoFont"`); // 值里的族名已改名
    expect(out).not.toMatch(/--my-font:\s*"DemoFont"/);
    expect(out).toContain(`${prefix}-fade-in`); // 动画名同样
    expect(out).toMatch(/font-family:\s*var\(--my-font\)/); // 引用侧保持 var() 语义
  });

  it("值里的通用族（`sans-serif`）与系统族不被改名", () => {
    const { css: out } = run(css);
    expect(out).toContain("sans-serif");
  });
});

describe("#306 评审 N2：UNC 路径归一化保留双前导斜杠", () => {
  it("`\\\\srv\\share\\a\\b` 归一化后仍是合法 UNC", () => {
    expect(normalizePath("\\\\srv\\share\\a\\b")).toBe("\\\\srv\\share\\a\\b");
  });

  it("UNC 上的 `..` 折叠不丢主机名", () => {
    expect(normalizePath("\\\\srv\\share\\a\\..\\b")).toBe("\\\\srv\\share\\b");
    expect(resolvePath("\\\\srv\\share\\themes", "../x.png")).toBe("\\\\srv\\share\\x.png");
  });

  it("UNC 根仍按 Windows 语义判定在根内", () => {
    expect(isWithinRoot("\\\\srv\\share\\themes\\a.png", "\\\\srv\\share\\themes")).toBe(true);
    expect(isWithinRoot("\\\\srv\\share\\themes-extra\\a.png", "\\\\srv\\share\\themes")).toBe(false);
  });
});

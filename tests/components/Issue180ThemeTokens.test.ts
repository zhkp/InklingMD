import { describe, expect, it } from "vitest";
import {
  readFixture,
  readSrc,
  definitionUnion,
  referencedTokens,
  tokensInBlock,
} from "../helpers/theme-css";

// #224 S1/S2/S5：断言能力与历史版本逐条对齐（不得弱化），
// 但文件来源改由 tests/fixtures/theme-entries.json 驱动；
// 切块解析改为花括号配平（#223 A-1，@layer 包裹+缩进后不再依赖「顶格 }」）。
describe("Issue #180 theme contracts（#224 S1/S2/S5）", () => {
  const fixture = readFixture();
  const appCss = readSrc(fixture.themeBlocks.file);
  const defined = definitionUnion(fixture);

  it.each(
    fixture.sourceScanFiles
      .map((rel) => [rel, readSrc(rel)] as [string, string])
      // LinkDialog.css / ConflictDialog.css 的 var() 同样在 S1 覆盖范围内
      .concat([
        ["src/components/Editor/LinkDialog.css", readSrc("src/components/Editor/LinkDialog.css")],
        ["src/components/FileConflict/ConflictDialog.css", readSrc("src/components/FileConflict/ConflictDialog.css")],
      ]),
  )("S1 %s 引用的每个 var(--x) 都能在清单定义并集中找到", (_name, source) => {
    const missing = [...new Set(referencedTokens(source))].filter((t) => !defined.has(t));
    expect(missing).toEqual([]);
  });

  it("S2 themeColorTokens 在 light/dark 两块都声明", () => {
    const lightTokens = tokensInBlock(appCss, fixture.themeBlocks.light);
    const darkTokens = tokensInBlock(appCss, fixture.themeBlocks.dark);
    expect(fixture.themeColorTokens.filter((t) => !lightTokens.has(t))).toEqual([]);
    expect(fixture.themeColorTokens.filter((t) => !darkTokens.has(t))).toEqual([]);
  });

  it("S5 LinkDialog.css 定义其样式控件用到的 4 个 class", () => {
    const linkDialogCss = readSrc("src/components/Editor/LinkDialog.css");
    for (const className of fixture.linkDialogClasses) {
      expect(linkDialogCss).toMatch(new RegExp(`\\.${className}\\b`));
    }
  });
});

// #223 A-1：历史 tokensInBlock 依赖「顶格 }」正则，App.css 包进
// @layer base { … }（且内部块缩进）后，light 块会被惰性匹配到文件尾，
// 导致 light 侧断言恒真（静默弱化）。花括号配平解析必须对此免疫。
describe("tokensInBlock 花括号配平解析（#223 A-1 回归）", () => {
  it("在 @layer 包裹 + 统一缩进的形态下仍精确切出 light/dark 块", () => {
    const wrapped = `@layer base {
  :root,
  [data-theme="light"] {
    --a: 1;
    --shared: 1;
  }
  .other { color: red; }
  [data-theme="dark"] {
    --a: 2;
    --shared: 2;
    --only-dark: 2;
  }
}`;
    const light = tokensInBlock(wrapped, '[data-theme="light"]');
    const dark = tokensInBlock(wrapped, '[data-theme="dark"]');
    expect(light.has("--a")).toBe(true);
    expect(light.has("--only-dark")).toBe(false);
    expect(dark.has("--only-dark")).toBe(true);
  });

  it("负例：light 块缺某个 themeColorToken 时必须能检出（旧正则恒真，这里必须失败）", () => {
    const broken = `@layer base {
  :root,
  [data-theme="light"] {
    --other: 1;
  }
  [data-theme="dark"] {
    --missing-in-light: 2;
  }
}`;
    const light = tokensInBlock(broken, '[data-theme="light"]');
    expect(light.has("--missing-in-light")).toBe(false);
  });
});

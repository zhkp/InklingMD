import { describe, it, expect } from "vitest";
import {
  balancedBlock,
  expandEntries,
  maskComments,
  readFixture,
  readSrc,
  referencedTokens,
} from "../helpers/theme-css";

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

  it("应用样式入口（App.css + 14 组件 CSS）中不存在 .cm-* 选择器", () => {
    const offenders: string[] = [];
    for (const rel of expandEntries(fixture.tokenDefinitionFiles)) {
      maskComments(readSrc(rel))
        .split("\n")
        .forEach((line, i) => {
          if (/\.cm-[a-z]/.test(line)) offenders.push(`${rel}:${i + 1} ${line.trim()}`);
        });
    }
    expect(
      offenders,
      `这些声明在入层后必然被 CodeMirror 运行时样式压掉，请移入 cmHostTheme：\n${offenders.join("\n")}`,
    ).toEqual([]);
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

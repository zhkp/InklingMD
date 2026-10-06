// E2E（dev server）：#224 S17 的行为级半边（#310 评审阻塞项 1 的回归防线）。
//
// 断言「CM 宿主外观必须取自应用 token」——这正是被 @layer base 反转掉的那部分覆盖：
// App.css 时代这些声明靠特异性/文档序胜出，入层后未层化的 CodeMirror 注入样式恒胜，
// 于是源码模式字体、代码块行号栏底色/文字色、frontmatter 行号栏边框色全部悄悄变值。
//
// 手法：在宿主里临时插一个探针元素，取其 `var(--token)` 的**计算值**作为期望，
// 与被断言元素的同名计算属性逐字符比对。探针与目标在同一作用域解析变量，
// 因此期望值不会硬编码，也不会因主题不同而失效；同时每个用例都断言
// 「高亮主题/默认值确实与 token 不同」，保证断言本身有区分力（非空转）。

import { test, expect } from "@playwright/test";
import { openMockWorkspace, openFile, insertCodeBlock, MOD } from "./helpers";

test.describe("S17 CM 宿主外观取自应用 token（#310 阻塞项 1）", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
  });

  test("S17a 代码块：行号栏底色/文字色与编辑器底色来自 --code-block-*，不被 oneDark 压过", async ({
    page,
  }) => {
    await openFile(page, "readme.md");
    await insertCodeBlock(page);
    await expect(page.locator(".code-block-cm .cm-gutters")).toBeVisible({
      timeout: 10_000,
    });

    const r = await page.evaluate(() => {
      const block = document.querySelector(".code-block") as HTMLElement | null;
      const gutters = block?.querySelector(".cm-gutters") as HTMLElement | null;
      const editor = block?.querySelector(".cm-editor") as HTMLElement | null;
      if (!block || !gutters || !editor) return null;
      const probe = document.createElement("span");
      probe.style.cssText =
        "color: var(--code-block-muted); background-color: var(--code-block-gutter-bg);";
      const probe2 = document.createElement("span");
      probe2.style.cssText = "background-color: var(--code-block-bg);";
      block.append(probe, probe2);
      const out = {
        expectedGutterColor: getComputedStyle(probe).color,
        expectedGutterBg: getComputedStyle(probe).backgroundColor,
        expectedEditorBg: getComputedStyle(probe2).backgroundColor,
        gutterColor: getComputedStyle(gutters).color,
        gutterBg: getComputedStyle(gutters).backgroundColor,
        editorBg: getComputedStyle(editor).backgroundColor,
        codeTheme: block.dataset.codeTheme ?? null,
      };
      probe.remove();
      probe2.remove();
      return out;
    });
    expect(r, "代码块 CM 宿主未挂载").not.toBeNull();

    // 默认 codeBlockTheme = oneDark；它自带 `.cm-gutters { color: stone }`（#7d8799），
    // 正是「挂载顺序压过应用值」的典型，故本用例只在有高亮主题时才有区分力。
    expect(r!.codeTheme, "默认代码高亮主题应为 oneDark").toBe("oneDark");
    expect(r!.expectedGutterColor).not.toBe("rgb(125, 135, 153)");
    expect(
      r!.gutterColor,
      "行号栏文字色必须来自 --code-block-muted（oneDark 的 stone 说明宿主主题被压过）",
    ).toBe(r!.expectedGutterColor);
    expect(r!.gutterBg, "行号栏底色必须来自 --code-block-gutter-bg").toBe(r!.expectedGutterBg);
    expect(r!.editorBg, "编辑器底色必须来自 --code-block-bg").toBe(r!.expectedEditorBg);
  });

  test("S17b 源码模式：字体来自 --editor-font、编辑器撑满宿主高度", async ({ page }) => {
    await openFile(page, "readme.md");
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const host = page.getByTestId("source-mode-editor");
    await expect(host.locator(".cm-editor")).toBeVisible({ timeout: 5_000 });

    const r = await page.evaluate(() => {
      const hostEl = document.querySelector(".source-mode-editor") as HTMLElement | null;
      const editor = hostEl?.querySelector(".cm-editor") as HTMLElement | null;
      const scroller = hostEl?.querySelector(".cm-scroller") as HTMLElement | null;
      const cmHost = hostEl?.querySelector(".source-mode-cm-host") as HTMLElement | null;
      if (!hostEl || !editor || !scroller || !cmHost) return null;
      const probe = document.createElement("span");
      probe.style.fontFamily = "var(--editor-font)";
      hostEl.appendChild(probe);
      const expectedFont = getComputedStyle(probe).fontFamily;
      probe.remove();
      return {
        expectedFont,
        actualFont: getComputedStyle(scroller).fontFamily,
        editorHeight: editor.getBoundingClientRect().height,
        cmHostHeight: cmHost.getBoundingClientRect().height,
      };
    });
    expect(r, "源码模式 CM 宿主未挂载").not.toBeNull();

    // --editor-font 是系统字体栈，与 CodeMirror baseTheme 的 monospace 明显不同：
    // 若声明被压过，这里读到的就是 "monospace"。
    expect(r!.expectedFont).not.toBe("monospace");
    expect(r!.actualFont, "源码模式字体必须来自 --editor-font").toBe(r!.expectedFont);
    expect(
      Math.abs(r!.editorHeight - r!.cmHostHeight),
      "编辑器应撑满 .source-mode-cm-host（原 App.css height:100% 已迁入 CM 主题）",
    ).toBeLessThanOrEqual(2);
  });

  test("S17c frontmatter（dark）：行号栏右边框色来自 --content-frontmatter-gutter-border", async ({
    page,
  }) => {
    await openFile(page, "frontmatter-demo.md");
    await expect(page.locator(".frontmatter-cm .cm-editor")).toBeVisible({ timeout: 10_000 });
    // 切深色：light 下 --content-frontmatter-gutter-border 就等于 --border，不具区分力
    await page.locator('.topbar-btn[title="主题"]').click();
    await page.locator(".export-item", { hasText: "深色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const r = await page.evaluate(() => {
      const block = document.querySelector(".frontmatter-block") as HTMLElement | null;
      const gutters = block?.querySelector(".cm-gutters") as HTMLElement | null;
      if (!block || !gutters) return null;
      const probe = document.createElement("span");
      probe.style.borderRight = "1px solid var(--content-frontmatter-gutter-border)";
      const probe2 = document.createElement("span");
      probe2.style.borderRight = "1px solid var(--border)";
      block.append(probe, probe2);
      const out = {
        expected: getComputedStyle(probe).borderRightColor,
        borderOnly: getComputedStyle(probe2).borderRightColor,
        actual: getComputedStyle(gutters).borderRightColor,
      };
      probe.remove();
      probe2.remove();
      return out;
    });
    expect(r, "frontmatter CM 宿主未挂载").not.toBeNull();

    // 两个 token 在 dark 下取值不同（#30363d vs #2d333b），断言才有区分力
    expect(r!.expected).not.toBe(r!.borderOnly);
    expect(
      r!.actual,
      "frontmatter 行号栏边框色必须来自 --content-frontmatter-gutter-border",
    ).toBe(r!.expected);
  });
});

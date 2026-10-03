// E2E（dev server）：#224 S12/S13 的运行时部分。
// - S13（含 N17）：渲染公式触发懒加载 katex 样式后，文档中不存在任何
//   「不在 CSSLayerBlockRule 内、且非 CSSLayerStatementRule」的规则；
// - S12：层序 statement 为 base,theme,user（首个出现决定层序，N1）。
// S7/S8/S14/S12 行为层断言依赖 #225/#306 的 <style id=inkling-theme> 与
// 映射产物，在 describe.skip 中显式登记，待对应 PR 激活。

import { test, expect, type Page } from "@playwright/test";
import { openMockWorkspace, openFile } from "./helpers";

async function scanLayers(page: Page) {
  return page.evaluate(() => {
    interface Scan {
      statementNames: string[] | null;
      unlayered: string[];
      totalTopLevel: number;
      layerBlocks: { name: string; rules: number; hasFontFace: boolean }[];
    }
    const result: Scan = {
      statementNames: null,
      unlayered: [],
      totalTopLevel: 0,
      layerBlocks: [],
    };
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        result.totalTopLevel++;
        if (rule instanceof CSSLayerStatementRule) {
          if (result.statementNames === null)
            result.statementNames = [...rule.nameList];
          continue;
        }
        if ((rule as CSSRule).constructor.name === "CSSLayerBlockRule") {
          const block = rule as unknown as {
            name: string;
            cssRules: CSSRuleList;
          };
          let hasFontFace = false;
          const walk = (rs: CSSRuleList) => {
            for (const r of Array.from(rs)) {
              if ((r as CSSRule).constructor.name === "CSSFontFaceRule")
                hasFontFace = true;
              if ((r as CSSRule).constructor.name === "CSSLayerBlockRule")
                walk((r as unknown as { cssRules: CSSRuleList }).cssRules);
            }
          };
          walk(block.cssRules);
          result.layerBlocks.push({
            name: block.name,
            rules: block.cssRules.length,
            hasFontFace,
          });
          continue;
        }
        result.unlayered.push(rule.cssText.slice(0, 80));
      }
    }
    return result;
  });
}

test.describe("CSS 层级模型（#224 S12/S13，dev）", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
  });

  test("S12 层序 statement 为 base → theme → user（首个出现决定层序）", async ({ page }) => {
    await openFile(page, "math-demo.md");
    await expect
      .poll(async () => (await scanLayers(page)).statementNames, {
        timeout: 15_000,
      })
      .toEqual(["base", "theme", "user"]);
  });

  test("S13/N17 渲染公式触发懒加载 katex 后，全部样式仍在层内（未分层规则=0，vendor_katex 含 @font-face）", async ({
    page,
  }) => {
    await openFile(page, "math-demo.md");
    // N17：先渲染一个公式（懒加载 katex.min.css）
    await expect(page.locator(".math-inline .katex").first()).toBeVisible({
      timeout: 15_000,
    });
    // 等懒加载样式入 CSSOM：轮询到某个 layer 块内含 @font-face（KaTeX）
    await expect
      .poll(
        async () =>
          (await scanLayers(page)).layerBlocks.some((b) => b.hasFontFace),
        { timeout: 15_000 },
      )
      .toBe(true);

    const scan = await scanLayers(page);
    expect(
      scan.unlayered,
      `存在未分层样式规则：\n${scan.unlayered.slice(0, 20).join("\n")}`,
    ).toEqual([]);
    expect(scan.totalTopLevel).toBeGreaterThan(0);
  });
});

// 以下断言的「被断言对象」由后续 PR 提供，届时移除 skip：
// - S7：#inkling-theme 位于 App.css 之后、#inkling-custom-theme 之前（#225）
// - S8：首帧 rAF 前 data-theme 就位（#225 main.tsx 顶部静态导入）
// - S12 行为级：同属性主题值在层竞争中胜出（#225/#306）
// - S14：@keyframes/@font-face 全局名称不被主题夺走（#306/#225）
test.describe.skip("主题层行为断言（等待 #225/#306 被断言对象，#224 已定义口径）", () => {
  test("S7 DOM 顺序冒烟（dev-only）", () => {});
  test("S8 首帧 data-theme 就位（addInitScript rAF）", () => {});
  test("S12 行为级：主题值胜出 base", () => {});
  test("S14 全局名称不泄漏（含主题引用应用侧 keyframes 负例）", () => {});
});

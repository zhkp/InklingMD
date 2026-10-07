// E2E（dev server）：#224 S12/S13 的运行时部分。
// - S13（含 N17）：渲染公式触发懒加载 katex 样式后，文档中不存在任何
//   「不在 CSSLayerBlockRule 内、且非 CSSLayerStatementRule」的规则；
// - S13-CM（#310 评审阻塞项 1）：只要挂载 CodeMirror，style-mod 就会在运行时往
//   <head> 首位注入一个**未分层** <style>，所以「未分层 = 0」在 CM 场景下不可达 ——
//   口径改为「应用源必须 100% 在层内；未分层规则只允许来自 registry 登记的运行时
//   注入源（runtimeStyleSources）」，并在挂载了三个 CM 宿主的状态下生效；
// - S12：层序 statement 为 base,theme,user（首个出现决定层序，N1）。
// S7/S8/S14/S12 行为层断言依赖 #225/#306 的 <style id=inkling-theme> 与
// 映射产物，在 describe.skip 中显式登记，待对应 PR 激活。
// CM 宿主外观 != 应用 CSS 的行为级断言见 theme-cm-host.spec.ts（S17）。

import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { openMockWorkspace, openFile, insertCodeBlock, MOD } from "./helpers";

interface RuntimeStyleSource {
  id: string;
  detect: string;
  reason: string;
}

interface UnlayeredSource {
  /** 承载该样式表的元素名（STYLE / LINK），用于失败信息定位 */
  ownerTag: string;
  /** 样式表位于 SVG 内部（mermaid 的注入形态） */
  isSvgOwned: boolean;
  /** 未分层规则里出现 style-mod 生成类（CodeMirror 的注入形态，U+037C） */
  hasStyleModClass: boolean;
  count: number;
  sample: string;
}

// 与 tests/fixtures/theme-entries.json 同源（不另立真值源）
const runtimeStyleSources = (
  JSON.parse(
    readFileSync(resolve(process.cwd(), "tests/fixtures/theme-entries.json"), "utf8"),
  ) as { runtimeStyleSources: RuntimeStyleSource[] }
).runtimeStyleSources;

/** 按 registry 的 detect 判定某样式表是否属于已登记的运行时来源 */
function isRegisteredSource(src: UnlayeredSource): boolean {
  return runtimeStyleSources.some((entry) => {
    switch (entry.detect) {
      case "style-mod-class":
        return src.hasStyleModClass;
      case "svg-owned":
        return src.isSvgOwned;
      default:
        throw new Error(
          `theme-entries.json 的 runtimeStyleSources 出现未实现的 detect：${entry.detect}`,
        );
    }
  });
}

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

/** 把「含未分层规则的样式表」按来源聚合，供白名单判定 */
async function scanUnlayeredSources(page: Page): Promise<UnlayeredSource[]> {
  return page.evaluate(() => {
    const out: {
      ownerTag: string;
      isSvgOwned: boolean;
      hasStyleModClass: boolean;
      count: number;
      sample: string;
    }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const unlayered: string[] = [];
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSLayerStatementRule) continue;
        if ((rule as CSSRule).constructor.name === "CSSLayerBlockRule") continue;
        unlayered.push(rule.cssText);
      }
      if (!unlayered.length) continue;
      const owner = sheet.ownerNode as (Node & { ownerSVGElement?: Element | null }) | null;
      out.push({
        ownerTag: owner ? owner.nodeName : "unknown",
        isSvgOwned: Boolean(owner && owner.ownerSVGElement),
        // style-mod 的类名 = U+037C + base36（style-mod.js:1 `const C = "\u037c"`）
        hasStyleModClass: unlayered.some((t) => t.includes("\u037c")),
        count: unlayered.length,
        sample: unlayered[0].slice(0, 100),
      });
    }
    return out;
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

  test("S13-CM 挂载 CodeMirror（frontmatter / 代码块 / 源码模式）后，未分层规则只来自登记白名单", async ({
    page,
  }) => {
    // 宿主一：frontmatter（预览态即挂 CM）
    await openFile(page, "frontmatter-demo.md");
    await expect(page.locator(".frontmatter-cm .cm-editor")).toBeVisible({
      timeout: 10_000,
    });

    // 宿主二：代码块（斜杠菜单插入，每个代码块自带一个 CM 实例）
    await insertCodeBlock(page);
    await expect(page.locator(".code-block-cm .cm-editor")).toBeVisible({
      timeout: 10_000,
    });

    // 宿主三：源码模式（整篇替换为 CM）
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(
      page.getByTestId("source-mode-editor").locator(".cm-editor"),
    ).toBeVisible({ timeout: 5_000 });

    // 防空转：CM 的 style-mod 样式表必须真的存在（否则本用例什么都没断言）
    await expect
      .poll(
        async () =>
          (await scanUnlayeredSources(page)).filter((s) => s.hasStyleModClass).length,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const sources = await scanUnlayeredSources(page);
    const styleMod = sources.filter((s) => s.hasStyleModClass);
    expect(
      styleMod.reduce((n, s) => n + s.count, 0),
      "CM 运行时应注入实质数量的未分层规则",
    ).toBeGreaterThan(0);

    const offenders = sources.filter((s) => !isRegisteredSource(s));
    expect(
      offenders,
      `这些未分层样式来源未登记在 theme-entries.json 的 runtimeStyleSources：\n${offenders
        .map((s) => `[${s.ownerTag}] count=${s.count} ${s.sample}`)
        .join("\n")}\n（应用自身样式必须 100% 在 @layer 内；新增运行时来源请登记白名单）`,
    ).toEqual([]);
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

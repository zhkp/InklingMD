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

// ── #225 落地：S7 / S8 / S12 行为级 / S14 ────────────────────────────────────
test.describe("主题层行为断言（#225 落地）", () => {
  test("S7 DOM 顺序冒烟（dev-only）：statement 在首位，theme 先于 user（自定义 CSS 最高层）", async ({
    page,
  }) => {
    await openMockWorkspace(page);
    const probe = await page.evaluate(() => {
      const ids = [...document.head.querySelectorAll("style")].map((el) => el.id || "(anon)");
      return { ids, firstStyleId: document.head.querySelector("style")?.id ?? "" };
    });
    // N1：层序声明必须是 <head> 的第一个样式块（层序由首次出现决定）
    expect(probe.firstStyleId).toBe("inkling-layer-statement");
    const iTheme = probe.ids.indexOf("inkling-theme");
    const iUser = probe.ids.indexOf("inkling-custom-theme");
    // 两者同时存在时必须 theme < user（N5：插入到 <head> 末尾即可；自定义 CSS 最后 = 最高层）
    if (iTheme >= 0 && iUser >= 0) expect(iTheme).toBeLessThan(iUser);
    // 说明：内置基线 css.kind = none → 本 PR 的 dev 首帧没有 #inkling-theme；
    // 其注入次序（theme 先、user 后）由 tests/theme/theme-injection.test.ts 确定性覆盖，
    // 磁盘主题（#307/#308）落地后本断言自动升级为强断言。
  });

  /**
   * S8 的采集口径（与 G3「首帧前 data-theme 已就位」等价可判定的形式）：
   * 在**应用内容首次出现的那一帧**（`#root` 第一次有子节点的 rAF）记录 `data-theme`。
   * 若属性是「渲染后」才写上的，此处读到的就会是默认值而不是 stored 主题 → 断言失败。
   */
  const installFirstPaintRecorder = async (page: Page, stored: string | null) => {
    await page.addInitScript((storedThemeId: string | null) => {
      if (storedThemeId === null) localStorage.removeItem("inkling-theme");
      else localStorage.setItem("inkling-theme", storedThemeId);
      const w = window as unknown as { __firstPaintTheme?: string | null };
      delete w.__firstPaintTheme;
      const tick = () => {
        const root = document.getElementById("root");
        if (root && root.childElementCount > 0) {
          w.__firstPaintTheme = document.documentElement.getAttribute("data-theme");
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, stored);
  };

  test("S8 首帧就位：stored themeId = builtin:dark → 应用内容首帧时 data-theme 已是 dark（反 FOUC，G3）", async ({
    page,
  }) => {
    await installFirstPaintRecorder(page, "builtin:dark");
    await openMockWorkspace(page);
    await page.waitForFunction(
      () => (window as unknown as { __firstPaintTheme?: string | null }).__firstPaintTheme !== undefined,
      undefined,
      { timeout: 15_000 },
    );
    const firstPaintTheme = await page.evaluate(
      () => (window as unknown as { __firstPaintTheme?: string | null }).__firstPaintTheme,
    );
    // 内容一出现就已经是正确的明暗 —— 不存在「先亮后暗」的可见切换
    expect(firstPaintTheme).toBe("dark");
    // 权威源与派生属性一致（§3.2/C3）
    await expect(page.locator("html")).toHaveAttribute("data-theme-id", "builtin:dark");
  });

  test("S8 首装：无存储 → 按 prefers-color-scheme 决定首次默认（C7）", async ({ page }) => {
    await installFirstPaintRecorder(page, null);
    await openMockWorkspace(page);
    await page.waitForFunction(
      () => (window as unknown as { __firstPaintTheme?: string | null }).__firstPaintTheme !== undefined,
      undefined,
      { timeout: 15_000 },
    );
    // Playwright 默认 prefers-color-scheme: light
    expect(
      await page.evaluate(
        () => (window as unknown as { __firstPaintTheme?: string }).__firstPaintTheme,
      ),
    ).toBe("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme-id", "builtin:light");
  });

  test("S12 行为级：同属性同特异性下 @layer theme 胜出 @layer base（与 DOM 顺序无关）", async ({
    page,
  }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
    const h1 = page.locator(".editor-scroll .milkdown h1").first();
    await expect(h1).toBeVisible({ timeout: 10_000 });

    await page.addStyleTag({
      content: "@layer base { .editor-scroll .milkdown h1 { color: rgb(1, 1, 1); } }",
    });
    await page.addStyleTag({
      content: "@layer theme { .editor-scroll .milkdown h1 { color: rgb(2, 2, 2); } }",
    });
    await expect(h1).toHaveCSS("color", "rgb(2, 2, 2)");

    // 反向：base 层**后加**的规则（同特异性）仍不能压过 theme —— 层序决定，与块内/DOM 顺序无关
    await page.addStyleTag({
      content: "@layer base { .editor-scroll .milkdown h1 { color: rgb(3, 3, 3); } }",
    });
    await expect(h1).toHaveCSS("color", "rgb(2, 2, 2)");
  });

  test("S14 全局名称不泄漏：主题层的带前缀名称不夺走应用侧 fade-in / 无未加前缀的主题字体名", async ({
    page,
  }) => {
    await openMockWorkspace(page);
    await page.addStyleTag({
      content: `@layer theme {
        @keyframes tdeadbeef-fade-in { from { opacity: 0 } to { opacity: 1 } }
        @font-face { font-family: "tdeadbeef-SampleFont"; src: local("X"); }
      }`,
    });
    const probe = await page.evaluate(() => {
      const out: { keyframes: string[]; fonts: string[] } = { keyframes: [], fonts: [] };
      const collect = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule.constructor.name === "CSSKeyframesRule") out.keyframes.push((rule as CSSKeyframesRule).name);
          if (rule.constructor.name === "CSSFontFaceRule")
            out.fonts.push((rule as CSSFontFaceRule).style.getPropertyValue("font-family"));
          const inner = (rule as unknown as { cssRules?: CSSRuleList }).cssRules;
          if (inner) collect(inner);
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          collect(sheet.cssRules);
        } catch {
          continue;
        }
      }
      return out;
    });
    // 应用侧通用名仍在（未被主题夺走），主题副本带前缀
    expect(probe.keyframes).toContain("fade-in");
    expect(probe.keyframes).toContain("tdeadbeef-fade-in");
    // 反向（可失败形态）：文档里 `fade-in` **恰好一个** —— 若主题以未加前缀的名字注入，
    // 这里会数到 2（#306 的前缀化 + 引用重写另有强断言：tests/e2e/typora-shim.spec.ts）
    expect(probe.keyframes.filter((n) => n === "fade-in")).toHaveLength(1);
  });
});

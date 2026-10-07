// #306 E2E：把「未修改的 Typora 形态主题」经兼容层改写后注入真实浏览器（dev server），
// 断言四类事实：
//   ① 主题生效（文档元素的计算样式按主题变化）；
//   ② 外壳**三层不变**（token 级 / 全局名称级 / 选择器命中级）—— N7 要求；
//   ③ 远程资源被拦的场景不报错、不白屏；
//   ④ `@layer theme` 下主题仍能覆盖基线（含 dark 场景，G6-I1/I2）。
//
// 注入方式刻意复刻 `#225` 的 `inject()`：`@layer theme { … }` + `<head>` 末尾（G5/G10）。
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rewriteWithReport } from "../../src/theme/typora/rewrite";
import { openMockWorkspace, MOD } from "./helpers";

const THEME_FILE = resolve(process.cwd(), "tests/fixtures/typora-themes/sample-theme.css");
const THEME_DIR = resolve(process.cwd(), "tests/fixtures/typora-themes");
const THEME_ID = "user:sample-theme";

function buildThemeCss(): string {
  const source = readFileSync(THEME_FILE, "utf8");
  return rewriteWithReport(source, {
    themeId: THEME_ID,
    themeDir: THEME_DIR,
    toAssetUrl: (abs) => `http://asset.localhost/${encodeURIComponent(abs)}`,
    assetRoot: THEME_DIR,
  }).css;
}

/** 复刻 #225 的注入协议：`@layer theme { … }` + `<head>` 末尾（G5/G10） */
async function injectTheme(page: Page, css: string) {
  await page.addStyleTag({ content: `@layer theme {\n${css}\n}` });
}

/** 外壳四区（E5：顶栏 / 标签栏 / 侧边栏 / 状态栏） */
const SHELL_SELECTORS = [".editor-topbar", ".tabs-bar", ".sidebar", ".status-bar"] as const;

async function shellStyles(page: Page) {
  return page.evaluate((sels: string[]) => {
    const out: Record<string, Record<string, string>> = {};
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) {
        out[sel] = { __missing: "1" };
        continue;
      }
      const cs = getComputedStyle(el);
      out[sel] = {
        backgroundColor: cs.backgroundColor,
        color: cs.color,
        borderTopColor: cs.borderTopColor,
        fontFamily: cs.fontFamily,
      };
    }
    return out;
  }, SHELL_SELECTORS as unknown as string[]);
}

/** 造一个含 h1 / 行内代码 / 引用 的草稿，保证被断言元素一定存在 */
async function draftWithContent(page: Page) {
  await page.keyboard.press(`${MOD}+n`);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible({ timeout: 10_000 });
  await editor.click();
  await page.keyboard.type("# 一级标题");
  await page.keyboard.press("Enter");
  await page.keyboard.type("行内 `code` 片段");
  await expect(page.locator(".editor-scroll .milkdown h1")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".editor-scroll .milkdown code").first()).toBeVisible({
    timeout: 5_000,
  });
}

test.describe("#306 Typora 兼容层（真实注入）", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
  });

  test("主题生效：文档元素的标题/行内代码/容器背景按主题变化，且外壳四区逐项不变", async ({
    page,
  }) => {
    await draftWithContent(page);
    const before = await shellStyles(page);
    // 外壳选择器必须真实存在（防「选择器写错 → 前后都为 missing → 假通过」）
    for (const sel of SHELL_SELECTORS) expect(before[sel].__missing).toBeUndefined();

    const h1Before = await page.evaluate(() => {
      const h1 = document.querySelector(".editor-scroll .milkdown h1");
      return h1 ? getComputedStyle(h1).color : "";
    });

    await injectTheme(page, buildThemeCss());
    await page.waitForTimeout(150);

    const docAfter = await page.evaluate(() => {
      const h1 = document.querySelector(".editor-scroll .milkdown h1")!;
      const code = document.querySelector(".editor-scroll .milkdown code")!;
      const container = document.querySelector(".editor-scroll .milkdown")!;
      return {
        h1Color: getComputedStyle(h1).color,
        h1BorderBottom: getComputedStyle(h1).borderBottomColor,
        codeBg: getComputedStyle(code).backgroundColor,
        containerBg: getComputedStyle(container).backgroundColor,
      };
    });
    expect(docAfter.h1Color).toBe("rgb(255, 0, 0)");
    expect(docAfter.h1Color).not.toBe(h1Before);
    expect(docAfter.h1BorderBottom).toBe("rgb(255, 0, 0)");
    expect(docAfter.codeBg).toBe("rgb(255, 248, 197)");
    expect(docAfter.containerBg).toBe("rgb(253, 253, 253)");

    // ② 外壳三层一致之「token 级 + 选择器命中级」：外壳四区计算样式逐项不变
    const after = await shellStyles(page);
    for (const sel of SHELL_SELECTORS) {
      expect(after[sel], `${sel} 被主题外溢影响`).toEqual(before[sel]);
    }
    // 主题里的 `body { background: #123456 }` 只作用于编辑区容器，不得染到外壳
    expect(after[".editor-topbar"].backgroundColor).not.toBe("rgb(18, 52, 86)");
  });

  test("外壳三层一致之「全局名称级」：主题 @keyframes/@font-face 不夺走应用的名字", async ({
    page,
  }) => {
    await draftWithContent(page);
    await injectTheme(page, buildThemeCss());
    await page.waitForTimeout(150);

    const probe = await page.evaluate(() => {
      const names: { keyframes: string[]; fonts: string[] } = { keyframes: [], fonts: [] };
      const collect = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule.constructor.name === "CSSKeyframesRule")
            names.keyframes.push((rule as CSSKeyframesRule).name);
          if (rule.constructor.name === "CSSFontFaceRule")
            names.fonts.push((rule as CSSFontFaceRule).style.getPropertyValue("font-family"));
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
      return names;
    });

    // 应用侧原有动画名仍在（未被夺走），主题的副本带前缀
    expect(probe.keyframes).toContain("fade-in");
    expect(probe.keyframes.some((n) => /^t[0-9a-f]{8}-fade-in$/.test(n))).toBe(true);
    // 主题 font-face 被重命名；应用侧不存在「未加前缀的 SampleFont」
    expect(probe.fonts.some((f) => /t[0-9a-f]{8}-SampleFont/.test(f))).toBe(true);
    expect(probe.fonts.some((f) => f.replace(/["']/g, "") === "SampleFont")).toBe(false);
  });

  test("dark 场景下主题仍覆盖基线（G6-I1/I2，@layer 层序）", async ({ page }) => {
    await draftWithContent(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await injectTheme(page, buildThemeCss());
    await page.waitForTimeout(150);

    const h1Color = await page.evaluate(() => {
      const h1 = document.querySelector(".editor-scroll .milkdown h1");
      return h1 ? getComputedStyle(h1).color : "";
    });
    expect(h1Color).toBe("rgb(255, 0, 0)");
  });

  test("远程 @import / 远程字体被拦：不报错、不白屏，编辑区仍可用", async ({ page }) => {
    const errors: string[] = [];
    const externalRequests: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("request", (req) => {
      if (/fonts\.googleapis\.com|example\.com/.test(req.url())) externalRequests.push(req.url());
    });

    await draftWithContent(page);
    await injectTheme(page, buildThemeCss());
    await page.waitForTimeout(300);

    // 远程 @import 已被兼容层丢弃 → 不应产生任何远程请求
    expect(externalRequests).toEqual([]);
    // 页面仍然可用：编辑器与外壳都在，且无未捕获异常
    await expect(page.locator(".ProseMirror")).toBeVisible();
    await expect(page.locator(".editor-topbar")).toBeVisible();
    expect(errors, `注入主题后出现未捕获异常：${errors.join(" | ")}`).toEqual([]);
  });

  test("越权赋值被拒：--shell-*/基础变量不被主题改写，--content-* 允许覆盖", async ({ page }) => {
    await draftWithContent(page);
    const css = buildThemeCss();
    // ① 兼容层产物侧：越权赋值已被删除，私有/内容 token 保留
    expect(css).not.toContain("--shell-topbar-bg");
    expect(css).not.toContain("--text:");
    expect(css).toContain("--sample-accent");
    expect(css).toContain("--sample-bg");

    const before = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const container = getComputedStyle(document.querySelector(".editor-scroll .milkdown")!);
      return {
        rootText: root.getPropertyValue("--text").trim(),
        containerBgToken: container.getPropertyValue("--sample-bg").trim(),
      };
    });

    await injectTheme(page, css);
    await page.waitForTimeout(150);

    const after = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const container = getComputedStyle(document.querySelector(".editor-scroll .milkdown")!);
      return {
        rootText: root.getPropertyValue("--text").trim(),
        containerBgToken: container.getPropertyValue("--sample-bg").trim(),
      };
    });
    // 基础变量仍是应用基线值（主题尝试写成 #ff00ff 已被拒）
    expect(after.rootText).toBe(before.rootText);
    expect(after.rootText).not.toBe("#ff00ff");
    // 主题私有变量在编辑区容器上生效（作用域收敛，不改名）
    expect(after.containerBgToken).toBe("#fdfdfd");
    expect(before.containerBgToken).not.toBe("#fdfdfd");
  });
});

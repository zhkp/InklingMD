/**
 * #308 验收（浏览器内真实链路，**用仓库里真实的预装主题文件**播种 mock 源副本）：
 * 预装主题（`$RESOURCE/themes` 源副本）→ 首启幂等复制到运行时副本（N13）→ 清单驱动识别（N15，`bundled:*`）
 * → 列表可见/可切换（含明暗变体一键切换）→ 注入产物经兼容层改写过 → 隐藏（不物理删除）。
 *
 * 真机侧另有：`scripts/check-theme-licenses.mjs`（许可/署名/体积/两侧 slug 集合，CI 门禁）与
 * `scripts/theme-compat-report.ts`（映射层不变量：前缀恒 2 段、无 `@import`、无 `.cm-*`）。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { openFile, openMockWorkspace } from "./helpers";

const BUNDLED_ROOT = "/mock-resource/themes";
const REPO_THEMES_DIR = join("src-tauri", "resources", "themes");

/** 真实预装源副本（manifest + 全部 .css），逐字节进 mock，保证「测的就是要发的东西」 */
function realBundledFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(REPO_THEMES_DIR)) {
    if (!name.endsWith(".css") && name !== "manifest.json") continue;
    files[`${BUNDLED_ROOT}/${name}`] = readFileSync(join(REPO_THEMES_DIR, name), "utf8");
  }
  return files;
}

const BUNDLED_SLUGS = [
  "drake",
  "drake-dark",
  "lapis",
  "lapis-dark",
  "notion",
  "notion-dark",
] as const;

async function seedBundledOnly(page: Page): Promise<void> {
  await page.addInitScript((files) => {
    (window as unknown as { __inklingThemesMock?: unknown }).__inklingThemesMock = {
      root: "/mock-appdata/themes",
      bundledRoot: "/mock-resource/themes",
      files,
    };
  }, realBundledFiles());
}

async function ensureTopbar(page: Page): Promise<void> {
  if ((await page.getByTitle("主题").count()) === 0) {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
    await expect(page.getByTitle("主题")).toBeVisible({ timeout: 25_000 });
  }
}

async function openThemeMenu(page: Page): Promise<void> {
  await ensureTopbar(page);
  await page.getByTitle("主题").click();
  await expect(page.locator('[data-theme-menu="1"]')).toBeVisible();
}

async function state(page: Page) {
  return page.evaluate(() => ({
    themeId: document.documentElement.getAttribute("data-theme-id"),
    injected: document.getElementById("inkling-theme")?.textContent ?? "",
    index: window.localStorage.getItem("inkling-themes-index") ?? "",
    hidden: window.localStorage.getItem("inkling-themes-hidden") ?? "",
  }));
}

test.describe("#308 预装主题（真实文件）", () => {
  test.describe.configure({ mode: "serial" });

  test("首启把源副本复制为运行时副本并被识别为 bundled:*（N13 + N15）", async ({ page }) => {
    await seedBundledOnly(page);
    await openThemeMenu(page);

    // 6 款（3 对明暗）全部可见，且 id 前缀是 bundled:*（清单驱动识别，而非 user:*）
    for (const slug of BUNDLED_SLUGS) {
      await expect(page.locator(`[data-theme-option="bundled:${slug}"]`)).toBeVisible();
    }
    await expect(page.locator('[data-theme-option="user:drake"]')).toHaveCount(0);

    // 索引记录（#307 的生产写入方）：source=bundled + 磁盘文件名
    const s = await state(page);
    const index = JSON.parse(s.index) as { themes: { id: string; source: string; file?: string }[] };
    for (const slug of BUNDLED_SLUGS) {
      expect(index.themes).toContainEqual(
        expect.objectContaining({ id: `bundled:${slug}`, source: "bundled", file: `${slug}.css` }),
      );
    }
  });

  test("选中预装主题：经兼容层改写后注入，且运行时副本可读（N13 复制真的发生了）", async ({ page }) => {
    await seedBundledOnly(page);
    await openThemeMenu(page);
    await page.locator('[data-theme-option="bundled:notion-dark"]').click();
    await expect
      .poll(async () => (await state(page)).themeId, { timeout: 5000 })
      .toBe("bundled:notion-dark");
    await expect
      .poll(async () => (await state(page)).injected, { timeout: 10_000 })
      .toContain("@layer theme");

    const injected = (await state(page)).injected;
    // 兼容层产物特征：2 段前缀 + 主题私有变量被作用域收敛（notion 用 :root 变量）
    expect(injected).toMatch(/\.editor-scroll \.milkdown/);
    // 根级选择器已被收敛（G6/D4）：产物里不应再有裸的 `:root {`
    expect(injected).not.toMatch(/^:root\s*\{/m);
    // 主题内容真的来自源副本（选到 notion 的深色变体）
    expect(injected.replace(/\s+/g, "")).toMatch(/--bg-color:#[0-9a-f]{3,8}/i);
  });

  test("明暗成对：菜单提供变体一键切换（drake ↔ drake-dark）", async ({ page }) => {
    await seedBundledOnly(page);
    await openThemeMenu(page);
    await page.locator('[data-theme-option="bundled:drake"]').click();
    await expect.poll(async () => (await state(page)).themeId, { timeout: 5000 }).toBe("bundled:drake");

    await openThemeMenu(page);
    const variant = page.locator('[data-theme-variant="1"]');
    await expect(variant).toBeVisible();
    await expect(variant).toContainText("深色");
    await variant.click();
    await expect
      .poll(async () => (await state(page)).themeId, { timeout: 5000 })
      .toBe("bundled:drake-dark");
    await expect.poll(async () => (await state(page)).injected, { timeout: 10_000 }).toContain("@layer theme");
    // 切到深色变体后属性同步（App.css 的 [data-theme] 依赖它）
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
  });

  test("预装主题「移除」= 隐藏（持久化隐藏位，不物理删除；刷新后不复活到可见列表）", async ({ page }) => {
    await seedBundledOnly(page);
    await openThemeMenu(page);
    await page.locator('[data-theme-option="bundled:lapis"]').click();
    await expect.poll(async () => (await state(page)).themeId, { timeout: 5000 }).toBe("bundled:lapis");

    await openThemeMenu(page);
    await page.locator('[data-theme-remove="1"]').click();
    // 当前主题回落（隐藏的预装主题不再作为当前项）
    await expect.poll(async () => (await state(page)).themeId, { timeout: 5000 }).toBe("builtin:light");
    const hidden = JSON.parse((await state(page)).hidden || "[]") as string[];
    expect(hidden).toContain("bundled:lapis");

    // 重新扫描（N13 会把文件再复制回来，但隐藏位让它仍不显示）；移除动作会关闭菜单，故先重开
    await openThemeMenu(page);
    await page.locator('[data-theme-refresh="1"]').click();
    await expect(page.locator('[data-theme-option="bundled:lapis"]')).toHaveCount(0);
    await expect(page.locator('[data-theme-option="bundled:lapis-dark"]')).toBeVisible();
  });
});

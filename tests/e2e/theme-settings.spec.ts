// E2E：主题切换与设置面板
// 覆盖：明暗切换、data-theme 属性、localStorage 持久化、设置项开关、代码高亮主题、恢复默认、关闭方式

import { test, expect } from "@playwright/test";
import { openMockWorkspace, openFile, openSettings, insertCodeBlock } from "./helpers";

test.describe("主题切换", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
  });

  test("TH1 点击主题按钮展开下拉", async ({ page }) => {
    await page.locator('.topbar-btn[title="主题"]').click();
    await expect(page.locator(".export-dropdown")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".export-item", { hasText: "浅色" })).toBeVisible();
    await expect(page.locator(".export-item", { hasText: "深色" })).toBeVisible();
    await expect(page.locator(".export-item", { hasText: "加载自定义 CSS" })).toBeVisible();
  });

  test("TH2 默认浅色且 data-theme=light", async ({ page }) => {
    // 默认或显式点浅色
    await page.locator('.topbar-btn[title="主题"]').click();
    const lightItem = page.locator(".export-item", { hasText: "浅色" });
    await lightItem.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  });

  test("TH3 切换深色后 data-theme=dark 并持久化", async ({ page }) => {
    await page.locator('.topbar-btn[title="主题"]').click();
    await page.locator(".export-item", { hasText: "深色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    // localStorage 持久化：#225 起值升级为 themeId（旧值 "light"/"dark" 仅作读取侧迁移）
    const stored = await page.evaluate(() => localStorage.getItem("inkling-theme"));
    expect(stored).toBe("builtin:dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme-id", "builtin:dark");
  });

  test("TH4 刷新后保持主题", async ({ page }) => {
    await page.locator('.topbar-btn[title="主题"]').click();
    await page.locator(".export-item", { hasText: "深色" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    // 重新打开工作区（刷新后状态丢失需重新加载 mock）
    await openMockWorkspace(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});

test.describe("设置面板", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
  });

  test("SE1 点更多菜单打开设置面板", async ({ page }) => {
    await openSettings(page);
    await expect(page.locator(".settings-modal")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".settings-title")).toContainText("偏好设置");
  });

  test("SE2 开关可切换并持久化", async ({ page }) => {
    await openSettings(page);
    const focusToggle = page.locator(".settings-row", { hasText: "专注模式" }).locator(".settings-toggle");
    const before = await focusToggle.isChecked();
    void before;
    await focusToggle.check({ force: true });
    await expect(focusToggle).toBeChecked();
    // 持久化到 localStorage
    const stored = await page.evaluate(() => localStorage.getItem("inkling-settings"));
    expect(stored).toContain("focusMode");
  });

  test("SE3 代码高亮主题同步原生控件配色", async ({ page }) => {
    await insertCodeBlock(page);
    const codeBlock = page.locator(".code-block");
    const languageSelect = codeBlock.locator(".code-block-lang");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    await expect(codeBlock).toHaveAttribute("data-code-theme", "oneDark");
    await expect(languageSelect).toHaveCSS("color-scheme", "dark");

    await page.locator('.topbar-btn[title="主题"]').click();
    await page.locator(".export-item", { hasText: "深色" }).click();
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(languageSelect).toHaveCSS("color-scheme", "dark");

    await openSettings(page);
    const select = page.locator(".settings-select");
    await expect(select).toHaveCSS("color-scheme", "dark");
    await select.selectOption("light");
    await expect(codeBlock).toHaveAttribute("data-code-theme", "light");
    await expect(languageSelect).toHaveCSS("color-scheme", "light");

    await page.locator(".settings-backdrop").click({ position: { x: 5, y: 5 } });
    await page.locator('.topbar-btn[title="主题"]').click();
    await page.locator(".export-item", { hasText: "浅色" }).click();
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    await expect(languageSelect).toHaveCSS("color-scheme", "light");

    await openSettings(page);
    await select.selectOption("none");
    await expect(select).toHaveValue("none");
    await expect(codeBlock).toHaveAttribute("data-code-theme", "none");
    await expect(languageSelect).toHaveCSS("color-scheme", "light");

    await page.locator(".settings-backdrop").click({ position: { x: 5, y: 5 } });
    await page.locator('.topbar-btn[title="主题"]').click();
    await page.locator(".export-item", { hasText: "深色" }).click();
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    await expect(languageSelect).toHaveCSS("color-scheme", "dark");
  });

  test("SE4 恢复默认", async ({ page }) => {
    await openSettings(page);
    // 先改一个开关
    const focusToggle = page.locator(".settings-row", { hasText: "专注模式" }).locator(".settings-toggle");
    await focusToggle.check({ force: true });
    await expect(focusToggle).toBeChecked();
    // 恢复默认
    await page.locator(".settings-reset").click();
    await expect(focusToggle).not.toBeChecked();
  });

  test("SE5 点遮罩关闭面板", async ({ page }) => {
    await openSettings(page);
    await expect(page.locator(".settings-modal")).toBeVisible();
    await page.locator(".settings-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(page.locator(".settings-modal")).toBeHidden();
  });
});

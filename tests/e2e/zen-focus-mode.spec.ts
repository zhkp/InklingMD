import { test, expect } from "@playwright/test";
import { openMockWorkspace, openFile, openSettings } from "./helpers";

test.describe("禅模式与打字机/专注模式交互", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "intro.md");
  });

  test("通过更多菜单切换禅模式并按 Esc 退出", async ({ page }) => {
    // 打开更多菜单
    await page.locator('button[aria-label="更多操作"]').click();
    await expect(page.locator(".export-dropdown")).toBeVisible();

    // 点击禅模式（与设置面板的「专注模式」是不同功能，文案已区分）
    await page
      .locator(".export-dropdown button.export-item")
      .filter({ hasText: /^禅模式$/ })
      .click();

    // 应该进入禅模式全屏容器
    await expect(page.locator(".app-shell.zen-mode")).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCount(0);

    // 按 Esc 退出禅模式
    await page.keyboard.press("Escape");
    await expect(page.locator(".app-shell.zen-mode")).toHaveCount(0);
    await expect(page.locator(".sidebar")).toBeVisible();
  });

  test("在设置中切换段落专注模式并在编辑器内生效样式", async ({ page }) => {
    // 打开设置面板
    await openSettings(page);
    await expect(page.locator(".settings-modal")).toBeVisible();

    // 勾选专注模式
    const focusRow = page.locator(".settings-row").filter({ hasText: "专注模式" });
    await focusRow.locator('input[type="checkbox"]').click();

    // 关闭设置面板
    await page.locator(".settings-close").click();
    await expect(page.locator(".settings-modal")).not.toBeVisible();

    // 编辑器容器应应用 focus-mode 类名
    await expect(page.locator(".md-editor-root.focus-mode")).toBeVisible();
  });
});

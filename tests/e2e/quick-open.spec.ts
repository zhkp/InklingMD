// E2E：Quick Open（Ctrl/Cmd+P，#228）
//
// 覆盖：打开并聚焦、实时过滤、键盘选中后打开、Esc 关闭、空态、双向模态互斥、单文件模式。

import { test, expect } from "@playwright/test";
import { openMockWorkspace, openFile, MOD } from "./helpers";

async function openQuickOpen(page: import("@playwright/test").Page) {
  await page.keyboard.press(`${MOD}+P`);
  await expect(page.locator(".qo-modal")).toBeVisible({ timeout: 5_000 });
}

test.describe("Quick Open", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
  });

  test("Q1 Ctrl+P 打开并聚焦输入框", async ({ page }) => {
    await openQuickOpen(page);
    await expect(page.locator(".qo-input")).toBeFocused();
  });

  test("Q2 输入实时过滤，高亮项可由键盘确认并打开对应文件", async ({ page }) => {
    await openQuickOpen(page);
    await page.locator(".qo-input").fill("todo");

    const items = page.locator(".qo-item");
    await expect(items.first()).toContainText("todo.md");
    // 首项即为高亮项（aria-activedescendant 指向它）
    await expect(items.first()).toHaveClass(/qo-item-active/);

    await page.keyboard.press("Enter");

    await expect(page.locator(".qo-modal")).toBeHidden();
    await expect(page.locator(".tabs-bar")).toContainText("todo.md");
    await expect(page.locator(".ProseMirror")).toBeVisible();
  });

  test("Q3 空查询展示候选；无匹配时展示空态", async ({ page }) => {
    await openQuickOpen(page);

    // 空查询：直接列出候选（含 mock 工作区里的文件）
    await expect(page.locator(".qo-item").first()).toBeVisible({ timeout: 5_000 });
    expect(await page.locator(".qo-item").count()).toBeGreaterThanOrEqual(1);

    await page.locator(".qo-input").fill("zzzz_not_exist_zzzz");
    await expect(page.locator(".qo-empty")).toContainText("无匹配结果", { timeout: 5_000 });
    await expect(page.locator(".qo-item")).toHaveCount(0);
  });

  test("Q4 Esc 关闭面板", async ({ page }) => {
    await openQuickOpen(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".qo-modal")).toBeHidden();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Q5 模态互斥：全局搜索打开时按 Ctrl+P 不叠加", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Shift+F`);
    await expect(page.locator(".gs-modal")).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press(`${MOD}+P`);

    await expect(page.locator(".qo-modal")).toHaveCount(0);
    await expect(page.locator(".gs-modal")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });

  test("Q6 模态互斥：Quick Open 打开时按 Ctrl+Shift+F 不叠加", async ({ page }) => {
    await openQuickOpen(page);

    await page.keyboard.press(`${MOD}+Shift+F`);

    await expect(page.locator(".gs-modal")).toHaveCount(0);
    await expect(page.locator(".qo-modal")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
  });
});

// 单文件模式单独一组：**不能**先打开工作区，否则 workspaceMode 会变成 "folder"
test.describe("Quick Open（单文件模式）", () => {
  test("Q7 无工作区时候选只来自已打开标签页 + 最近文件，不扫磁盘", async ({ page }) => {
    await page.goto("/");
    // 浏览器端「打开 Markdown 文件」走 mock 分支，直接以单文件模式打开 intro.md
    await page.getByRole("button", { name: "打开 Markdown 文件" }).click();
    await expect(page.locator(".tab-active")).toContainText("intro.md", { timeout: 10_000 });

    await openQuickOpen(page);

    // 恰好一项：单文件模式不发起索引命令，候选 = 当前标签页（最近文件去重后仍是它）
    const names = page.locator(".qo-item .qo-item-name");
    await expect(names).toHaveCount(1);
    await expect(names.first()).toHaveText("intro.md");

    // 工作区里确实存在、但未打开的 readme.md 不得出现——这是「没扫磁盘」的直接证据
    await expect(page.locator(".qo-item").filter({ hasText: "readme.md" })).toHaveCount(0);

    // 仍然可以正常打开（候选本身就是当前文件，走 ensureTab 复用已打开标签）
    await page.keyboard.press("Enter");
    await expect(page.locator(".qo-modal")).toBeHidden();
    await expect(page.locator(".tab-active")).toContainText("intro.md");
  });
});

// 禅模式（评审 P2-2）：模态层原先落在 zenMode 的提前 return 之后，
// 「模态不渲染 + requestModal 照常置位」会让快捷键变成全局静默锁。
test.describe("Quick Open（禅模式）", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "intro.md");
    await page.locator('button[aria-label="更多操作"]').click();
    await page.locator("button.export-item", { hasText: "禅模式" }).click();
    await expect(page.locator(".app-shell.zen-mode")).toBeVisible();
  });

  test("Q8 禅模式下 Ctrl+P 能真的打开面板（不再是无声的死键）", async ({ page }) => {
    await expect(page.locator(".sidebar")).toHaveCount(0);

    await openQuickOpen(page);

    await expect(page.locator(".qo-input")).toBeFocused();
  });

  test("Q9 禅模式下模态互斥成立，且状态不会卡死", async ({ page }) => {
    await openQuickOpen(page);

    // 已有面板时按 Ctrl+Shift+F：忽略、不叠加
    await page.keyboard.press(`${MOD}+Shift+F`);
    await expect(page.locator(".gs-modal")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(1);

    // 用关闭按钮关闭（Esc 会退出禅模式，这里要在禅模式内继续验证）
    await page.locator(".qo-close").click();
    await expect(page.locator(".qo-modal")).toBeHidden();
    await expect(page.locator(".app-shell.zen-mode")).toBeVisible();

    // 关键回归防线：上一步的 activeModal 必须已清空，否则这里会被 ignore 静默吞掉
    await page.keyboard.press(`${MOD}+Shift+F`);
    await expect(page.locator(".gs-modal")).toBeVisible({ timeout: 5_000 });
  });
});

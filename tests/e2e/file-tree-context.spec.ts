// E2E：文件树右键菜单
// 覆盖：目录/文件右键菜单项、新建文件、重命名、删除确认、书签、复制路径
//
// 注意：书签区块也在 .sidebar-tree 内（recent-section），加入书签后同名文件会出现
// 两处（树节点 + 书签条目）。用 data-tree-row 限定到窗口化文件树节点。

import { test, expect, type Page } from "@playwright/test";
import { appendToEditor, expandMockNotes, openFile, openMockWorkspace } from "./helpers";

// 定位到文件树里的某个节点行（排除书签/最近打开区块），右键并等菜单出现
async function rightClickTreeNode(page: Page, name: string) {
  const node = page.locator(".workspace-tree-scroll [data-tree-row]")
    .filter({ hasText: name })
    .first();
  await node.click({ button: "right" });
  await expect(page.locator(".tree-context-menu")).toBeVisible({ timeout: 5_000 });
}

// 点击右键菜单项（用 exact regex 避免子串误匹配，如"新建文件"vs"新建文件夹"）
async function clickContextItem(page: Page, text: string, exact = false) {
  const pattern = exact ? new RegExp(`^${text}$`) : text;
  const item = page.locator(".tree-context-item").filter({ hasText: pattern });
  await item.click();
}

test.describe("文件树右键菜单", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await expandMockNotes(page);
  });

  test("FC1 目录右键菜单项齐全", async ({ page }) => {
    await rightClickTreeNode(page, "mock-workspace");
    await expect(page.locator(".tree-context-item").filter({ hasText: /^新建文件$/ })).toBeVisible();
    await expect(page.locator(".tree-context-item").filter({ hasText: "新建文件夹" })).toBeVisible();
    await expect(page.locator(".tree-context-item").filter({ hasText: "复制路径" })).toBeVisible();
  });

  test("FC2 新建文件并自动打开", async ({ page }) => {
    await rightClickTreeNode(page, "notes");
    await clickContextItem(page, "新建文件", true);
    await expect(page.locator(".tree-row-new .rename-input")).toBeVisible({ timeout: 5_000 });
    await page.locator(".tree-row-new .rename-input").fill("e2e-new.md");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-tree-row].tree-row-file").filter({ hasText: "e2e-new.md" })).toBeVisible({ timeout: 5_000 });
  });

  test("FC3 重命名文件", async ({ page }) => {
    await rightClickTreeNode(page, "todo.md");
    await clickContextItem(page, "重命名");
    await expect(page.locator(".tree-row-rename .rename-input")).toBeVisible({ timeout: 5_000 });
    await page.locator(".tree-row-rename .rename-input").fill("renamed-todo.md");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-tree-row].tree-row-file").filter({ hasText: "renamed-todo.md" })).toBeVisible({ timeout: 5_000 });
  });

  test("FC4 加入书签", async ({ page }) => {
    await rightClickTreeNode(page, "intro.md");
    await clickContextItem(page, "加入书签");
    await expect(page.locator(".recent-section").locator("text=书签")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".recent-section").getByText("intro.md", { exact: true })).toBeVisible();
  });

  test("FC5 已书签文件菜单变取消书签", async ({ page }) => {
    await rightClickTreeNode(page, "intro.md");
    await clickContextItem(page, "加入书签");
    await expect(page.locator(".recent-section").getByText("intro.md")).toBeVisible({ timeout: 5_000 });
    // 再次右键文件树节点，避免误点书签条目
    await rightClickTreeNode(page, "intro.md");
    await expect(page.locator(".tree-context-item").filter({ hasText: "取消书签" })).toBeVisible();
  });

  test("FC6 删除文件确认对话框", async ({ page }) => {
    // 先新建一个待删文件
    await rightClickTreeNode(page, "notes");
    await clickContextItem(page, "新建文件", true);
    await page.locator(".tree-row-new .rename-input").fill("to-delete.md");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-tree-row].tree-row-file").filter({ hasText: "to-delete.md" })).toBeVisible({ timeout: 5_000 });

    // 右键删除，点取消（保留）
    let dialogHandled = false;
    page.on("dialog", (d) => {
      dialogHandled = true;
      expect(d.message()).toContain("to-delete.md");
      d.dismiss();
    });
    await rightClickTreeNode(page, "to-delete.md");
    await clickContextItem(page, "删除");
    await page.waitForTimeout(500);
    expect(dialogHandled).toBe(true);
    await expect(page.locator("[data-tree-row].tree-row-file").filter({ hasText: "to-delete.md" })).toBeVisible();
  });

  test("FC7 .md 文件显示在新窗口打开项", async ({ page }) => {
    await rightClickTreeNode(page, "readme.md");
    await expect(page.locator(".tree-context-item").filter({ hasText: "在新窗口打开" })).toBeVisible();
  });

  test("FC9 删除含已打开文件的文件夹：一次确认说清影响，子 tab 全部关闭，未保存内容进「可恢复文件」（#366）", async ({ page }) => {
    await openFile(page, "readme.md");
    await openFile(page, "todo.md");
    // 让 todo.md 带未保存修改（最后一步，紧接着发起删除）
    await appendToEditor(page, "删除前的未保存编辑");
    await expect(page.locator(".tab").filter({ hasText: "todo.md" }).locator(".tab-dirty")).toBeVisible();

    const messages: string[] = [];
    page.on("dialog", (d) => {
      messages.push(d.message());
      void d.accept();
    });
    await rightClickTreeNode(page, "notes");
    await clickContextItem(page, "删除");

    await expect(page.locator(".tab")).toHaveCount(0, { timeout: 5_000 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("确定删除文件夹「notes」及其所有内容吗？");
    expect(messages[0]).toContain("2 个文件正在编辑器中打开");
    expect(messages[0]).toContain("1 个有未保存的修改（todo.md）");
    expect(messages[0]).toContain("可恢复文件");
    await expect(page.locator('[data-tree-row][data-path="/mock-workspace/notes"]')).toHaveCount(0);

    // 未保存内容可从「可恢复文件」恢复为新标签页
    const snapshots = page.locator(".deleted-snapshots-section");
    await expect(snapshots).toContainText("todo.md");
    await snapshots.locator(".snapshot-restore-btn").first().click();
    await expect(page.locator(".ProseMirror")).toContainText("删除前的未保存编辑");
  });

  test("FC8 复制路径写入剪贴板", async ({ page }, testInfo) => {
    await testInfo.annotations.push({ type: "needs-clipboard", description: "需 clipboard 权限" });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await rightClickTreeNode(page, "readme.md");
    await clickContextItem(page, "复制路径");
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain("readme.md");
  });

  test("FC9 非 Markdown 文件也能唤起右键菜单 (#158)", async ({ page }) => {
    // 修复前该行是原生 disabled，Chromium 抑制 contextmenu，菜单不会出现；
    // 修复后为 aria-disabled：真实浏览器不阻断鼠标事件，但 Playwright 的
    // actionability 检查仍把 aria-disabled 当 disabled 拒点，故用 force 右键
    // （真实派发鼠标事件）——这正是本用例要验证的行为差异
    const node = page.locator('[data-tree-row][data-path="/mock-workspace/notes/attachment.txt"]');
    await expect(node).toHaveAttribute("aria-disabled", "true");
    await node.click({ button: "right", force: true });
    await expect(page.locator(".tree-context-menu")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".tree-context-item").filter({ hasText: /^重命名$/ })).toBeVisible();
    await expect(page.locator(".tree-context-item").filter({ hasText: /^删除$/ })).toBeVisible();
    await expect(page.locator(".tree-context-item").filter({ hasText: /^复制路径$/ })).toBeVisible();
    // 非 md 文件没有「在新窗口打开」（TreeContextMenu 仅对 md 文件显示）
    await expect(page.locator(".tree-context-item").filter({ hasText: "在新窗口打开" })).toHaveCount(0);
  });
});

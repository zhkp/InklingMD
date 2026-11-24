// E2E：切 tab 复用同一个编辑器实例后的状态承接（issue #426）
//
// 改前每次切 tab 都会重建 Milkdown 编辑器；改成实例复用 + 按 tab 缓存后，
// 这些「跨 tab 的状态」必须仍然成立，否则是用户可感知的数据/交互回归：
// 1. 切走再切回：内容还在，且**撤销历史仍在**（Ctrl+Z 能撤销切走前的输入）；
// 2. Ctrl+N 后焦点跟随新草稿（不用先点编辑器就能直接输入）——
//    实例复用后不再重挂，靠重挂触发聚焦的老路径失效，这里锁住新路径。

import { test, expect } from "@playwright/test";
import { openFile, openMockWorkspace, MOD, moveCaretToDocEnd } from "./helpers";

test.describe("切 tab 的编辑器状态承接（#426）", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
  });

  test("切走再切回：内容保留且撤销历史可用（Ctrl+Z 撤销切走前的输入）", async ({ page }) => {
    await openFile(page, "readme.md");
    const editor = page.locator(".ProseMirror");
    await editor.click();
    await moveCaretToDocEnd(page);
    await page.keyboard.type("跨tab撤销标记");
    await expect(editor).toContainText("跨tab撤销标记");
    // 等防抖发布落进 store（切走前还会再 flush 一次，这里只是让后续断言更稳）
    await page.waitForTimeout(300);

    // 切到另一个文件再切回
    await openFile(page, "todo.md");
    await expect(page.locator(".tab-active")).toContainText("todo.md");
    await page.locator(".tab", { hasText: "readme.md" }).click();
    await expect(page.locator(".tab-active")).toContainText("readme.md");

    // 内容必须完整地回到同一个编辑器实例里
    await expect(editor).toContainText("跨tab撤销标记");

    // 撤销历史随 tab 恢复：一次 Ctrl+Z 必须撤掉切走前那次输入
    await editor.click();
    await page.keyboard.press(`${MOD}+KeyZ`);
    await expect(editor).not.toContainText("跨tab撤销标记", { timeout: 5_000 });
  });

  test("Ctrl+N 后焦点跟随新草稿，不点击编辑器也能直接输入", async ({ page }) => {
    await openFile(page, "readme.md");
    await expect(page.locator(".tab-active")).toContainText("readme.md");

    // 先把焦点移到编辑器之外（侧边栏文件树），让「焦点是否被新草稿接管」可判定
    await page.locator(".workspace-tree-scroll").click({ position: { x: 8, y: 8 } });
    await page.keyboard.press(`${MOD}+KeyN`);
    await expect(page.locator(".tab-active")).toContainText("未命名", { timeout: 5_000 });

    // 不点击编辑器，直接输入：必须落在新草稿里（首字丢失就是回归）
    await page.keyboard.type("焦点跟随标记");
    await expect(page.locator(".ProseMirror")).toContainText("焦点跟随标记", {
      timeout: 5_000,
    });
  });
});

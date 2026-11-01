// E2E：全局搜索覆盖未保存内容（issue #370）
//
// 场景一（未命名草稿）：草稿输入关键词（自动保存刻意跳过未命名 tab，
// 无时序竞态）→ Ctrl+Shift+F 搜索 → 以「未命名 1」分组命中并标注「未保存」
// → 点击命中跳回草稿。
// 场景二（冲突暂停自动保存）：打开文件追加输入 → 置 conflictPending 暂停
// 自动保存（等过 2 秒防抖窗证明磁盘未写入）→ 搜索仍命中内存内容且磁盘
// 上确实没有该关键词 → 命中带「未保存」徽标。

import { test, expect } from "@playwright/test";
import { MOD, openFile, openMockWorkspace, expandMockNotes, moveCaretToDocEnd } from "./helpers";

const DRAFT_KEYWORD = "草稿独有关键词QF70";
const CONFLICT_KEYWORD = "冲突态独有关键词QF88";

test.describe("全局搜索未保存内容（#370）", () => {
  test("未命名草稿中刚输入的内容可被全局搜索命中并跳转，且不污染最近打开列表", async ({ page }) => {
    await openMockWorkspace(page);
    // 先打开一个真实文件：让「最近打开」区域真实渲染，后面断言「草稿不进最近」
    // 才有区分力（区域不存在时 not.toContainText 会恒真）
    await expandMockNotes(page);
    await openFile(page, "readme.md");

    // 新建草稿并输入独有关键词（自动保存跳过未命名 tab，内容只存在于内存）
    await page.keyboard.press(`${MOD}+n`);
    await expect(page.locator(".ProseMirror p")).toBeVisible({ timeout: 5_000 });
    await page.locator(".ProseMirror p").first().click();
    await page.keyboard.type(DRAFT_KEYWORD);

    // 打开全局搜索并检索
    await page.keyboard.press(`${MOD}+Shift+F`);
    const input = page.locator(".gs-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("QF70");

    // 草稿以「未命名 1」分组命中，且带「未保存」徽标
    await expect(page.locator(".gs-group", { hasText: "未命名 1" })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".gs-unsaved-badge")).toBeVisible();
    await expect(page.locator(".gs-group", { hasText: "未命名 1" }).locator(".gs-hit")).toHaveCount(
      1,
    );

    // 点击命中：跳转回草稿 tab
    await page.locator(".gs-group", { hasText: "未命名 1" }).locator(".gs-hit").first().click();
    await expect(page.locator(".tab-active")).toContainText("未命名 1", { timeout: 5_000 });

    // #370 评审：草稿虚拟路径不得进入持久化的「最近打开」（区域已由 readme.md 渲染）
    const recentSection = page.locator(".recent-section").filter({ hasText: "最近打开" });
    await expect(recentSection).toBeVisible();
    await expect(recentSection).toContainText("readme.md");
    await expect(recentSection).not.toContainText("untitled-");
  });

  test("冲突暂停自动保存时，未落盘的编辑仍可被搜索命中", async ({ page }) => {
    await openMockWorkspace(page);
    await expandMockNotes(page);
    await openFile(page, "readme.md");

    // 文件末尾追加独有关键词（进入 dirty 状态）
    await page.locator(".ProseMirror").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.type(CONFLICT_KEYWORD);

    // 置 conflictPending 暂停自动保存：tab 级标志（保存互斥与状态栏）+
    // 顶层镜像（useAutoSave 订阅的是顶层 mirror，不置它自动保存不会暂停）
    await page.evaluate(async (path) => {
      const { useWorkspace } = (await import(
        // @ts-ignore Vite dev 专用绝对模块路径
        "/src/store/workspace.ts"
      )) as typeof import("../../src/store/workspace");
      const state = useWorkspace.getState();
      useWorkspace.setState({
        conflictPending: true,
        openTabs: state.openTabs.map((t) =>
          t.path === path ? { ...t, conflictPending: true } : t,
        ),
      });
    }, "/mock-workspace/notes/readme.md");
    await page.waitForTimeout(2_500);

    // 磁盘上确实没有该关键词（内容只存在于内存缓冲）
    const diskHasKeyword = await page.evaluate(async (kw) => {
      const { MOCK_FILE_CONTENT } = (await import(
        // @ts-ignore Vite dev 专用绝对模块路径
        "/src/lib/mockFs.ts"
      )) as typeof import("../../src/lib/mockFs");
      return (MOCK_FILE_CONTENT["/mock-workspace/notes/readme.md"] ?? "").includes(kw);
    }, CONFLICT_KEYWORD);
    expect(diskHasKeyword).toBe(false);

    // 全局搜索仍能命中内存内容，且带「未保存」徽标
    await page.keyboard.press(`${MOD}+Shift+F`);
    const input = page.locator(".gs-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("QF88");
    await expect(
      page.locator(".gs-group", { hasText: "readme.md" }).locator(".gs-hit"),
    ).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator(".gs-unsaved-badge")).toBeVisible();

    // 点击命中跳回文件
    await page.locator(".gs-group", { hasText: "readme.md" }).locator(".gs-hit").first().click();
    await expect(page.locator(".tab-active")).toContainText("readme.md", { timeout: 5_000 });
  });
});

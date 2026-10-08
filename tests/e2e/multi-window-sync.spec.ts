// E2E：跨窗口 / 多标签页存储同步测试（#133）
// 目标：验证同一存储域内，一个窗口对 localStorage 的修改，会通过浏览器原生
// storage 事件被另一窗口的应用状态监听器捕获并自动应用到 UI。
// 这里取消之前"手动 dispatchEvent + 只查 localStorage 值"的伪断言，
// 改为：窗口 A 写入修改 → 窗口 B 的真实 DOM 状态随之更新（应用真实参与）。

import { test, expect } from "@playwright/test";
import { openMockWorkspace } from "./helpers";

const THEME_KEY = "inkling-theme";

test.describe("跨窗口 / 多页面存储同步 (#133)", () => {
  test("窗口 A 切换主题后，窗口 B 通过 storage 事件自动应用（应用状态联动）", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    // 同一存储域下的两个独立标签页（真正"多窗口"：各自持有独立文档上下文）
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await openMockWorkspace(pageA);
    await openMockWorkspace(pageB);

    // 确认 window B 已加载应用且主题 store 监听已生效
    const initialTheme = await pageB.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(["light", "dark"]).toContain(initialTheme);

    // 窗口 A 修改主题（与应用 setMode 相同的底层写入路径：直接 setItem 触发原生 storage 事件）
    const targetTheme = initialTheme === "dark" ? "light" : "dark";
    await pageA.evaluate(
      ({ key, value }) => {
        localStorage.setItem(key, value);
      },
      { key: THEME_KEY, value: targetTheme },
    );

    // 窗口 B 通过原生 storage 事件被应用监听并自动应用到 DOM（真实事件 + 应用响应）
    await expect
      .poll(() =>
        pageB.evaluate(() => document.documentElement.getAttribute("data-theme")),
      )
      .toBe(targetTheme);

    await context.close();
  });

  // #225 D/P1-1：负向断言 —— 不同 browser context 存储相互隔离，
  // 不能把「同 context 两 page 联动了」误当成「跨窗口机制对」。
  test("P1-1 负向：另一 browser context 切换主题不影响本 context（存储隔离）", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await openMockWorkspace(pageA);
    await openMockWorkspace(pageB);
    const before = await pageB.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(before).toBe("light"); // Playwright 默认 prefers-color-scheme: light
    expect(await pageB.evaluate(() => localStorage.getItem("inkling-theme"))).toBeNull();

    // A 窗口写入主题（与 #133 用例同一底层路径：真实 setItem 触发原生 storage 事件）
    await pageA.evaluate(() => {
      localStorage.setItem("inkling-theme", "builtin:dark");
    });
    // 写入侧存储已变（storage 事件不会在本窗口触发，故这里只断言存储；
    // 「同 context 另一窗口的联动」由 #133 用例正向覆盖）
    expect(await pageA.evaluate(() => localStorage.getItem("inkling-theme"))).toBe("builtin:dark");

    // B 窗口（另一存储域）必须完全不受影响
    await pageB.waitForTimeout(300);
    expect(await pageB.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe(
      before,
    );
    expect(await pageB.evaluate(() => localStorage.getItem("inkling-theme"))).toBeNull();

    await ctxA.close();
    await ctxB.close();
  });
});

// #165：workspace 域（最近文件/书签）此前没有 storage 事件同步，
// 多窗口下后写覆盖先写。这里验证窗口 A 的真实应用写入（加入书签 / 打开文件）
// 经原生 storage 事件自动出现在窗口 B 的侧边栏。
test.describe("workspace 持久化的跨窗口同步 (#165)", () => {
  test("窗口 A 加入书签后，窗口 B 侧边栏自动出现书签条目", async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await openMockWorkspace(pageA);
    await openMockWorkspace(pageB);

    // 初始两窗口都没有书签区块
    const bookmarkSectionB = pageB.locator(".recent-section").filter({ hasText: "书签" });
    await expect(bookmarkSectionB).toHaveCount(0);

    // 窗口 A 走真实应用路径加入书签（右键菜单 → toggleBookmark → persistBookmarks）
    await pageA
      .locator('[data-tree-row][data-path="/mock-workspace/notes"]')
      .click(); // 展开 notes 目录
    await pageA
      .locator('[data-tree-row][data-path="/mock-workspace/notes/readme.md"]')
      .click({ button: "right" });
    await pageA.locator(".tree-context-item").filter({ hasText: "加入书签" }).click();
    await expect(
      pageA.locator(".recent-section").filter({ hasText: "书签" }).getByText("readme.md"),
    ).toBeVisible();

    // 窗口 B 经原生 storage 事件同步：书签区块自动出现且包含 readme.md
    await expect
      .poll(async () => bookmarkSectionB.getByText("readme.md").isVisible().catch(() => false))
      .toBe(true);

    await context.close();
  });

  test("窗口 A 打开文件后，窗口 B 侧边栏自动记录最近打开", async ({ browser }) => {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    await openMockWorkspace(pageA);
    await openMockWorkspace(pageB);

    const recentSectionB = pageB.locator(".recent-section").filter({ hasText: "最近打开" });

    // 窗口 A 打开 intro.md（真实打开链路：激活后写入最近文件）
    await pageA
      .locator('[data-tree-row][data-path="/mock-workspace/intro.md"]')
      .click();
    await expect(pageA.locator(".tab-active")).toContainText("intro.md");

    // 窗口 B 经原生 storage 事件同步：最近打开区块出现 intro.md
    await expect
      .poll(async () => recentSectionB.getByText("intro.md").isVisible().catch(() => false))
      .toBe(true);

    await context.close();
  });
});
// E2E：源代码模式（issue #19）

import { test, expect } from "@playwright/test";
import { openMockWorkspace, openFile, moveCaretToDocEnd, MOD } from "./helpers";

test.describe("源代码模式", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
  });

  test("SM1 顶栏按钮切换源码模式", async ({ page }) => {
    const btn = page.locator('.topbar-btn[title*="源代码模式"]');
    await btn.click();
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".ProseMirror")).toBeHidden();
    await btn.click();
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("source-mode-editor")).toBeHidden();
  });

  test("SM2 快捷键 Ctrl+Alt+S 切换", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
  });

  test("SM3 源码模式编辑会标记未保存", async ({ page }) => {
    await page.locator('.topbar-btn[title*="源代码模式"]').click();
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("source-mode-editor").locator(".cm-content").click();
    await page.keyboard.type("# source mode edit");
    await expect(page.getByText("未保存")).toBeVisible({ timeout: 5_000 });
  });

  test("SM5 编辑后立即切换源码模式不丢失防抖窗口内的输入", async ({ page }) => {
    // 回归：publisher 序列化防抖 150ms，切换瞬间 store 若落后于 PM doc，
    // 源码模式会用旧内容播种并永久丢失最近编辑（PR #34 review P1）
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("即时切换不丢字");
    // 不等防抖，立即切换
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(
      page.getByTestId("source-mode-editor").locator(".cm-content"),
    ).toContainText("即时切换不丢字", { timeout: 5_000 });
    // 往返回 WYSIWYG 内容仍在
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toContainText("即时切换不丢字", {
      timeout: 5_000,
    });
  });

  test("SM4 callout 往返", async ({ page }) => {
    await openFile(page, "callout-demo.md");
    await page.locator('.topbar-btn[title*="源代码模式"]').click();
    await expect(page.getByTestId("source-mode-editor").locator(".cm-content")).toContainText("[!", { timeout: 5_000 });
    await page.locator('.topbar-btn[title*="源代码模式"]').click();
    await expect(page.locator(".callout-block").first()).toBeVisible({ timeout: 5_000 });
  });

  test("SM6 源码模式下大纲面板正常解析标题并支持点击跳转", async ({ page }) => {
    await openFile(page, "outline-demo.md");
    // 确保大纲面板可见
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }

    // 切换至源码模式
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });

    // 大纲项依然存在且与文档结构对应
    const outlineItems = panel.locator(".outline-item");
    await expect(outlineItems.first()).toBeVisible({ timeout: 5_000 });
    expect(await outlineItems.count()).toBe(3);

    // 点击三级标题大纲项跳转并激活
    const thirdItem = outlineItems.nth(2);
    await thirdItem.click();
    await expect(thirdItem).toHaveClass(/active/, { timeout: 5_000 });
  });

  test("SM7 源码模式新增标题后大纲在停笔后更新（#375）", async ({ page }) => {
    await openFile(page, "outline-demo.md");
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor");
    await expect(source).toBeVisible({ timeout: 5_000 });
    await expect(panel.locator(".outline-item")).toHaveCount(3);

    await source.locator(".cm-content").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("# 新增标题");

    // 停笔后防抖 200ms 内完成重解析并发布新标题集
    const items = panel.locator(".outline-item");
    await expect(items).toHaveCount(4, { timeout: 5_000 });
    await expect(items.nth(3)).toContainText("新增标题");
    // 旧标题仍在且顺序不变（未因重解析整体错位）
    await expect(items.nth(0)).toContainText("一级标题");
    await expect(items.nth(2)).toContainText("三级标题");
  });

  test("SM8 源码模式新增标题后立即退出，大纲不回退旧快照（#375 竞态）", async ({ page }) => {
    await openFile(page, "outline-demo.md");
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor");
    await expect(source).toBeVisible({ timeout: 5_000 });

    // 把源码模式大纲防抖（200ms）拉长到 1200ms：打字速度不再决定
    // 「切回 WYSIWYG 时定时器是否还挂在队列上」，竞态成为确定性事件。
    // 只包 200ms 定时器，且只在打字期间生效；切回前恢复，避免 WYSIWYG tracker
    // 自己的 200ms 滚动停歇刷新混入计数。
    await page.evaluate(() => {
      const w = window as unknown as {
        __outlineTimerFires?: number;
        __outlineTimerArmed?: boolean;
        __origSetTimeout?: typeof window.setTimeout;
      };
      w.__outlineTimerFires = 0;
      w.__outlineTimerArmed = false;
      w.__origSetTimeout = window.setTimeout.bind(window);
      const orig = w.__origSetTimeout;
      window.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (timeout === 200 && typeof handler === "function") {
          return orig(() => {
            if (w.__outlineTimerArmed) {
              w.__outlineTimerFires = (w.__outlineTimerFires ?? 0) + 1;
            }
            handler(...args);
          }, 1200);
        }
        return orig(handler, timeout, ...args);
      }) as typeof window.setTimeout;
    });

    await source.locator(".cm-content").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("# 竞态标题");

    // 打字结束：恢复 setTimeout 并布防（此后的迟到触发才计入），再切回 WYSIWYG。
    // 卸载若没清掉待执行定时器，它会在 1200ms 后触发并留下计数。
    await page.evaluate(() => {
      const w = window as unknown as {
        __outlineTimerFires?: number;
        __outlineTimerArmed?: boolean;
        __origSetTimeout?: typeof window.setTimeout;
      };
      window.setTimeout = w.__origSetTimeout!;
      w.__outlineTimerArmed = true;
    });
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });

    const items = panel.locator(".outline-item");
    await expect(items).toHaveCount(4, { timeout: 5_000 });
    await expect(items.nth(3)).toContainText("竞态标题");

    // 越过被拉长的防抖窗口后，源码模式的旧定时器必须已被卸载清理
    await page.waitForTimeout(1_400);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as { __outlineTimerFires?: number }
          ).__outlineTimerFires,
      ),
    ).toBe(0);
    await expect(items).toHaveCount(4);
  });

  test("SM9 源码模式滚动时活动标题按行号定位（含重复标题）", async ({ page }) => {
    // #375：活动项由「视口高度 → 行块 → 标题行号二分」定位。
    // 用同名标题分别放在中段与末尾，滚动到底部时必须命中末尾那个（按行号而不是按文本）。
    const body = (label: string) =>
      Array.from({ length: 8 }, (_, i) => `${label}正文 ${i + 1}`);
    const doc = [
      "# 长文顶部",
      "",
      ...Array.from({ length: 20 }, (_, i) => [
        `## 前段 ${i + 1}`,
        "",
        ...body("前段"),
        "",
      ]).flat(),
      "## 重复标题",
      "",
      ...body("第一个重复标题后"),
      "",
      ...Array.from({ length: 20 }, (_, i) => [
        `## 后段 ${i + 1}`,
        "",
        ...body("后段"),
        "",
      ]).flat(),
      "## 重复标题",
      "",
      ...Array.from({ length: 80 }, (_, i) => `末尾填充段落 ${i + 1}`),
    ].join("\n");

    await openFile(page, "outline-demo.md");
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor");
    await expect(source.locator(".cm-content")).toBeVisible({ timeout: 5_000 });

    await source.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+KeyA`);
    await page.keyboard.insertText(doc);

    const items = panel.locator(".outline-item");
    const duplicates = items.filter({ hasText: "重复标题" });
    // 1 个顶部标题 + 20 前段 + 1 重复 + 20 后段 + 1 重复
    await expect(items).toHaveCount(43, { timeout: 10_000 });
    await expect(duplicates).toHaveCount(2);

    // 反复设置 scrollTop 直到虚拟化高度稳定在底部
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector(
              ".source-mode-editor .cm-scroller",
            ) as HTMLElement | null;
            if (!el) return 0;
            const max = el.scrollHeight - el.clientHeight;
            if (max <= 0) return 0;
            const ratio = el.scrollTop / max;
            if (ratio < 0.98) el.scrollTop = el.scrollHeight;
            return ratio;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.98);

    // 末尾重复标题成为活动项；中段同名标题不得被误选
    await expect(duplicates.nth(1)).toHaveClass(/outline-item-active/, {
      timeout: 10_000,
    });
    await expect(duplicates.nth(0)).not.toHaveClass(/outline-item-active/);

    // 回到顶部：首标题重新激活（视口在首标题之上时归到首标题）
    await page.evaluate(() => {
      const el = document.querySelector(
        ".source-mode-editor .cm-scroller",
      ) as HTMLElement | null;
      if (el) el.scrollTop = 0;
    });
    await expect(items.first()).toHaveClass(/outline-item-active/, {
      timeout: 10_000,
    });
  });
});

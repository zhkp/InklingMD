// E2E：源代码模式（issue #19）

import { test, expect } from "@playwright/test";
import { openMockWorkspace, openFile, moveCaretToDocStart, MOD } from "./helpers";

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

  test("SM7 双向无缝切换：长文档光标与阅读进度原地保留（issue #136）", async ({ page }) => {
    // 构造长文档：全选现有内容后插入 400 段正文
    await page.locator(".ProseMirror").click();
    await page.keyboard.press(`${MOD}+KeyA`);
    const paragraphs: string[] = [];
    for (let i = 0; i < 400; i++) {
      paragraphs.push(`第 ${i} 节：模式切换滚动恢复回归的长文档正文，模拟真实笔记内容段落 ${i}。`);
    }
    await page.keyboard.insertText(paragraphs.join("\n\n"));
    await expect(page.locator(".ProseMirror")).toContainText("第 399 节", { timeout: 10_000 });
    // 等待防抖序列化与渲染稳定
    await page.waitForTimeout(600);

    const wysiwyg = page.locator(".editor-scroll");
    const cm = page.getByTestId("source-mode-editor");
    const cmScroller = cm.locator(".cm-scroller");
    const bottomRatio = (el: Element) =>
      (el.scrollTop + el.clientHeight) / Math.max(1, el.scrollHeight);

    // ---- 方向 A（issue 复现路径）：顶部进入源码模式 ----
    await moveCaretToDocStart(page);
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(cm).toBeVisible({ timeout: 5_000 });

    // 在源码里滚/移动到底部并编辑（模拟用户「看完源码」的场景）
    await cm.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+End`);
    await expect
      .poll(async () => cmScroller.evaluate(bottomRatio), { timeout: 5_000 })
      .toBeGreaterThan(0.7);
    await page.keyboard.type("EDITED-136");

    // 退出源码模式：阅读进度必须保留在底部（修复前被过期记忆拉回顶部）
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () => wysiwyg.evaluate(bottomRatio), { timeout: 5_000 })
      .toBeGreaterThan(0.7);
    // 编辑内容往返保留
    await expect(page.locator(".ProseMirror")).toContainText("EDITED-136");
    // 光标在可视区域内：聚焦编辑器后读取真实选区几何
    await page.locator(".ProseMirror").press("ArrowLeft");
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const sel = window.getSelection();
            const scroller = document.querySelector(".editor-scroll");
            if (!sel || sel.rangeCount === 0 || !scroller) return false;
            const r = sel.getRangeAt(0).getBoundingClientRect();
            const s = scroller.getBoundingClientRect();
            return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom;
          }),
        { timeout: 5_000 },
      )
      .toBe(true);

    // ---- 方向 B：底部富文本进入源码模式，进度与光标原地保留 ----
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(cm).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () => cmScroller.evaluate(bottomRatio), { timeout: 5_000 })
      .toBeGreaterThan(0.7);
    // CM 光标在可视区域内
    await expect
      .poll(
        async () =>
          cmScroller.evaluate((el) => {
            const cursor = document.querySelector(
              ".source-mode-editor .cm-cursor",
            );
            if (!cursor) return false;
            const r = cursor.getBoundingClientRect();
            const s = el.getBoundingClientRect();
            return r.height > 0 && r.top >= s.top && r.bottom <= s.bottom;
          }),
        { timeout: 5_000 },
      )
      .toBe(true);

    // ---- 往返稳定性：再切回富文本，阅读进度仍在底部 ----
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(async () => wysiwyg.evaluate(bottomRatio), { timeout: 5_000 })
      .toBeGreaterThan(0.7);
  });

  test("SM8 中部位置双向切换：阅读进度按比例保留 ±0.15（review 补测）", async ({ page }) => {
    // 旧实现现场读取已 display:none 塌陷的 scrollHeight（≈clientHeight），
    // 中部位置（0.504）映射成天文数字被钳到底部（1.000）。本用例钉住中部。
    await page.locator(".ProseMirror").click();
    await page.keyboard.press(`${MOD}+KeyA`);
    const paragraphs: string[] = [];
    for (let i = 0; i < 400; i++) {
      paragraphs.push(`第 ${i} 节：中部位置模式切换阅读进度保留回归段落 ${i}。`);
    }
    await page.keyboard.insertText(paragraphs.join("\n\n"));
    await expect(page.locator(".ProseMirror")).toContainText("第 399 节", { timeout: 10_000 });
    await page.waitForTimeout(600);

    const wysiwyg = page.locator(".editor-scroll");
    const cm = page.getByTestId("source-mode-editor");
    const cmScroller = cm.locator(".cm-scroller");
    const progressOf = (el: Element) => {
      const range = el.scrollHeight - el.clientHeight;
      return range > 0 ? el.scrollTop / range : 0;
    };

    // 滚到中部并把光标落在可视中央：光标与阅读进度一致，
    // 进入源码模式后的「光标可视兜底」才不会把视口拉走
    await wysiwyg.evaluate((el) => {
      el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.5;
    });
    const box = await wysiwyg.boundingBox();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const before = await wysiwyg.evaluate(progressOf);
    expect(before).toBeGreaterThan(0.25);
    expect(before).toBeLessThan(0.75);

    // ---- 进入源码模式：进度保持在中部（修复前被钳到底部） ----
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(cm).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        async () => Math.abs((await cmScroller.evaluate(progressOf)) - before),
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(0.15);
    const cmBeforeExit = await cmScroller.evaluate(progressOf);

    // ---- 退出源码模式：进度回到中部 ----
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(
        async () => Math.abs((await wysiwyg.evaluate(progressOf)) - cmBeforeExit),
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(0.15);
  });

  test("SM9 源码模式全局快捷键不被 CM 内建键位双触发（review 问题 2）", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const cm = page.getByTestId("source-mode-editor");
    await expect(cm).toBeVisible({ timeout: 5_000 });
    const cmContent = cm.locator(".cm-content");
    await cmContent.click();

    const tabsBefore = await page.locator(".tab-name").count();

    // Ctrl+/：只应打开快捷键帮助；修复前 CM toggleComment 会同时插入注释
    await page.keyboard.press(`${MOD}+/`);
    await expect(
      page.getByRole("dialog", { name: "快捷键帮助" }),
    ).toBeVisible({ timeout: 5_000 });
    expect(await cmContent.innerText()).not.toContain("<!--");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "快捷键帮助" })).toBeHidden();

    // Ctrl+N：只应新建草稿；修复前 CM cursorLineDown 会同时吃掉按键
    await page.keyboard.press(`${MOD}+KeyN`);
    await expect
      .poll(async () => page.locator(".tab-name").count(), { timeout: 5_000 })
      .toBe(tabsBefore + 1);
  });
});

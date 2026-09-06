// E2E：模式切换滚动位置恢复（issue #136）
// 方向 A：源码模式 → 富文本（退出）
// 方向 B：富文本 → 源码模式（进入）
// 断言：切换后滚动容器 scrollTop 接近映射目标值，且光标所在内容位于可视区域

import { test, expect, type Page } from "@playwright/test";
import { openMockWorkspace, openFile, MOD, waitScrollConverged } from "./helpers";

const LONG_DOC = Array.from(
  { length: 300 },
  (_, i) => `## 第 ${i + 1} 节\n\n这是第 ${i + 1} 节的正文内容，用来撑长文档以测试滚动恢复。`,
).join("\n\n");

async function scrollInfo(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      maxScroll: el.scrollHeight - el.clientHeight,
    };
  }, selector);
}

function ratio(info: { scrollTop: number; maxScroll: number } | null) {
  if (!info || info.maxScroll <= 0) return 0;
  return info.scrollTop / info.maxScroll;
}

/** 进入源码模式 */
async function enterSourceMode(page: Page) {
  await page.keyboard.press(`${MOD}+Alt+KeyS`);
  await expect(
    page.getByTestId("source-mode-editor").locator(".cm-content"),
  ).toBeVisible({ timeout: 5_000 });
}

/** 退出源码模式 */
async function exitSourceMode(page: Page) {
  await page.keyboard.press(`${MOD}+Alt+KeyS`);
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
}

/** 在源码模式下灌入长文并退回富文本，构造长文档场景 */
async function buildLongDocInWysiwyg(page: Page) {
  await enterSourceMode(page);
  const cm = page.getByTestId("source-mode-editor").locator(".cm-content");
  await cm.click();
  await page.keyboard.insertText(LONG_DOC);
  await exitSourceMode(page);
  await expect(page.locator(".ProseMirror")).toContainText("第 300 节", {
    timeout: 10_000,
  });
  // #214：退出源码模式的过渡恢复（settle 收敛循环，最长 30 帧）会按「进入
  // 前的锚点」持续校正 WYSIWYG 滚动——本 fixture 在文档顶部进入源码模式，
  // 退出时 settle 会把视口校正回顶部。旧实现只等 scrollHeight 撑起
  //（waitForFunction 布局轮询）不等过渡收敛：若调用方紧接着 scrollTop=…
  // 赋值且 settle 尚未结束，赋值会被后续收敛帧拽回，表现为前置断言 flaky。
  // 与用例 A 一致，改为等 scrollTop + scrollHeight 双重收敛（waitScrollConverged
  // 连续 3 次稳定 ≈ 300-500ms，同时覆盖布局撑起与过渡结束）再返回。
  await waitScrollConverged(page, ".editor-scroll", 15_000);
}

/** 滚动 CM 到底部并点击底部文本行放置光标（模拟真实用户位置） */
async function scrollCmToBottomAndClick(page: Page) {
  // insertText 后 CM 视口化渲染需时间撑起 scrollHeight，单次 `scrollTop =
  // scrollHeight` 会被当时的 maxScroll clamp 到很小值（慢 CI 上 ratio 近 0）。
  // 轮询等待滚动真正生效，未生效则持续重设直到滚到底部。
  await expect
    .poll(
      async () => {
        const info = await scrollInfo(page, ".source-mode-editor .cm-scroller");
        if (!info || info.maxScroll <= 0) return false;
        if (ratio(info) > 0.9) return true;
        await page.evaluate(() => {
          const el = document.querySelector(".source-mode-editor .cm-scroller");
          if (el) el.scrollTop = el.scrollHeight;
        });
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  const box = await page.getByTestId("source-mode-editor").boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(
    box!.x + box!.width / 2,
    box!.y + box!.height - 40,
  );
}

test.describe("模式切换滚动位置恢复（#136）", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
  });

  test("A：源码模式滚到底部编辑，退出后视口停留在底部映射位置且光标可见", async ({ page }) => {
    // 进入源码模式并构造长文（进入前停留在顶部，对应 issue 复现步骤）
    await enterSourceMode(page);
    const cm = page.getByTestId("source-mode-editor").locator(".cm-content");
    await cm.click();
    await page.keyboard.insertText(LONG_DOC);

    // 滚到底部并放置光标、编辑
    await scrollCmToBottomAndClick(page);
    await page.keyboard.type("尾部编辑");

    const cmBefore = await scrollInfo(page, ".source-mode-editor .cm-scroller");
    // 前置条件：CM 已滚动到底部
    expect(ratio(cmBefore)).toBeGreaterThan(0.9);

    // 退出源码模式
    await exitSourceMode(page);
    await expect(page.locator(".ProseMirror")).toContainText("第 300 节", {
      timeout: 10_000,
    });
    // 等 settle 收敛循环真正稳定后再读滚动位置（替代固定 1s sleep，评审 N6）
    await waitScrollConverged(page, ".editor-scroll");

    const pmAfter = await scrollInfo(page, ".editor-scroll");
    // 视口接近底部映射位置，而非顶部
    expect(ratio(pmAfter)).toBeGreaterThan(0.5);
    // 光标所在的编辑内容在可视区域内
    await expect(page.getByText("尾部编辑")).toBeInViewport();
  });

  test("A2：进入前富文本已滚动到中部，退出后仍以源码侧位置为准（单一写者）", async ({ page }) => {
    await buildLongDocInWysiwyg(page);

    // 富文本滚到中部并等待滚动收敛（tab 记忆防抖 300ms 落盘）
    await page.evaluate(() => {
      const el = document.querySelector(".editor-scroll");
      if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.4;
    });
    await waitScrollConverged(page, ".editor-scroll");

    // 进入源码模式（WYSIWYG 塌缩会把 tab 滚动记忆钳 0 污染）
    await enterSourceMode(page);
    const cm = page.getByTestId("source-mode-editor").locator(".cm-content");
    await cm.click();
    await page.keyboard.press(`${MOD}+KeyA`);
    await page.keyboard.insertText(LONG_DOC);
    await waitScrollConverged(page, ".source-mode-editor .cm-scroller");

    // 源码侧滚到底部编辑
    await scrollCmToBottomAndClick(page);
    await page.keyboard.type("底部锚点");

    await exitSourceMode(page);
    await expect(page.locator(".ProseMirror")).toContainText("底部锚点", {
      timeout: 10_000,
    });
    await waitScrollConverged(page, ".editor-scroll");

    const pmAfter = await scrollInfo(page, ".editor-scroll");
    // 以源码侧结束位置为唯一事实源：接近底部，而非中部旧值或顶部
    expect(ratio(pmAfter)).toBeGreaterThan(0.5);
    await expect(page.getByText("底部锚点")).toBeInViewport();
  });

  test("B：富文本滚到底部，进入源码模式后视口停留在底部映射位置且光标可见", async ({ page }) => {
    await buildLongDocInWysiwyg(page);

    // 滚到底部并点击底部文本放置光标
    await page.evaluate(() => {
      const el = document.querySelector(".editor-scroll");
      if (el) el.scrollTop = el.scrollHeight;
    });
    const box = await page.locator(".editor-scroll").boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 40);

    const pmBefore = await scrollInfo(page, ".editor-scroll");
    expect(ratio(pmBefore)).toBeGreaterThan(0.9);

    // 进入源码模式
    await enterSourceMode(page);
    await waitScrollConverged(page, ".source-mode-editor .cm-scroller");

    const cmAfter = await scrollInfo(page, ".source-mode-editor .cm-scroller");
    expect(ratio(cmAfter)).toBeGreaterThan(0.5);
    // 光标附近内容在可视区域内（CM 视口化渲染：不可见则不渲染）
    await expect(
      page.getByTestId("source-mode-editor").getByText("## 第 300 节", {
        exact: true,
      }),
    ).toBeInViewport();
  });

  test("B2：富文本滚到中部，进入源码模式后保持中部映射位置、不钳到底部（#138 进入方向缺陷回归）", async ({ page }) => {
    await buildLongDocInWysiwyg(page);

    // 滚到中部（只滚动不点击：光标停留在构造文档时的位置，
    // 复刻「只滚动阅读、光标未动」的真实场景）
    await page.evaluate(() => {
      const el = document.querySelector(".editor-scroll");
      if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.5;
    });
    // 等待滚动事件更新持续缓存 + settle 稳定（替代固定 1.5s sleep，评审 N6）
    await waitScrollConverged(page, ".editor-scroll");

    const pmBefore = await scrollInfo(page, ".editor-scroll");
    expect(ratio(pmBefore)).toBeGreaterThan(0.35);
    expect(ratio(pmBefore)).toBeLessThan(0.65);

    await enterSourceMode(page);
    await waitScrollConverged(page, ".source-mode-editor .cm-scroller");

    const cmAfter = await scrollInfo(page, ".source-mode-editor .cm-scroller");
    // 阅读进度比例跨容器保留在中部：旧实现直接拷贝像素值会被
    // CM 更小的 maxScroll 钳到底部（ratio → 1.0）
    expect(ratio(cmAfter)).toBeGreaterThan(0.2);
    expect(ratio(cmAfter)).toBeLessThan(0.8);
  });

  test("B3：往返后滚到新位置再进入，应停在新位置而非旧位置（#137 陈旧位置缺陷回归）", async ({ page }) => {
    await buildLongDocInWysiwyg(page);

    // 往返一：底部进入源码模式再退出（复刻用户操作序列）
    await page.evaluate(() => {
      const el = document.querySelector(".editor-scroll");
      if (el) el.scrollTop = el.scrollHeight;
    });
    const box = await page.locator(".editor-scroll").boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 40);
    await enterSourceMode(page);
    await waitScrollConverged(page, ".source-mode-editor .cm-scroller");
    await exitSourceMode(page);
    await waitScrollConverged(page, ".editor-scroll");

    // 往返后在富文本滚到新的中部位置
    await page.evaluate(() => {
      const el = document.querySelector(".editor-scroll");
      if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.4;
    });
    await waitScrollConverged(page, ".editor-scroll");

    const pmBefore = await scrollInfo(page, ".editor-scroll");
    expect(ratio(pmBefore)).toBeGreaterThan(0.25);
    expect(ratio(pmBefore)).toBeLessThan(0.55);

    // 再次进入源码模式：应停在新位置（中部），而非往返时的旧位置（底部）
    await enterSourceMode(page);
    await waitScrollConverged(page, ".source-mode-editor .cm-scroller");

    const cmAfter = await scrollInfo(page, ".source-mode-editor .cm-scroller");
    expect(ratio(cmAfter)).toBeGreaterThan(0.15);
    expect(ratio(cmAfter)).toBeLessThan(0.75);
  });
});
// E2E：链接跟随
// 覆盖：外部链接 Ctrl+click 打开、锚点链接 Ctrl+click 滚动、裸点击不跟随
//
// #299：原 L3 的断言是 `expect(typeof after).toBe("number")`（恒真），L4 只断言
// `window.open` 未被调用、不看 URL。这里改为：
//   L3  强断言——滚动量 > 100px **且** 目标标题真的落进视口；
//   L3b 反向用例——不存在的锚点不得滚动、不得改 URL/hash；
//   L4  补 `page.url()` 与 hash 断言。
//
// 锚点用例使用 `link-anchor-demo.md`：`link-demo.md` 只有 8 行、目标标题就在首屏，
// `scrollTop` 恒为 0，强化后的断言在它上面必然失败。新 fixture 的正文足够长，目标
// 标题初始在首屏之外——这是"能观测到滚动"的前提，不是可选的排版偏好。

import { test, expect, type Page } from "@playwright/test";
import { openMockWorkspace, openFile, MOD } from "./helpers";

// 点击链接时的修饰键：macOS 用 Meta，其他用 Control
const CLICK_MODIFIER = MOD === "Meta" ? "Meta" : "Control";

// 长文档 fixture：标题组在首屏之外，且链接全部是纯 #frag
const ANCHOR_DEMO_FILE = "link-anchor-demo.md";
// L3 的目标标题：中文同文本锚点，当前匹配端（两侧都 slugify）即可命中，
// 不依赖 #297 的锚点表。
const L3_HEADING = "理解问题与方法";

/** 读取滚动容器位置与目标标题的视口位置（找不到标题时 targetTop 为 NaN，断言自然失败） */
async function readAnchorViewport(page: Page, headingText: string) {
  return page.evaluate((text) => {
    const scroll = document.querySelector(".editor-scroll");
    const heading = Array.from(document.querySelectorAll(".ProseMirror h2")).find(
      (el) => (el.textContent ?? "").trim() === text,
    );
    return {
      scrollTop: scroll ? scroll.scrollTop : -1,
      viewportHeight: window.innerHeight,
      targetTop: heading ? heading.getBoundingClientRect().top : Number.NaN,
    };
  }, headingText);
}

test.describe("链接跟随", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "link-demo.md");
  });

  test("L1 外部链接渲染为 a[href]", async ({ page }) => {
    const link = page.locator('.ProseMirror a[href="https://example.com"]');
    await expect(link).toBeVisible({ timeout: 10_000 });
    await expect(link).toContainText("Example");
  });

  test("L2 Ctrl+click 外部链接调用 window.open", async ({ page }) => {
    const link = page.locator('.ProseMirror a[href="https://example.com"]');
    await expect(link).toBeVisible({ timeout: 10_000 });

    // 注入 window.open 拦截
    await page.evaluate(() => {
      (window as unknown as { __openedUrl: string }).__openedUrl = "";
      const origOpen = window.open.bind(window);
      window.open = (url?: string | URL) => {
        (window as unknown as { __openedUrl: string }).__openedUrl = String(url);
        return null;
      };
      void origOpen;
    });

    // Ctrl/Cmd + click 链接
    await link.click({ modifiers: [CLICK_MODIFIER] });
    await page.waitForTimeout(300);

    const openedUrl = await page.evaluate(
      () => (window as unknown as { __openedUrl: string }).__openedUrl,
    );
    expect(openedUrl).toBe("https://example.com");
  });

  test("L3 Ctrl+click 锚点链接滚动到标题（强断言）", async ({ page }) => {
    await openFile(page, ANCHOR_DEMO_FILE);

    const anchorLink = page.locator('.ProseMirror a[href="#理解问题与方法"]');
    await expect(anchorLink).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator(".ProseMirror h2", { hasText: L3_HEADING }),
    ).toHaveCount(1);

    // 与 L3b 同理：先让 Playwright 完成自己的 scrollIntoViewIfNeeded，再取基线，
    // 避免把「点击前的自动滚动」算成应用行为。
    await anchorLink.scrollIntoViewIfNeeded();

    // 前置条件断言：目标标题初始确实在首屏之外，否则"滚动"无从观测
    const before = await readAnchorViewport(page, L3_HEADING);
    expect(before.targetTop).toBeGreaterThan(before.viewportHeight);

    // Ctrl/Cmd + click 锚点链接
    await anchorLink.click({ modifiers: [CLICK_MODIFIER] });

    // 强断言：相对基线滚动 >100px，且目标标题落进视口
    await expect
      .poll(
        async () => {
          const after = await readAnchorViewport(page, L3_HEADING);
          return (
            after.scrollTop > before.scrollTop + 100 &&
            after.targetTop >= -1 &&
            after.targetTop < after.viewportHeight
          );
        },
        { timeout: 10_000, intervals: [100, 150, 200] },
      )
      .toBe(true);
  });

  test("L3b 不存在的锚点：不滚动、不改 URL", async ({ page }) => {
    await openFile(page, ANCHOR_DEMO_FILE);

    const missingLink = page.locator('.ProseMirror a[href="#不存在的锚点"]');
    await expect(missingLink).toBeVisible({ timeout: 10_000 });

    // 基线必须在「Playwright 已把目标滚进视口」之后取：locator.click() 会先做
    // scrollIntoViewIfNeeded，若该链接初始不在可视区内，这步会自己把 scrollTop
    // 顶上去（实测 0 → 395），从而被误记成"应用滚动了"。先显式滚好，点击时就不会再动。
    await missingLink.scrollIntoViewIfNeeded();

    const urlBefore = page.url();
    const before = await readAnchorViewport(page, L3_HEADING);

    await missingLink.click({ modifiers: [CLICK_MODIFIER] });
    await page.waitForTimeout(600);

    const after = await readAnchorViewport(page, L3_HEADING);
    expect(after.scrollTop).toBe(before.scrollTop);
    expect(page.url()).toBe(urlBefore);
    expect(await page.evaluate(() => window.location.hash)).toBe("");
  });

  test("L4 普通 click 不触发链接跟随，也不改变 URL", async ({ page }) => {
    const link = page.locator('.ProseMirror a[href="https://example.com"]');
    await expect(link).toBeVisible({ timeout: 10_000 });

    // 注入拦截
    await page.evaluate(() => {
      (window as unknown as { __openedUrl: string }).__openedUrl = "";
      window.open = (url?: string | URL) => {
        (window as unknown as { __openedUrl: string }).__openedUrl = String(url);
        return null;
      };
    });

    const urlBefore = page.url();

    // 不按修饰键直接 click，不应调用 window.open，也不应把 WebView 导航走
    await link.click();
    await page.waitForTimeout(300);

    const openedUrl = await page.evaluate(
      () => (window as unknown as { __openedUrl: string }).__openedUrl,
    );
    expect(openedUrl).toBe("");
    expect(page.url()).toBe(urlBefore);
    expect(await page.evaluate(() => window.location.hash)).toBe("");
  });
});

// E2E：Smart Paste（#219）
//
// 在真实 Chromium 里走完整粘贴链路。两种注入方式：
// - 构造 ClipboardEvent（DataTransfer 注入 text/html / text/plain）派发到编辑区——可精确控制
//   剪贴板形态（如「只有 text/html、没有 files」的 macOS 图片复制）
// - 真实系统剪贴板 + 键盘快捷键（Ctrl+V / Ctrl+Shift+V）——验证浏览器原生粘贴事件与
//   「粘贴为纯文本」快捷键

import { test, expect, type Page } from "@playwright/test";
import { openMockWorkspace, openFile, MOD } from "./helpers";

const PM = ".ProseMirror";

/**
 * 光标移到文末的新空段落。直接用 DOM 选区定位到最后一个文本节点末尾（ProseMirror 经
 * selectionchange 同步），比 Ctrl+End 稳定；readme.md 以列表结尾：第一次回车新建列表项，
 * 第二次在空列表项上回车退出列表。
 */
async function focusDocEnd(page: Page) {
  await page.locator(PM).focus();
  await page.evaluate((sel) => {
    const root = document.querySelector(sel)!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    while (walker.nextNode()) last = walker.currentNode as Text;
    window.getSelection()!.collapse(last!, last!.length);
  }, PM);
  await page.waitForTimeout(50);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.locator(`${PM} > p:last-child`)).toHaveText("");
}

/** 构造 ClipboardEvent 派发到编辑区，返回是否被 preventDefault（即被编辑器接管） */
async function dispatchPaste(page: Page, data: Record<string, string>) {
  return page.evaluate((entries) => {
    const dt = new DataTransfer();
    for (const [type, value] of Object.entries(entries)) dt.setData(type, value);
    const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector(".ProseMirror")!.dispatchEvent(event);
    return event.defaultPrevented;
  }, data);
}

async function sourceText(page: Page): Promise<string> {
  await page.keyboard.press(`${MOD}+Alt+KeyS`);
  const cm = page.getByTestId("source-mode-editor").locator(".cm-content");
  await expect(cm).toBeVisible({ timeout: 5_000 });
  const text = await cm.innerText();
  await page.keyboard.press(`${MOD}+Alt+KeyS`);
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
  return text;
}

test.describe("Smart Paste", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
  });

  test("SP1 网页 HTML 粘贴转为结构化内容，脚本与事件处理器不执行", async ({ page }) => {
    await focusDocEnd(page);
    const html =
      '<h2 onclick="window.__spXss=1">粘贴的章节</h2>' +
      '<p>正文 <strong>加粗</strong> <a href="https://example.com">链接</a>' +
      '<img src="x-not-exist.png" onerror="window.__spXss=2"></p>' +
      "<ul><li>要点一</li><li>要点二</li></ul>" +
      '<pre><code class="language-js">const a = 1;</code></pre>' +
      "<table><tr><th>列A</th><th>列B</th></tr><tr><td>1</td><td>2</td></tr></table>" +
      "<script>window.__spXss = 3</script>";
    expect(await dispatchPaste(page, { "text/html": html, "text/plain": "粘贴的章节" })).toBe(true);

    await expect(page.locator(`${PM} h2`, { hasText: "粘贴的章节" })).toBeVisible();
    await expect(page.locator(`${PM} strong`, { hasText: "加粗" })).toBeVisible();
    await expect(page.locator(`${PM} li`, { hasText: "要点二" })).toBeVisible();
    await expect(page.locator(`${PM} table`)).toBeVisible();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as unknown as { __spXss?: number }).__spXss)).toBeUndefined();

    const md = await sourceText(page);
    expect(md).toContain("## 粘贴的章节");
    expect(md).toContain("**加粗**");
    expect(md).toContain("[链接](https://example.com)");
    expect(md).toContain("```js");
    expect(md).toMatch(/\|\s*列A\s*\|\s*列B\s*\|/);
    expect(md).not.toMatch(/onclick|onerror|__spXss|<script/);
  });

  test("SP3 纯文本粘贴按原样插入（不做转换）", async ({ page }) => {
    await focusDocEnd(page);
    await dispatchPaste(page, { "text/plain": "今天天气很好，我们去公园散步。" });
    await expect(page.locator(`${PM} p`, { hasText: "今天天气很好，我们去公园散步。" })).toBeVisible();
    await expect(page.locator(`${PM} h1, ${PM} h2`)).toHaveCount(1); // 仅原文档的 # Readme
  });

  test("SP4 一次粘贴 = 一个撤销步", async ({ page }) => {
    await focusDocEnd(page);
    await page.keyboard.type("前置输入");
    await dispatchPaste(page, { "text/html": "<h3>撤销测试</h3><ol><li>甲</li><li>乙</li></ol>", "text/plain": "撤销测试" });
    await expect(page.locator(`${PM} h3`, { hasText: "撤销测试" })).toBeVisible();
    await page.keyboard.press(`${MOD}+z`);
    await expect(page.locator(`${PM} h3`)).toHaveCount(0);
    await expect(page.locator(`${PM} li`, { hasText: "甲" })).toHaveCount(0);
    await expect(page.locator(PM)).toContainText("前置输入");
  });

  test("SP5 真实剪贴板：Ctrl+V 转换 HTML，Ctrl+Shift+V 粘贴为纯文本", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.evaluate(async () => {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob(["<h3>剪贴板标题</h3><p><em>斜体</em></p>"], { type: "text/html" }),
          "text/plain": new Blob(["### 剪贴板标题\n\n*斜体*"], { type: "text/plain" }),
        }),
      ]);
    });

    await focusDocEnd(page);
    await page.keyboard.press(`${MOD}+KeyV`);
    await expect(page.locator(`${PM} h3`, { hasText: "剪贴板标题" })).toBeVisible();
    await expect(page.locator(`${PM} em`, { hasText: "斜体" })).toBeVisible();

    await page.keyboard.press("Enter");
    await page.keyboard.press(`${MOD}+Shift+KeyV`);
    // 纯文本：字面 Markdown 源码，不生成新的 h3
    await expect(page.locator(PM)).toContainText("### 剪贴板标题");
    await expect(page.locator(`${PM} h3`)).toHaveCount(1);
  });

  test("SP8 源码模式不做 HTML 转换，保持纯文本", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const cm = page.getByTestId("source-mode-editor").locator(".cm-content");
    await expect(cm).toBeVisible({ timeout: 5_000 });
    await cm.click();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData("text/html", "<h2>HTML 标题</h2>");
      dt.setData("text/plain", "纯文本内容");
      document
        .querySelector('[data-testid="source-mode-editor"] .cm-content')!
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(cm).toContainText("纯文本内容");
    await expect(cm).not.toContainText("## HTML 标题");
  });
});

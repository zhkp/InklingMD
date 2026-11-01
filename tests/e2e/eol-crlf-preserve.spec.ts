// E2E：换行保真（issue #368）
//
// 场景：CRLF 文件打开 → WYSIWYG 编辑一行 → Ctrl+S 保存 → 读回 mock 磁盘内容，
// 断言写盘字节仍为 CRLF，且与原文件逐行对比**仅编辑行不同**（等价于
// 「git diff 只显示该行」的验收口径）。
// 源码模式同样验证一遍（CodeMirror 编辑 → 保存 → CRLF 保持）。
// LF 文件做对照：保存后不得引入 CR。
//
// mock 侧写盘落在 MOCK_FILE_CONTENT（fs.ts 浏览器分支），通过 Vite dev
// 模块导入读取同一实例（同 source-mode-scroll-race.spec.ts 的注入口径）。

import { test, expect } from "@playwright/test";
import { MOD, openFile, openMockWorkspace, expandMockNotes, moveCaretToDocEnd } from "./helpers";

/** CRLF fixture：标题 + 段落（Milkdown parse→serialize 对该形态逐字稳定） */
const CRLF_DOC = [
  "# 换行保真验证",
  "",
  "第一段正文，用于验证 CRLF 保持。",
  "",
  "## 二级标题",
  "",
  "第二段正文，光标将落在这一段末尾。",
  "",
].join("\r\n");

/**
 * 末行**无**换行的 CRLF fixture（评审 B3）：覆盖「文件末尾换行保持」。
 * 原文件末行无换行时，序列化器恒补的 \n 必须被去掉，否则 git diff 除编辑行
 * 外还会多一条「末尾换行」差异——这正是 #368 要消除的整文件 diff 来源之一。
 */
const CRLF_DOC_NO_FINAL_NEWLINE = CRLF_DOC.replace(/\r\n$/, "");

/** 读取 mock 磁盘上指定路径的当前内容（与页面同一模块实例） */
async function readMockContent(page: import("@playwright/test").Page, path: string) {
  return page.evaluate(async (p) => {
    const { MOCK_FILE_CONTENT } = (await import(
      // @ts-ignore Vite dev 专用绝对模块路径（运行时可用，TS 无对应声明）
      "/src/lib/mockFs.ts"
    )) as typeof import("../../src/lib/mockFs");
    return MOCK_FILE_CONTENT[p];
  }, path);
}

/** 注入 fixture：必须在 goto 后、点开文件前完成（打开动作才读取内容槽） */
async function seedMockContent(page: import("@playwright/test").Page, path: string, content: string) {
  await page.evaluate(
    async ({ p, c }) => {
      const { MOCK_FILE_CONTENT } = (await import(
        // @ts-ignore Vite dev 专用绝对模块路径
        "/src/lib/mockFs.ts"
      )) as typeof import("../../src/lib/mockFs");
      MOCK_FILE_CONTENT[p] = c;
    },
    { p: path, c: content },
  );
}

/** 断言 written 与 original 仅 expectedChangedLines 中的行不同，且全部为 CRLF 行尾 */
function assertCrlfDiffOnly(written: string, original: string, changedLineSuffix: string) {
  // 写盘内容不允许出现孤立 \n（未跟 \r 的换行 = 换行保真失败）
  expect(written, "写盘后不得残留孤立 LF").not.toMatch(/(?<!\r)\n/);
  const before = original.split("\r\n");
  const after = written.split("\r\n");
  expect(after.length, "行数不得因保存而变化").toBe(before.length);
  const diffs: number[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) diffs.push(i);
  }
  expect(
    diffs.length,
    `只允许编辑行变化，实际差异行：${diffs.map((i) => `${i}:${JSON.stringify(before[i])}→${JSON.stringify(after[i])}`).join("; ")}`,
  ).toBe(1);
  expect(after[diffs[0]]).toBe(before[diffs[0]] + changedLineSuffix);
}

test.describe("换行保真（#368）", () => {
  test("CRLF 文件在 WYSIWYG 编辑一行并保存：写盘仍为 CRLF，仅编辑行变化", async ({ page }) => {
    const path = "/mock-workspace/notes/readme.md";
    await openMockWorkspace(page);
    // 注入必须晚于 openMockWorkspace 的 goto（页面重载会重置 mockFs 模块状态）、
    // 早于打开文件（打开动作才读取内容槽）
    await seedMockContent(page, path, CRLF_DOC);
    await expandMockNotes(page);
    await openFile(page, "readme.md");

    // 在最后一段末尾追加文字（唯一被编辑的行）
    await page.locator(".ProseMirror").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.type("（已编辑）");
    await page.keyboard.press(`${MOD}+s`);

    const written = await readMockContent(page, path);
    assertCrlfDiffOnly(written, CRLF_DOC, "（已编辑）");
  });

  test("CRLF 文件在源码模式编辑并保存：同样保持 CRLF", async ({ page }) => {
    const path = "/mock-workspace/notes/readme.md";
    await openMockWorkspace(page);
    await seedMockContent(page, path, CRLF_DOC);
    await expandMockNotes(page);
    await openFile(page, "readme.md");

    // 切入源码模式（CodeMirror）
    await page.locator('.topbar-btn[title*="源代码模式"]').click();
    await expect(page.locator(".cm-editor")).toBeVisible({ timeout: 10_000 });

    // 末尾追加一行新内容（唯一编辑行）
    await page.locator(".cm-content").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.type("源码模式追加");
    await page.keyboard.press(`${MOD}+s`);

    const written = await readMockContent(page, path);
    assertCrlfDiffOnly(written, CRLF_DOC, "源码模式追加");
  });

  test("CRLF 文件末行无换行：保存后仍无末尾换行，仅编辑行变化（评审 B3）", async ({ page }) => {
    const path = "/mock-workspace/notes/readme.md";
    await openMockWorkspace(page);
    await seedMockContent(page, path, CRLF_DOC_NO_FINAL_NEWLINE);
    await expandMockNotes(page);
    await openFile(page, "readme.md");

    await page.locator(".ProseMirror").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.type("（已编辑）");
    await page.keyboard.press(`${MOD}+s`);

    const written = await readMockContent(page, path);
    assertCrlfDiffOnly(written, CRLF_DOC_NO_FINAL_NEWLINE, "（已编辑）");
    // 关键：序列化器恒补的末尾换行被去掉——git diff 不会多出「末尾换行」这一行
    expect(written.endsWith("\r\n"), "原文件末行无换行，保存后不得补末尾换行").toBe(false);
    expect(written.endsWith("（已编辑）")).toBe(true);
  });

  test("LF 文件编辑保存：不引入 CR", async ({ page }) => {
    const path = "/mock-workspace/intro.md";
    const lfDoc = "# LF 文档\n\n第一段正文。\n\n第二段正文，将被编辑。\n";
    await openMockWorkspace(page);
    await seedMockContent(page, path, lfDoc);
    await openFile(page, "intro.md");

    await page.locator(".ProseMirror").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.type("（LF 编辑）");
    await page.keyboard.press(`${MOD}+s`);

    const written = await readMockContent(page, path);
    expect(written, "LF 文件保存不得引入 CR").not.toContain("\r");
    expect(written).toBe("# LF 文档\n\n第一段正文。\n\n第二段正文，将被编辑。（LF 编辑）\n");
  });
});

// 性能场景共享助手（issue #216）
//
// 与 tests/e2e/helpers.ts 的分工：那边是功能 E2E，这边只服务测量。
// 关键差异是「注入 fixture 必须在 goto 之后、打开文件之前」，因此不能复用
// e2e 的 openMockWorkspace（它内部会再一次 goto，导致注入丢失）。

import { expect, type Page } from "@playwright/test";
import { injectFile } from "./inject";
import { moveCaretToDocEnd, waitScrollConverged } from "../e2e/helpers";

/** 编辑器滚动容器 */
export const EDITOR_SCROLL = ".editor-scroll";

export interface InjectedFile {
  path: string;
  content: string;
}

/**
 * 打开应用首页 → 注入全部 fixture → 打开 mock 工作区。
 * 此刻还没有打开任何文件，调用方再按需 openFileInTree。
 */
export async function bootWithFiles(
  page: Page,
  files: InjectedFile[],
): Promise<void> {
  await page.goto("/");
  for (const file of files) {
    await injectFile(page, file.path, file.content);
  }
  await page.getByRole("button", { name: "打开文件夹" }).click();
  await expect(
    page.locator(".sidebar-tree").getByText("mock-workspace"),
  ).toBeVisible({ timeout: 10_000 });
}

/** mock 的 notes 目录默认折叠，需要访问其中的文件时按需展开 */
async function ensureNotesExpanded(page: Page): Promise<void> {
  const notes = page.locator(
    '[data-tree-row][data-path="/mock-workspace/notes"]',
  );
  if ((await notes.getAttribute("aria-expanded")) !== "true") {
    await notes.click();
  }
  await expect(
    page.locator('[data-tree-row][data-path="/mock-workspace/notes/readme.md"]'),
  ).toBeVisible({ timeout: 10_000 });
}

/** 在已打开的工作区里点开某个文件，等标签与编辑器就位 */
export async function openFileInTree(
  page: Page,
  path: string,
  timeout = 60_000,
): Promise<void> {
  const name = path.split("/").pop() ?? path;
  let target = page.locator(".workspace-tree-scroll").getByText(name, {
    exact: true,
  });
  if ((await target.count()) === 0) {
    await ensureNotesExpanded(page);
    target = page.locator(".workspace-tree-scroll").getByText(name, {
      exact: true,
    });
  }
  await target.click();
  await expect(page.locator(".tab-active")).toContainText(name, { timeout });
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout });
}

/**
 * 等编辑器内容真正渲染到位：滚动高度达到 expectedHeight 且滚动收敛。
 * 大档位文档（万行以上）从挂载到撑起完整高度有异步重排过程，
 * 不等到位就开测会把「渲染中」当成「卡顿」。
 */
export async function waitEditorRendered(
  page: Page,
  expectedHeight: number,
  timeout = 120_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const h = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el ? el.scrollHeight : 0;
        }, EDITOR_SCROLL);
        return h >= expectedHeight;
      },
      { timeout, intervals: [500, 800] },
    )
    .toBe(true);
  await waitScrollConverged(page, EDITOR_SCROLL, timeout);
}

/** 把光标放到文档末尾并聚焦编辑器（输入场景前置） */
export async function focusEditorEnd(page: Page): Promise<void> {
  await page.locator(".ProseMirror").click();
  await moveCaretToDocEnd(page);
}

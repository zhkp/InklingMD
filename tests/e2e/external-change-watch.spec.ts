// E2E：工作区外部变更感知（issue #369）
//
// 场景（AI Agent / 终端在应用运行期间改动工作区）：
// - 外部新建 .md → 3 秒轮询量级内出现在文件树；
// - 外部删除 .md → 3 秒轮询量级内从文件树消失；
// - Quick Open 面板保持打开 → 外部新建文件后索引原地刷新，无需关闭重开。
//
// 外部变更通过 Vite dev 模块导入直接改动 MOCK_TREE 模拟（与页面同一模块
// 实例，等价于磁盘被外部程序改写；应用侧的轮询与 refreshTree 全链路真实执行）。

import { test, expect } from "@playwright/test";
import { MOD, openMockWorkspace, expandMockNotes } from "./helpers";

/** 向 mock 文件树的根目录注入一个新文件节点（模拟外部新建） */
async function createExternalFile(page: import("@playwright/test").Page, name: string) {
  await page.evaluate(async (fileName) => {
    const { MOCK_TREE } = (await import(
      // @ts-ignore Vite dev 专用绝对模块路径
      "/src/lib/mockFs.ts"
    )) as typeof import("../../src/lib/mockFs");
    const path = `/mock-workspace/${fileName}`;
    if (!MOCK_TREE.children.some((c) => c.path === path)) {
      MOCK_TREE.children.push({ name: fileName, path, is_dir: false, children: [] });
    }
  }, name);
}

/** 向 mock 文件树的指定目录注入新文件节点（模拟子目录外部新建，#369 验收） */
async function createExternalFileIn(
  page: import("@playwright/test").Page,
  dirPath: string,
  name: string,
) {
  await page.evaluate(
    async ({ dir, fileName }) => {
      const { MOCK_TREE, findNode } = (await import(
        // @ts-ignore Vite dev 专用绝对模块路径
        "/src/lib/mockFs.ts"
      )) as typeof import("../../src/lib/mockFs");
      const parent = findNode(MOCK_TREE, dir);
      if (!parent) throw new Error(`父目录不存在: ${dir}`);
      const path = `${dir}/${fileName}`;
      if (!parent.children.some((c) => c.path === path)) {
        parent.children.push({ name: fileName, path, is_dir: false, children: [] });
      }
    },
    { dir: dirPath, fileName: name },
  );
}

/** 从 mock 文件树删除一个根目录文件节点（模拟外部删除） */
async function deleteExternalFile(page: import("@playwright/test").Page, name: string) {
  await page.evaluate(async (fileName) => {
    const { MOCK_TREE } = (await import(
      // @ts-ignore Vite dev 专用绝对模块路径
      "/src/lib/mockFs.ts"
    )) as typeof import("../../src/lib/mockFs");
    MOCK_TREE.children = MOCK_TREE.children.filter((c) => c.name !== fileName);
  }, name);
}

/** 把 mock 文件树根目录下的文件就地改名（模拟外部重命名） */
async function renameExternalFile(
  page: import("@playwright/test").Page,
  fromName: string,
  toName: string,
) {
  await page.evaluate(
    async ({ from, to }) => {
      const { MOCK_TREE } = (await import(
        // @ts-ignore Vite dev 专用绝对模块路径
        "/src/lib/mockFs.ts"
      )) as typeof import("../../src/lib/mockFs");
      const node = MOCK_TREE.children.find((c) => c.name === from);
      if (node) {
        node.name = to;
        node.path = `/mock-workspace/${to}`;
      }
    },
    { from: fromName, to: toName },
  );
}

// 轮询间隔 3 秒；等待窗口取两个轮询周期 + 刷新合并余量
const WATCH_TIMEOUT = 8_000;

test.describe("工作区外部变更感知（#369）", () => {
  test("外部新建文件在 3 秒量级内出现在文件树", async ({ page }) => {
    await openMockWorkspace(page);
    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/agent-new.md"]'),
    ).toHaveCount(0);

    await createExternalFile(page, "agent-new.md");

    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/agent-new.md"]'),
    ).toBeVisible({ timeout: WATCH_TIMEOUT });
  });

  test("外部删除文件在 3 秒量级内从文件树消失", async ({ page }) => {
    await openMockWorkspace(page);
    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/intro.md"]'),
    ).toBeVisible();

    await deleteExternalFile(page, "intro.md");

    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/intro.md"]'),
    ).toHaveCount(0, { timeout: WATCH_TIMEOUT });
  });

  test("已展开子目录中的外部新建在 3 秒量级内可见（#369 验收第 2 条）", async ({ page }) => {
    await openMockWorkspace(page);
    await expandMockNotes(page);
    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/notes/readme.md"]'),
    ).toBeVisible();

    await createExternalFileIn(page, "/mock-workspace/notes", "notes-external-new.md");

    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/notes/notes-external-new.md"]'),
    ).toBeVisible({ timeout: WATCH_TIMEOUT });
  });

  test("外部重命名文件在 3 秒量级内更新：新名出现、旧名消失", async ({ page }) => {
    await openMockWorkspace(page);
    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/intro.md"]'),
    ).toBeVisible();

    await renameExternalFile(page, "intro.md", "renamed-intro.md");

    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/renamed-intro.md"]'),
    ).toBeVisible({ timeout: WATCH_TIMEOUT });
    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/intro.md"]'),
    ).toHaveCount(0, { timeout: WATCH_TIMEOUT });
  });

  test("Quick Open 面板打开期间感知外部新建文件（索引原地刷新）", async ({ page }) => {
    await openMockWorkspace(page);

    // 打开 Quick Open 并确认初始状态（无目标文件）
    await page.keyboard.press(`${MOD}+p`);
    const input = page.locator(".qo-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("quick-external");
    await expect(page.locator(".qo-empty")).toBeVisible({ timeout: 5_000 });

    // 面板保持打开，外部新建文件
    await createExternalFile(page, "quick-external.md");

    // 索引经 refreshTree 失效 + 版本信号驱动面板重新取数，列表原地更新
    await expect(
      page.locator('.qo-item[data-option-index]', { hasText: "quick-external.md" }),
    ).toBeVisible({ timeout: WATCH_TIMEOUT });
  });

  test("工作区根被折叠时仍感知根级外部新建（树数据与 Quick Open 索引同步）", async ({ page }) => {
    await openMockWorkspace(page);
    const rootRow = page.locator('[data-tree-row][data-path="/mock-workspace"]');

    // 折叠工作区根：子项在树中不可见，但 Quick Open 仍应覆盖根级文件
    await rootRow.click();
    await expect(rootRow).toHaveAttribute("aria-expanded", "false");
    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/intro.md"]'),
    ).toHaveCount(0);

    await createExternalFile(page, "root-collapsed-new.md");

    // Quick Open 能搜到（证明根级变更仍触发索引失效并重建）
    await page.keyboard.press(`${MOD}+p`);
    const input = page.locator(".qo-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("root-collapsed");
    await expect(
      page.locator('.qo-item[data-option-index]', { hasText: "root-collapsed-new.md" }),
    ).toBeVisible({ timeout: WATCH_TIMEOUT });
    await page.keyboard.press("Escape");

    // 展开根：树数据已被刷新，新文件直接可见（折叠期间也在扫描根）
    await rootRow.click();
    await expect(
      page.locator('[data-tree-row][data-path="/mock-workspace/root-collapsed-new.md"]'),
    ).toBeVisible({ timeout: WATCH_TIMEOUT });
  });
});

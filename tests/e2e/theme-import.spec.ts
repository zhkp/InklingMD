/**
 * #307 验收（浏览器内真实链路，主题目录用 `mockThemes` 播种）：
 * 扫描主题目录 → 列表出现 → 选中生效（兼容层改写过）→ 索引/快照落盘
 * → 重启首帧仍就位（无闪烁）→ 多窗口一致 → 移除后回落默认。
 *
 * 说明：真实文件对话框与 zip 解压（需 Tauri 运行时）由 Rust 单测（含 zip-slip）与
 * `tests/theme/theme-import.test.ts` 覆盖；本 spec 覆盖「主题目录 → 列表 → 生效 → 持久化」这条主干。
 */
import { test, expect, type Page } from "@playwright/test";
import { openFile, openMockWorkspace } from "./helpers";

const THEMES_ROOT = "/mock-appdata/themes";
const PROBE_CSS = "#write h1{color:rgb(1,2,3)}\n#write p{margin:0}";

const SEED = {
  root: THEMES_ROOT,
  bundledRoot: "/mock-resource/themes",
  files: {
    [`${THEMES_ROOT}/probe.css`]: PROBE_CSS,
    [`${THEMES_ROOT}/probe/README.md`]: "# Probe theme",
    [`${THEMES_ROOT}/other.css`]: "#write h2{color:rgb(9,9,9)}",
  },
};

async function seedThemes(page: Page): Promise<void> {
  await page.addInitScript((seed) => {
    (window as unknown as { __inklingThemesMock?: unknown }).__inklingThemesMock = seed;
  }, SEED);
}

/** 顶栏（含主题菜单）只在打开工作区**且有打开的文件**后渲染 → 未就绪时先补这两步 */
async function ensureTopbar(page: Page): Promise<void> {
  if ((await page.getByTitle("主题").count()) === 0) {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
    // 首次访问时 Vite 按需编译整棵依赖树 → 给足上限，避免把「慢」当成「坏」
    await expect(page.getByTitle("主题")).toBeVisible({ timeout: 25_000 });
  }
}

async function openThemeMenu(page: Page): Promise<void> {
  await ensureTopbar(page);
  await page.getByTitle("主题").click();
  await expect(page.locator('[data-theme-menu="1"]')).toBeVisible();
}

async function currentState(page: Page) {
  return page.evaluate(() => ({
    themeId: document.documentElement.getAttribute("data-theme-id"),
    dataTheme: document.documentElement.getAttribute("data-theme"),
    injected: document.getElementById("inkling-theme")?.textContent ?? "",
    index: window.localStorage.getItem("inkling-themes-index") ?? "",
    snapshotKeys: Object.keys(window.localStorage).filter((k) =>
      k.startsWith("inkling-theme-snapshot:"),
    ),
  }));
}

test.describe("#307 主题目录 → 列表 → 生效 → 持久化", () => {
  // 串行：每个用例都要冷启动应用（Vite 首次编译 + 主题扫描），并行会把「慢」放大成超时
  test.describe.configure({ mode: "serial" });

  test("扫描主题目录后列表出现已导入主题，可选中并生效（兼容层改写过）", async ({ page }) => {
    await seedThemes(page);
    await ensureTopbar(page);
    await openThemeMenu(page);

    const probe = page.locator('[data-theme-option="user:probe"]');
    await expect(probe).toBeVisible();
    // 分组：内置 / 已导入（列表结构可断言，不靠文案细节）
    await expect(page.locator('[data-theme-group="imported"]')).toBeVisible();
    await expect(page.locator('[data-theme-option="user:other"]')).toBeVisible();

    await probe.click();
    await expect
      .poll(async () => (await currentState(page)).themeId, { timeout: 5000 })
      .toBe("user:probe");
    // 磁盘主题：快照缺失时由读盘路径异步补 CSS（首帧允许一次可见切换，见矩阵登记）
    await expect
      .poll(async () => (await currentState(page)).injected, { timeout: 10_000 })
      .toContain(".editor-scroll .milkdown h1");

    const state = await currentState(page);
    // 注入的是**改写产物**：包在 @layer theme 内、选择器收敛为 2 段前缀、!important 已剥
    expect(state.injected).toContain("@layer theme");
    expect(state.injected).toContain(".editor-scroll .milkdown h1");
    // 声明原样保留（postcss 不改写值格式）→ 断言去掉空白，避免被格式化差异误伤
    expect(state.injected.replace(/\s+/g, "")).toContain("color:rgb(1,2,3)");
    // 索引落盘（#307 是它唯一的生产写入方），且带磁盘文件名（跨窗口读盘/移除要用）
    const index = JSON.parse(state.index) as { themes: { id: string; file?: string }[] };
    expect(index.themes.some((t) => t.id === "user:probe" && t.file === "probe.css")).toBe(true);
    // 快照落盘（G9：重启零闪烁的前提）
    expect(state.snapshotKeys.some((k) => k.startsWith("inkling-theme-snapshot:user:probe:"))).toBe(true);
  });

  test("重启后首帧仍就位（快照路径，无先闪内置浅色）", async ({ page }) => {
    await seedThemes(page);
    await ensureTopbar(page);
    await openThemeMenu(page);
    await page.locator('[data-theme-option="user:probe"]').click();
    await expect
      .poll(async () => (await currentState(page)).themeId, { timeout: 5000 })
      .toBe("user:probe");

    // 模拟重启：同源重载（localStorage 保留，主题目录依旧由 mock 播种）
    await page.reload({ waitUntil: "domcontentloaded" });
    const firstFrame = await page.evaluate(() => ({
      id: document.documentElement.getAttribute("data-theme-id"),
      injected: document.getElementById("inkling-theme")?.textContent ?? "",
    }));
    expect(firstFrame.id).toBe("user:probe");
    expect(firstFrame.injected).toContain("@layer theme");
  });

  test("多窗口一致：同 context 两个窗口用同一主题（另一窗口首帧即一致）", async ({ page, context }) => {
    await seedThemes(page);
    await ensureTopbar(page);
    await openThemeMenu(page);
    await page.locator('[data-theme-option="user:other"]').click();
    await expect
      .poll(async () => (await currentState(page)).themeId, { timeout: 5000 })
      .toBe("user:other");

    const second = await context.newPage();
    await seedThemes(second);
    await second.goto("/", { waitUntil: "domcontentloaded" });
    const secondState = await second.evaluate(() => ({
      id: document.documentElement.getAttribute("data-theme-id"),
    }));
    expect(secondState.id).toBe("user:other");
    await second.close();
  });

  test("移除主题：回落到默认主题并清掉索引/快照（文件进 .backup，可恢复）", async ({ page }) => {
    await seedThemes(page);
    await ensureTopbar(page);
    await openThemeMenu(page);
    await page.locator('[data-theme-option="user:probe"]').click();
    await expect
      .poll(async () => (await currentState(page)).themeId, { timeout: 5000 })
      .toBe("user:probe");

    await openThemeMenu(page);
    await page.locator('[data-theme-remove="1"]').click();
    await expect
      .poll(async () => (await currentState(page)).themeId, { timeout: 5000 })
      .toBe("builtin:light");
    // 移除后索引由扫描重建（异步）→ 轮询索引里不再有该主题
    await expect
      .poll(async () => {
        const s = await currentState(page);
        return (JSON.parse(s.index) as { themes: { id: string }[] }).themes.some(
          (t) => t.id === "user:probe",
        );
      }, { timeout: 10_000 })
      .toBe(false);
    const state = await currentState(page);
    expect(state.snapshotKeys.some((k) => k.includes("user:probe"))).toBe(false);

    // 重新扫描后列表里也不再有该主题（回到主题目录已无 probe.css）
    await openThemeMenu(page);
    await page.locator('[data-theme-refresh="1"]').click();
    await expect(page.locator('[data-theme-option="user:probe"]')).toHaveCount(0);
  });
});

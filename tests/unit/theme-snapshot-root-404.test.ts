// #404 复审阻塞 1：便携目录搬家 / 旧版从 Roaming 升级后，主题 CSS 快照不能固化旧绝对路径。
//
// 走真实链路：bootstrapFirstFrameTheme → syncThemes → buildThemeCatalog → loadThemeFromDisk →
// loadThemeCss → applyTheme → writeSnapshot → 再次切换 setTheme。
// 仅 mock Tauri IPC 边界与 dialog。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { currentDataRoot, readFileCounts, customReadHandlers } = vi.hoisted(() => ({
  currentDataRoot: { value: "D:/PortableA/InklingMD/data" },
  readFileCounts: new Map<string, number>(),
  customReadHandlers: new Map<string, () => Promise<string>>(),
}));

const RAW_MYTHEME_CSS = [
  "@font-face {",
  '  font-family: "MyFont";',
  "  src: url('mytheme/font.woff2');",
  "}",
  "#write h1 { color: #123456; }",
].join("\n");

const RAW_OTHER_CSS = [
  "@font-face {",
  '  font-family: "OtherFont";',
  "  src: url('other/font.woff2');",
  "}",
  "#write p { color: #654321; }",
].join("\n");

function themesDirOf(dataRoot: string): string {
  return `${dataRoot}/themes`;
}

function resourceThemesDirOf(dataRoot: string): string {
  return `${dataRoot.replace(/\/data$/, "")}/themes`;
}

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) =>
    `http://asset.localhost/${encodeURIComponent(path.replace(/\\/g, "/"))}`,
  invoke: async (command: string, args?: Record<string, unknown>) => {
    const dataRoot = currentDataRoot.value;
    const themesDir = themesDirOf(dataRoot);
    const bundledDir = resourceThemesDirOf(dataRoot);

    if (command === "app_data_root") return dataRoot;
    if (command === "resource_themes_dir") return bundledDir;
    if (command === "create_dir") return undefined;
    if (command === "scan_theme_dir") {
      const dirPath = String(args?.dirPath ?? "").replace(/\\/g, "/");
      if (dirPath === themesDir) {
        return {
          exists: true,
          skipped: [],
          skippedPaths: [],
          entries: [
            { name: "mytheme.css", path: `${themesDir}/mytheme.css`, is_dir: false, size: RAW_MYTHEME_CSS.length },
            { name: "other.css", path: `${themesDir}/other.css`, is_dir: false, size: RAW_OTHER_CSS.length },
            { name: "mytheme", path: `${themesDir}/mytheme`, is_dir: true, size: 0 },
            { name: "other", path: `${themesDir}/other`, is_dir: true, size: 0 },
          ],
        };
      }
      if (dirPath === bundledDir) {
        return {
          exists: true,
          skipped: [],
          skippedPaths: [],
          entries: [
            { name: "manifest.json", path: `${bundledDir}/manifest.json`, is_dir: false, size: 20 },
          ],
        };
      }
      return { exists: false, skipped: [], skippedPaths: [], entries: [] };
    }
    if (command === "read_text_file") {
      const filePath = String(args?.filePath ?? "").replace(/\\/g, "/");
      readFileCounts.set(filePath, (readFileCounts.get(filePath) ?? 0) + 1);
      const custom = customReadHandlers.get(filePath);
      if (custom) return custom();
      if (filePath === `${themesDir}/mytheme.css`) return RAW_MYTHEME_CSS;
      if (filePath === `${themesDir}/other.css`) return RAW_OTHER_CSS;
      if (filePath === `${bundledDir}/manifest.json`) return JSON.stringify({ v: 1, themes: [] });
      throw new Error(`文件不存在: ${filePath}`);
    }
    return undefined;
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  message: vi.fn(async () => undefined),
}));

async function bootAppModules() {
  vi.resetModules();
  document.head.innerHTML = "";
  const stmt = document.createElement("style");
  stmt.id = "inkling-layer-statement";
  stmt.textContent = "@layer base, theme, user;";
  document.head.appendChild(stmt);
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-id");

  const session = await import("../../src/theme/session");
  const inject = await import("../../src/theme/inject");
  const snapshot = await import("../../src/theme/snapshot");
  const rewrite = await import("../../src/theme/typora/rewrite");
  const store = await import("../../src/store/theme");
  return { session, inject, snapshot, rewrite, store };
}

beforeEach(() => {
  localStorage.clear();
  readFileCounts.clear();
  customReadHandlers.clear();
  currentDataRoot.value = "D:/PortableA/InklingMD/data";
});

describe("#404 便携目录搬家与升级迁移后的主题快照重校验", () => {
  it("搬家场景：从路径 A 移到路径 B 后重启并 syncThemes()，注入样式与快照均重写为路径 B", async () => {
    // 1. 机器 A（D:/PortableA/InklingMD/data）：扫描 + 选中主题并落快照
    currentDataRoot.value = "D:/PortableA/InklingMD/data";
    const bootA = await bootAppModules();
    await bootA.store.useTheme.getState().syncThemes();

    bootA.store.useTheme.getState().setTheme("user:mytheme");
    // 等待 setTheme 触发的异步 loadThemeFromDisk 落盘并写入快照
    const hash = bootA.rewrite.themeCssHash(RAW_MYTHEME_CSS);
    await vi.waitFor(() => {
      expect(bootA.snapshot.readSnapshot("user:mytheme", hash)).toBeDefined();
    });
    bootA.inject.flushThemeInjection();

    const encodedA = encodeURIComponent("D:/PortableA/InklingMD/data/themes/mytheme/font.woff2");
    expect(bootA.inject.readInjectedThemeCss()).toContain(encodedA);
    expect(bootA.snapshot.readSnapshot("user:mytheme", hash)?.css).toContain(encodedA);

    // 2. 模拟把便携目录（含 localStorage）拷到机器 B（E:/USB/InklingMD/data）并重启
    currentDataRoot.value = "E:/USB/InklingMD/data";
    const bootB = await bootAppModules();
    await bootB.store.useTheme.getState().syncThemes();
    bootB.inject.flushThemeInjection();

    const encodedB = encodeURIComponent("E:/USB/InklingMD/data/themes/mytheme/font.woff2");
    expect(bootB.store.useTheme.getState().themeId).toBe("user:mytheme");
    expect(bootB.inject.readInjectedThemeCss()).toContain(encodedB);
    expect(bootB.inject.readInjectedThemeCss()).not.toContain("PortableA");

    const snapB = bootB.snapshot.readSnapshot("user:mytheme", hash);
    expect(snapB?.css).toContain(encodedB);
    expect(snapB?.css).not.toContain("PortableA");

    // 3. 切走再切回：必须命中路径 B 的新快照，不得回吐路径 A
    bootB.store.useTheme.getState().setTheme("builtin:light");
    bootB.inject.flushThemeInjection();
    bootB.store.useTheme.getState().setTheme("user:mytheme");
    bootB.inject.flushThemeInjection();

    expect(bootB.inject.readInjectedThemeCss()).toContain(encodedB);
    expect(bootB.inject.readInjectedThemeCss()).not.toContain("PortableA");
  });

  it("老版升级迁移场景：已有无根记录的旧快照指向 Roaming，便携启动 syncThemes() 后重写为便携路径", async () => {
    // 预置旧版升级遗留的 localStorage（无 themesRoot 记录，快照 CSS 指向 Roaming）
    const { themeCssHash } = await import("../../src/theme/typora/rewrite");
    const hash = themeCssHash(RAW_MYTHEME_CSS);
    const roamingUrl =
      "http://asset.localhost/" +
      encodeURIComponent("C:/Users/demo/AppData/Roaming/com.inklingmd.editor/themes/mytheme/font.woff2");

    localStorage.setItem("inkling-theme", "user:mytheme");
    localStorage.setItem(
      "inkling-themes-index",
      JSON.stringify({
        v: 1,
        themes: [
          {
            id: "user:mytheme",
            name: "mytheme",
            mode: "light",
            hash,
            source: "user",
            file: "mytheme.css",
          },
        ],
      }),
    );
    localStorage.setItem(
      `inkling-theme-snapshot:user:mytheme:${hash}`,
      JSON.stringify({
        v: 1,
        themeId: "user:mytheme",
        hash,
        css: `.editor-scroll .milkdown { src: url(${roamingUrl}); }`,
        at: 1,
      }),
    );

    currentDataRoot.value = "D:/Portable/InklingMD/data";
    const boot = await bootAppModules();
    await boot.store.useTheme.getState().syncThemes();
    boot.inject.flushThemeInjection();

    const encodedPortable = encodeURIComponent("D:/Portable/InklingMD/data/themes/mytheme/font.woff2");
    expect(boot.inject.readInjectedThemeCss()).toContain(encodedPortable);
    expect(boot.inject.readInjectedThemeCss()).not.toContain("Roaming");

    const updatedSnap = boot.snapshot.readSnapshot("user:mytheme", hash);
    expect(updatedSnap?.css).toContain(encodedPortable);
    expect(updatedSnap?.css).not.toContain("Roaming");

    // 切走再切回仍保持便携路径
    boot.store.useTheme.getState().setTheme("builtin:light");
    boot.inject.flushThemeInjection();
    boot.store.useTheme.getState().setTheme("user:mytheme");
    boot.inject.flushThemeInjection();
    expect(boot.inject.readInjectedThemeCss()).toContain(encodedPortable);
    expect(boot.inject.readInjectedThemeCss()).not.toContain("Roaming");
  });

  it("非当前激活的旧快照也会在搬家后被清理，且同路径二次重启保留首帧快照命中", async () => {
    // 在路径 A 缓存 user:other 快照，然后切回 builtin:light 再搬家到路径 B
    currentDataRoot.value = "D:/PortableA/InklingMD/data";
    const bootA = await bootAppModules();
    await bootA.store.useTheme.getState().syncThemes();
    const otherHash = bootA.rewrite.themeCssHash(RAW_OTHER_CSS);

    bootA.store.useTheme.getState().setTheme("user:other");
    await vi.waitFor(() => {
      expect(bootA.snapshot.readSnapshot("user:other", otherHash)).toBeDefined();
    });
    bootA.store.useTheme.getState().setTheme("builtin:light");
    bootA.inject.flushThemeInjection();

    // 搬家到路径 B 启动时当前是 builtin:light：旧快照仍须被清理
    currentDataRoot.value = "E:/USB/InklingMD/data";
    const bootB = await bootAppModules();
    await bootB.store.useTheme.getState().syncThemes();
    expect(bootB.snapshot.readSnapshot("user:other", otherHash)).toBeUndefined();

    // 切到 user:other 时必须重新读盘重写为路径 B
    bootB.store.useTheme.getState().setTheme("user:other");
    await vi.waitFor(() => {
      expect(bootB.snapshot.readSnapshot("user:other", otherHash)).toBeDefined();
    });
    bootB.inject.flushThemeInjection();
    const encodedOtherB = encodeURIComponent("E:/USB/InklingMD/data/themes/other/font.woff2");
    expect(bootB.inject.readInjectedThemeCss()).toContain(encodedOtherB);
    expect(bootB.inject.readInjectedThemeCss()).not.toContain("PortableA");

    // 路径未变再次重启：首帧即命中快照，不触发额外的 loadThemeFromDisk
    readFileCounts.clear();
    const bootB2 = await bootAppModules();
    await bootB2.store.useTheme.getState().syncThemes();
    bootB2.inject.flushThemeInjection();
    expect(bootB2.session.firstFrame?.source).toBe("snapshot");
    expect(bootB2.session.firstFrame?.needsAsyncLoad).toBe(false);
    expect(["hit", "slow"]).toContain(bootB2.snapshot.readSnapshotState()?.last);
    expect(bootB2.inject.readInjectedThemeCss()).toContain(encodedOtherB);
    // 模块顶层自启动 syncThemes + 显式 syncThemes 各扫一次 catalog 算 hash（共 2 次），未触发 loadThemeFromDisk
    expect(readFileCounts.get("E:/USB/InklingMD/data/themes/other.css")).toBe(2);
  });

  it("多窗口并发竞态：窗口 1 先完成搬家快照清理后，窗口 2 执行 syncThemes() 仍重算本窗口样式", async () => {
    // 1. 路径 A 下生成快照
    currentDataRoot.value = "D:/PortableA/InklingMD/data";
    const bootA = await bootAppModules();
    await bootA.store.useTheme.getState().syncThemes();
    bootA.store.useTheme.getState().setTheme("user:mytheme");
    const hash = bootA.rewrite.themeCssHash(RAW_MYTHEME_CSS);
    await vi.waitFor(() => {
      expect(bootA.snapshot.readSnapshot("user:mytheme", hash)).toBeDefined();
    });

    // 2. 搬家到路径 B，模拟窗口 2 首帧先命中尚未清理的旧快照 A（注入了路径 A 的样式）
    currentDataRoot.value = "E:/USB/InklingMD/data";
    vi.resetModules();
    document.head.innerHTML = "";
    const stmt = document.createElement("style");
    stmt.id = "inkling-layer-statement";
    stmt.textContent = "@layer base, theme, user;";
    document.head.appendChild(stmt);
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-id");

    const sessionW2 = await import("../../src/theme/session");
    const injectW2 = await import("../../src/theme/inject");
    const snapshotW2 = await import("../../src/theme/snapshot");
    injectW2.flushThemeInjection();
    const encodedA = encodeURIComponent("D:/PortableA/InklingMD/data/themes/mytheme/font.woff2");
    expect(sessionW2.firstFrame?.needsAsyncLoad).toBe(false);
    expect(injectW2.readInjectedThemeCss()).toContain(encodedA);

    // 3. 在窗口 2 启动 syncThemes 之前，模拟窗口 1 已把 localStorage 清理并更新成路径 B
    snapshotW2.reconcileSnapshotsForThemesRoot("E:/USB/InklingMD/data/themes");
    snapshotW2.writeSnapshot(
      "user:mytheme",
      hash,
      "/* written by window 1 */",
      "E:/USB/InklingMD/data/themes",
    );

    // 4. 窗口 2 挂载 store 并运行 syncThemes()：虽然 localStorage 已是 B，仍必须重读盘覆盖窗口 2 的 DOM
    const storeW2 = await import("../../src/store/theme");
    await storeW2.useTheme.getState().syncThemes();
    injectW2.flushThemeInjection();

    const encodedB = encodeURIComponent("E:/USB/InklingMD/data/themes/mytheme/font.woff2");
    expect(injectW2.readInjectedThemeCss()).toContain(encodedB);
    expect(injectW2.readInjectedThemeCss()).not.toContain("PortableA");
  });

  it("在途异步读盘被 setTheme 切走后失效：慢读盘成功或失败都不得覆写新主题", async () => {
    currentDataRoot.value = "D:/PortableA/InklingMD/data";
    const boot = await bootAppModules();
    await boot.store.useTheme.getState().syncThemes();
    const dialog = await import("@tauri-apps/plugin-dialog");
    vi.mocked(dialog.message).mockClear();

    let resolveSlow: ((css: string) => void) | undefined;
    let rejectSlow: ((err: Error) => void) | undefined;
    const slowPath = "D:/PortableA/InklingMD/data/themes/mytheme.css";

    // 场景 A：慢读盘在 loadThemeCss await 阶段，期间用户切到 builtin:dark，随后慢读盘 resolve
    customReadHandlers.set(
      slowPath,
      () =>
        new Promise<string>((resolve) => {
          resolveSlow = resolve;
        }),
    );
    boot.store.useTheme.getState().setTheme("user:mytheme");
    await vi.waitFor(() => expect(resolveSlow).toBeTypeOf("function"));
    boot.store.useTheme.getState().setTheme("builtin:dark");
    boot.inject.flushThemeInjection();

    resolveSlow!(RAW_MYTHEME_CSS);
    await Promise.resolve();
    await Promise.resolve();
    boot.inject.flushThemeInjection();

    expect(boot.store.useTheme.getState().themeId).toBe("builtin:dark");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("builtin:dark");
    expect(boot.inject.readInjectedThemeCss()).toBeNull();

    // 场景 B：慢读盘最终 reject（如主题刚被移除），但期间用户已切到 builtin:dark → catch 不得回写默认或弹窗
    customReadHandlers.set(
      slowPath,
      () =>
        new Promise<string>((_, reject) => {
          rejectSlow = reject;
        }),
    );
    boot.store.useTheme.getState().setTheme("user:mytheme");
    await vi.waitFor(() => expect(rejectSlow).toBeTypeOf("function"));
    boot.store.useTheme.getState().setTheme("builtin:dark");
    boot.inject.flushThemeInjection();

    rejectSlow!(new Error("removed"));
    await Promise.resolve();
    await Promise.resolve();
    boot.inject.flushThemeInjection();

    expect(boot.store.useTheme.getState().themeId).toBe("builtin:dark");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("builtin:dark");
    expect(dialog.message).not.toHaveBeenCalled();
  });
});

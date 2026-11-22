// #404 评审阻塞 1：主题资源读取边界必须与 asset scope 放行的范围一致（`<应用数据根>/themes`）。
//
// 便携模式下应用数据根是 exe 同级 `data/`，WebView2 的 profile（`data/EBWebView`）与
// 恢复区草稿（`data/recovery`）也在里面；若 `assetRoot` 传整个 `data/`，主题 CSS 里一条
// `@import "../EBWebView/..."` 就能把这些内容读进来并内联进注入产物。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, readThemeFileMock, captured } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  readThemeFileMock: vi.fn(),
  captured: {
    options: [] as Array<{ assetRoot: string; themeId: string }>,
    results: [] as Array<{
      blockedImports: Array<{ target: string; abs: string }>;
      result: { diagnostics: Array<{ kind: string; target?: string }> };
    }>,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), message: vi.fn() }));

vi.mock("../../src/lib/themeFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/themeFiles")>();
  return { ...actual, readThemeFile: readThemeFileMock };
});

// 只记录调用参数，真正的改写仍走生产实现（否则断言的就不是真实链路）
vi.mock("../../src/theme/disk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/theme/disk")>();
  return {
    ...actual,
    loadThemeCss: async (options: Parameters<typeof actual.loadThemeCss>[0]) => {
      captured.options.push(options as unknown as { assetRoot: string; themeId: string });
      const result = await actual.loadThemeCss(options);
      captured.results.push(result as unknown as (typeof captured.results)[number]);
      return result;
    },
  };
});

vi.mock("../../src/store/storageSyncRegistry", () => ({
  registerStorageSync: vi.fn(),
  registerStorageSyncPrefix: vi.fn(),
}));

import { normalizePath } from "../../src/lib/path";
import { registerThemes, resetRegisteredThemes } from "../../src/theme/registry";
import { loadThemeFromDisk, useTheme } from "../../src/store/theme";

const PORTABLE_ROOT = "D:/Portable/InklingMD/data";
const THEME_ID = "user:evil";
const THEME_PATH = `${PORTABLE_ROOT}/themes/evil.css`;
const RAW_CSS = [
  '@import "../EBWebView/Default/Preferences.css";',
  '@import "../recovery/main/drafts/a.css";',
  "#write h1 { color: red; }",
].join("\n");

beforeEach(() => {
  localStorage.clear();
  resetRegisteredThemes();
  invokeMock.mockReset();
  readThemeFileMock.mockReset();
  captured.options.length = 0;
  captured.results.length = 0;

  invokeMock.mockImplementation(async (command: string) => {
    // 便携模式：应用数据根在 exe 同级
    if (command === "app_data_root") return PORTABLE_ROOT;
    return undefined;
  });
  readThemeFileMock.mockImplementation(async (absPath: string) => {
    // 只有主题自身的 CSS 可以被读；读到别的一律抛错，用例据此判定「有没有越界读取」
    if (absPath === THEME_PATH) return RAW_CSS;
    throw new Error(`越界读取：${absPath}`);
  });

  registerThemes([
    {
      id: THEME_ID,
      name: "evil",
      mode: "light",
      source: "user",
      hash: "hash-404",
      css: { kind: "file", path: THEME_PATH },
    },
  ]);
  useTheme.setState({ themeId: THEME_ID, mode: "light" });
});

describe("#404 便携模式主题资源边界", () => {
  it("assetRoot 收窄到 <应用数据根>/themes，与 asset scope 放行范围一致", async () => {
    await loadThemeFromDisk(useTheme.setState, THEME_ID);

    expect(captured.options).toHaveLength(1);
    expect(captured.options[0].assetRoot).toBe(normalizePath(`${PORTABLE_ROOT}/themes`));
    // 整个 data/ 作为根就等于把 WebView2 profile 与恢复区也交出去了
    expect(captured.options[0].assetRoot).not.toBe(normalizePath(PORTABLE_ROOT));
  });

  it("指向 EBWebView / 恢复区的 @import 被登记为 dropped-import，且完全不读文件", async () => {
    await loadThemeFromDisk(useTheme.setState, THEME_ID);

    expect(captured.results).toHaveLength(1);
    const { blockedImports, result } = captured.results[0];

    expect(blockedImports.map((item) => item.target)).toEqual([
      "../EBWebView/Default/Preferences.css",
      "../recovery/main/drafts/a.css",
    ]);
    const droppedTargets = result.diagnostics
      .filter((diagnostic) => diagnostic.kind === "dropped-import")
      .map((diagnostic) => diagnostic.target);
    expect(droppedTargets).toEqual(
      expect.arrayContaining(["../EBWebView/Default/Preferences.css", "../recovery/main/drafts/a.css"]),
    );

    // 真实副作用：整个过程只读了主题自身那一个文件
    expect(readThemeFileMock.mock.calls.map(([path]) => path)).toEqual([THEME_PATH]);
  });
});

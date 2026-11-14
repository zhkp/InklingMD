import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResult, CopyPlanItem } from "../../src/theme/catalog";

const {
  buildThemeCatalogMock,
  bundledThemesRootMock,
  copyThemePathMock,
  ensureDirMock,
  readBundledManifestMock,
  scanThemesDirMock,
  showMessageMock,
  themesRootMock,
} = vi.hoisted(() => ({
  buildThemeCatalogMock: vi.fn(),
  bundledThemesRootMock: vi.fn(async () => "/resources/themes"),
  copyThemePathMock: vi.fn(async () => undefined),
  ensureDirMock: vi.fn(async () => undefined),
  readBundledManifestMock: vi.fn(async () => ({ themes: [] })),
  scanThemesDirMock: vi.fn(async () => ({ entries: [], skipped: [], exists: true })),
  showMessageMock: vi.fn(async () => undefined),
  themesRootMock: vi.fn(async () => "/app/themes"),
}));

vi.mock("../../src/lib/themeFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/themeFiles")>();
  return {
    ...actual,
    bundledThemesRoot: bundledThemesRootMock,
    copyThemePath: copyThemePathMock,
    ensureDir: ensureDirMock,
    readBundledManifest: readBundledManifestMock,
    scanThemesDir: scanThemesDirMock,
    themesRoot: themesRootMock,
  };
});

vi.mock("../../src/theme/catalog", () => ({
  buildThemeCatalog: buildThemeCatalogMock,
  indexChanged: () => false,
}));

vi.mock("../../src/lib/dialogs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/dialogs")>();
  return { ...actual, showMessage: showMessageMock };
});

vi.mock("../../src/store/storageSyncRegistry", () => ({
  registerStorageSync: vi.fn(),
  registerStorageSyncPrefix: vi.fn(),
}));

import { useTheme } from "../../src/store/theme";

function catalogResult(issues: string[] = [], copyPlan: CopyPlanItem[] = []): CatalogResult {
  return { themes: [], index: [], issues, copyPlan, manifest: [] };
}

function missingSourceIssue(path: string, slug: string): string {
  return `预装源副本缺失或不可读：${path}（清单 slug=${slug}，ENOENT）→ 本次不补齐该主题`;
}

describe("theme store missing bundled-source warning count", () => {
  beforeEach(async () => {
    localStorage.clear();
    useTheme.setState({ themeId: "builtin:light", mode: "light", scanIssues: [], scanState: "idle" });
    buildThemeCatalogMock.mockReset().mockResolvedValue(catalogResult());
    copyThemePathMock.mockReset().mockResolvedValue(undefined);
    ensureDirMock.mockReset().mockResolvedValue(undefined);
    scanThemesDirMock.mockReset().mockResolvedValue({ entries: [], skipped: [], exists: true });
    showMessageMock.mockReset().mockResolvedValue(undefined);

    // A clean scan resets the module-level one-time warning guard between cases.
    await useTheme.getState().syncThemes();
    buildThemeCatalogMock.mockReset();
    showMessageMock.mockClear();
  });

  it("counts a missing source CSS once when there is no copy plan", async () => {
    buildThemeCatalogMock.mockResolvedValueOnce(
      catalogResult([missingSourceIssue("a.css", "alpha")]),
    );

    await useTheme.getState().syncThemes();

    expect(buildThemeCatalogMock).toHaveBeenCalledTimes(1);
    expect(showMessageMock).toHaveBeenCalledWith(
      "预装主题不可用：源副本缺少或无法读取 1 项",
      { title: "预装主题不可用", kind: "warning" },
    );
  });

  it("counts the same missing source CSS once after another theme is copied and rescanned", async () => {
    const copyPlan: CopyPlanItem = {
      slug: "other-theme",
      from: "/resources/themes/other.css",
      to: "/app/themes/other.css",
      reason: "运行时缺失",
    };
    const missing = missingSourceIssue("a.css", "alpha");
    buildThemeCatalogMock
      .mockResolvedValueOnce(catalogResult([missing], [copyPlan]))
      .mockResolvedValueOnce(catalogResult([missing]));

    await useTheme.getState().syncThemes();

    expect(copyThemePathMock).toHaveBeenCalledTimes(1);
    expect(buildThemeCatalogMock).toHaveBeenCalledTimes(2);
    expect(showMessageMock).toHaveBeenCalledWith(
      "预装主题不可用：源副本缺少或无法读取 1 项",
      { title: "预装主题不可用", kind: "warning" },
    );
    expect(useTheme.getState().scanIssues).toContain(
      "预装主题已按源副本补齐 1 项（N13：用户改动只落 user:*）",
    );
  });
});

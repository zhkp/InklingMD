import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogResult, CopyPlanItem } from "../../src/theme/catalog";
import type { CopyReport } from "../../src/lib/themeFiles";

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
  copyThemePathMock: vi.fn(async (): Promise<CopyReport> => ({ files: 0, bytes: 0, skipped: [] })),
  ensureDirMock: vi.fn(async () => undefined),
  readBundledManifestMock: vi.fn(async () => ({ themes: [] })),
  scanThemesDirMock: vi.fn(async () => ({ entries: [], skipped: [], skippedPaths: [], exists: true })),
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

function catalogResult(
  missingSourceDiagnostics: Array<{ path: string; issue: string }> = [],
  copyPlan: CopyPlanItem[] = [],
): CatalogResult {
  return {
    themes: [],
    index: [],
    issues: missingSourceDiagnostics.map(({ issue }) => issue),
    missingSourceDiagnostics,
    copyPlan,
    manifest: [],
  };
}

function missingSourceIssue(path: string, slug: string): { path: string; issue: string } {
  return { path, issue: `预装源副本缺失或不可读：${path}（清单 slug=${slug}，ENOENT）→ 本次不补齐该主题` };
}

describe("theme store missing bundled-source warning count", () => {
  beforeEach(async () => {
    localStorage.clear();
    useTheme.setState({ themeId: "builtin:light", mode: "light", scanIssues: [], scanState: "idle" });
    buildThemeCatalogMock.mockReset().mockResolvedValue(catalogResult());
    copyThemePathMock.mockReset().mockResolvedValue({ files: 0, bytes: 0, skipped: [] });
    ensureDirMock.mockReset().mockResolvedValue(undefined);
    scanThemesDirMock.mockReset().mockResolvedValue({ entries: [], skipped: [], skippedPaths: [], exists: true });
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
    expect(useTheme.getState().scanIssues).toHaveLength(2);
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
    expect(useTheme.getState().scanIssues).toHaveLength(3);
  });

  it("counts distinct missing CSS paths even when their names contain diagnostic delimiter text", async () => {
    const bluePath = "themes/one（清单 slug=blue.css";
    const greenPath = "themes/one（清单 slug=green.css";
    buildThemeCatalogMock.mockResolvedValueOnce(
      catalogResult([
        missingSourceIssue(bluePath, "blue"),
        missingSourceIssue(greenPath, "green"),
      ]),
    );

    await useTheme.getState().syncThemes();

    expect(showMessageMock).toHaveBeenCalledWith(
      "预装主题不可用：源副本缺少或无法读取 2 项",
      { title: "预装主题不可用", kind: "warning" },
    );
    expect(useTheme.getState().scanIssues).toHaveLength(3);
  });

  it("retains supplement failures as separate scan issues", async () => {
    const copyPlan: CopyPlanItem = {
      slug: "blocked-theme",
      from: "/resources/themes/blocked.css",
      to: "/app/themes/blocked.css",
      reason: "运行时缺失",
    };
    copyThemePathMock.mockRejectedValueOnce(new Error("permission denied"));
    buildThemeCatalogMock.mockResolvedValueOnce(
      catalogResult([missingSourceIssue("a.css", "alpha")], [copyPlan]),
    );

    await useTheme.getState().syncThemes();

    expect(buildThemeCatalogMock).toHaveBeenCalledTimes(1);
    expect(useTheme.getState().scanIssues).toContain(
      "预装主题补齐失败（blocked-theme）：permission denied",
    );
    expect(useTheme.getState().scanIssues).toHaveLength(3);
  });

  it("reports symlinks skipped while copying bundled resource directories", async () => {
    const resourceCopy: CopyPlanItem = {
      slug: "theme-with-assets",
      from: "/resources/themes/assets",
      to: "/app/themes/assets",
      reason: "运行时缺失",
    };
    copyThemePathMock.mockResolvedValueOnce({
      files: 1,
      bytes: 4,
      skipped: [
        "/resources/themes/assets/fonts/font-link.woff2（符号链接，不跟随）",
        "/resources/themes/assets/linked-assets（符号链接，不跟随）",
      ],
    });
    buildThemeCatalogMock
      .mockResolvedValueOnce(catalogResult([], [resourceCopy]))
      .mockResolvedValueOnce(catalogResult());

    await useTheme.getState().syncThemes();

    expect(buildThemeCatalogMock).toHaveBeenCalledTimes(2);
    expect(useTheme.getState().scanIssues).toContain(
      "预装主题资源跳过（theme-with-assets）：/resources/themes/assets/fonts/font-link.woff2（符号链接，不跟随）",
    );
    expect(useTheme.getState().scanIssues).toContain(
      "预装主题资源跳过（theme-with-assets）：/resources/themes/assets/linked-assets（符号链接，不跟随）",
    );
    expect(useTheme.getState().scanIssues).toContain(
      "预装主题已按源副本补齐 1 项（N13：用户改动只落 user:*）",
    );
  });

  it("preserves mixed supplement results and newly discovered missing paths after rescan", async () => {
    const successfulCopy: CopyPlanItem = {
      slug: "good-theme",
      from: "/resources/themes/good.css",
      to: "/app/themes/good.css",
      reason: "运行时缺失",
    };
    const failedCopy: CopyPlanItem = {
      slug: "blocked-theme",
      from: "/resources/themes/blocked.css",
      to: "/app/themes/blocked.css",
      reason: "运行时缺失",
    };
    const existingMissing = missingSourceIssue("a.css", "alpha");
    const newlyMissing = missingSourceIssue("b.css", "beta");
    copyThemePathMock
      .mockResolvedValueOnce({ files: 1, bytes: 1, skipped: [] })
      .mockRejectedValueOnce(new Error("permission denied"));
    buildThemeCatalogMock
      .mockResolvedValueOnce(catalogResult([existingMissing], [successfulCopy, failedCopy]))
      .mockResolvedValueOnce(catalogResult([existingMissing, newlyMissing]));

    await useTheme.getState().syncThemes();

    expect(buildThemeCatalogMock).toHaveBeenCalledTimes(2);
    expect(useTheme.getState().scanIssues).toContain(
      "预装主题补齐失败（blocked-theme）：permission denied",
    );
    expect(useTheme.getState().scanIssues).toContain(
      "预装主题已按源副本补齐 1 项（N13：用户改动只落 user:*）",
    );
    expect(useTheme.getState().scanIssues).toContain(newlyMissing.issue);
    expect(showMessageMock).toHaveBeenCalledWith(
      "预装主题不可用：源副本缺少或无法读取 2 项",
      { title: "预装主题不可用", kind: "warning" },
    );
    expect(useTheme.getState().scanIssues).toHaveLength(5);
  });
});

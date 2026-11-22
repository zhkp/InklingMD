import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mockEnsureDir, mockScan, resetMockThemes } from "../../src/lib/mockThemes";

const seed = (value: unknown) => {
  (globalThis as { __inklingThemesMock?: unknown }).__inklingThemesMock = value;
};

beforeEach(() => {
  seed(undefined);
  resetMockThemes();
});

afterEach(() => {
  seed(undefined);
  resetMockThemes();
});

describe("mock theme directory existence", () => {
  it("derives a file-only directory's existence from its file path", () => {
    seed({ files: { "/mock-appdata/themes/dark.css": "body {}" } });
    resetMockThemes();

    expect(mockScan("/mock-appdata/themes").exists).toBe(true);
    expect(mockScan("/mock-appdata/themes/dark").exists).toBe(false);
  });

  it("represents an explicitly seeded empty directory", () => {
    seed({ existingDirs: ["/mock-resource/themes/"] });
    resetMockThemes();

    expect(mockScan("/mock-resource/themes")).toEqual({
      entries: [],
      skipped: [],
      skippedPaths: [],
      exists: true,
    });
  });

  it("records an empty directory created by ensure", () => {
    mockEnsureDir("/mock-appdata/empty/");

    expect(mockScan("/mock-appdata/empty").exists).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  expectedThemeSlugs,
  hasExpectedBundledThemes,
  // @ts-ignore -- 纯 JS helper 由运行探针与单测共用，不带类型声明
} from "../../scripts/lib/portable-theme-probe.mjs";

describe("portable theme runtime probe expectations", () => {
  it("derives an exact three-theme bundled count from the source manifest", () => {
    const expectedSlugs: string[] = expectedThemeSlugs({
      themes: [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma" }],
    });
    const index = {
      themes: expectedSlugs.map((slug) => ({ id: `bundled:${slug}`, source: "bundled" })),
    };

    expect(expectedSlugs).toEqual(["alpha", "beta", "gamma"]);
    expect(index.themes).toHaveLength(3);
    expect(hasExpectedBundledThemes(index, expectedSlugs)).toBe(true);
    expect(hasExpectedBundledThemes({ themes: index.themes.slice(0, 2) }, expectedSlugs)).toBe(false);
    expect(
      hasExpectedBundledThemes(
        { themes: [...index.themes, { id: "bundled:legacy", source: "bundled" }] },
        expectedSlugs,
      ),
    ).toBe(false);
  });
});

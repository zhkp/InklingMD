export function expectedThemeSlugs(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.themes)) {
    throw new Error("源主题清单缺少 themes 数组");
  }

  const seen = new Set();
  const slugs = manifest.themes.map((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof entry.slug !== "string" || !entry.slug.trim()) {
      throw new Error(`源主题清单 themes[${index}] 缺少有效 slug`);
    }
    if (seen.has(entry.slug)) throw new Error(`源主题清单 slug 重复：${entry.slug}`);
    seen.add(entry.slug);
    return entry.slug;
  });

  if (slugs.length === 0) throw new Error("源主题清单未登记任何主题");
  return slugs;
}

export function hasExpectedBundledThemes(index, expectedSlugs) {
  if (!Array.isArray(expectedSlugs) || expectedSlugs.length === 0 || !Array.isArray(index?.themes)) {
    return false;
  }

  const bundledEntries = index.themes.filter((theme) => theme && typeof theme === "object" && theme.source === "bundled");
  if (bundledEntries.length !== expectedSlugs.length) return false;

  const indexedSlugs = bundledEntries.map((theme) => {
    if (typeof theme.id !== "string" || !theme.id.startsWith("bundled:")) return null;
    return theme.id.slice("bundled:".length) || null;
  });
  if (indexedSlugs.some((slug) => slug === null)) return false;

  return JSON.stringify(indexedSlugs.sort()) === JSON.stringify([...expectedSlugs].sort());
}

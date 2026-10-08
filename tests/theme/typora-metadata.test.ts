import { describe, expect, it } from "vitest";
import {
  buildThemeId,
  detectDeclaredMode,
  detectHeuristicMode,
  isThemeFile,
  normalizeThemeSlug,
  pairVariants,
  parseThemeCandidate,
  scanThemesInDirectory,
} from "../../src/theme/typora/metadata";

describe("#306 G11-1：主题名归一化算法", () => {
  it.each([
    ["Vue", "vue"],
    ["GitHub Dark", "github-dark"],
    ["  Newsprint  ", "newsprint"],
    ["Cobalt#2", "cobalt-2"],
    ["vue_dark", "vue-dark"],
    ["主题", "主题"],
    ["我的 主题 2", "我的-主题-2"],
    ["🌙 Moon", "moon"],
    ["a/b:c", "a-b-c"],
    ["x---y", "x-y"],
  ])("%s → %s", (raw, expected) => {
    expect(normalizeThemeSlug(raw)).toBe(expected);
  });

  it("全 emoji 名回落到 `theme-<hash8>`（不产生空 id）", () => {
    const slug = normalizeThemeSlug("🌙🌙🌙");
    expect(slug).toMatch(/^theme-[0-9a-f]{8}$/);
  });

  it("超长名截断并带 hash 后缀（≤64 且不同长名不撞）", () => {
    const long = "a".repeat(200);
    const slug = normalizeThemeSlug(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toMatch(/-[0-9a-f]{8}$/);
    expect(normalizeThemeSlug("a".repeat(199))).not.toBe(slug);
  });

  it("大小写不同、空格不同的同一主题归一化后 id 稳定（G11：themeId 不依赖路径）", () => {
    expect(buildThemeId("user", normalizeThemeSlug("Vue"))).toBe(
      buildThemeId("user", normalizeThemeSlug("vue ")),
    );
  });
});

describe("#306 G11-3/4：mode 判定与 -dark 配对", () => {
  const siblings = ["vue.css", "vue-dark.css", "newsprint.css", "Notes.txt", "solarized.scss"];
  const dirNames = ["vue", "vue-dark"];

  it("文件名后缀优先：`vue-dark.css` → dark（modeSource=filename）", () => {
    const d = parseThemeCandidate({ fileName: "vue-dark.css", siblings, dirNames, source: "user" });
    expect(d.mode).toBe("dark");
    expect(d.modeSource).toBe("filename");
    expect(d.themeId).toBe("user:vue-dark");
  });

  it("无后缀时用主题内声明（declaredMode > 启发式）", () => {
    const d = parseThemeCandidate({
      fileName: "newsprint.css",
      siblings,
      source: "user",
      declaredMode: "dark",
      content: "body { color: #fff }",
    });
    expect(d.mode).toBe("dark");
    expect(d.modeSource).toBe("declared");
  });

  it("无声明时用启发式（prefers-color-scheme: dark / color-scheme: dark）", () => {
    expect(detectHeuristicMode("@media (prefers-color-scheme: dark) { :root { --x: 1 } }")).toBe("dark");
    expect(detectHeuristicMode("html { color-scheme: dark }")).toBe("dark");
    expect(detectHeuristicMode("body { color: #111 }")).toBe("light");
  });

  it("文件内标记 `inkling-mode: dark` 被识别（G11-4 的「主题内声明」通道）", () => {
    expect(detectDeclaredMode("/* inkling-mode: dark */\n#write h1 {}")).toBe("dark");
    expect(detectDeclaredMode("#write h1 {}")).toBeUndefined();
  });

  it("成对主题互指 variantOf（vue ↔ vue-dark）", () => {
    const themes = pairVariants([
      parseThemeCandidate({ fileName: "vue.css", siblings, dirNames, source: "user" }),
      parseThemeCandidate({ fileName: "vue-dark.css", siblings, dirNames, source: "user" }),
    ]);
    const light = themes.find((t) => t.fileName === "vue.css")!;
    const dark = themes.find((t) => t.fileName === "vue-dark.css")!;
    expect(light.variantOf).toBe("user:vue-dark");
    expect(dark.variantOf).toBe("user:vue");
  });

  it("`<name>-dark.css` 而 `<name>.css` 不存在 → 独立主题 + 登记", () => {
    const d = parseThemeCandidate({
      fileName: "lonely-dark.css",
      siblings: ["lonely-dark.css"],
      source: "user",
    });
    expect(d.variantOf).toBeUndefined();
    expect(d.issues.some((i) => i.includes("不存在"))).toBe(true);
  });

  it("`<name>-dark-dark.css`：只剥一层后缀，配对目标是 `<name>-dark`", () => {
    const siblings2 = ["ghost-dark.css", "ghost-dark-dark.css"];
    const themes = pairVariants([
      parseThemeCandidate({ fileName: "ghost-dark.css", siblings: siblings2, source: "user" }),
      parseThemeCandidate({ fileName: "ghost-dark-dark.css", siblings: siblings2, source: "user" }),
    ]);
    const double = themes.find((t) => t.fileName === "ghost-dark-dark.css")!;
    expect(double.mode).toBe("dark");
    expect(double.themeId).toBe("user:ghost-dark-dark");
    expect(double.variantOf).toBe("user:ghost-dark");
    expect(double.issues.some((i) => i.includes("-dark-dark"))).toBe(true);
  });
});

describe("#306 G11-5：扫描范围与边界", () => {
  it("只识别 .css；.scss 跳过并登记", () => {
    expect(isThemeFile("a.css")).toBe(true);
    expect(isThemeFile("a.scss")).toBe(false);
    const { themes, issues } = scanThemesInDirectory(
      ["vue.css", "vue-dark.css", "solarized.scss", "notes.md"],
      ["vue"],
      "user",
    );
    expect(themes.map((t) => t.fileName)).toEqual(["vue.css", "vue-dark.css"]);
    expect(issues.some((i) => i.includes("solarized.scss"))).toBe(true);
  });

  it("同名资源目录被识别（大小写不敏感）", () => {
    const d = parseThemeCandidate({
      fileName: "Vue.css",
      siblings: ["Vue.css"],
      dirNames: ["vue"],
      source: "user",
    });
    expect(d.resourceDir).toBe("vue");
  });

  it("大小写冲突：两个文件归一化后同名 → 登记（取先出现者）", () => {
    const d = parseThemeCandidate({
      fileName: "Vue.css",
      siblings: ["Vue.css", "vue.css"],
      source: "user",
    });
    expect(d.issues.some((i) => i.includes("归一化名冲突"))).toBe(true);
  });

  it("bundled 走清单 slug（N15-3：文件与清单不同名也不得误判为 user:*）", () => {
    const d = parseThemeCandidate({
      fileName: "Vue-1.2.css",
      siblings: ["Vue-1.2.css"],
      source: "bundled",
      manifestSlug: "vue",
    });
    expect(d.themeId).toBe("bundled:vue");
  });
});

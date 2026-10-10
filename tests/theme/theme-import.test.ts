/**
 * #307 §3.1 / §4 / §9 / §2 新-2 / §10 N13·N15：导入纯核心的断言。
 *
 * 这些断言是「契约的可执行形态」：包结构归一化、重名策略（含预装禁覆盖）、
 * 体积三档与显式拒绝、预装清单解析与幂等补齐判据。
 */
import { describe, expect, it } from "vitest";
import {
  BUNDLED_MANIFEST_VERSION,
  THEME_REJECT_MAX_BYTES,
  THEME_SNAPSHOT_MAX_BYTES,
  analyzeRemoteResources,
  availableConflictChoices,
  checkThemeCssSafety,
  matchBundledSlug,
  nextFreeSlugId,
  normalizePackage,
  parseBundledManifest,
  planBundledSync,
  resolveImportConflict,
  sizeTierOf,
  utf8Bytes,
  validateImportedTheme,
  type BundledManifestEntry,
  type PackageEntry,
} from "../../src/theme/import";
import { rewriteWithReport, themeCssHash } from "../../src/theme/typora/rewrite";

const file = (path: string): PackageEntry => ({ path, kind: "file" });
const dir = (path: string): PackageEntry => ({ path, kind: "dir" });

describe("§3.1 包结构归一化（压缩包/文件夹）", () => {
  it("扁平包：<name>.css + 同名资源目录 → 一条主题并绑定资源目录", () => {
    const { themes, issues } = normalizePackage([
      file("vue-dark.css"),
      dir("vue-dark"),
      file("vue-dark/font.woff2"),
      file("vue-dark/bg.png"),
      file("README.md"),
      file("LICENSE"),
    ]);
    expect(issues).toEqual([]);
    expect(themes).toHaveLength(1);
    expect(themes[0]).toMatchObject({
      slug: "vue-dark",
      cssPath: "vue-dark.css",
      resourceDir: "vue-dark",
      mode: "dark",
    });
    expect(themes[0].extras.sort()).toEqual(["LICENSE", "README.md"]);
  });

  it("包内多一层（GitHub zip 形态）：下探 1 层后归一化，路径带回根目录", () => {
    const { themes, issues } = normalizePackage([
      dir("typora-theme-pixyll-master"),
      file("typora-theme-pixyll-master/pixyll.css"),
      dir("typora-theme-pixyll-master/pixyll"),
      file("typora-theme-pixyll-master/pixyll/Merriweather.ttf"),
    ]);
    expect(issues).toEqual([]);
    expect(themes).toHaveLength(1);
    expect(themes[0].cssPath).toBe("typora-theme-pixyll-master/pixyll.css");
    expect(themes[0].resourceDir).toBe("typora-theme-pixyll-master/pixyll");
  });

  it("下探超过 1 层（深层嵌套）→ 不猜、整包拒绝并给原因", () => {
    const { themes, issues } = normalizePackage([
      dir("a"),
      dir("a/b"),
      file("a/b/c/vue.css"),
    ]);
    expect(themes).toEqual([]);
    expect(issues.join("\n")).toContain("未找到任何 .css");
  });

  it("明暗成对的多 css → 全部导入", () => {
    const { themes } = normalizePackage([file("vue.css"), file("vue-dark.css")]);
    expect(themes.map((t) => [t.slug, t.mode])).toEqual([
      ["vue", "light"],
      ["vue-dark", "dark"],
    ]);
  });

  it("包内无 .css → 整包拒绝（§3.1：.css 数量 ≥1）", () => {
    const { themes, issues } = normalizePackage([dir("themes"), file("themes/readme.txt")]);
    expect(themes).toEqual([]);
    expect(issues.join("\n")).toContain("未找到任何 .css");
  });

  it("归一化同名（Vue.css 与 vue.css）→ 取先出现者并登记，不产生重复 themeId", () => {
    const { themes, issues } = normalizePackage([file("Vue.css"), file("vue.css")]);
    expect(themes).toHaveLength(1);
    expect(themes[0].cssPath).toBe("Vue.css");
    expect(issues.join("\n")).toContain("归一化同名冲突");
  });

  it("资源目录绑定按「与 .css 基名同名」，不误绑其它目录", () => {
    const { themes } = normalizePackage([file("night.css"), dir("other"), file("other/x.png")]);
    expect(themes[0].resourceDir).toBeUndefined();
  });
});

describe("§4 重名与覆盖策略", () => {
  const taken = (...ids: string[]) => new Set(ids);

  it("无同名 → 直接导入", () => {
    const r = resolveImportConflict({
      incomingId: "user:vue",
      incomingHash: "h1",
      takenIds: taken(),
    });
    expect(r.action).toBe("overwrite");
    expect(r.targetId).toBe("user:vue");
  });

  it("同 hash → skip-identical（不重复导入）", () => {
    const r = resolveImportConflict({
      incomingId: "user:vue",
      incomingHash: "same",
      existing: { id: "user:vue", source: "user", hash: "same" },
      takenIds: taken("user:vue"),
    });
    expect(r.action).toBe("skip-identical");
    expect(r.reason).toContain("完全相同");
  });

  it("目标是用户主题且内容不同 → 覆盖（旧文件由 IO 层移入备份）", () => {
    const r = resolveImportConflict({
      incomingId: "user:vue",
      incomingHash: "new",
      existing: { id: "user:vue", source: "user", hash: "old" },
      takenIds: taken("user:vue"),
    });
    expect(r.action).toBe("overwrite");
    expect(r.targetId).toBe("user:vue");
  });

  it("目标是预装主题 → **禁止覆盖**，复制为 my 主题（新-1）", () => {
    const r = resolveImportConflict({
      incomingId: "user:vue",
      incomingHash: "new",
      existing: { id: "bundled:vue", source: "bundled", hash: "src" },
      takenIds: taken("bundled:vue"),
    });
    expect(r.action).toBe("duplicate-as-user");
    expect(r.targetId).toBe("user:vue");
    expect(r.reason).toContain("不允许原地替换");
    expect(availableConflictChoices({ id: "bundled:vue", source: "bundled" })).toEqual([
      "duplicate-as-user",
      "rename",
    ]);
  });

  it("预装重名 + 用户已占同名 → 复制为带序号的 user:*", () => {
    const r = resolveImportConflict({
      incomingId: "user:vue",
      incomingHash: "new",
      existing: { id: "bundled:vue", source: "bundled", hash: "src" },
      takenIds: taken("bundled:vue", "user:vue"),
    });
    expect(r.targetId).toBe("user:vue-2");
    expect(nextFreeSlugId("user:vue", taken("user:vue", "user:vue-2"))).toBe("user:vue-3");
  });

  it("用户主题可选「覆盖 / 重命名」；预装主题选不到「覆盖」", () => {
    expect(availableConflictChoices({ id: "user:vue", source: "user" })).toEqual(["overwrite", "rename"]);
    expect(availableConflictChoices({ id: "bundled:vue", source: "bundled" })).not.toContain("overwrite");
    expect(availableConflictChoices(undefined)).toEqual([]);
  });
});

describe("§9 体积分档与显式拒绝", () => {
  it("三档边界（A-2 分档：≤256 KB 快照 / 256–512 KB 降级 / >512 KB 拒绝）", () => {
    expect(sizeTierOf(1)).toBe("snapshot");
    expect(sizeTierOf(THEME_SNAPSHOT_MAX_BYTES)).toBe("snapshot");
    expect(sizeTierOf(THEME_SNAPSHOT_MAX_BYTES + 1)).toBe("degraded");
    expect(sizeTierOf(THEME_REJECT_MAX_BYTES)).toBe("degraded");
    expect(sizeTierOf(THEME_REJECT_MAX_BYTES + 1)).toBe("reject");
  });

  it("合法主题：走快照档，无提示", () => {
    const v = validateImportedTheme("h1{color:#333}");
    expect(v.ok).toBe(true);
    expect(v.tier).toBe("snapshot");
    expect(v.notices).toEqual([]);
  });

  it("256–512 KB → 可用但恒定降级，必须给可见提示", () => {
    const css = `/* ${"x".repeat(300 * 1024)} */`;
    const v = validateImportedTheme(css);
    expect(v.ok).toBe(true);
    expect(v.tier).toBe("degraded");
    expect(v.notices.join("\n")).toContain("不走首屏快照");
  });

  it(">512 KB → 拒绝并给可读理由", () => {
    const v = validateImportedTheme(`/* ${"x".repeat(600 * 1024)} */`);
    expect(v.ok).toBe(false);
    expect(v.tier).toBe("reject");
    expect(v.reason).toContain("超过上限");
  });

  it("`url(javascript:…)` / `expression(…)` 显式拒绝（大小写与空白容错）", () => {
    expect(checkThemeCssSafety("a{background:url(javascript:alert(1))}").ok).toBe(false);
    expect(checkThemeCssSafety("a{background:URL( 'JavaScript:alert(1)' )}").ok).toBe(false);
    expect(checkThemeCssSafety("a{width:expression(alert(1))}").ok).toBe(false);
    expect(checkThemeCssSafety("a{width:calc(100% - 1px)}").ok).toBe(true);
    expect(validateImportedTheme("a{background:url(javascript:1)}").ok).toBe(false);
  });

  it("远程资源提示：分别统计远程样式表 / 字体 / 图片（P1-7 明示取舍）", () => {
    const css = [
      `@import url(https://fonts.example.com/a.css);`,
      `@font-face{font-family:X;src:url(https://cdn.example.com/x.woff2)}`,
      `@font-face{font-family:Y;src:url(./y.woff2)}`,
      `body{background:url(https://img.example.com/bg.png)}`,
    ].join("\n");
    const n = analyzeRemoteResources(css);
    expect(n.remoteImports).toBe(1);
    expect(n.remoteFonts).toBe(1);
    expect(n.remoteImages).toBe(1);
    expect(n.shouldNotice).toBe(true);
    expect(validateImportedTheme("body{background:url(./local.png)}").notices).toEqual([]);
  });

  it("utf8Bytes 与 TextEncoder 一致（含多字节）", () => {
    expect(utf8Bytes("abc")).toBe(3);
    expect(utf8Bytes("中文")).toBe(6);
    expect(utf8Bytes("😀")).toBe(4);
  });
});

describe("§2 新-2 预装清单 + §10 N13/N15", () => {
  const manifest = (themes: unknown[], v: unknown = BUNDLED_MANIFEST_VERSION) => ({ v, themes });

  it("合法清单：解析出最小字段集", () => {
    const r = parseBundledManifest(
      manifest([{ slug: "vue", css: "vue.css", dir: "vue", name: "Vue", mode: "light", hiddenByDefault: true }]),
    );
    expect(r.issues).toEqual([]);
    expect(r.entries).toEqual([
      { slug: "vue", css: "vue.css", dir: "vue", name: "Vue", mode: "light", hiddenByDefault: true },
    ]);
  });

  it("版本不认识 / 缺 themes → 视为无预装主题并留痕", () => {
    expect(parseBundledManifest(manifest([], 99)).issues.join("\n")).toContain("版本不认识");
    expect(parseBundledManifest({ v: BUNDLED_MANIFEST_VERSION }).issues.join("\n")).toContain("缺少 themes");
    expect(parseBundledManifest(null).issues.join("\n")).toContain("不是对象");
  });

  it("单条非法只跳过该条（slug/css/name/mode 必填），slug 重复取先出现者", () => {
    const r = parseBundledManifest(
      manifest([
        { slug: "ok", css: "ok.css", name: "OK", mode: "dark" },
        { slug: "", css: "x.css", name: "X", mode: "light" },
        { slug: "ok", css: "ok2.css", name: "OK2", mode: "dark" },
      ]),
    );
    expect(r.entries.map((e) => e.slug)).toEqual(["ok"]);
    expect(r.issues).toHaveLength(2);
  });

  it("清单条目的 css/dir 拒绝绝对路径与 `..`（会驱动复制到主题目录，必须与 zip 同级判据）", () => {
    const r = parseBundledManifest(
      manifest([
        { slug: "ok", css: "ok.css", name: "OK", mode: "light" },
        { slug: "abs", css: "/etc/passwd", name: "ABS", mode: "light" },
        { slug: "up", css: "../evil.css", name: "UP", mode: "light" },
        { slug: "drive", css: "C:\\evil.css", name: "DRIVE", mode: "light" },
        { slug: "dirup", css: "x.css", dir: "../x", name: "DIRUP", mode: "light" },
      ]),
    );
    expect(r.entries.map((e) => e.slug)).toEqual(["ok"]);
    expect(r.issues.filter((i) => i.includes("路径不合法"))).toHaveLength(4);
  });

  it("N15 清单驱动识别：相对路径 → slug（大小写不敏感、不做模糊匹配）", () => {
    const entries: BundledManifestEntry[] = [
      { slug: "vue", css: "vue.css", dir: "vue", name: "Vue", mode: "light" },
    ];
    expect(matchBundledSlug("Vue.css", entries)).toBe("vue");
    expect(matchBundledSlug("./vue.css", entries)).toBe("vue");
    expect(matchBundledSlug("vue", entries)).toBe("vue");
    // 文件名不同（清单 vue / 文件 vue-1.2.css）→ 不得误判为预装
    expect(matchBundledSlug("vue-1.2.css", entries)).toBeUndefined();
    expect(matchBundledSlug("my-vue.css", entries)).toBeUndefined();
  });

  it("N13 幂等补齐：缺失 / 不一致才复制，一致则不动", () => {
    const entries: BundledManifestEntry[] = [
      { slug: "a", css: "a.css", name: "A", mode: "light" },
      { slug: "b", css: "b.css", name: "B", mode: "dark" },
      { slug: "c", css: "c.css", name: "C", mode: "dark" },
    ];
    const src = new Map([
      ["a.css", "src-a"],
      ["b.css", "src-b"],
      ["c.css", "src-c"],
    ]);
    const plan = planBundledSync(entries, src, [
      { css: "a.css", hash: "src-a" }, // 一致 → 不动
      { css: "b.css", hash: "user-edited" }, // 不一致 → 按源副本覆盖
      // c.css 缺失 → 补齐
    ]);
    expect(plan.copy.map((e) => e.slug)).toEqual(["b", "c"]);
    expect(plan.reasons.a).toBeUndefined();
    expect(plan.reasons.b).toContain("不一致");
    expect(plan.reasons.c).toContain("缺失");
  });
});

describe("G9 hash 口径：扫描期算 hash 与切换时一致", () => {
  it("BOM / @charset / CRLF 变体 → 同一 hash（与 rewrite 的 hash 相同）", () => {
    const plain = "h1{color:#333}\n";
    const messy = "\uFEFF@charset \"utf-8\";\r\nh1{color:#333}\r\n";
    expect(themeCssHash(plain)).toBe(themeCssHash(messy));
    const ctx = {
      themeId: "user:h",
      themeDir: "/themes",
      toAssetUrl: (abs: string) => `asset://${abs}`,
    };
    expect(rewriteWithReport(plain, ctx).hash).toBe(themeCssHash(messy));
  });
});

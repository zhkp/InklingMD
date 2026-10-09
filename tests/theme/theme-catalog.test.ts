/**
 * #307 §2 / §10 N13·N15：清单编排断言（扫描 → 预装识别 → 幂等补齐计划 → 落盘索引）。
 */
import { describe, expect, it } from "vitest";
import { buildThemeCatalog, indexChanged, type CatalogIo } from "../../src/theme/catalog";
import { themeCssHash } from "../../src/theme/typora/rewrite";

const THEMES = "/appdata/themes";
const BUNDLED = "/resource/themes";

interface StubOptions {
  files: Record<string, string>;
  bundledFiles?: Record<string, string>;
  manifest?: unknown;
  skipped?: string[];
  failRead?: string[];
  dirs?: Record<string, boolean>;
}

function stubIo(opts: StubOptions): CatalogIo {
  const join = (dir: string, rel: string) => `${dir.replace(/\/+$/, "")}/${rel.replace(/^\/+/, "")}`;
  return {
    themesRoot: THEMES,
    bundledRoot: BUNDLED,
    manifestRaw: opts.manifest,
    join,
    scanDir: async (dir: string) => {
      const base = dir.replace(/\/+$/, "");
      const entries = new Map<string, { name: string; path: string; is_dir: boolean; size: number }>();
      const all = dir === THEMES ? opts.files : (opts.bundledFiles ?? {});
      for (const [path, content] of Object.entries(all)) {
        if (!path.startsWith(`${base}/`)) continue;
        const rest = path.slice(base.length + 1);
        const [head, ...tail] = rest.split("/");
        if (!head) continue;
        if (tail.length === 0) entries.set(head, { name: head, path, is_dir: false, size: content.length });
        else if (!entries.has(head)) entries.set(head, { name: head, path: join(base, head), is_dir: true, size: 0 });
      }
      for (const [rel, isDir] of Object.entries(opts.dirs ?? {})) {
        const name = rel.split("/").pop()!;
        if (isDir && !entries.has(name)) entries.set(name, { name, path: join(base, name), is_dir: true, size: 0 });
      }
      return { entries: [...entries.values()], skipped: opts.skipped ?? [] };
    },
    readFile: async (abs: string) => {
      if (opts.failRead?.includes(abs)) throw new Error("读取失败");
      const hit = opts.files[abs] ?? opts.bundledFiles?.[abs];
      if (hit === undefined) throw new Error(`文件不存在: ${abs}`);
      return hit;
    },
  };
}

describe("#307 清单编排：扫描与落盘索引", () => {
  it("用户主题成对识别 + 索引带文件名与 hash", async () => {
    const files = {
      [`${THEMES}/vue.css`]: "#write h1{color:#333}",
      [`${THEMES}/vue-dark.css`]: "#write h1{color:#eee}",
    };
    const { themes, index, issues } = await buildThemeCatalog(stubIo({ files }));
    expect(issues).toEqual([]);
    expect(themes.map((t) => t.id).sort()).toEqual(["user:vue", "user:vue-dark"]);
    const vue = themes.find((t) => t.id === "user:vue")!;
    expect(vue.mode).toBe("light");
    expect(vue.variantOf).toBe("user:vue-dark");
    expect(vue.css).toEqual({ kind: "file", path: `${THEMES}/vue.css` });
    expect(vue.hash).toBe(themeCssHash(files[`${THEMES}/vue.css`]));
    expect(index).toContainEqual(
      expect.objectContaining({ id: "user:vue", file: "vue.css", source: "user", variantOf: "user:vue-dark" }),
    );
  });

  it("同目录资源目录不进入清单，但主题照常登记", async () => {
    const files = { [`${THEMES}/pixyll.css`]: "#write h1{}" };
    const { themes } = await buildThemeCatalog(stubIo({ files, dirs: { pixyll: true } }));
    expect(themes.map((t) => t.id)).toEqual(["user:pixyll"]);
  });

  it("跳过项 / 读取失败 → 全部进 issues（不静默）", async () => {
    const files = { [`${THEMES}/ok.css`]: "h1{}", [`${THEMES}/bad.css`]: "h1{}" };
    const { themes, issues } = await buildThemeCatalog(
      stubIo({ files, skipped: ["link.css（符号链接，不跟随）"], failRead: [`${THEMES}/bad.css`] }),
    );
    expect(themes.map((t) => t.id)).toEqual(["user:ok"]);
    expect(issues.join("\n")).toContain("符号链接");
    expect(issues.join("\n")).toContain("读取主题文件失败：bad.css");
  });

  it("归一化同名冲突（Vue.css 与 vue.css）→ 取先出现者并登记", async () => {
    const files = { [`${THEMES}/Vue.css`]: "h1{}", [`${THEMES}/vue.css`]: "h1{}" };
    const { themes, issues } = await buildThemeCatalog(stubIo({ files }));
    expect(themes).toHaveLength(1);
    expect(issues.join("\n")).toContain("主题 ID 冲突");
  });
});

describe("#307 N15 清单驱动识别", () => {
  const manifest = {
    v: 1,
    themes: [{ slug: "vue", css: "vue.css", dir: "vue", name: "Vue", mode: "light" }],
  };

  it("命中清单 → bundled:*（即使文件名大小写不同）", async () => {
    const files = { [`${THEMES}/Vue.css`]: "h1{}" };
    const { themes, index } = await buildThemeCatalog(stubIo({ files, manifest }));
    expect(themes.map((t) => t.id)).toEqual(["bundled:vue"]);
    expect(index[0]).toMatchObject({ id: "bundled:vue", source: "bundled", file: "Vue.css" });
  });

  it("未命中清单的同名变体（my-vue.css）→ 仍是 user:*（不误判）", async () => {
    const files = { [`${THEMES}/my-vue.css`]: "h1{}" };
    const { themes } = await buildThemeCatalog(stubIo({ files, manifest }));
    expect(themes.map((t) => t.id)).toEqual(["user:my-vue"]);
  });
});

describe("#307 N13 幂等补齐计划", () => {
  const manifest = {
    v: 1,
    themes: [
      { slug: "vue", css: "vue.css", dir: "vue", name: "Vue", mode: "light" },
      { slug: "night", css: "night.css", name: "Night", mode: "dark" },
    ],
  };
  const bundledFiles = {
    [`${BUNDLED}/vue.css`]: "h1{color:#111}",
    [`${BUNDLED}/night.css`]: "h1{color:#222}",
  };

  it("运行时缺失 → 计划复制（含同名资源目录）", async () => {
    const { copyPlan } = await buildThemeCatalog(
      stubIo({ files: {}, bundledFiles, manifest }),
    );
    expect(copyPlan.map((c) => c.to).sort()).toEqual(
      [`${THEMES}/night.css`, `${THEMES}/vue`, `${THEMES}/vue.css`].sort(),
    );
    expect(copyPlan.find((c) => c.slug === "vue" && c.to.endsWith("vue.css"))!.reason).toContain("缺失");
    // 同名资源目录同样补齐（否则带字体的预装主题缺字）
    expect(copyPlan.some((c) => c.from === `${BUNDLED}/vue`)).toBe(true);
  });

  it("运行时与源副本一致 → 不复制（幂等，不每次写盘）", async () => {
    const files = {
      [`${THEMES}/vue.css`]: bundledFiles[`${BUNDLED}/vue.css`],
      [`${THEMES}/night.css`]: bundledFiles[`${BUNDLED}/night.css`],
    };
    const { copyPlan } = await buildThemeCatalog(stubIo({ files, bundledFiles, manifest }));
    expect(copyPlan).toEqual([]);
  });

  it("运行时被改动（hash 不一致）→ 按源副本覆盖并给原因", async () => {
    const files = {
      [`${THEMES}/vue.css`]: "h1{color:#999}",
      [`${THEMES}/night.css`]: bundledFiles[`${BUNDLED}/night.css`],
    };
    const { copyPlan } = await buildThemeCatalog(stubIo({ files, bundledFiles, manifest }));
    // css + 同名资源目录各一条（清单登记了 dir）
    expect(copyPlan.map((c) => c.slug)).toEqual(["vue", "vue"]);
    expect(copyPlan[0].reason).toContain("不一致");
  });

  it("源副本缺失 → 只登记不补齐（不删运行时副本；N15「补齐」与「用户意志」不冲突）", async () => {
    const { copyPlan, issues } = await buildThemeCatalog(
      stubIo({
        files: {},
        // 清单声明了 vue（含资源目录），但源副本只有 night → vue 既不能补齐也不该误报为「已就绪」
        bundledFiles: { [`${BUNDLED}/night.css`]: "h1{}" },
        manifest: { v: 1, themes: [manifest.themes[0]] },
      }),
    );
    expect(copyPlan).toEqual([]);
    expect(issues.join("\n")).toContain("预装源副本缺失或不可读：vue.css");
  });

  it("清单登记了资源目录：目录副本也进计划（带字体的预装主题才不缺字）", async () => {
    const { copyPlan } = await buildThemeCatalog(
      stubIo({ files: {}, bundledFiles, manifest }),
    );
    expect(copyPlan.some((c) => c.from === `${BUNDLED}/vue` && c.to === `${THEMES}/vue`)).toBe(true);
  });
});

describe("#307 清单写入去抖", () => {
  it("indexChanged 只在内容变化时为 true", () => {
    const a = [{ id: "user:a", name: "A", mode: "light" as const, hash: "h", file: "a.css" }];
    expect(indexChanged(a, a)).toBe(false);
    expect(indexChanged(a, [])).toBe(true);
    expect(indexChanged([...a, { id: "user:b", name: "B", mode: "dark" as const }], a)).toBe(true);
    expect(indexChanged([{ ...a[0], hash: "h2" }], a)).toBe(true);
  });
});

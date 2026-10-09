/**
 * #307 读盘路径断言：本地 `@import` 预读（递归 / 循环 / 缺失 / 远程跳过）+ 兼容层组装。
 *
 * 这些断言锁的是「与 #306 冻结实现的逐项对齐」：解析基准、大小写键、丢弃语义。
 */
import { describe, expect, it } from "vitest";
import { extractImportTargets, loadThemeCss, preloadLocalImports, rawThemeHash } from "../../src/theme/disk";

/** 用内存文件表当读盘桩（键 = 绝对路径，值 = 内容） */
function io(files: Record<string, string>) {
  return {
    readFile: async (abs: string) => {
      const hit = files[abs] ?? files[abs.toLowerCase()];
      if (hit === undefined) throw new Error(`不存在: ${abs}`);
      return hit;
    },
    toAssetUrl: (abs: string) => `asset://localhost/${abs.replace(/^\/+/, "")}`,
  };
}

describe("extractImportTargets：只取本地相对目标", () => {
  it("识别四种形态，跳过远程 / 绝对 / data", () => {
    const css = [
      `@import "a.css";`,
      `@import 'b.css';`,
      `@import url(c.css);`,
      `@import url("d.css") screen;`,
      `@import url(https://cdn.example.com/e.css);`,
      `@import "data:text/css,body{}";`,
      `@import "/abs/f.css";`,
    ].join("\n");
    expect(extractImportTargets(css)).toEqual(["a.css", "b.css", "c.css", "d.css"]);
  });
});

describe("preloadLocalImports：递归预读与保护", () => {
  it("递归读取子导入，并同时登记精确与小写键（与 inlineImports 查找口径一致）", async () => {
    const files = {
      "/themes/vue.css": `@import "./base.css";\n#write{color:#333}`,
      "/themes/base.css": `@import "extra.css";\nbody{margin:0}`,
      "/themes/extra.css": `h1{font-size:2em}`,
    };
    const sources = await preloadLocalImports("/themes", files["/themes/vue.css"], io(files).readFile);
    expect(sources.get("/themes/base.css")).toContain("extra.css");
    expect(sources.get("/themes/extra.css")).toContain("font-size");
    // 小写键也在（Linux 下大小写敏感，查找方能命中）
    expect(sources.get("/themes/base.css".toLowerCase())).toBe(sources.get("/themes/base.css"));
  });

  it("循环引用不无限递归（A → B → A）", async () => {
    const files = {
      "/themes/a.css": `@import "b.css";\na{}`,
      "/themes/b.css": `@import "a.css";\nb{}`,
    };
    const sources = await preloadLocalImports("/themes", files["/themes/a.css"], io(files).readFile);
    // 两个都在，且不挂
    expect(sources.get("/themes/a.css")).toBeDefined();
    expect(sources.get("/themes/b.css")).toBeDefined();
  });

  it("深度上限生效（链式三层 + 上限 2）", async () => {
    const files = {
      "/themes/l1.css": `@import "l2.css";`,
      "/themes/l2.css": `@import "l3.css";`,
      "/themes/l3.css": `@import "l4.css";`,
      "/themes/l4.css": `h1{}`,
    };
    const sources = await preloadLocalImports("/themes", files["/themes/l1.css"], io(files).readFile, 2);
    expect(sources.has("/themes/l2.css")).toBe(true);
    expect(sources.has("/themes/l3.css")).toBe(true);
    expect(sources.has("/themes/l4.css")).toBe(false);
  });

  it("目标缺失不算错误（真实主题包的可选资源）：不预读，由流水线登记丢弃", async () => {
    const files = { "/themes/night.css": `@import "night/mermaid.dark.css";\n#write{}` };
    const sources = await preloadLocalImports("/themes", files["/themes/night.css"], io(files).readFile);
    expect([...sources.keys()]).toEqual([]);
  });
});

describe("loadThemeCss：读盘 + 预读 + #306 改写组装", () => {
  it("本地 @import 被内联、相对 url() 被重写为资产 URL、前缀为 2 段", async () => {
    const files = {
      "/appdata/themes/vue.css": [
        `@import "shared.css";`,
        `#write h1{color:#333}`,
        `body{background:url("./vue/bg.png")}`,
      ].join("\n"),
      "/appdata/themes/shared.css": `#write p{margin:0}`,
    };
    const { result, importSources } = await loadThemeCss({
      themeId: "user:vue",
      filePath: "/appdata/themes/vue.css",
      assetRoot: "/appdata",
      io: io(files),
    });
    expect(result.rejected).toBe(false);
    expect(importSources.size).toBeGreaterThan(0);
    // 内联：产物里不再有 @import
    expect(result.css).not.toMatch(/@import/);
    expect(result.css).toContain(".editor-scroll .milkdown h1");
    expect(result.css).toContain(".editor-scroll .milkdown p");
    // 资源重写为资产 URL
    expect(result.css).toContain("asset://localhost/appdata/themes/vue/bg.png");
    // 无重复导入诊断
    expect(result.diagnostics.filter((d) => d.kind === "inlined-import").length).toBeGreaterThan(0);
  });

  it("资源根之外（`../../` 越界）→ 降级为不加载并登记（§C9）", async () => {
    const files = {
      "/appdata/themes/x.css": `body{background:url("../../../etc/passwd")}`,
    };
    const { result } = await loadThemeCss({
      themeId: "user:x",
      filePath: "/appdata/themes/x.css",
      assetRoot: "/appdata",
      io: io(files),
    });
    expect(result.diagnostics.some((d) => d.kind === "dropped-url")).toBe(true);
    expect(result.css).not.toContain("asset://localhost/etc/passwd");
  });

  it("解析失败 → 整包拒绝（空产物 + parse-error），不注入半解析内容", async () => {
    const files = { "/appdata/themes/broken.css": `#write{color:#333` };
    const { result } = await loadThemeCss({
      themeId: "user:broken",
      filePath: "/appdata/themes/broken.css",
      assetRoot: "/appdata",
      io: io(files),
    });
    expect(result.rejected).toBe(true);
    expect(result.css).toBe("");
    expect(result.diagnostics.some((d) => d.kind === "parse-error")).toBe(true);
  });

  it("hash 与扫描期同口径（BOM/CRLF 变体同 hash）——快照 key 才能对齐", async () => {
    const plain = "h1{color:#333}\n";
    const messy = "\uFEFF@charset \"utf-8\";\r\nh1{color:#333}\r\n";
    expect(rawThemeHash(plain)).toBe(rawThemeHash(messy));
    const files = { "/appdata/themes/h.css": messy };
    const { result } = await loadThemeCss({
      themeId: "user:h",
      filePath: "/appdata/themes/h.css",
      assetRoot: "/appdata",
      io: io(files),
    });
    expect(result.hash).toBe(rawThemeHash(plain));
  });
});

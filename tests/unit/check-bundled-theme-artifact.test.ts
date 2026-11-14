import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts", "check-bundled-theme-artifact.mjs");
const TEMP = mkdtempSync(join(tmpdir(), "inkling-theme-artifact-"));
const SOURCE = join(TEMP, "source-manifest.json");
const SOURCE_MANIFEST = {
  v: 1,
  themes: [
    { slug: "alpha", css: "alpha.css", dir: "alpha", name: "Alpha", mode: "light" },
    { slug: "beta", css: "beta.css", name: "Beta", mode: "dark" },
  ],
};

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function createPackage(name: string, manifest: unknown = SOURCE_MANIFEST): string {
  const root = join(TEMP, name);
  const themes = join(root, "resources", "themes");
  mkdirSync(join(themes, "alpha"), { recursive: true });
  writeJson(join(themes, "manifest.json"), manifest);
  writeFileSync(join(themes, "alpha.css"), "h1 { color: red; }");
  writeFileSync(join(themes, "alpha", "font.woff2"), "font");
  writeFileSync(join(themes, "beta.css"), "h1 { color: black; }");
  return root;
}

function run(root: string) {
  return spawnSync(process.execPath, [SCRIPT, root, SOURCE], { encoding: "utf8" });
}

function createSymlinkOrSkip(
  target: string,
  path: string,
  type: "dir" | "file" | "junction",
  context: { skip: (reason?: string) => never },
): void {
  try {
    symlinkSync(target, path, type);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EPERM", "EACCES", "UNKNOWN"].includes(code ?? "")) {
      context.skip("当前 Windows runner 不允许创建符号链接");
    }
    throw error;
  }
}

describe("check-bundled-theme-artifact", () => {
  beforeAll(() => writeJson(SOURCE, SOURCE_MANIFEST));
  afterAll(() => rmSync(TEMP, { recursive: true, force: true }));

  it("accepts the exact manifest, CSS set, and optional resource directory", () => {
    const root = createPackage("valid");
    writeFileSync(join(root, "resources", "themes", "alpha", "support.css"), "span {}");
    const result = run(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 个主题");
    expect(result.stderr).toBe("");
  });

  it("fails when the package has no themes/manifest.json", () => {
    const root = join(TEMP, "no-manifest");
    mkdirSync(root, { recursive: true });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("恰有一个 themes/manifest.json");
  });

  it("fails when a manifest-declared CSS or resource directory is missing", () => {
    const root = createPackage("missing-resource");
    rmSync(join(root, "resources", "themes", "beta.css"));
    rmSync(join(root, "resources", "themes", "alpha"), { recursive: true, force: true });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少清单声明的 CSS：beta.css");
    expect(result.stderr).toContain("缺少清单声明的资源目录：alpha");
  });

  it("fails on unmanifested CSS and package/source slug drift", () => {
    const drifted = {
      v: 1,
      themes: [
        { slug: "alpha", css: "alpha.css", dir: "alpha", name: "Alpha", mode: "light" },
        { slug: "gamma", css: "gamma.css", name: "Gamma", mode: "dark" },
      ],
    };
    const root = createPackage("drift", drifted);
    writeFileSync(join(root, "resources", "themes", "gamma.css"), "h1 {}");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("缺少仓库登记的主题 slug：beta");
    expect(result.stderr).toContain("含有仓库未登记的主题 slug：gamma");
    expect(result.stderr).toContain("未由清单登记的 CSS：beta.css");
  });

  it("fails when different slugs point to the same CSS", () => {
    const root = createPackage("duplicate-css", {
      v: 1,
      themes: [SOURCE_MANIFEST.themes[0], { slug: "beta", css: "alpha.css" }],
    });
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("多个 slug 指向同一个 CSS：alpha.css");
  });

  it("fails on duplicate slugs and unsafe resource paths", () => {
    const invalid = {
      v: 1,
      themes: [
        { slug: "alpha", css: "../alpha.css", name: "Alpha", mode: "light" },
        { slug: "alpha", css: "alpha.css", name: "Duplicate", mode: "dark" },
        { slug: "beta", css: "beta.css", name: "Beta", mode: "dark" },
      ],
    };
    const root = createPackage("invalid", invalid);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("slug 重复：alpha");
    expect(result.stderr).toContain("必须是包内安全相对路径");
  });

  it("rejects a manifest-declared resource directory that is a symlink outside themes", (context) => {
    const root = createPackage("symlinked-resource-dir");
    const themes = join(root, "resources", "themes");
    const outside = join(TEMP, "outside-theme-resources");
    rmSync(join(themes, "alpha"), { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "untracked.css"), "body { color: red; }");
    createSymlinkOrSkip(
      outside,
      join(themes, "alpha"),
      process.platform === "win32" ? "junction" : "dir",
      context,
    );

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("符号链接");
    expect(result.stderr).toContain("alpha");
  });

  it("rejects an unmanifested CSS file that is a symlink", (context) => {
    const root = createPackage("symlinked-extra-css");
    const themes = join(root, "resources", "themes");
    createSymlinkOrSkip(join(themes, "alpha.css"), join(themes, "evil.css"), "file", context);

    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("符号链接");
    expect(result.stderr).toContain("evil.css");
  });
});

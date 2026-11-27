// #398：Logo v3 定稿资源与入口引用契约。
// 整体摘要直接锁定设计包的相对路径和逐文件字节，防止重绘、改色、漏档或混入预览 / source。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const publicAssets = [
  "public/apple-touch-icon.png",
  "public/favicon.ico",
  "public/favicon.svg",
  "public/logo.svg",
];

function filesUnder(relativeDir: string): string[] {
  const absoluteDir = resolve(root, relativeDir);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push(absolute);
    }
  };
  walk(absoluteDir);
  return files;
}

function relativePosix(absolute: string): string {
  return absolute.slice(root.length + 1).split(sep).join("/");
}

function pngSize(relativePath: string): [number, number] {
  const png = readFileSync(resolve(root, relativePath));
  expect(png.subarray(1, 4).toString("ascii"), `${relativePath} 必须是 PNG`).toBe("PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe("#398 Logo v3：定稿资源完整性", () => {
  it("52 个平台图标 + 4 个 Web 资源 + 12 个品牌素材与设计包逐字节一致", () => {
    const files = [
      ...filesUnder("src-tauri/icons"),
      ...filesUnder("brand"),
      ...publicAssets.map((path) => resolve(root, path)),
    ]
      .map((path) => ({ path, relative: relativePosix(path) }))
      .sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));

    expect(files.map(({ relative }) => relative)).toHaveLength(68);
    const hash = createHash("sha256");
    for (const { path, relative } of files) {
      hash.update(relative, "utf8");
      hash.update(Buffer.from([0]));
      hash.update(readFileSync(path));
      hash.update(Buffer.from([0]));
    }
    expect(hash.digest("hex")).toBe("cf81f42336f906bc1a3a3ab3954ac268374f7b7ab8744f39346e0f645d077d85");
  });

  it("Windows ICO 含 16 / 24 / 32 / 48 / 64 / 256 六档方形图标", () => {
    const ico = readFileSync(resolve(root, "src-tauri/icons/icon.ico"));
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const count = ico.readUInt16LE(4);
    expect(count).toBe(6);
    const sizes = Array.from({ length: count }, (_, index) => {
      const offset = 6 + index * 16;
      const width = ico[offset] || 256;
      const height = ico[offset + 1] || 256;
      expect(height, `ICO 第 ${index + 1} 档应为方形`).toBe(width);
      return width;
    });
    expect(sizes.sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 256]);
  });

  it("macOS ICNS 保留定稿的十一档，不被重新生成", () => {
    const icns = readFileSync(resolve(root, "src-tauri/icons/icon.icns"));
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const types: string[] = [];
    for (let offset = 8; offset < icns.length; ) {
      const length = icns.readUInt32BE(offset + 4);
      expect(length).toBeGreaterThanOrEqual(8);
      expect(offset + length).toBeLessThanOrEqual(icns.length);
      types.push(icns.subarray(offset, offset + 4).toString("ascii"));
      offset += length;
    }
    expect(types).toEqual([
      "icp4",
      "icp5",
      "icp6",
      "ic07",
      "ic08",
      "ic09",
      "ic10",
      "ic11",
      "ic12",
      "ic13",
      "ic14",
    ]);
  });

  it("应用母版为 1024×1024，Apple touch icon 为 180×180", () => {
    expect(pngSize("brand/app-icon.png")).toEqual([1024, 1024]);
    expect(pngSize("brand/app-icon-macos.png")).toEqual([1024, 1024]);
    expect(pngSize("public/apple-touch-icon.png")).toEqual([180, 180]);
  });
});

describe("#398 Logo v3：入口接线与范围约束", () => {
  it("index.html 同时接入 SVG favicon、ICO 回退和 Apple touch icon", () => {
    const source = readFileSync(resolve(root, "index.html"), "utf8").replace(
      /<script\b[^>]*>[\s\S]*?<\/script>/gi,
      "",
    );
    const html = new DOMParser().parseFromString(source, "text/html");
    const icons = [...html.querySelectorAll('link[rel="icon"]')].map((link) => ({
      href: link.getAttribute("href"),
      type: link.getAttribute("type"),
      sizes: link.getAttribute("sizes"),
    }));
    expect(icons).toEqual([
      { href: "/favicon.svg", type: "image/svg+xml", sizes: null },
      { href: "/favicon.ico", type: null, sizes: "any" },
    ]);
    expect(html.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
      "/apple-touch-icon.png",
    );
    expect(html.querySelector('link[href="/vite.svg"]')).toBeNull();
  });

  it("README 顶部使用明暗自适应横版 Logo，且保留原主标题", () => {
    const readme = readFileSync(resolve(root, "README.md"), "utf8");
    expect(readme).toMatch(
      /^<p align="center">\r?\n  <picture>\r?\n    <source media="\(prefers-color-scheme: dark\)" srcset="brand\/logo-horizontal-dark\.png">\r?\n    <img src="brand\/logo-horizontal-light\.png" width="380" alt="InklingMD">\r?\n  <\/picture>\r?\n<\/p>\r?\n\r?\n# InklingMD/,
    );
  });

  it("Tauri 图标配置不变，仅清理已无引用的 Vite 图标", () => {
    const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
    expect(config.bundle.icon).toEqual([
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico",
    ]);
    expect(existsSync(resolve(root, "public/vite.svg"))).toBe(false);
    expect(existsSync(resolve(root, "public/tauri.svg"))).toBe(true);
  });
});

#!/usr/bin/env node
/**
 * Verify an extracted application package contains the exact bundled theme set.
 *
 * Usage: node scripts/check-bundled-theme-artifact.mjs <extracted-package-root> <source-manifest>
 * The workflow extracts each release artifact independently before invoking this script.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const [packageRootArg, expectedManifestArg] = process.argv.slice(2);
if (!packageRootArg || !expectedManifestArg) {
  console.error("用法：node scripts/check-bundled-theme-artifact.mjs <解包目录> <仓库源清单>");
  process.exit(2);
}

const packageRoot = resolve(packageRootArg);
const expectedManifestPath = resolve(expectedManifestArg);
const errors = [];

function fail(message) {
  errors.push(message);
}

function readManifest(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} 无法读取或不是合法 JSON：${error.message}`);
    return undefined;
  }
}

function findThemeManifests(root) {
  const found = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      fail(`无法枚举解包目录 ${dir}：${error.message}`);
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "manifest.json" && basename(dirname(path)) === "themes") {
        found.push(path);
      }
    }
  };
  visit(root);
  return found;
}

function validateEntries(manifest, label) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.themes)) {
    fail(`${label} 缺少 themes 数组`);
    return [];
  }
  const bySlug = new Map();
  const cssPaths = new Set();
  for (const [index, entry] of manifest.themes.entries()) {
    if (!entry || typeof entry !== "object" || typeof entry.slug !== "string" || !entry.slug.trim()) {
      fail(`${label} themes[${index}] 缺少有效 slug`);
      continue;
    }
    if (bySlug.has(entry.slug)) {
      fail(`${label} slug 重复：${entry.slug}`);
      continue;
    }
    if (typeof entry.css !== "string" || !entry.css.trim()) {
      fail(`${label} ${entry.slug} 缺少有效 css 路径`);
      continue;
    }
    if (entry.dir !== undefined && typeof entry.dir !== "string") {
      fail(`${label} ${entry.slug} 的 dir 必须是字符串`);
      continue;
    }
    const cssPath = entry.css.replaceAll("\\", "/");
    if (cssPaths.has(cssPath)) fail(`${label} 多个 slug 指向同一个 CSS：${cssPath}`);
    cssPaths.add(cssPath);
    bySlug.set(entry.slug, entry);
  }
  return [...bySlug.values()];
}

function safeRelative(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} 必须是非空相对路径`);
    return undefined;
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized) || segments.some((part) => part === ".." || part === "")) {
    fail(`${label} 必须是包内安全相对路径：${value}`);
    return undefined;
  }
  return segments.join(sep);
}

function findSymlinkComponent(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return relative(root, current).split(sep).join("/");
      }
    } catch {
      // Leave missing or unreadable paths to the existing stat-based diagnostics.
      return undefined;
    }
  }
  return undefined;
}

function listCssFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`主题目录包含符号链接：${relative(root, path).split(sep).join("/")}`);
      }
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".css")) {
        files.push(relative(root, path).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return files.sort();
}

let actualThemesRoot;
const manifests = findThemeManifests(packageRoot);
if (manifests.length !== 1) {
  fail(`解包产物应恰有一个 themes/manifest.json，实际找到 ${manifests.length} 个`);
} else {
  actualThemesRoot = dirname(manifests[0]);
}

const expectedManifest = readManifest(expectedManifestPath, "仓库源清单");
const expectedEntries = validateEntries(expectedManifest, "仓库源清单");
let actualEntries = [];
if (manifests.length === 1) {
  const actualManifest = readManifest(manifests[0], "包内清单");
  actualEntries = validateEntries(actualManifest, "包内清单");
}

if (expectedManifest && actualThemesRoot) {
  const expectedBySlug = new Map(expectedEntries.map((entry) => [entry.slug, entry]));
  const actualBySlug = new Map(actualEntries.map((entry) => [entry.slug, entry]));
  for (const slug of expectedBySlug.keys()) {
    if (!actualBySlug.has(slug)) fail(`包内清单缺少仓库登记的主题 slug：${slug}`);
  }
  for (const slug of actualBySlug.keys()) {
    if (!expectedBySlug.has(slug)) fail(`包内清单含有仓库未登记的主题 slug：${slug}`);
  }

  const expectedCss = new Set();
  const resourceDirs = [];
  for (const [slug, expected] of expectedBySlug) {
    const actual = actualBySlug.get(slug);
    if (!actual) continue;
    const expectedCssRel = expected.css?.replaceAll("\\", "/");
    const actualCssRel = actual.css?.replaceAll("\\", "/");
    if (actualCssRel !== expectedCssRel) {
      fail(`${slug} 的 css 路径与仓库清单不一致：包内=${String(actual.css)}，仓库=${String(expected.css)}`);
    }
    const expectedDir = expected.dir?.replaceAll("\\", "/");
    const actualDir = actual.dir?.replaceAll("\\", "/");
    if (actualDir !== expectedDir) {
      fail(`${slug} 的 dir 路径与仓库清单不一致：包内=${String(actual.dir)}，仓库=${String(expected.dir)}`);
    }
  }

  for (const entry of actualEntries) {
    const cssRel = safeRelative(entry.css, `${entry.slug}.css`);
    if (cssRel) {
      expectedCss.add(cssRel.split(sep).join("/"));
      const target = resolve(actualThemesRoot, cssRel);
      const symlink = findSymlinkComponent(actualThemesRoot, cssRel);
      const inside = relative(actualThemesRoot, target);
      if (symlink) {
        fail(`${entry.slug}.css 路径包含符号链接：${symlink}`);
      } else if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        fail(`${entry.slug}.css 越出 themes 目录：${entry.css}`);
      } else {
        try {
          if (!statSync(target).isFile()) fail(`包内 CSS 不是文件：${entry.css}`);
        } catch {
          fail(`包内缺少清单声明的 CSS：${entry.css}（slug=${entry.slug}）`);
        }
      }
    }
    if (entry.dir !== undefined) {
      const dirRel = safeRelative(entry.dir, `${entry.slug}.dir`);
      if (dirRel) {
        resourceDirs.push(dirRel.split(sep).join("/"));
        const target = resolve(actualThemesRoot, dirRel);
        const symlink = findSymlinkComponent(actualThemesRoot, dirRel);
        const inside = relative(actualThemesRoot, target);
        if (symlink) {
          fail(`${entry.slug}.dir 路径包含符号链接：${symlink}`);
        } else if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
          fail(`${entry.slug}.dir 越出 themes 目录：${entry.dir}`);
        } else {
          try {
            if (!statSync(target).isDirectory()) fail(`包内资源目录不是目录：${entry.dir}`);
          } catch {
            fail(`包内缺少清单声明的资源目录：${entry.dir}（slug=${entry.slug}）`);
          }
        }
      }
    }
  }

  try {
    const packagedCss = listCssFiles(actualThemesRoot);
    for (const file of packagedCss) {
      const resourceAsset = resourceDirs.some((dir) => file.startsWith(`${dir}/`));
      if (!expectedCss.has(file) && !resourceAsset) fail(`包内存在未由清单登记的 CSS：${file}`);
    }
    for (const file of expectedCss) {
      if (!packagedCss.includes(file)) fail(`清单登记的 CSS 未出现在包内：${file}`);
    }
  } catch (error) {
    fail(`无法完整核对包内 CSS 集合：${error.message}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`✗ ${error}`);
  console.error(`主题包内资源核对失败（${errors.length} 项）`);
  process.exit(1);
}

console.log(`主题包内资源核对通过：${actualEntries.length} 个主题（${actualEntries.map((entry) => entry.slug).join(", ")}）`);

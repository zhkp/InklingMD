#!/usr/bin/env node
/**
 * #307 预装清单校验（发版门禁的一环）：
 *  - `manifest.json` 版本与最小字段集（slug / css / name / mode，可选 dir / hiddenByDefault）；
 *  - slug 唯一、`css` / `dir` 在清单同级目录真实存在（打包遗漏会在这里暴露，而不是到用户机器上才「主题缺失」）；
 *  - 与 #308 的许可登记（`docs/theme-licenses.json`）**两侧 slug 集合一致**（该文件尚未落地 → 跳过并提示）。
 *
 * 用法：node scripts/check-theme-manifest.mjs [--json]
 * 退出码：0 通过；1 校验失败（CI 可据此阻断发版）。
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THEMES_DIR = join(ROOT, "src-tauri", "resources", "themes");
const MANIFEST = join(THEMES_DIR, "manifest.json");
const LICENSE_REGISTRY = join(ROOT, "docs", "theme-licenses.json");
const MANIFEST_VERSION = 1;

const errors = [];
const warnings = [];
const notes = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

function loadJson(path, label) {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`${label} 不是合法 JSON：${e.message}`);
    return undefined;
  }
}

const manifest = loadJson(MANIFEST, "src-tauri/resources/themes/manifest.json");
if (!manifest) {
  if (!existsSync(MANIFEST)) fail("缺少预装清单 src-tauri/resources/themes/manifest.json（#307 新-2 要求随包分发）");
} else {
  if (manifest.v !== MANIFEST_VERSION) fail(`预装清单版本应为 ${MANIFEST_VERSION}，实际 ${String(manifest.v)}`);
  if (!Array.isArray(manifest.themes)) {
    fail("预装清单缺少 themes 数组");
  } else {
    const slugs = new Set();
    manifest.themes.forEach((entry, i) => {
      const where = `themes[${i}]`;
      if (!entry || typeof entry !== "object") return fail(`${where} 不是对象`);
      const { slug, css, dir, name, mode, hiddenByDefault } = entry;
      if (typeof slug !== "string" || !slug.trim()) fail(`${where}.slug 必填且非空`);
      if (typeof css !== "string" || !css.trim()) fail(`${where}.css 必填且非空`);
      if (typeof name !== "string" || !name.trim()) fail(`${where}.name 必填且非空`);
      if (mode !== "light" && mode !== "dark") fail(`${where}.mode 必须是 light / dark`);
      if (hiddenByDefault !== undefined && typeof hiddenByDefault !== "boolean") {
        fail(`${where}.hiddenByDefault 必须是布尔`);
      }
      // 许可字段不允许进运行时清单（留在 #308 的发版登记）
      for (const field of ["license", "attribution", "upstream", "commit"]) {
        if (field in entry) fail(`${where} 不应包含许可字段 ${field}（运行时清单只带必要字段，见 06 §2 新-2）`);
      }
      if (typeof slug === "string" && slug.trim()) {
        if (slugs.has(slug)) fail(`slug 重复：${slug}`);
        slugs.add(slug);
      }
      for (const [field, value] of [
        ["css", css],
        ["dir", dir],
      ]) {
        if (typeof value !== "string" || !value.trim()) continue;
        const target = join(THEMES_DIR, value);
        if (!existsSync(target)) {
          fail(`${where}.${field} 指向的文件不存在：${value}（打包/入库遗漏）`);
        } else if (field === "css" && statSync(target).isDirectory()) {
          fail(`${where}.css 指向的是目录：${value}`);
        } else if (field === "dir" && !statSync(target).isDirectory()) {
          fail(`${where}.dir 指向的不是目录：${value}`);
        }
      }
    });
    notes.push(`预装清单：${manifest.themes.length} 个主题（slug: ${[...slugs].join(", ") || "（空）"}）`);

    // 与 #308 的许可登记对账（两侧 slug 集合必须一致）
    const registry = loadJson(LICENSE_REGISTRY, "docs/theme-licenses.json");
    if (!registry) {
      notes.push("许可登记 docs/theme-licenses.json 尚未落地（#308）→ 本次跳过两侧 slug 对账");
    } else {
      const licensed = new Set(
        (Array.isArray(registry.themes) ? registry.themes : []).map((t) => t?.slug).filter(Boolean),
      );
      for (const slug of slugs) {
        if (!licensed.has(slug)) fail(`预装主题 ${slug} 未登记许可（docs/theme-licenses.json）`);
      }
      for (const slug of licensed) {
        if (!slugs.has(slug)) fail(`许可登记里的 ${slug} 不在预装清单中（两侧集合必须一致）`);
      }
      notes.push(`两侧 slug 对账通过（${licensed.size} 条许可登记）`);
    }
  }
}

if (!existsSync(THEMES_DIR)) {
  warn("src-tauri/resources/themes 目录不存在（预装主题运行时光源副本，06 §2 N13）");
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, notes }, null, 2));
} else {
  for (const n of notes) console.log(`· ${n}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const e of errors) console.error(`✗ ${e}`);
  console.log(errors.length === 0 ? "预装清单校验通过" : `预装清单校验失败（${errors.length} 项）`);
}
process.exit(errors.length === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * #308 §3.3 预装主题的**可执行许可检查**（发版/PR 门禁；不是口头约定）：
 *  1. 每款预装主题必须有归档的 LICENSE 文件（`licenseFile` 指向的文件存在）；
 *  2. `license` ∈ 允许集（`docs/theme-licenses.json#allowed`）；
 *  3. 登记完整：`upstream`（https URL）+ `version` + `commit`（40 位 sha）+ `attribution`；
 *  4. `THIRD-PARTY.md` 与登记一致（每条的 `attribution` 锚点存在）；
 *  5. **两侧 slug 集合一致**：发版登记（`docs/theme-licenses.json`）↔ 运行时 `$RESOURCE/themes/manifest.json`
 *     —— 防「注册了但没打包 / 打包了但没注册」；
 *  6. **完整性**：随包 CSS 的字节数与 sha256 必须与登记一致（防「登记与实物漂移」）；
 *  7. **体积预算**（§4.2）：单主题 CSS ≤ 512 KB、单主题资源 ≤ 2 MB、预装总量 ≤ 8 MB；
 *     并**提示**超出 256 KB（快照上限）的文件——超过就不享受「零闪烁」，选型应避免。
 *
 * 用法：`npm run check:theme-licenses`（`--json` 输出机器可读结果）
 * 退出码：0 通过；1 任一不满足（CI 据此阻断）。
 */
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "docs", "theme-licenses.json");
const MANIFEST = join(ROOT, "src-tauri", "resources", "themes", "manifest.json");
const THEMES_DIR = join(ROOT, "src-tauri", "resources", "themes");
const THIRD_PARTY = join(ROOT, "THIRD-PARTY.md");
const SNAPSHOT_LIMIT = 256 * 1024;
const CSS_LIMIT = 512 * 1024;
const ASSETS_LIMIT = 2 * 1024 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;

const errors = [];
const warnings = [];
const notes = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function loadJson(path, label) {
  if (!existsSync(path)) {
    fail(`缺少 ${label}：${path.replace(`${ROOT}/`, "")}`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`${label} 不是合法 JSON：${e.message}`);
    return undefined;
  }
}

const registry = loadJson(REGISTRY, "发版许可登记 docs/theme-licenses.json");
const manifest = loadJson(MANIFEST, "运行时清单 src-tauri/resources/themes/manifest.json");

if (registry && manifest) {
  const allowed = new Set(Array.isArray(registry.allowed) ? registry.allowed : []);
  if (allowed.size === 0) fail("docs/theme-licenses.json 缺少 allowed（允许的 SPDX 许可证集）");
  const themes = Array.isArray(registry.themes) ? registry.themes : [];
  if (themes.length === 0) warn("发版登记里没有任何预装主题（#308 验收要求 ≥2）");
  const thirdParty = existsSync(THIRD_PARTY) ? readFileSync(THIRD_PARTY, "utf8") : "";
  if (!thirdParty) fail("缺少 THIRD-PARTY.md（第三方署名清单）");

  const slugs = new Set();
  let totalBytes = 0;
  for (const [i, t] of themes.entries()) {
    const where = `themes[${i}]${t?.slug ? `(${t.slug})` : ""}`;
    if (!t || typeof t !== "object") {
      fail(`${where} 不是对象`);
      continue;
    }
    if (typeof t.slug !== "string" || !t.slug.trim()) fail(`${where}.slug 必填且非空`);
    if (slugs.has(t.slug)) fail(`slug 重复：${t.slug}`);
    slugs.add(t.slug);
    if (t.id !== `bundled:${t.slug}`) fail(`${where}.id 必须等于 "bundled:" + slug`);
    if (typeof t.upstream !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(t.upstream)) {
      fail(`${where}.upstream 必须是可解析的上游仓库 URL（https://github.com/<owner>/<repo>）`);
    }
    if (typeof t.version !== "string" || !t.version.trim()) fail(`${where}.version 必填（上游 tag/release）`);
    if (typeof t.commit !== "string" || !/^[0-9a-f]{40}$/.test(t.commit)) {
      fail(`${where}.commit 必须是 40 位 sha（精确到 commit，不用 branch/tag 漂移）`);
    }
    if (!allowed.has(t.license)) {
      fail(`${where}.license=${t.license} 不在允许集内（隐含「禁止再分发」的主题不得内置，见 07 §3.2）`);
    }
    // ① LICENSE 归档副本
    if (typeof t.licenseFile !== "string" || !t.licenseFile.trim()) {
      fail(`${where}.licenseFile 必填（需归档上游 LICENSE 副本）`);
    } else if (!existsSync(join(ROOT, t.licenseFile))) {
      fail(`${where}.licenseFile 指向的文件不存在：${t.licenseFile}`);
    }
    // ④ 署名锚点（明暗变体指向**同一上游作品**的小节，故按 attribution 的 fragment 查，而不是按主题自身 slug）
    if (typeof t.attribution !== "string" || !t.attribution.startsWith("THIRD-PARTY.md#")) {
      fail(`${where}.attribution 必须形如 "THIRD-PARTY.md#<section>"`);
    } else {
      const fragment = t.attribution.slice("THIRD-PARTY.md#".length);
      if (!fragment.trim()) fail(`${where}.attribution 的锚点不能为空`);
      else if (!new RegExp(`^#{2,4} \\s*${escapeRegExp(fragment)}\\s*$`, "m").test(thirdParty)) {
        fail(`${where}.attribution 指向的锚点不存在于 THIRD-PARTY.md：### ${fragment}`);
      }
    }
    // ⑥ 完整性：随包实物与登记一致
    if (typeof t.shippedCss !== "string" || !t.shippedCss.trim()) {
      fail(`${where}.shippedCss 必填（随包 CSS 的相对路径）`);
    } else if (!existsSync(join(ROOT, t.shippedCss))) {
      fail(`${where}.shippedCss 指向的文件不存在：${t.shippedCss}`);
    } else {
      const buf = readFileSync(join(ROOT, t.shippedCss));
      totalBytes += buf.byteLength;
      if (typeof t.bytes === "number" && t.bytes !== buf.byteLength) {
        fail(`${where}.bytes 与实物不符：登记 ${t.bytes}，实际 ${buf.byteLength}（${t.shippedCss}）`);
      }
      if (typeof t.sha256 === "string" && t.sha256.length > 0) {
        const digest = createHash("sha256").update(buf).digest("hex");
        if (digest !== t.sha256) fail(`${where}.sha256 与实物不符（${t.shippedCss}）`);
      }
      // ⑦ 体积预算
      if (buf.byteLength > CSS_LIMIT) {
        fail(`${where} 单主题 CSS ${(buf.byteLength / 1024).toFixed(1)} KB 超上限 ${CSS_LIMIT / 1024} KB`);
      } else if (buf.byteLength > SNAPSHOT_LIMIT) {
        warn(`${where} CSS ${(buf.byteLength / 1024).toFixed(1)} KB 超过快照上限 256 KB → 不享受「零闪烁」（选型应避免）`);
      }
    }
    // ⑦ 资源预算：同名资源目录（不允许有例外，超了就是超了）
    const cssBase = typeof t.shippedCss === "string" ? t.shippedCss.replace(/\.css$/, "") : "";
    if (cssBase && existsSync(join(ROOT, cssBase)) && statSync(join(ROOT, cssBase)).isDirectory()) {
      const size = dirSize(join(ROOT, cssBase));
      if (size > ASSETS_LIMIT) {
        fail(`${where} 同名资源目录 ${(size / 1024 / 1024).toFixed(2)} MB 超上限 ${ASSETS_LIMIT / 1024 / 1024} MB`);
      }
    }
    if (Array.isArray(t.assets)) {
      for (const a of t.assets) {
        if (!a || typeof a.license !== "string" || !a.license.trim()) {
          fail(`${where}.assets[] 每项必须有 license（字体/图片同样要过许可证，07 §3.2）`);
        }
      }
    }
  }

  // ⑤ 两侧 slug 集合一致
  const manifestSlugs = new Set((manifest.themes ?? []).map((m) => m?.slug).filter(Boolean));
  for (const slug of slugs) {
    if (!manifestSlugs.has(slug)) fail(`预装主题 ${slug} 已登记许可但**未打进运行时清单**（注册了没打包）`);
  }
  for (const slug of manifestSlugs) {
    if (!slugs.has(slug)) fail(`运行时清单里的 ${slug} **没有许可登记**（打包了没注册）`);
  }

  if (totalBytes > TOTAL_LIMIT) {
    fail(`预装主题总量 ${(totalBytes / 1024).toFixed(1)} KB 超上限 ${TOTAL_LIMIT / 1024 / 1024} MB`);
  }
  notes.push(`预装主题 ${themes.length} 款 / 随包 CSS 合计 ${(totalBytes / 1024).toFixed(1)} KB（上限 ${TOTAL_LIMIT / 1024 / 1024} MB）`);
  notes.push(`两侧 slug 集合一致：${[...slugs].join(", ")}`);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dirSize(dir) {
  let size = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    size += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return size;
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, notes }, null, 2));
} else {
  for (const n of notes) console.log(`· ${n}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
  for (const e of errors) console.error(`✗ ${e}`);
  console.log(errors.length === 0 ? "预装主题许可检查通过" : `预装主题许可检查失败（${errors.length} 项）`);
}
process.exit(errors.length === 0 ? 0 : 1);

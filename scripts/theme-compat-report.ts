/**
 * #306 兼容性矩阵证据生成器（开发者工具，也是本层纯函数的第一处真实调用链路）。
 *
 * 用法（vite-node 提供 TS 直跑）：
 *   node node_modules/vite-node/vite-node.mjs scripts/theme-compat-report.ts <主题目录> [--md]
 *
 * 做什么：
 * 1. 把目录下每个 `.css` 主题喂给 `rewrite()`（含本地 `@import` 预读内联），输出：
 *    文件名 → themeId / hash / 规则数变化 / 诊断分类统计；
 * 2. 汇总「丢弃的选择器原因」「映射/降级的类名」「全局名称前缀化数量」等，
 *    直接对应用户可见的兼容性矩阵行（`docs/typora-compatibility-matrix.md`）；
 * 3. 校验产物不变量：不含 `@import`、不含指向 asset 的样式表、不含 `.cm-*` 选择器、前缀恒为 2 段。
 *
 * ⚠️ 真实第三方主题 CSS **不入库**（许可合规归 #308）；本脚本只是测量工具，
 * 输出用于人工登记矩阵，可随时对任意主题目录重跑。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { rewriteWithReport } from "../src/theme/typora/rewrite";
import { EDITOR_PREFIX } from "../src/theme/typora/selector";
import type { ThemeDiagnostic } from "../src/theme/typora/types";

const dir = resolve(process.argv[2] ?? "tmp/themes-probe");
const asMarkdown = process.argv.includes("--md");

/** 预读本地 `@import` 目标（相对主题文件目录），供内联使用；远程/绝对不读。 */
function preloadImports(entry: string, seen = new Set<string>()): Map<string, string> {
  const sources = new Map<string, string>();
  const visit = (file: string, depth: number) => {
    if (depth > 8) return;
    let css: string;
    try {
      css = readFileSync(file, "utf8");
    } catch {
      return;
    }
    const re = /@import\s+(?:url\(\s*)?["']([^"')]+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(css))) {
      const target = m[1];
      if (/^(data|blob|https?|asset|file):/i.test(target) || target.startsWith("/")) continue;
      const abs = resolve(dirname(file), target);
      if (seen.has(abs.toLowerCase())) continue;
      seen.add(abs.toLowerCase());
      try {
        sources.set(abs, readFileSync(abs, "utf8"));
        visit(abs, depth + 1);
      } catch {
        // 目标缺失（真实主题包常带可选资源）：不预读 → 流水线会丢弃该 @import 并登记
      }
    }
  };
  visit(entry);
  return sources;
}

const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".css")).sort();
if (files.length === 0) {
  console.error(`目录下没有 .css 主题：${dir}`);
  process.exit(1);
}

const rows: string[] = [];
const totals = new Map<string, number>();
const droppedSelectors = new Map<string, string>();
const mappedClasses = new Map<string, string>();
let violations: string[] = [];

for (const file of files) {
  const full = join(dir, file);
  const css = readFileSync(full, "utf8");
  const diagnostics: ThemeDiagnostic[] = [];
  const themeId = `user:${file.replace(/\.css$/i, "").toLowerCase()}`;
  const result = rewriteWithReport(css, {
    themeId,
    themeDir: dirname(full),
    toAssetUrl: (abs) => `http://asset.localhost/${encodeURIComponent(abs)}`,
    importSources: preloadImports(full),
    assetRoot: dir,
    onDiagnostic: (d) => diagnostics.push(d),
  });

  const count = (kind: ThemeDiagnostic["kind"]) => diagnostics.filter((d) => d.kind === kind).length;
  for (const d of diagnostics) totals.set(d.kind, (totals.get(d.kind) ?? 0) + 1);
  for (const d of diagnostics) {
    if (d.kind === "dropped-selector") droppedSelectors.set(d.reason, (droppedSelectors.get(d.reason) ?? 0) + 1);
    if (d.kind === "scoped-root") mappedClasses.set(d.reason.slice(0, 60), (mappedClasses.get(d.reason) ?? 0) + 1);
  }

  // 产物不变量（**先剥注释**：主题里的 `/* .CodeMirror-xxx { */` 之类注释文本不是规则；
  // 注释本身是作者/许可信息，必须原样保留）
  const ruleText = result.css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bad = [
    [/@import/, "产物含 @import（必须已内联）"],
    [/asset\.localhost[^"')]*\.css/, "产物含指向 asset 的样式表引用"],
    [/\.cm-[a-z]/, "产物含 .cm-* 选择器（G1 要求丢弃）"],
    [/\.CodeMirror/, "产物含 .CodeMirror* 选择器（G1 要求丢弃）"],
    [/\.editor\s|\.ProseMirror/, "产物含 3–4 段前缀（I1 要求恒 2 段）"],
  ] as const;
  for (const [re, msg] of bad) if (re.test(ruleText)) violations.push(`${file}: ${msg}`);

  const selectorCount = (result.css.match(/{/g) ?? []).length;
  // §D1 耗时实测：同一主题重复 9 次取中位数（纯解析 + 改写 + 序列化）
  const times: number[] = [];
  for (let i = 0; i < 9; i++) {
    const t0 = performance.now();
    rewriteWithReport(css, {
      themeId,
      themeDir: dirname(full),
      toAssetUrl: (abs) => `http://asset.localhost/${encodeURIComponent(abs)}`,
      importSources: preloadImports(full),
      assetRoot: dir,
    });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  rows.push(
    [
      file,
      themeId,
      result.hash.slice(0, 8),
      String((css.match(/{/g) ?? []).length),
      String(selectorCount),
      `${times[Math.floor(times.length / 2)].toFixed(2)}ms`,
      String(count("scoped-root")),
      String(count("dropped-selector")),
      String(count("rejected-token")),
      String(count("prefixed-name")),
      String(count("rewritten-ref")),
      String(count("rewritten-url")),
      String(count("inlined-import")),
      String(count("dropped-import")),
      String(count("stripped-important")),
      String(count("dropped-at-rule")),
    ].join(" | "),
  );
}

if (asMarkdown) {
  console.log(`| 主题文件 | themeId | hash | 输入块 | 输出规则 | 改写中位耗时 | 根级收敛 | 选择器丢弃 | 变量拒绝 | 名称前缀 | 引用重写 | URL 重写 | @import 内联 | @import 丢弃 | !important 剥离 | at-rule 丢弃 |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r} |`);
  console.log("\n诊断分类合计：");
  for (const [k, v] of [...totals.entries()].sort((a, b) => b[1] - a[1])) console.log(`- ${k}: ${v}`);
  console.log("\n丢弃选择器的原因分布（矩阵「不支持/降级」行来源）：");
  for (const [reason, n] of [...droppedSelectors.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`- ${n} 条 · ${reason}`);
} else {
  console.log(`主题目录：${dir}（${files.length} 个 .css）\n`);
  for (const r of rows) console.log(r);
  console.log("\n诊断分类合计：", Object.fromEntries([...totals.entries()].sort((a, b) => b[1] - a[1])));
  console.log("\n丢弃原因分布：");
  for (const [reason, n] of [...droppedSelectors.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${n} 条 · ${reason}`);
}

console.log(`\n前缀恒为 2 段：${EDITOR_PREFIX}`);
if (violations.length > 0) {
  console.error("\n❌ 产物不变量被破坏：");
  for (const v of violations) console.error("  - " + v);
  process.exit(1);
}
console.log("✅ 产物不变量通过（无 @import / 无 asset 样式表 / 无 .cm-* / 前缀恒 2 段）");

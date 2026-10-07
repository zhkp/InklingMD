#!/usr/bin/env node
/**
 * #224 S16（N16/N17/A-5）：构建产物级层化断言。
 *
 * 必须在「清空 dist → vite build」之后运行（package.json 的 check:build-layers
 * 负责清目录；CI 同此顺序），不得对陈旧产物断言。
 *
 * 检查项：
 *  ① dist/assets/*.css 恰好 3 个（index / vendor_milkdown / vendor_katex）；
 *  ② 每个资产用 postcss 解析后，顶层规则只能是 CSSLayerBlockRule /
 *     CSSLayerStatementRule，且**层名必须恰为 `base`**（防插件把 vendor 包成
 *     `@layer vendor` 等其它名字——那样「未分层=0」仍成立却不满足 G5 层序）；
 *  ③ 不含残留 @charset / 外链 @import；
 *  ④ vendor_katex 单列存在、完全层化、层内含 @font-face（KaTeX 20 条同源字体）；
 *  ⑤ dist/index.html 的 @layer statement 位于所有样式表之前；
 *  ⑥ CSS 资产为压缩单行形态，且 @layer 块结构在压缩后保留（esbuild 不改写层序）。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import postcss from "postcss";

const dist = resolve(process.cwd(), "dist");
if (!existsSync(dist)) {
  console.error("dist/ 不存在：请先执行清空 + vite build（pnpm check:build-layers）");
  process.exit(1);
}

const failures = [];
const fail = (msg) => failures.push(msg);

const cssFiles = readdirSync(resolve(dist, "assets")).filter((f) => f.endsWith(".css"));

// ① 数量
if (cssFiles.length !== 3) {
  fail(`CSS 资产数应为 3（index/vendor_milkdown/vendor_katex），实际 ${cssFiles.length}：${cssFiles.join(", ")}`);
}
for (const chunk of ["index", "vendor_milkdown", "vendor_katex"]) {
  if (!cssFiles.some((f) => f.startsWith(`${chunk}-`) && f.endsWith(".css"))) {
    fail(`缺少 ${chunk} CSS 资产`);
  }
}

for (const file of cssFiles) {
  const css = readFileSync(resolve(dist, "assets", file), "utf8");
  const ast = postcss.parse(css); {
    // ② 顶层规则只能是带 layer 名的 @layer（块或 statement），且层名必须恰为 base
    ast.each((node) => {
      if (node.type !== "atrule" || node.name !== "layer") {
        fail(`${file} 存在未分层顶层节点：${node.type} ${node.name ?? ""} ${node.selector ?? ""}`.trim());
        return;
      }
      const layerNames = node.params.replace(/\s/g, "");
      if (layerNames !== "base") {
        fail(`${file} 存在非 base 层：@layer ${node.params}（G5 要求 base 入门清单全部包入 base）`);
      }
    });
    // ③ 残留 @charset / @import
    ast.walkAtRules("charset", () => fail(`${file} 残留 @charset`));
    ast.walkAtRules("import", (r) => fail(`${file} 残留未内联 @import：${r.params}`));
    // ⑥ 压缩形态：整体不应含多行未压缩缩进（允许 sourcemap 外无换行）
    if ((css.match(/\n/g) ?? []).length > 2) {
      fail(`${file} 看起来不是压缩产物（${css.length} 字节却含多行），压缩可能被关闭/改写`);
    }
  }
}

// ④ vendor_katex：层块内必须含 @font-face 且数量为 20
const katexCss = cssFiles.find((f) => f.startsWith("vendor_katex-"));
if (katexCss) {
  const ast = postcss.parse(readFileSync(resolve(dist, "assets", katexCss), "utf8"));
  let fontFaceCount = 0;
  ast.walkAtRules("font-face", () => fontFaceCount++);
  if (fontFaceCount !== 20) {
    fail(`vendor_katex.css 层内 @font-face 应为 20 条（KaTeX 同名字体），实际 ${fontFaceCount}`);
  }
  // @font-face 必须在 @layer 块内（完全层化）
  ast.walkAtRules("font-face", (rule) => {
    let p = rule.parent;
    while (p && p.type !== "root") {
      if (p.type === "atrule" && p.name === "layer") return;
      p = p.parent;
    }
    fail("vendor_katex.css 存在 @layer 块之外的 @font-face");
  });
}

// ⑤ index.html statement 位于样式表之前
const indexHtml = readFileSync(resolve(dist, "index.html"), "utf8");
const statementIdx = indexHtml.indexOf("@layer base, theme, user");
const linkStyleIdx = indexHtml.search(/<link[^>]+rel=["']stylesheet["']/);
if (statementIdx === -1) fail("dist/index.html 缺少层序 statement");
if (linkStyleIdx !== -1 && statementIdx > linkStyleIdx) {
  fail("dist/index.html 层序 statement 必须位于所有 <link rel=stylesheet> 之前");
}

if (failures.length) {
  console.error("S16 构建产物层化断言失败：");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`S16 OK：${cssFiles.length} 个 CSS 资产完全层化，statement 位置正确，压缩保留 @layer。`);

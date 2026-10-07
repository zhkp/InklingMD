/**
 * #306 兼容层入口：`rewrite(css, ctx): string`（接口冻结，纯函数、不碰 DOM）。
 *
 * 流水线顺序（顺序本身是契约，改动即需评审）：
 *   0. **规范化**（剥 BOM + 剥 `@charset` + 统一 LF）→ 内容 hash 基于规范化文本（N11-1/N12）
 *   1. 解析（失败 → **整包拒绝**：返回空串 + `parse-error` 诊断，绝不注入半解析产物）
 *   2. **`@import` 内联**（本地读取内联；远程/绝对/超深度/循环 → 丢弃并登记，P1-6）
 *   3. **全局名称**（I3/N9）：先建集合、再加前缀；`@property` 丢弃（N10）
 *   4. **选择器三分类前缀收敛**（§C1/§C2，结构化改写）
 *   5. **声明处置**：G8 变量白名单拒绝 + G12 剥 `!important` + §C9 `url()` 重写
 *   6. 序列化（**不含** `@layer theme { }` 包裹 —— 那是 #225 的注入职责，见 00 §5.2）
 */
import { parse, type Declaration, type Root } from "postcss";
import { hashThemeCss, normalizeThemeCss } from "./normalize";
import { EDITOR_PREFIX, rewriteSelectorList } from "./selector";
import {
  classifyToken,
  isRejectedToken,
  loadTokenWhitelist,
  privateTokenDiagnostic,
  rejectedTokenDiagnostic,
} from "./tokens";
import { inlineImports, rewriteUrlsInValue } from "./assets";
import { collectGlobalNames, prefixGlobalNames } from "./global-names";
import { defaultPathApi } from "./path";
import { collectDiagnostics, type ThemeDiagnostic, type ThemeRewriteContext } from "./types";

/** 主题作用域前缀（全局名称用）：`themeId` 的短哈希，无需碰撞检测。 */
export function themePrefix(themeId: string): string {
  return `t${hashThemeCss(themeId).slice(0, 8)}`;
}

/** 允许透传的条件规则（递归改写其内部规则）。 */
const CONDITION_AT_RULES = new Set(["media", "supports", "container"]);

/** 明确丢弃的 at-rule（含登记原因）。 */
const DROPPED_AT_RULES: Record<string, string> = {
  layer: "主题自带 @layer 会注入到应用的层命名空间，破坏 base/theme/user 层序 → 丢弃",
  namespace: "@namespace 与单文件样式表注入模型不兼容（无作用域、无对应宿主）→ 丢弃",
  page: "@page 属打印页面外观（窗口级），本层不覆盖 → 丢弃",
  charset: "@charset 属表首限定 at-rule（第 0 步已剥表首形态），文件中部残留即非法 → 丢弃",
};

export interface RewriteResult {
  css: string;
  hash: string;
  diagnostics: ThemeDiagnostic[];
  /** 是否整包拒绝（解析失败） */
  rejected: boolean;
}

/** 带报告版本（矩阵生成 / 单测 / E2E harness 用）。 */
export function rewriteWithReport(css: string, ctx: ThemeRewriteContext): RewriteResult {
  const collector = collectDiagnostics();
  const report = (d: ThemeDiagnostic) => {
    collector.onDiagnostic(d);
    ctx.onDiagnostic?.(d);
  };

  const normalized = normalizeThemeCss(css);
  for (const d of normalized.diagnostics) report(d);
  const hash = hashThemeCss(normalized.css);

  let root: Root;
  try {
    root = parse(normalized.css);
  } catch (error) {
    // C7：解析失败 → 整包拒绝（不注入半解析产物）
    report({
      kind: "parse-error",
      target: ctx.themeId,
      reason: `主题 CSS 解析失败（${(error as Error).message}）→ 整包拒绝（不注入任何规则）`,
    });
    return { css: "", hash, diagnostics: collector.diagnostics, rejected: true };
  }

  const path = ctx.path ?? defaultPathApi;
  const whitelist = ctx.whitelist ?? loadTokenWhitelist();

  // ② @import 内联（本地读取内联；其余丢弃并登记）
  inlineImports(
    root,
    {
      ctx,
      importSources: ctx.importSources ?? new Map<string, string>(),
      maxDepth: ctx.maxImportDepth ?? 8,
      report,
    },
    0,
    new Set<string>(),
  );

  // ③ 全局名称（I3）：先建集合，再加前缀；@property 丢弃
  const sets = collectGlobalNames(root);
  prefixGlobalNames(root, { prefix: themePrefix(ctx.themeId), sets, report });

  // ④⑤ 规则选择器 + 声明
  const processDeclarations = (decl: Declaration, wasRootScoped: boolean) => {
    // G12：仅 theme 层剥 !important（user 层不剥 —— 见 00 G12/N3）
    if (decl.important) {
      decl.important = false;
      report({
        kind: "stripped-important",
        target: `${decl.prop}: !important`,
        reason:
          "G12：@layer 下 !important 的层间优先级是反的（base 反压 theme）→ 仅 theme 层剥离并登记为已知差异",
      });
    }

    // G8：基础变量 / --shell-* 的赋值被拒绝
    if (decl.prop.startsWith("--")) {
      if (isRejectedToken(decl.prop, whitelist)) {
        report(rejectedTokenDiagnostic(decl.prop, classifyToken(decl.prop, whitelist)));
        decl.remove();
        return;
      }
      if (wasRootScoped && classifyToken(decl.prop, whitelist) === "private") {
        report(privateTokenDiagnostic(decl.prop, EDITOR_PREFIX));
      }
    }

    // §C9：资源 url() → convertFileSrc 绝对 URL
    if (decl.value.includes("url(")) {
      decl.value = rewriteUrlsInValue(decl.value, {
        themeDir: ctx.themeDir,
        toAssetUrl: ctx.toAssetUrl,
        path,
        report,
        root: ctx.assetRoot,
      });
    }
  };

  root.walkRules((rule) => {
    // `@keyframes` 内的「规则」是 `0%` / `from` 这类步进选择器，必须跳过
    const parent = rule.parent;
    if (parent && parent.type === "atrule" && parent.name === "keyframes") return;

    const rewritten = rewriteSelectorList(rule.selector, report);
    if (rewritten === null) {
      rule.remove();
      return;
    }
    const wasRootScoped = rewritten === EDITOR_PREFIX;
    rule.selector = rewritten;
    rule.walkDecls((decl) => processDeclarations(decl, wasRootScoped));
  });

  // `@font-face` 这类 at-rule 的声明**直接**挂在 at-rule 下（不在 rule 里），必须单独处理
  root.walkAtRules((atRule) => {
    atRule.each((node) => {
      if (node.type === "decl") processDeclarations(node, false);
    });
  });

  // at-rule 处置
  root.walkAtRules((atRule) => {
    const name = atRule.name.toLowerCase();
    if (CONDITION_AT_RULES.has(name)) return;
    if (name === "keyframes" || name === "font-face" || name === "counter-style") return;
    if (name === "include-when-export") {
      // Typora 专有：该块只在「导出（打印/PDF）」时生效 → 忠实翻译为 @media print 并递归改写
      report({
        kind: "dropped-at-rule",
        target: "@include-when-export",
        reason:
          "Typora 专有 at-rule（仅导出时生效）→ 翻译为 @media print，保留「PDF 跟随主题」的语义（P2-7）",
      });
      atRule.name = "media";
      atRule.params = "print";
      return;
    }
    if (DROPPED_AT_RULES[name]) {
      report({
        kind: "dropped-at-rule",
        target: `@${name}`,
        reason: DROPPED_AT_RULES[name],
      });
      atRule.remove();
      return;
    }
    // 其它未知 at-rule：保守丢弃并登记（不做猜测映射）
    report({
      kind: "dropped-at-rule",
      target: `@${name}`,
      reason: `未登记的 at-rule（${atRule.params.slice(0, 40)}）→ 保守丢弃（避免不可预期的作用域外溢）`,
    });
    atRule.remove();
  });

  return {
    css: root.toString(),
    hash,
    diagnostics: collector.diagnostics,
    rejected: false,
  };
}

/** 冻结签名：`rewrite(css, ctx) => string`（诊断经 `ctx.onDiagnostic` 上报）。 */
export function rewrite(css: string, ctx: ThemeRewriteContext): string {
  return rewriteWithReport(css, ctx).css;
}

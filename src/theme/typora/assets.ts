/**
 * #306 §C9（G7-b）+ P1-6：资源 URL 重写与 `@import` 内联。
 *
 * 两个必须同时成立的事实：
 * 1. 主题 CSS 以文档内联 `<style>` 注入 → `url()` 的相对路径按 **document base URL** 解析，
 *    不指向主题目录 → 请求打到 `http://tauri.localhost/…` 得 **404**（CSP 放行也救不回来）。
 *    故必须重写为 `convertFileSrc()` 产出的**绝对 URL**（相对路径按**主题目录**解析）。
 * 2. `style-src` **不含** asset 协议 → 任何指向 asset 的**样式表**（`@import` / `<link>`）都会被拦。
 *    故本地 `@import` 必须**读取并内联**（递归 + 深度上限 + 循环保护），**不得**重写为 asset URL。
 */
import valueParser from "postcss-value-parser";
import { parse, type Root } from "postcss";
import type { ThemeDiagnostic, ThemePathApi, ThemeRewriteContext } from "./types";
import { defaultPathApi, isAbsolutePath, isWithinRoot, normalizePath, resolvePath } from "./path";

/** 已经是「绝对 URL」或协议内联资源：一律不重写。 */
export function isNonRewritableUrl(raw: string): boolean {
  const v = raw.trim();
  if (v === "") return true;
  if (/^(data|blob|http|https|asset|file|tauri):/i.test(v)) return true;
  if (v.startsWith("//")) return true; // 协议相对 URL
  return false;
}

export interface AssetRewriteOptions {
  themeDir: string;
  toAssetUrl: (absPath: string) => string;
  path?: ThemePathApi;
  report: (d: ThemeDiagnostic) => void;
  /** 允许的根（默认 = themeDir）：解析结果越出该根即登记为降级（assetProtocol.scope 会拒） */
  root?: string;
}

/** 单个 `url()` 目标的重写判定（返回替换后的值；不重写时原样返回）。 */
export function rewriteUrlTarget(url: string, opts: AssetRewriteOptions): string {
  if (isNonRewritableUrl(url)) return url;
  const path = opts.path ?? defaultPathApi;
  if (isAbsolutePath(url)) {
    // §C9 边界：绝对路径不重写（既可能是系统字体路径，也可能越出 scope）
    opts.report({
      kind: "dropped-url",
      target: url,
      reason: "绝对路径：按 §C9 边界不重写（保留原样，由加载侧决定成败）",
    });
    return url;
  }
  const abs = path.resolve(opts.themeDir, url);
  const root = normalizePath(opts.root ?? opts.themeDir);
  // 越界判据 = **路径边界**比较（不是字符串前缀）：`…/dark-extra/x.png` 不属于根 `…/dark`
  if (!isWithinRoot(normalizePath(abs), root)) {
    opts.report({
      kind: "dropped-url",
      target: url,
      reason: `相对路径解析后越出主题目录（${abs}）→ 降级为不加载（assetProtocol.scope 会拒绝）`,
    });
    return url;
  }
  const assetUrl = opts.toAssetUrl(abs);
  opts.report({
    kind: "rewritten-url",
    target: url,
    reason: `相对路径按主题目录解析并重写为 asset 绝对 URL（${assetUrl}）`,
  });
  return assetUrl;
}

/**
 * 重写一条声明值里的全部 `url()`（覆盖 `background*` / `border-image` / `mask` /
 * `list-style-image` / `cursor` / `image-set()` / `@font-face src` 多候选）。
 * `local(...)` 不会被触碰（只处理 `url()` 函数）。
 */
export function rewriteUrlsInValue(
  value: string,
  opts: AssetRewriteOptions,
): string {
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
    const first = node.nodes[0];
    if (!first) return;
    const raw = first.value;
    const rewritten = rewriteUrlTarget(raw, opts);
    if (rewritten !== raw) {
      // 不额外加引号：`convertFileSrc` 的产物经 encodeURIComponent，不含空格/括号/引号，
      // 裸 url() 形态安全（保持与原文一致的书写风格）。
      first.value = rewritten;
    }
  });
  return parsed.toString();
}

export interface InlineImportsOptions {
  ctx: ThemeRewriteContext;
  /** 已预读的 `@import` 目标表（绝对路径 → 原文） */
  importSources: ReadonlyMap<string, string>;
  maxDepth: number;
  report: (d: ThemeDiagnostic) => void;
}

/** 从 `@import` 参数里取「URL 之后」的剩余条件（媒体查询 / `layer()` / `supports()`）。 */
function splitImportConditions(rest: string): {
  layer?: string;
  supports?: string;
  media?: string;
} {
  let tail = rest.trim();
  const out: { layer?: string; supports?: string; media?: string } = {};
  const layerMatch = /^layer\s*(?:\(([^)]*)\))?/i.exec(tail);
  if (layerMatch) {
    out.layer = (layerMatch[1] ?? "").trim();
    tail = tail.slice(layerMatch[0].length).trim();
  }
  if (/^supports\s*\(/i.test(tail)) {
    const open = tail.indexOf("(");
    let depth = 0;
    let end = -1;
    for (let i = open; i < tail.length; i++) {
      if (tail[i] === "(") depth += 1;
      else if (tail[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end > 0) {
      out.supports = tail.slice(open + 1, end).trim();
      tail = tail.slice(end + 1).trim();
    }
  }
  if (tail) out.media = tail;
  return out;
}

/**
 * 条件 `@import` 的语义保全（评审阻塞 3）：内联时把条件**包回去**，不允许静默丢弃。
 * `layer()` 无法保留（整包主题统一进 `@layer theme`）→ 登记说明；`@media` / `@supports` 原样包回。
 */
function wrapInlinedNodes(
  nodes: import("postcss").ChildNode[],
  conditions: { layer?: string; supports?: string; media?: string },
  target: string,
  opts: InlineImportsOptions,
): import("postcss").ChildNode[] {
  let inner = nodes;
  const notes: string[] = [];
  if (conditions.media) {
    const media = parse(`@media ${conditions.media} {}`).first as import("postcss").AtRule;
    media.append(inner);
    inner = [media];
    notes.push(`条件 \`${conditions.media}\` 包回 \`@media\``);
  }
  if (conditions.supports) {
    const at = parse(`@supports (${conditions.supports}) {}`).first as import("postcss").AtRule;
    at.append(inner);
    inner = [at];
    notes.push(`条件 \`supports(${conditions.supports})\` 包回 \`@supports\``);
  }
  if (conditions.layer !== undefined) {
    notes.push(
      `\`layer(${conditions.layer})\` 无法保留（整包主题统一进 \`@layer theme\`）→ 忽略该层名并登记`,
    );
  }
  if (notes.length > 0) {
    opts.report({
      kind: "inlined-import",
      target,
      reason: `本地 @import 已内联；条件保全：${notes.join("；")}`,
    });
  }
  return inner;
}

/**
 * 把本地 `@import` 读取并内联（递归）。远程 `@import` 一律丢弃并登记（A1：CSP 不放远程）。
 * 读取失败 / 深度超限 / 循环引用 → 丢弃该 `@import`（不报错、不白屏）。
 */
export function inlineImports(
  root: Root,
  opts: InlineImportsOptions,
  depth = 0,
  seen: Set<string> = new Set(),
): void {
  const path = opts.ctx.path ?? defaultPathApi;
  root.walkAtRules("import", (atRule) => {
    const params = atRule.params.trim();
    const match = /^(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)|"([^"]*)"|'([^']*)')/i.exec(
      params,
    );
    const target = (match?.[1] ?? match?.[2] ?? match?.[3] ?? match?.[4] ?? match?.[5] ?? "").trim();
    // URL 之后的剩余条件（媒体查询 / `layer()` / `supports()`）——内联时必须包回，不得静默丢弃
    const conditions = splitImportConditions(match ? params.slice(match[0].length) : "");
    if (!target) {
      opts.report({
        kind: "dropped-import",
        target: params,
        reason: "@import 形式无法识别 → 丢弃（不猜测目标）",
      });
      atRule.remove();
      return;
    }
    const abs = path.resolve(opts.ctx.themeDir, target);
    if (isNonRewritableUrl(target) || isAbsolutePath(target)) {
      opts.report({
        kind: "dropped-import",
        target,
        reason: "远程 / 绝对 @import：CSP style-src 不含远程与 asset 协议 → 丢弃（本地主题内 @import 才内联）",
      });
      atRule.remove();
      return;
    }
    if (depth >= opts.maxDepth) {
      opts.report({
        kind: "dropped-import",
        target,
        reason: `@import 递归深度超过上限（${opts.maxDepth}）→ 丢弃`,
      });
      atRule.remove();
      return;
    }
    if (seen.has(abs.toLowerCase())) {
      opts.report({
        kind: "dropped-import",
        target,
        reason: "@import 循环引用 → 丢弃该分支",
      });
      atRule.remove();
      return;
    }
    const source = opts.importSources.get(abs) ?? opts.importSources.get(abs.toLowerCase());
    if (source === undefined) {
      opts.report({
        kind: "dropped-import",
        target,
        reason: "本地 @import 未能预读（文件不存在 / 读取失败 / 调用方未提供）→ 丢弃，不重写为 asset URL（P1-6）",
      });
      atRule.remove();
      return;
    }
    try {
      const parsed = parse(source);
      parsed.walkAtRules("charset", (a) => {
        a.remove();
      });
      seen.add(abs.toLowerCase());
      inlineImports(parsed, opts, depth + 1, seen);
      atRule.replaceWith(wrapInlinedNodes(parsed.nodes, conditions, target, opts));
      opts.report({
        kind: "inlined-import",
        target,
        reason: `本地 @import 已读取并内联（深度 ${depth + 1}）`,
      });
    } catch (error) {
      opts.report({
        kind: "dropped-import",
        target,
        reason: `内联失败（${(error as Error).message}）→ 丢弃，不重写为 asset URL`,
      });
      atRule.remove();
    }
  });
}

export { resolvePath };

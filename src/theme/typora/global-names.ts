/**
 * #306 §C10（G6 不变量 I3 / N7 / N9）:全局名称前缀化 + 引用重写。
 *
 * 为什么必须做：`@layer` 只保护「声明（declaration）的层叠」，**不保护全局名称**：
 * - `@keyframes <name>`：同名**按文档顺序取最后一个**（与 layer 无关）→ 主题会把外壳动画换掉；
 * - `@font-face { font-family: <name> }`：family 名文档全局生效 → 外壳字体被替换；
 * - `@property --<name>`：全局注册，无作用域 → 与 G8「私有变量不改名」互斥 → **整个丢弃**（N10）；
 * - `@counter-style <name>`：同类风险。
 *
 * N9 算法（**不得**给引用里每个名称都加前缀）：
 *   ① 先扫描主题建立「主题自身声明的名称集合」K(keyframes) / F(font-face family) / C(counter-style)；
 *   ② 只对集合内成员加主题前缀（`<themePrefix>-<name>`），引用重写也只改 ∈ 集合的名称；
 *      **通用族**（serif/sans-serif/monospace/system-ui…）、**系统族名**（"Segoe UI"…）、
 *      `local(...)` 永不重写；未声明的 `animation: 2s fade-in`（本意复用应用侧）也不重写。
 */
import type { AtRule, Declaration, Root } from "postcss";
import type { ThemeDiagnostic } from "./types";

export interface GlobalNameSets {
  keyframes: Set<string>;
  fontFamilies: Set<string>;
  counterStyles: Set<string>;
}

export interface GlobalNameOptions {
  /** 主题作用域前缀（`themeId` 短哈希），无需碰撞检测 */
  prefix: string;
  sets: GlobalNameSets;
  report: (d: ThemeDiagnostic) => void;
}

/** ① 扫描：收集主题自身声明的全局名称。 */
export function collectGlobalNames(root: Root): GlobalNameSets {
  const keyframes = new Set<string>();
  const fontFamilies = new Set<string>();
  const counterStyles = new Set<string>();
  root.walkAtRules((atRule) => {
    if (atRule.name === "keyframes") keyframes.add(atRule.params.trim());
    else if (atRule.name === "counter-style") counterStyles.add(atRule.params.trim());
    else if (atRule.name === "font-face") {
      atRule.walkDecls("font-family", (decl) => {
        const family = firstFamilyName(decl.value);
        if (family) fontFamilies.add(family);
      });
    }
  });
  return { keyframes, fontFamilies, counterStyles };
}

/** 取 `font-family: X` 里的首个族名（去引号）。 */
function firstFamilyName(value: string): string | null {
  const raw = value.split(",")[0]?.trim();
  if (!raw) return null;
  return raw.replace(/^["']|["']$/g, "").trim() || null;
}

/** 生成前缀化名称（`<prefix>-<name>`）。 */
export function prefixedName(prefix: string, name: string): string {
  return `${prefix}-${name}`;
}

/**
 * ② 前缀化 + 引用重写。返回处理后的 root（就地修改）。
 * `@property` 一律丢弃（N10 推荐路径）。
 */
export function prefixGlobalNames(
  root: Root,
  opts: GlobalNameOptions,
): void {
  const { prefix, sets, report } = opts;

  // 丢弃 @property（N10）：@property 无法作用域收敛，保留会与 G8「私有变量不改名」互斥
  root.walkAtRules("property", (atRule: AtRule) => {
    report({
      kind: "dropped-at-rule",
      target: `@property ${atRule.params.trim()}`,
      reason: "@property 是文档级全局注册、无作用域（N10：推荐整个丢弃，不保留半改状态）",
    });
    atRule.remove();
  });

  // 顶部 at-rule 重命名：@keyframes / @counter-style
  root.walkAtRules((atRule) => {
    if (atRule.name === "keyframes" && sets.keyframes.has(atRule.params.trim())) {
      const from = atRule.params.trim();
      atRule.params = prefixedName(prefix, from);
      report({
        kind: "prefixed-name",
        target: from,
        reason: `@keyframes 同名按文档顺序取最后一个（与 layer 无关）→ 加前缀 ${prefix}- 防夺名`,
      });
    } else if (atRule.name === "counter-style" && sets.counterStyles.has(atRule.params.trim())) {
      const from = atRule.params.trim();
      atRule.params = prefixedName(prefix, from);
      report({
        kind: "prefixed-name",
        target: from,
        reason: `@counter-style 是全局名称 → 加前缀 ${prefix}-`,
      });
    }
  });

  // @font-face 的 family 名：**声明侧**重命名（诊断记 prefixed-name，与引用侧区分）
  root.walkAtRules("font-face", (atRule) => {
    atRule.walkDecls("font-family", (decl: Declaration) => {
      decl.value = rewriteNameTokens(
        decl.value,
        sets.fontFamilies,
        prefix,
        report,
        "@font-face font-family",
        "font-family",
        "prefixed-name",
      );
    });
  });

  // font-family / font / animation 的**引用侧**重写（跳过 @font-face 内部，已在上一段处理）
  root.walkDecls((decl: Declaration) => {
    const parent = decl.parent as { type?: string; name?: string } | undefined;
    if (parent?.type === "atrule" && parent.name === "font-face") return;
    const prop = decl.prop.toLowerCase();
    if (prop === "font-family") {
      decl.value = rewriteFamilyList(decl.value, sets.fontFamilies, prefix, report);
    } else if (prop === "font") {
      decl.value = rewriteFamilyList(decl.value, sets.fontFamilies, prefix, report, true);
    } else if (prop === "animation" || prop === "animation-name") {
      decl.value = rewriteWordList(decl.value, sets.keyframes, prefix, report, prop);
    } else if (decl.prop.startsWith("--")) {
      // N1：主题私有变量**原样保留变量名**（P0-5），但其**值**里属「主题自身名称集合」的
      // font-family / keyframes 名必须同步改名，否则 `font-family: var(--my-font)` 会静默回退。
      decl.value = rewriteNameTokens(
        decl.value,
        sets.fontFamilies,
        prefix,
        report,
        decl.prop,
        "font-family",
      );
      decl.value = rewriteNameTokens(decl.value, sets.keyframes, prefix, report, decl.prop, "keyframes");
    }
  });
}

/**
 * 名称 token 重写：只改 ∈ `names` 的名称（引号写法与裸标识符都覆盖），其余原样保留。
 * - `font-family` / `font` 传 F（@font-face family）：通用族 `sans-serif`、系统族 `"Segoe UI"` ∉ F → 保留 ✓
 * - `animation` / `animation-name` 传 K（keyframes）：未声明的 `fade-in` ∉ K → 保留（避免动画静默消失）✓
 */
export function rewriteNameTokens(
  value: string,
  names: ReadonlySet<string>,
  prefix: string,
  report: (d: ThemeDiagnostic) => void,
  prop: string,
  kind: "keyframes" | "font-family",
  /** 诊断分类：声明侧重命名记 `prefixed-name`，引用侧重写记 `rewritten-ref`（矩阵列口径） */
  diagKind: "prefixed-name" | "rewritten-ref" = "rewritten-ref",
): string {
  if (names.size === 0) return value;
  return value.replace(
    /"([^"]*)"|'([^']*)'|([A-Za-z_][\w-]*)/g,
    (match: string, dq?: string, sq?: string, bare?: string) => {
      const name = dq ?? sq ?? bare ?? "";
      if (!name || !names.has(name)) return match;
      report({
        kind: diagKind,
        target: `${prop}: ${name}`,
        reason:
          diagKind === "prefixed-name"
            ? `主题自身声明了该 @font-face family → 声明侧加前缀 ${prefix}-（不夺应用侧字体名）`
            : kind === "keyframes"
              ? `引用主题自身声明的 @keyframes（同名按文档顺序夺名）→ 同步加前缀 ${prefix}-；未声明的不改名`
              : `引用主题自身声明的 @font-face family → 同步加前缀 ${prefix}-；回退链中的通用族/系统族保留`,
      });
      // animation-name 取 <custom-ident>（**不能带引号**，带引号是非法值）；字体族名用引号形式更稳
      return kind === "keyframes" ? prefixedName(prefix, name) : `"${prefixedName(prefix, name)}"`;
    },
  );
}

/** 兼容入口：族名列表（`font-family` / `font` 简写）。 */
export function rewriteFamilyList(
  value: string,
  families: ReadonlySet<string>,
  prefix: string,
  report: (d: ThemeDiagnostic) => void,
  isShorthand = false,
): string {
  return rewriteNameTokens(value, families, prefix, report, isShorthand ? "font" : "font-family", "font-family");
}

/** 兼容入口：animation / animation-name 的 keyframes 名。 */
export function rewriteWordList(
  value: string,
  names: ReadonlySet<string>,
  prefix: string,
  report: (d: ThemeDiagnostic) => void,
  prop: string,
): string {
  return rewriteNameTokens(value, names, prefix, report, prop, "keyframes");
}

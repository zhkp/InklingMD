/**
 * #306 §C3（G4 + G8）：主题变量的白名单处置。
 *
 * 裁决回顾（P0-5）：
 * - **拒绝集 = 白名单里的 `--shell-*`（含 `--shell-` 前缀）与基础变量**；`--content-*` 允许覆盖；
 * - 主题**私有**变量**原样保留、不改名、不删除**，只做**作用域收敛**
 *   （`:root { --x }` → `.editor-scroll .milkdown`，由选择器阶段完成）；
 * - N6 碰撞扫描已完成（6 款基线主题 ∩ 白名单 = **零碰撞**，见兼容性矩阵 D8）→ 默认拒绝即可，
 *   不需要「例外白名单」。
 *
 * 为什么只删声明、不做引用侧改写：白名单里的 token **全部由应用自身定义**
 * （`App.css` 的 light/dark 块 + `.code-block` 元素级块），删掉主题的赋值后，主题内
 * `var(--x)` 会自然解析到应用基线值 —— 这正是 G8 要的「拒绝赋值 + 引用兜底」，
 * 且比替换成字面量更稳（应用切换 light/dark 时仍跟着变）。
 */
// `with { type: "json" }`：Node 原生 ESM（Playwright 的加载器）要求显式 import attribute；
// Vite/Vitest 亦兼容该写法。
import whitelistJson from "../token-whitelist.json" with { type: "json" };
import type { ThemeDiagnostic, TokenWhitelist } from "./types";

interface RawWhitelist {
  base?: string[];
  shell?: string[];
  content?: string[];
  shellPrefixes?: string[];
  contentPrefixes?: string[];
  existingNamesByLayer?: { shell?: string[]; content?: string[] };
}

let cached: TokenWhitelist | null = null;

/** 内置白名单（`src/theme/token-whitelist.json`，#223 交付物，与 #224 断言同源）。 */
export function loadTokenWhitelist(): TokenWhitelist {
  if (cached) return cached;
  const raw = whitelistJson as unknown as RawWhitelist;
  cached = {
    base: [...(raw.base ?? [])],
    shell: [...(raw.shell ?? []), ...(raw.existingNamesByLayer?.shell ?? [])],
    content: [...(raw.content ?? []), ...(raw.existingNamesByLayer?.content ?? [])],
    shellPrefixes: [...(raw.shellPrefixes ?? [])],
    contentPrefixes: [...(raw.contentPrefixes ?? [])],
  };
  return cached;
}

export type TokenLayer = "base" | "shell" | "content" | "private";

/** 三层归属判定（前缀优先，其次枚举列表）。 */
export function classifyToken(token: string, whitelist: TokenWhitelist): TokenLayer {
  if ((whitelist.shellPrefixes ?? []).some((p) => token.startsWith(p))) return "shell";
  if ((whitelist.contentPrefixes ?? []).some((p) => token.startsWith(p))) return "content";
  if (whitelist.base.includes(token)) return "base";
  if (whitelist.shell.includes(token)) return "shell";
  if (whitelist.content.includes(token)) return "content";
  return "private";
}

/** 拒绝集（基础变量 + 外壳层）：第三方主题不得覆盖。 */
export function isRejectedToken(token: string, whitelist: TokenWhitelist): boolean {
  const layer = classifyToken(token, whitelist);
  return layer === "base" || layer === "shell";
}

export const rejectedTokenDiagnostic = (token: string, layer: TokenLayer): ThemeDiagnostic => ({
  kind: "rejected-token",
  target: token,
  reason: `G8：主题对${layer === "shell" ? "外壳层（--shell-*）" : "基础变量"}的赋值被拒绝 → 删除声明；主题内 var() 引用自动落到应用基线值`,
});

export const privateTokenDiagnostic = (token: string, scope: string): ThemeDiagnostic => ({
  kind: "private-token-scoped",
  target: token,
  reason: `主题私有变量原样保留并收敛到 ${scope}（不改名、不删除，引用侧无需改写）`,
});

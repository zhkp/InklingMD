/**
 * #225 §3 / §3.1 / §3.2 / C3：应用级主题身份与清单。
 *
 * 冻结口径（issue #225「设计补充」§3.1/§3.2 + 契约 G11）：
 * - `themeId` 是**权威源**；`data-theme` 由其 `mode` 派生，二者在同一次同步写中落盘（§3.2）；
 * - `themeId` **不依赖文件系统路径**，仅依赖「归一化文件名 + 来源前缀」（G11-2）；
 * - 归一化/配对/mode 判定**复用** #306 已落地的 `typora/metadata`（同一冻结口径，不另立实现）；
 * - 本 Issue 的首发 2 套内置主题 = `builtin:light` / `builtin:dark`（A-3：由既有 light/dark 迁移，
 *   **不新增主题 CSS 文件**；其载体仍是 `App.css` 的二值变量块，由 `data-theme` 驱动）。
 */
import {
  parseThemeCandidate,
  type ThemeDescriptor as TyporaDescriptor,
  type ThemeMode,
} from "./typora/metadata";

/** 主题来源：决定可覆盖的 token 层（G4）与优先级（G6 §4.1） */
export type AppThemeSource = "builtin-base" | "builtin" | "bundled" | "user";

/** 主题 CSS 载体：内置基线无独立 CSS（变量块在 App.css，由 data-theme 驱动） */
export type AppThemeCss =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "file"; path: string };

export interface AppTheme {
  /** 权威身份（§3.1） */
  id: string;
  /** 显示名 */
  name: string;
  /** 明暗属性 → 派生 `data-theme`（§3.2） */
  mode: ThemeMode;
  source: AppThemeSource;
  /** 成对主题的变体互指（`vue` ↔ `vue-dark`，G11-3） */
  variantOf?: string;
  /** 内容哈希：快照一致性与缓存失效（G9） */
  hash?: string;
  author?: string;
  version?: string;
  css?: AppThemeCss;
}

/** §3.1 内置基线固定 id（不依赖文件名，故不经过 Typora 侧 `buildThemeId`） */
export const BUILTIN_LIGHT_ID = "builtin:light";
export const BUILTIN_DARK_ID = "builtin:dark";
/** 首装 / 快照缺失时的首屏回落基线（G3-③） */
export const DEFAULT_THEME_ID = BUILTIN_LIGHT_ID;

/**
 * 内置基线两套（A-3：`light`/`dark` 迁移为 `builtin:light`/`builtin:dark`）。
 * `css: { kind: "none" }` 是**契约化的**事实：它们的样式由 `data-theme` 选择 `App.css`
 * 的变量块提供，不存在需要注入的主题样式表。
 */
export const BUILTIN_THEMES: readonly AppTheme[] = [
  { id: BUILTIN_LIGHT_ID, name: "浅色", mode: "light", source: "builtin-base", css: { kind: "none" } },
  { id: BUILTIN_DARK_ID, name: "深色", mode: "dark", source: "builtin-base", css: { kind: "none" } },
];

const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));

/** 注册进来的非内置主题（`bundled:*` / `user:*` / `builtin:<slug>`；#307/#308 写入） */
const registered = new Map<string, AppTheme>();

/** 注册/覆盖主题（同 id 后者胜——幂等补齐语义，N15）。返回是否新增。 */
export function registerThemes(themes: readonly AppTheme[]): boolean {
  let added = false;
  for (const t of themes) {
    if (BUILTIN_IDS.has(t.id)) continue;
    if (!registered.has(t.id)) added = true;
    registered.set(t.id, t);
  }
  return added;
}

export function unregisterTheme(id: string): void {
  registered.delete(id);
}

/** 主题清单（内置基线恒在最前，其余按 id 排序，保证 UI 稳定） */
export function listThemes(): AppTheme[] {
  const rest = [...registered.values()].sort((a, b) => a.id.localeCompare(b.id));
  return [...BUILTIN_THEMES, ...rest];
}

export function getTheme(id: string | null | undefined): AppTheme | undefined {
  if (!id) return undefined;
  return BUILTIN_THEMES.find((t) => t.id === id) ?? registered.get(id);
}

export function isBuiltinThemeId(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

/**
 * G9 P2-4：快照**只对磁盘来源**（`bundled:*` / `user:*`）适用；
 * `builtin-base` / `builtin:*` 构建期即可同步得到 → 不走快照。
 */
export function isSnapshotEligible(themeId: string): boolean {
  return themeId.startsWith("bundled:") || themeId.startsWith("user:");
}

/**
 * C7 迁移：旧值（`"light"` / `"dark"`）→ `themeId`。
 * 读取侧**容忍旧格式一版**（回滚兜底）；未知值返回 `undefined` 交由调用方回落默认。
 */
export function resolveLegacyThemeId(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value === "light") return BUILTIN_LIGHT_ID;
  if (value === "dark") return BUILTIN_DARK_ID;
  if (value === BUILTIN_LIGHT_ID || value === BUILTIN_DARK_ID) return value;
  if (/^(builtin|bundled|user):/.test(value) && getTheme(value)) return value;
  return undefined;
}

/** 主题 id 的 mode：优先描述符，缺失时按 `-dark` 后缀/默认 light（调用方应保证描述符存在） */
export function themeModeOf(themeId: string): ThemeMode {
  return getTheme(themeId)?.mode ?? (/-dark(?:-dark)?$/.test(themeId) ? "dark" : "light");
}

/** 显示名：描述符 → 归一化文件名（兜底，不抛错） */
export function themeDisplayName(themeId: string): string {
  const theme = getTheme(themeId);
  if (theme) return theme.name;
  const slug = themeId.includes(":") ? themeId.slice(themeId.indexOf(":") + 1) : themeId;
  return slug || themeId;
}

/**
 * 把 #306 的 Typora 文件描述符转成本层模型（`user:*` / `bundled:*`）。
 * 供 #307/#308 复用，避免两套 id 规则。
 */
export function fromTyporaDescriptors(
  descriptors: readonly TyporaDescriptor[],
  hashOf?: (d: TyporaDescriptor) => string | undefined,
  cssOf?: (d: TyporaDescriptor) => AppThemeCss | undefined,
): AppTheme[] {
  return descriptors.map((d) => ({
    id: d.themeId,
    name: d.name,
    mode: d.mode,
    source: d.themeId.startsWith("bundled:") ? "bundled" : "user",
    variantOf: d.variantOf,
    hash: hashOf?.(d),
    css: cssOf?.(d),
  }));
}

/** 从文件名派生 `user:*` 描述符（#307 的入口；G11 归一化在此收口一次） */
export function userThemeFromFileName(fileName: string): AppTheme | undefined {
  if (!fileName.toLowerCase().endsWith(".css")) return undefined;
  // 归一化与 id 生成都走 G11 的唯一实现（avoid 两套规则）
  const desc = parseThemeCandidate({ fileName, siblings: [fileName], source: "user" });
  return {
    id: desc.themeId,
    name: desc.name,
    mode: desc.mode,
    source: "user",
    variantOf: desc.variantOf,
  };
}

/** 测试/多窗口重建用：清空注册表（内置基线不受影响） */
export function resetRegisteredThemes(): void {
  registered.clear();
}

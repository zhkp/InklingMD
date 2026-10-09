/**
 * #225 §4.3（G3）/ §4.4（G9）：主题会话 —— 首帧同步路径 + 切换管线。
 *
 * ⚠️ 本模块**必须在 `main.tsx` 顶部静态 import**（G3：禁止懒加载/代码分割）；
 * 其模块顶层副作用就是「首帧前把 `data-theme` 就位」的那一步。
 *
 * 时序（N8）：
 *   ① 同步：读 `inkling-theme` → 解析 `themeId`（容忍旧格式一版）→ 同步写
 *      `data-theme`（= mode 派生）+ `data-theme-id`；
 *   ② 同步：若快照适用（`bundled:*`/`user:*`）且命中 → 读快照，**微任务**注入
 *      `@layer theme { … }`（此时 `base` 层块已就绪 → 层序天然正确）；
 *   ③ 快照缺失 / 不适用 → 首屏回落**内置基线**（快照路径允许一次可见切换，见矩阵登记），
 *      并把「需要异步补主题」交给调用方（#307/#308 的磁盘读盘路径）。
 */
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  getTheme,
  isSnapshotEligible,
  registerThemes,
  resolveLegacyThemeId,
  themeModeOf,
  type AppTheme,
} from "./registry";
import {
  clearThemeAttributes,
  injectThemeCss,
  readInjectedThemeCss,
  writeThemeAttributes,
} from "./inject";
import {
  SNAPSHOT_BUDGET_MS,
  gcSnapshots,
  readSnapshot,
  readStoredThemeId,
  readThemesIndex,
  recordSnapshotState,
  writeSnapshot,
  writeStoredThemeId,
} from "./snapshot";
import type { ThemeMode } from "./typora/metadata";

export type FirstFrameSource = "snapshot" | "baseline" | "inapplicable";

export interface FirstFrameResult {
  themeId: string;
  mode: ThemeMode;
  source: FirstFrameSource;
  /** 首屏是否还需要异步补主题（快照缺失 / 不适用 / 未知 themeId 未被采纳） */
  needsAsyncLoad: boolean;
  /** 存储里的原始值（诊断/状态位用） */
  storedRaw: string | null;
}

/** 会话当前主题（权威源的内存镜像；store 与断言都读它，避免各处重复解析） */
let currentTheme: { themeId: string; mode: ThemeMode } = { themeId: DEFAULT_THEME_ID, mode: "light" };

export function currentThemeId(): string {
  return currentTheme.themeId;
}

export function currentThemeMode(): ThemeMode {
  return currentTheme.mode;
}

const now = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * 首帧同步路径。**必须在任何 React 渲染之前调用**（模块顶层）。
 * 返回诊断结果（供状态位/断言使用）。
 */
export function bootstrapFirstFrameTheme(): FirstFrameResult {
  // ⓪ **先消费持久化清单**（评审阻塞 2）：磁盘主题（`bundled:*`/`user:*`）的 id 必须先入册，
  // 否则（a）存储里的 themeId 被判「未知」→ 首帧回落内置基线（暗色磁盘主题每次重启闪一次浅色），
  // （b）GC 的 known 集合只剩两个内置 id → 每次启动把所有磁盘主题快照删掉。
  // `inkling-themes-index` 的**写入方**是 #307 的扫描/导入路径；本批负责在本帧消费它。
  const index = readThemesIndex();
  if (index.length > 0) {
    registerThemes(
      index.map((t) => ({
        id: t.id,
        name: t.name,
        mode: t.mode,
        variantOf: t.variantOf,
        hash: t.hash,
        source: t.source === "bundled" ? "bundled" : t.source === "builtin" ? "builtin" : "user",
      })),
    );
  }

  const storedRaw = readStoredThemeId();
  const resolved = resolveLegacyThemeId(storedRaw);

  // P2-3 跨 key 原子性：存储里是**未知 themeId**（清单/快照尚未就绪）→ **不采纳**，回落内置基线，
  // 并记录状态位；后续由清单/读盘路径决定是否切换（接受一次可见切换，但必须留痕）。
  let themeId = resolved ?? DEFAULT_THEME_ID;
  let unknownStored = false;
  if (!resolved && storedRaw) {
    unknownStored = true;
    recordSnapshotState({
      last: "invalid",
      themeId: storedRaw,
      detail: "存储中的 themeId 不在清单（跨 key 原子性：本帧不切换，回落内置基线）",
    });
  }
  if (!resolved && !storedRaw) {
    // 首装：`prefers-color-scheme` 只决定**首次默认**（C7）
    const prefersDark =
      typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    themeId = prefersDark ? BUILTIN_THEMES[1].id : DEFAULT_THEME_ID;
  }

  const mode = themeModeOf(themeId);
  // ① 同步落盘两个属性（§3.2/C3：同一次同步写，不存在「先有其一」）
  writeThemeAttributes(themeId, mode);
  currentTheme = { themeId, mode };

  const theme = getTheme(themeId);
  const hash = theme?.hash;
  const eligible = isSnapshotEligible(themeId) && !!hash;

  let source: FirstFrameSource = "inapplicable";
  let needsAsyncLoad = unknownStored || (theme?.css?.kind === "file" && !eligible);

  if (eligible && hash) {
    const started = now();
    const snap = readSnapshot(themeId, hash);
    if (snap) {
      injectThemeCss(snap.css);
      source = "snapshot";
      const elapsed = now() - started;
      // 耗时预算 ≤ 8 ms：超预算记状态位（仍可用），不阻塞首帧
      recordSnapshotState({
        last: elapsed > SNAPSHOT_BUDGET_MS ? "slow" : "hit",
        themeId,
        hash,
        ms: Math.round(elapsed * 100) / 100,
      });
      needsAsyncLoad = false;
    } else {
      // 该主题本应有 CSS，但快照缺失 → 首屏就用**内置基线**顶上（允许一次可见切换，必须留痕）
      source = "baseline";
      needsAsyncLoad = true;
      recordSnapshotState({
        last: "missing",
        themeId,
        hash,
        detail: "快照缺失 → 首屏回落内置基线，异步读盘后切换（允许一次可见切换）",
      });
    }
  } else if (theme?.css?.kind === "text") {
    // 构建期同步可得（无快照需求）：直接注入
    injectThemeCss(theme.css.text);
    source = "baseline";
    needsAsyncLoad = false;
  }

  // 启动时 GC（P2-2）：**known 集合必须来自持久化清单**，而不是「当刻内存注册表」——
  // 后者在首帧只含两个内置 id，会把所有磁盘主题快照误判为「已不存在」而清空（评审阻塞 2）。
  // 清单为空（尚无磁盘主题 / 索引丢失）时**不动快照**，等清单就绪再回收。
  if (index.length > 0) {
    gcSnapshots([...BUILTIN_THEMES.map((t) => t.id), ...index.map((t) => t.id)]);
  }

  return { themeId, mode, source, needsAsyncLoad, storedRaw };
}

export interface ApplyThemeOptions {
  /** 主题 CSS 文本（第三方主题为兼容层改写产物）；`null` 表示无独立样式表 */
  css?: string | null;
  /** 是否写回 `inkling-theme`（默认 true；多窗口同步接收方也应写回以便一致） */
  persist?: boolean;
}

/**
 * 切换主题：同步写属性 + 注入/卸载样式 + 快照落盘（G9 适用性）。
 * **不触碰文档内容与编辑状态**（验收项）。
 */
export function applyTheme(theme: AppTheme, options: ApplyThemeOptions = {}): void {
  const persist = options.persist ?? true;
  writeThemeAttributes(theme.id, theme.mode);
  currentTheme = { themeId: theme.id, mode: theme.mode };
  if (persist) writeStoredThemeId(theme.id);

  const css =
    options.css !== undefined ? options.css : theme.css?.kind === "text" ? theme.css.text : null;
  if (css === null || theme.css?.kind === "none") {
    // 内置基线：没有独立样式表 → 卸载主题样式（避免上一个主题的规则残留）
    injectThemeCss(null);
  } else {
    injectThemeCss(css);
    if (theme.hash) writeSnapshot(theme.id, theme.hash, css);
  }
}

/** 卸载主题（回到「无主题样式」状态）；`data-theme` 仍保持（由调用方决定） */
export function unloadThemeStyles(): void {
  injectThemeCss(null);
  clearThemeAttributes();
}

/** 诊断快照：当前已注入的主题样式文本（断言/调试） */
export function currentInjectedThemeCss(): string | null {
  return readInjectedThemeCss();
}

// 模块顶层副作用：main.tsx 顶部静态 import 本模块即完成「首帧前 data-theme 就位」（G3）
if (typeof window !== "undefined" && typeof document !== "undefined") {
  bootstrapFirstFrameTheme();
}

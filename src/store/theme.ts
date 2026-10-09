/**
 * 主题状态（#225 主题包机制）。
 *
 * 模型迁移：`ThemeMode`（light/dark）→ **`themeId` 为权威源**，`data-theme` 由其 `mode` 派生（§3.2/C3）；
 * 旧持久化值（`"light"`/`"dark"`）在读取侧**容忍一版**并迁移为 `builtin:light`/`builtin:dark`（C7）。
 *
 * 层与优先级（G5/G6）：主题注入 `@layer theme`、自定义 CSS 注入 `@layer user`（最高，必须最终胜出）。
 * 跨窗口同步（C4 方案 A）：本模块只**登记** key，`storage` 监听统一在 `storageSyncRegistry` 安装。
 */
import { create } from "zustand";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { open, message } from "@tauri-apps/plugin-dialog";
import { loadJSON, writeJSON } from "../lib/storage";
import {
  deleteThemeEntry,
  extractThemeZip,
  moveToBackup,
  readBundledManifest,
  readThemeFile,
  revealPath,
  scanThemesDir,
  themesRoot,
  ensureDir,
  walkThemeDir,
  copyThemePath,
  bundledThemesRoot,
} from "../lib/themeFiles";
import { normalizePath, joinPath, dirNameOf } from "../lib/path";
import { showMessage } from "../lib/dialogs";
import {
  BUILTIN_DARK_ID,
  BUILTIN_LIGHT_ID,
  DEFAULT_THEME_ID,
  getTheme,
  isBuiltinThemeId,
  listThemes,
  registerThemes,
  resetRegisteredThemes,
  resolveLegacyThemeId,
  themeDisplayName,
  type AppTheme,
} from "../theme/registry";
import { applyTheme, currentThemeId, currentThemeMode, firstFrame } from "../theme/session";
import { buildThemeCatalog, indexChanged, type CatalogResult } from "../theme/catalog";
import { loadThemeCss } from "../theme/disk";
import { themeCssHash } from "../theme/typora/rewrite";
import {
  bundledThemeId,
  normalizePackage,
  resolveImportConflict,
  userThemeId,
  validateImportedTheme,
  type PackageEntry,
} from "../theme/import";
import { injectUserCss } from "../theme/inject";
import {
  SNAPSHOT_PREFIX,
  THEMES_INDEX_KEY,
  THEME_KEY,
  readSnapshot,
  readThemesIndex,
  recordSnapshotState,
  removeSnapshotsFor,
  writeStoredThemeId,
  writeThemesIndex,
} from "../theme/snapshot";
import { registerStorageSync, registerStorageSyncPrefix } from "./storageSyncRegistry";
import type { ThemeMode } from "../theme/typora/metadata";

export type { ThemeMode };

/** 导入路径（#307 §3 三条） */
export type ImportKind = "css" | "zip" | "folder";

interface ThemeState {
  /** 当前主题身份（权威源） */
  themeId: string;
  /** `themeId.mode` 的派生镜像（UI 兼容；App.css 的 `[data-theme]` 依赖它） */
  mode: ThemeMode;
  /** 可选主题清单（内置基线 + 已注册的 bundled/user） */
  themes: AppTheme[];
  /** 用户自定义 CSS 内容（null 表示未加载） */
  customCSS: string | null;
  /** 自定义 CSS 文件路径（用于显示） */
  customCSSPath: string | null;
  /** 主题目录（`…/inklingmd/themes`；「打开主题文件夹」与提示用） */
  themesDir: string | null;
  /** 扫描状态（UI 可显示刷新中/失败） */
  scanState: "idle" | "scanning" | "ready" | "error";
  /** 目录级/导入级问题（可见提示来源；不允许静默） */
  scanIssues: string[];
  /** 被隐藏的预装主题 id（N15：预装条目「移除」= 隐藏，不物理删除） */
  hiddenBundled: string[];
  /** 切换主题（`themeId`） */
  setTheme: (themeId: string) => void;
  /** 兼容旧 UI：明暗二值切换 → `builtin:light` / `builtin:dark` */
  setMode: (mode: ThemeMode) => void;
  /** 重新读取清单（#307：扫描/导入后调用） */
  refreshThemes: () => void;
  /** 扫描主题目录 + 预装清单 → 注册 + 幂等补齐 + 落盘索引（#307） */
  syncThemes: () => Promise<void>;
  /** 读盘补主题（快照缺失时的异步路径，G3-③） */
  loadThemeCssFromDisk: (themeId: string) => Promise<void>;
  /** 导入主题（三条路径：单 `.css` / 压缩包 / 文件夹） */
  importThemes: (kind: ImportKind) => Promise<void>;
  /** 移除用户主题（移入 `.backup` 可恢复）/ 隐藏预装主题（N15） */
  removeTheme: (themeId: string) => Promise<void>;
  /** 复制预装主题为我的主题（N13：预装不可原地改） */
  duplicateAsUserTheme: (themeId: string) => Promise<void>;
  /** 打开主题文件夹（revealItemInDir） */
  openThemesFolder: () => Promise<void>;
  /** 初始化加载持久化的自定义 CSS */
  initCustomCSS: () => Promise<void>;
  /** 加载自定义 CSS 文件 */
  loadCustomCSS: () => Promise<void>;
  /** 清除自定义 CSS */
  clearCustomCSS: () => void;
}

const CUSTOM_CSS_PATH_KEY = "inkling-custom-css-path";
/** 预装主题的隐藏位（N15；与索引/快照分列，避免身份与可见性互相污染） */
const HIDDEN_BUNDLED_KEY = "inkling-themes-hidden";

/** 当前主题的展示名（菜单用） */
export function currentThemeLabel(themeId: string): string {
  return themeDisplayName(themeId);
}

/** 最近一次「远端窗口要求切换但本窗口尚未就绪」的 themeId（P2-3 跨 key 原子性） */
let pendingRemoteThemeId: string | null = null;

export const useTheme = create<ThemeState>((set, get) => {
  // ── 跨窗口同步（C4：只登记，不各自 addEventListener） ────────────────────
  registerStorageSync(
    THEME_KEY,
    (e) => {
      const next = e.newValue;
      if (!next || next === get().themeId) return;
      applyRemoteTheme(next, set);
    },
    "theme:current",
  );
  // 快照到达（另一窗口刚写入）→ 若正是本窗口待切换的主题，则拿到 CSS 后再切换（P2-3）
  registerStorageSyncPrefix(
    SNAPSHOT_PREFIX,
    () => {
      const pending = pendingRemoteThemeId;
      if (pending) applyRemoteTheme(pending, set);
    },
    "theme:snapshot",
  );
  // 预装主题的隐藏位（N15）：多窗口一致（被隐藏的预装条目在其它窗口同样不显示）
  registerStorageSync(
    HIDDEN_BUNDLED_KEY,
    (e) => {
      try {
        const parsed = e.newValue ? (JSON.parse(e.newValue) as unknown) : [];
        set({ hiddenBundled: Array.isArray(parsed) ? (parsed as string[]) : [] });
      } catch {
        /* 非法值不抹本窗口状态 */
      }
    },
    "theme:hidden",
  );
  registerStorageSync(
    THEMES_INDEX_KEY,
    () => {
      const entries = readThemesIndex();
      if (entries.length > 0) {
        registerThemes(
          entries.map((t) => ({
            id: t.id,
            name: t.name,
            mode: t.mode,
            variantOf: t.variantOf,
            hash: t.hash,
            source: t.source === "bundled" ? "bundled" : t.source === "builtin" ? "builtin" : "user",
          })),
        );
      }
      set({ themes: listThemes() });
      // 清单就绪后，重试此前因「未知 themeId」而未切换的远端主题
      const pending = pendingRemoteThemeId;
      if (pending) applyRemoteTheme(pending, set);
    },
    "theme:index",
  );

  return {
    themeId: currentThemeId(),
    mode: currentThemeMode(),
    themes: listThemes(),
    customCSS: null,
    customCSSPath: null,
    themesDir: null,
    scanState: "idle",
    scanIssues: [],
    hiddenBundled: loadJSON<string[]>(HIDDEN_BUNDLED_KEY, [], (v): v is string[] => Array.isArray(v)),

    setTheme: (themeId) => {
      const theme = getTheme(themeId);
      if (!theme) {
        // 未知 themeId：不切换（P2-3），登记状态位
        recordSnapshotState({
          last: "invalid",
          themeId,
          detail: "setTheme：themeId 不在清单，拒绝切换",
        });
        return;
      }
      // 快照缺失的磁盘主题 → 先切身份（属性 + 持久化），再由读盘路径补 CSS 并落快照
      const needsDiskLoad = applyThemeWithSnapshot(theme);
      set({ themeId: theme.id, mode: theme.mode });
      if (needsDiskLoad) void loadThemeFromDisk(set, theme.id);
    },

    setMode: (mode) => {
      get().setTheme(mode === "dark" ? BUILTIN_DARK_ID : BUILTIN_LIGHT_ID);
    },

    refreshThemes: () => set({ themes: listThemes() }),

    syncThemes: () => syncThemes(set, get),
    loadThemeCssFromDisk: (themeId) => loadThemeFromDisk(set, themeId),
    importThemes: (kind) => importThemes(set, get, kind),
    removeTheme: (themeId) => removeTheme(set, get, themeId),
    duplicateAsUserTheme: (themeId) => duplicateAsUserTheme(set, get, themeId),
    openThemesFolder: () => openThemesFolder(),

    initCustomCSS: async () => {
      if (!isTauri()) return;
      const savedPath = loadJSON<string | null>(CUSTOM_CSS_PATH_KEY, null, (v): v is string => typeof v === "string");
      if (!savedPath) return;

      try {
        const css = await invoke<string>("read_text_file", {
          filePath: savedPath,
        });
        injectUserCss(css);
        set({ customCSS: css, customCSSPath: savedPath });
      } catch {
        // 文件已被删/移动时静默降级（清除持久化值，回退默认主题）
        writeJSON(CUSTOM_CSS_PATH_KEY, null);
        injectUserCss(null);
        set({ customCSS: null, customCSSPath: null });
      }
    },

    loadCustomCSS: async () => {
      if (!isTauri()) {
        try {
          await message("自定义 CSS 仅在桌面端支持", { title: "提示", kind: "info" });
        } catch {
          // 对话框不可用时不处理
        }
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: "CSS", extensions: ["css"] }],
      });
      if (typeof selected !== "string") return;
      try {
        const css = await invoke<string>("read_text_file", {
          filePath: selected,
        });
        injectUserCss(css);
        writeJSON(CUSTOM_CSS_PATH_KEY, selected);
        set({ customCSS: css, customCSSPath: selected });
      } catch (e) {
        try {
          await message(`读取 CSS 文件失败：${e instanceof Error ? e.message : String(e)}`, {
            title: "错误",
            kind: "error",
          });
        } catch {
          // 忽略弹窗异常
        }
      }
    },

    clearCustomCSS: () => {
      writeJSON(CUSTOM_CSS_PATH_KEY, null);
      injectUserCss(null);
      set({ customCSS: null, customCSSPath: null });
    },
  };
});

/**
 * 切换主题：优先用「快照里的 CSS」（磁盘主题），否则用描述符自带的文本；
 * 内置基线（`css.kind === "none"`）→ 卸载主题样式。
 */
function applyThemeWithSnapshot(theme: AppTheme): boolean {
  const hash = theme.hash;
  if (theme.css?.kind === "file" && hash) {
    const snap = readSnapshot(theme.id, hash);
    if (snap) {
      applyTheme(theme, { css: snap.css });
      return false;
    }
    // 快照缺失：先把主题切过去（属性 + 持久化），CSS 由读盘路径补齐（调用方据返回值触发）
    recordSnapshotState({
      last: "missing",
      themeId: theme.id,
      hash,
      detail: "切换时快照缺失 → 由读盘路径补齐（允许一次可见切换）",
    });
    applyTheme(theme, { css: null });
    return true;
  }
  applyTheme(theme);
  return false;
}

/** 处理来自其他窗口的主题切换（P2-3：未知 themeId 不切换，等清单/快照就绪） */
function applyRemoteTheme(remoteValue: string, set: (patch: Partial<ThemeState>) => void): void {
  // C7：跨窗口同样容忍旧格式一版（老版本窗口写入 "light"/"dark" 时仍能同步）
  const themeId = resolveLegacyThemeId(remoteValue) ?? remoteValue;
  const theme = getTheme(themeId);
  if (!theme) {
    pendingRemoteThemeId = themeId;
    recordSnapshotState({
      last: "invalid",
      themeId,
      detail: "跨窗口：themeId 未知（清单未就绪）→ 本窗口暂不切换（P2-3）",
    });
    return;
  }
  if (theme.css?.kind === "file" && theme.hash) {
    const snap = readSnapshot(theme.id, theme.hash);
    if (snap) {
      applyTheme(theme, { css: snap.css, persist: false });
    } else {
      pendingRemoteThemeId = theme.id;
      recordSnapshotState({
        last: "missing",
        themeId: theme.id,
        hash: theme.hash,
        detail: "跨窗口：快照未就绪 → 等快照 key 到达后再切换（P2-3）",
      });
      // 本窗口也能读盘：补上并落快照后，pending 的重试路径即可完成切换（不让远端等空）
      void loadThemeFromDisk(set, theme.id);
      return;
    }
  } else {
    applyTheme(theme, { persist: false });
  }
  pendingRemoteThemeId = null;
  set({ themeId: theme.id, mode: theme.mode });
}

// ── #307：主题目录的读取/导入/移除实现（store action 的落地，供 UI 调用） ─────────

type SetState = (patch: Partial<ThemeState>) => void;
type GetState = () => ThemeState;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 可见提示（不静默）：对话框不可用时不抛错 */
async function notify(title: string, body: string, kind: "info" | "warning" | "error" = "info"): Promise<void> {
  try {
    await showMessage(body, { title, kind });
  } catch {
    /* 对话框不可用（浏览器/测试环境）时忽略 */
  }
}

/** 路径最后一段（跨平台分隔符） */
function basenameOf(p: string): string {
  const parts = normalizePath(p).split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** 备份目录名的时间戳（可恢复的「覆盖」语义，§4） */
function backupStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** 读一次清单（扫描主题目录 + 预装清单，含 N15 识别与 N13 补齐计划） */
async function collectCatalog(): Promise<{ root: string; catalog: CatalogResult }> {
  const root = await themesRoot();
  await ensureDir(root);
  const catalog = await buildThemeCatalog({
    themesRoot: root,
    bundledRoot: await bundledThemesRoot(),
    scanDir: (dir) => scanThemesDir(dir),
    readFile: (abs) => readThemeFile(abs),
    join: (dir, rel) => normalizePath(joinPath(dir, rel)),
    manifestRaw: await readBundledManifest(),
  });
  return { root, catalog };
}

/** 把清单结果落到注册表 + 落盘索引 + store（幂等：索引内容不变则不写，避免多窗口事件风暴） */
function applyCatalog(catalog: CatalogResult, root: string, set: SetState): void {
  resetRegisteredThemes();
  registerThemes(catalog.themes);
  if (indexChanged(catalog.index, readThemesIndex())) writeThemesIndex(catalog.index);
  set({
    themes: listThemes(),
    themesDir: root,
    scanState: "ready",
    scanIssues: catalog.issues,
  });
}

/** 扫描 + 幂等补齐 + 注册 + 落盘（#307 的主入口；启动与导入/移除后都走它） */
async function syncThemes(set: SetState, get: GetState): Promise<void> {
  set({ scanState: "scanning" });
  try {
    let { root, catalog } = await collectCatalog();
    const issues = [...catalog.issues];
    let copied = 0;
    for (const item of catalog.copyPlan) {
      try {
        await copyThemePath(item.from, item.to);
        copied += 1;
      } catch (error) {
        // 源副本缺资源目录等情况：登记但不中断其余主题的补齐
        issues.push(`预装主题补齐失败（${item.slug}）：${messageOf(error)}`);
      }
    }
    if (copied > 0) {
      // 补齐后重建一次清单（新文件要进入注册表与索引）
      ({ root, catalog } = await collectCatalog());
      issues.push(`预装主题已按源副本补齐 ${copied} 项（N13：用户改动只落 user:*）`);
    }
    applyCatalog({ ...catalog, issues: [...issues, ...catalog.issues] }, root, set);

    const currentId = get().themeId;
    if (!isBuiltinThemeId(currentId) && !getTheme(currentId)) {
      // §10：主题文件被删除/移动 → 清持久化 + 回落默认 + 可见提示
      recordSnapshotState({
        last: "invalid",
        themeId: currentId,
        detail: "扫描后该主题已不在主题目录（被删除/移动）→ 回落默认主题",
      });
      writeStoredThemeId(DEFAULT_THEME_ID);
      removeSnapshotsFor(currentId);
      applyTheme({ ...BUILTIN_LIGHT_THEME });
      set({ themeId: DEFAULT_THEME_ID, mode: "light" });
      await notify("主题已不可用", `主题「${themeDisplayName(currentId)}」已从主题目录消失，已回到默认主题。`, "warning");
      return;
    }

    // G3-③：首帧快照缺失/不适用（磁盘主题）→ 这里异步读盘补上
    if (firstFrame?.needsAsyncLoad && getTheme(currentId)) {
      await loadThemeFromDisk(set, currentId);
    }
  } catch (error) {
    set({ scanState: "error" });
    recordSnapshotState({ last: "invalid", detail: `主题目录扫描失败：${messageOf(error)}` });
    await notify("主题目录不可用", `扫描主题目录失败：${messageOf(error)}`, "error");
  }
}

/** 内置基线对象（回落用；避免依赖 registry 内部数组的元素顺序） */
const BUILTIN_LIGHT_THEME: AppTheme = { id: DEFAULT_THEME_ID, name: "浅色", mode: "light", source: "builtin-base", css: { kind: "none" } };

/** 读盘补主题：读文件 → 预读本地 `@import` → #306 改写 → 注入 + 落快照（#307 §6.1 第③层） */
async function loadThemeFromDisk(set: SetState, themeId: string): Promise<void> {
  const theme = getTheme(themeId);
  if (!theme || theme.css?.kind !== "file") return;
  try {
    // `assetRoot` = assetProtocol.scope 的根（应用数据目录）；浏览器/E2E 无 Tauri path API → 回落主题目录
    let assetRoot: string;
    try {
      assetRoot = normalizePath(await appDataDir());
    } catch {
      assetRoot = dirNameOf(theme.css.path);
    }
    const { result } = await loadThemeCss({
      themeId,
      filePath: theme.css.path,
      assetRoot,
      io: { readFile: (abs) => readThemeFile(abs), toAssetUrl: (abs) => convertFileSrc(abs) },
    });
    if (result.rejected) {
      throw new Error("主题 CSS 解析失败（整包拒绝，不注入半解析产物）");
    }
    applyTheme(theme, { css: result.css });
    set({ themeId: theme.id, mode: theme.mode });
  } catch (error) {
    // §10：读取失败 → 清持久化 + 回落默认 + 可见提示（不再静默）
    recordSnapshotState({
      last: "invalid",
      themeId,
      detail: `磁盘读盘失败：${messageOf(error)}`,
    });
    writeStoredThemeId(DEFAULT_THEME_ID);
    applyTheme({ ...BUILTIN_LIGHT_THEME });
    set({ themeId: DEFAULT_THEME_ID, mode: "light" });
    await notify(
      "主题读取失败",
      `主题「${themeDisplayName(themeId)}」读取失败，已回到默认主题：${messageOf(error)}`,
      "error",
    );
  }
}

/** 导入（§3 三条路径 + §4 重名策略 + §9 校验），落盘后自动扫描并切到新主题 */
async function importThemes(set: SetState, get: GetState, kind: ImportKind): Promise<void> {
  if (!isTauri()) {
    await notify("提示", "主题导入仅在桌面端支持（浏览器预览无文件系统）", "info");
    return;
  }
  const selected = await open({
    multiple: false,
    directory: kind === "folder",
    title: kind === "css" ? "选择主题 CSS" : kind === "zip" ? "选择主题压缩包" : "选择主题文件夹",
    filters:
      kind === "css"
        ? [{ name: "Typora 主题", extensions: ["css"] }]
        : kind === "zip"
          ? [{ name: "主题压缩包", extensions: ["zip"] }]
          : undefined,
  });
  if (typeof selected !== "string") return;

  const root = await themesRoot();
  await ensureDir(root);
  const stamp = backupStamp();
  const staging = normalizePath(joinPath(normalizePath(joinPath(root, ".staging")), stamp));
  let entries: PackageEntry[] = [];
  let sourceRoot = "";
  let cleanup: string | null = null;
  const notices: string[] = [];

  try {
    if (kind === "css") {
      await ensureDir(normalizePath(joinPath(root, ".staging")));
      await ensureDir(staging);
      const name = basenameOf(selected);
      const target = normalizePath(joinPath(staging, name));
      await copyThemePath(selected, target);
      entries = [{ path: name, kind: "file" }];
      sourceRoot = staging;
      cleanup = staging;
    } else if (kind === "folder") {
      const walked = await walkThemeDir(selected);
      entries = walked.entries;
      notices.push(...walked.issues, ...walked.skipped);
      sourceRoot = selected;
    } else {
      const report = await extractThemeZip(selected, staging);
      entries = report.entries.map((p) => ({
        path: p,
        kind: p.endsWith("/") ? "dir" : "file",
      }));
      if (report.skipped.length > 0) notices.push(...report.skipped);
      sourceRoot = staging;
      cleanup = staging;
    }

    const { themes: normalized, issues: packageIssues } = normalizePackage(entries);
    notices.push(...packageIssues);
    if (normalized.length === 0) {
      await notify("导入失败", notices.join("\n") || "压缩包/文件夹内没有可导入的 .css 主题", "error");
      return;
    }

    const imported: string[] = [];
    for (const item of normalized) {
      const cssAbs = normalizePath(joinPath(sourceRoot, item.cssPath));
      let content: string;
      try {
        content = await readThemeFile(cssAbs);
      } catch (error) {
        notices.push(`${item.slug}：读取失败（${messageOf(error)}）`);
        continue;
      }
      const validation = validateImportedTheme(content);
      if (!validation.ok) {
        notices.push(`${item.slug}：${validation.reason}`);
        continue;
      }
      notices.push(...validation.notices.map((n) => `${item.slug}：${n}`));

      const incomingId = userThemeId(item.slug);
      const bundled = getTheme(bundledThemeId(item.slug));
      const userTheme = getTheme(incomingId);
      const existing = bundled
        ? { id: bundled.id, source: bundled.source, hash: bundled.hash }
        : userTheme
          ? { id: userTheme.id, source: userTheme.source, hash: userTheme.hash }
          : undefined;
      const resolution = resolveImportConflict({
        incomingId,
        incomingHash: themeCssHash(content),
        existing,
        takenIds: new Set(listThemes().map((t) => t.id)),
      });
      if (resolution.action === "skip-identical") {
        notices.push(`${item.slug}：${resolution.reason}`);
        continue;
      }
      const targetId = resolution.action === "duplicate-as-user" ? resolution.targetId : incomingId;
      const targetSlug = targetId.slice(targetId.indexOf(":") + 1);
      if (resolution.action === "duplicate-as-user") notices.push(resolution.reason);

      // 覆盖用户主题：旧文件（含同名资源目录）先移入 .backup（可恢复）
      if (resolution.action === "overwrite" && userTheme?.css?.kind === "file") {
        const oldName = basenameOf(userTheme.css.path);
        try {
          await moveToBackup(root, oldName, `${stamp}-prev`);
          const oldSlug = oldName.replace(/\.css$/i, "");
          await moveToBackup(root, oldSlug, `${stamp}-prev`).catch(() => {});
        } catch (error) {
          notices.push(`旧主题备份失败（${oldName}）：${messageOf(error)}`);
        }
      }

      await copyThemePath(cssAbs, normalizePath(joinPath(root, `${targetSlug}.css`)));
      if (item.resourceDir) {
        await copyThemePath(
          normalizePath(joinPath(sourceRoot, item.resourceDir)),
          normalizePath(joinPath(root, targetSlug)),
        );
      }
      for (const extra of item.extras) {
        try {
          await copyThemePath(
            normalizePath(joinPath(sourceRoot, extra)),
            normalizePath(joinPath(root, basenameOf(extra))),
          );
        } catch {
          /* README/LICENSE 复制失败不影响主题可用 */
        }
      }
      imported.push(targetId);
    }

    await syncThemes(set, get);
    if (imported.length > 0) {
      const first = imported[0];
      if (getTheme(first)) get().setTheme(first);
      await notify(
        "导入完成",
        [`已导入 ${imported.length} 个主题：${imported.map(themeDisplayName).join("、")}`, ...notices]
          .filter(Boolean)
          .join("\n"),
        "info",
      );
    } else {
      await notify("未导入任何主题", notices.join("\n") || "所有主题都被跳过", "warning");
    }
  } catch (error) {
    recordSnapshotState({ last: "invalid", detail: `主题导入失败：${messageOf(error)}` });
    await notify("导入失败", messageOf(error), "error");
  } finally {
    if (cleanup) {
      try {
        await deleteThemeEntry(normalizePath(joinPath(root, ".staging")), basenameOf(cleanup));
      } catch {
        /* 暂存目录清理失败不影响导入结果（下次导入复用同一路径） */
      }
    }
  }
}

/** 移除：用户主题 → 移入 `.backup`（可恢复）；预装主题 → 只写隐藏位（N15，不物理删除） */
async function removeTheme(set: SetState, get: GetState, themeId: string): Promise<void> {
  const theme = getTheme(themeId);
  if (!theme || isBuiltinThemeId(themeId)) return;
  if (theme.source === "bundled") {
    const hidden = [...new Set([...get().hiddenBundled, themeId])];
    writeJSON(HIDDEN_BUNDLED_KEY, hidden);
    set({ hiddenBundled: hidden });
    if (get().themeId === themeId) get().setMode("light");
    await notify(
      "已隐藏预装主题",
      `「${theme.name}」是预装主题（由应用管理）：已从列表隐藏，不删除文件；下次启动会按源副本补齐（N15）。`,
      "info",
    );
    return;
  }
  const root = await themesRoot();
  const stamp = backupStamp();
  try {
    if (theme.css?.kind === "file") {
      const name = basenameOf(theme.css.path);
      await moveToBackup(root, name, stamp);
      await moveToBackup(root, name.replace(/\.css$/i, ""), stamp).catch(() => {});
    }
    removeSnapshotsFor(themeId);
    if (get().themeId === themeId) {
      writeStoredThemeId(DEFAULT_THEME_ID);
      applyTheme({ ...BUILTIN_LIGHT_THEME });
      set({ themeId: DEFAULT_THEME_ID, mode: "light" });
    }
    await syncThemes(set, get);
    await notify("已移除主题", `主题「${theme.name}」已移入主题目录的 .backup（可恢复）。`, "info");
  } catch (error) {
    await notify("移除失败", messageOf(error), "error");
  }
}

/** 「复制为我的主题」（N13）：预装主题不可原地改 → 复制成 `user:*` 独立文件 */
async function duplicateAsUserTheme(set: SetState, get: GetState, themeId: string): Promise<void> {
  const theme = getTheme(themeId);
  if (!theme || theme.css?.kind !== "file") return;
  const root = await themesRoot();
  await ensureDir(root);
  const bundled = getTheme(bundledThemeId(themeId.slice(themeId.indexOf(":") + 1)));
  const baseSlug = themeId.slice(themeId.indexOf(":") + 1);
  const targetId = getTheme(userThemeId(baseSlug)) ? undefined : userThemeId(baseSlug);
  const takenIds = new Set(listThemes().map((t) => t.id));
  let finalId = targetId ?? "";
  if (!finalId) {
    for (let n = 2; n < 1000; n += 1) {
      const candidate = userThemeId(`${baseSlug}-${n}`);
      if (!takenIds.has(candidate)) {
        finalId = candidate;
        break;
      }
    }
  }
  if (!finalId) return;
  const slug = finalId.slice(finalId.indexOf(":") + 1);
  try {
    await copyThemePath(theme.css.path, normalizePath(joinPath(root, `${slug}.css`)));
    const sourceName = basenameOf(theme.css.path).replace(/\.css$/i, "");
    await copyThemePath(
      normalizePath(joinPath(dirNameOf(theme.css.path), sourceName)),
      normalizePath(joinPath(root, slug)),
    ).catch(() => {});
    await syncThemes(set, get);
    if (getTheme(finalId)) get().setTheme(finalId);
    await notify(
      "已复制为我的主题",
      `${bundled ? "预装" : "该"}主题已复制为「${themeDisplayName(finalId)}」，改动只落 user:*（N13）。`,
      "info",
    );
  } catch (error) {
    await notify("复制失败", messageOf(error), "error");
  }
}

/** 「打开主题文件夹」：先确保目录存在；失败则提示（§10） */
async function openThemesFolder(): Promise<void> {
  try {
    const root = await themesRoot();
    await ensureDir(root);
    const dir = root;
    await revealPath(dir);
    if (!isTauri()) {
      await notify("主题文件夹", `主题目录：${dir}（桌面端会在文件管理器中打开）`, "info");
    }
  } catch (error) {
    await notify("打开主题文件夹失败", messageOf(error), "error");
  }
}

// 模块加载时：异步初始化自定义 CSS + 扫描主题目录（#307）
if (typeof window !== "undefined") {
  useTheme.getState().initCustomCSS().catch(() => {});
  useTheme
    .getState()
    .syncThemes()
    .catch(() => {});
}

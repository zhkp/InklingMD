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
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, message } from "@tauri-apps/plugin-dialog";
import { loadJSON, writeJSON } from "../lib/storage";
import {
  BUILTIN_DARK_ID,
  BUILTIN_LIGHT_ID,
  getTheme,
  listThemes,
  registerThemes,
  resolveLegacyThemeId,
  themeDisplayName,
  type AppTheme,
} from "../theme/registry";
import { applyTheme, currentThemeId, currentThemeMode } from "../theme/session";
import { injectUserCss } from "../theme/inject";
import {
  SNAPSHOT_PREFIX,
  THEMES_INDEX_KEY,
  THEME_KEY,
  readSnapshot,
  readThemesIndex,
  recordSnapshotState,
} from "../theme/snapshot";
import { registerStorageSync, registerStorageSyncPrefix } from "./storageSyncRegistry";
import type { ThemeMode } from "../theme/typora/metadata";

export type { ThemeMode };

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
  /** 切换主题（`themeId`） */
  setTheme: (themeId: string) => void;
  /** 兼容旧 UI：明暗二值切换 → `builtin:light` / `builtin:dark` */
  setMode: (mode: ThemeMode) => void;
  /** 重新读取清单（#307/#308 注册主题后调用） */
  refreshThemes: () => void;
  /** 初始化加载持久化的自定义 CSS */
  initCustomCSS: () => Promise<void>;
  /** 加载自定义 CSS 文件 */
  loadCustomCSS: () => Promise<void>;
  /** 清除自定义 CSS */
  clearCustomCSS: () => void;
}

const CUSTOM_CSS_PATH_KEY = "inkling-custom-css-path";

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
      applyThemeWithSnapshot(theme);
      set({ themeId: theme.id, mode: theme.mode });
    },

    setMode: (mode) => {
      get().setTheme(mode === "dark" ? BUILTIN_DARK_ID : BUILTIN_LIGHT_ID);
    },

    refreshThemes: () => set({ themes: listThemes() }),

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
function applyThemeWithSnapshot(theme: AppTheme): void {
  const hash = theme.hash;
  if (theme.css?.kind === "file" && hash) {
    const snap = readSnapshot(theme.id, hash);
    if (snap) {
      applyTheme(theme, { css: snap.css });
      return;
    }
    // 快照缺失：先把主题切过去（属性 + 持久化），CSS 等读盘完成后由调用方再注入
    recordSnapshotState({
      last: "missing",
      themeId: theme.id,
      hash,
      detail: "切换时快照缺失 → 由读盘路径补齐（允许一次可见切换）",
    });
    applyTheme(theme, { css: null });
    return;
  }
  applyTheme(theme);
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
      return;
    }
  } else {
    applyTheme(theme, { persist: false });
  }
  pendingRemoteThemeId = null;
  set({ themeId: theme.id, mode: theme.mode });
}

// 模块加载时异步尝试初始化自定义 CSS
if (typeof window !== "undefined") {
  useTheme.getState().initCustomCSS().catch(() => {});
}

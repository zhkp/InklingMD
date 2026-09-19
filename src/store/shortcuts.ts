// 应用级快捷键绑定状态
// 集中管理可由用户自定义的应用级快捷键（如查找、切换侧边栏、偏好设置）。
// 编辑器内的 Milkdown 预设快捷键（加粗、斜体等）不在自定义范围内。
// 持久化到 localStorage，App.tsx 通过 matchBinding 在 keydown 时匹配。
//
// 绑定字符串格式：小写、加号分隔，如 "mod+f"、"mod+shift+b"、"mod+\\"
//   mod = Ctrl（Win）/ Cmd（Mac）
//   shift、alt 为可选修饰键
//   最后一段为按键名（单字符或特殊键名，如 backspace、enter）

import { create } from "zustand";
import { loadJSON, writeJSON } from "../lib/storage";

/** 可自定义快捷键 ID */
export type ShortcutId =
  | "find"
  | "toggleSidebar"
  | "toggleOutline"
  | "showShortcuts"
  | "openSettings"
  | "toggleSourceMode"
  | "quickOpen";

export interface ShortcutDef {
  id: ShortcutId;
  desc: string;
  /** 默认绑定 */
  default: string;
}

/** 应用级快捷键定义（可自定义范围） */
export const SHORTCUT_DEFS: ShortcutDef[] = [
  { id: "find", desc: "查找替换", default: "mod+f" },
  { id: "toggleSidebar", desc: "切换侧边栏", default: "mod+\\" },
  { id: "toggleOutline", desc: "切换大纲面板", default: "mod+'" },
  { id: "showShortcuts", desc: "显示快捷键帮助", default: "mod+/" },
  { id: "openSettings", desc: "打开偏好设置", default: "mod+," },
  { id: "toggleSourceMode", desc: "切换源代码模式", default: "mod+alt+s" },
  // 与 Typora / VS Code 一致：mod+p 是「快速打开」。CodeMirror 默认 keymap 不占用
  // Mod-p，故源码模式下不会双重触发（由 shortcuts.test 断言锁定，防将来 CM 升级漂移）。
  { id: "quickOpen", desc: "快速打开文件", default: "mod+p" },
];

/**
 * 保留快捷键定义（硬编码内置或固定快捷键，不可被自定义覆盖）
 */
export interface ReservedShortcutDef {
  binding: string;
  desc: string;
}

export const RESERVED_SHORTCUTS: ReservedShortcutDef[] = [
  { binding: "mod+s", desc: "保存当前文件" },
  { binding: "mod+n", desc: "新建未命名草稿" },
  { binding: "mod+shift+f", desc: "全局搜索" },
  { binding: "mod+r", desc: "查找与替换" },
  { binding: "mod+k", desc: "插入超链接" },
  { binding: "mod+alt+0", desc: "转普通段落" },
  { binding: "mod+0", desc: "重置编辑器缩放" },
  { binding: "f11", desc: "切换禅模式" },
];

const STORAGE_KEY = "inkling-shortcuts";

interface Persisted {
  overrides: Partial<Record<ShortcutId, string>>;
}

const VALID_SHORTCUT_IDS = new Set<ShortcutId>(SHORTCUT_DEFS.map((d) => d.id));

function sanitizeOverrides(raw: unknown): Partial<Record<ShortcutId, string>> {
  if (!raw || typeof raw !== "object") return {};
  const clean: Partial<Record<ShortcutId, string>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (VALID_SHORTCUT_IDS.has(key as ShortcutId) && typeof val === "string") {
      clean[key as ShortcutId] = val;
    }
  }
  return clean;
}

function loadPersisted(): Persisted {
  const raw = loadJSON<Persisted>(STORAGE_KEY, { overrides: {} });
  return { overrides: sanitizeOverrides(raw?.overrides) };
}

function persist(p: Persisted): void {
  writeJSON(STORAGE_KEY, p);
}

export interface ShortcutsState {
  overrides: Partial<Record<ShortcutId, string>>;
  /** 读取某快捷键当前绑定（含默认值回退） */
  getBinding: (id: ShortcutId) => string;
  /** 设置某快捷键绑定（覆盖默认） */
  setBinding: (id: ShortcutId, binding: string) => void;
  /** 重置某快捷键为默认 */
  resetBinding: (id: ShortcutId) => void;
  /** 全部重置为默认 */
  resetAll: () => void;
}

const initial = loadPersisted();

export const useShortcuts = create<ShortcutsState>((set, get) => {
  // 监听多窗口/跨标签页的快捷键覆盖同步（storage 事件只在其他窗口触发）
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) as Partial<Persisted>;
          set({ overrides: sanitizeOverrides(parsed?.overrides) });
        } catch {
          // 忽略非法 JSON
        }
      }
    });
  }

  return {
    overrides: initial.overrides,

    getBinding: (id) => {
      const o = get().overrides[id];
      if (o) return o;
      return SHORTCUT_DEFS.find((d) => d.id === id)?.default ?? "";
    },

    setBinding: (id, binding) => {
      const next = { ...get().overrides, [id]: binding };
      set({ overrides: next });
      persist({ overrides: next });
    },

    resetBinding: (id) => {
      const next = { ...get().overrides };
      delete next[id];
      set({ overrides: next });
      persist({ overrides: next });
    },

    resetAll: () => {
      set({ overrides: {} });
      persist({ overrides: {} });
    },
  };
});

// "mod" 是 Ctrl/Cmd 的占位标记，必须在 find 时被跳过，
// 否则 parts.find 会把 "mod" 当作最终按键，导致 e.key === "mod" 永远 false
const MODIFIER_KEYS = new Set(["control", "shift", "alt", "meta", "mod"]);

/** 判断键盘事件是否匹配绑定字符串 */
export function matchBinding(binding: string, e: KeyboardEvent): boolean {
  const parts = binding.toLowerCase().split("+");
  const needsMod = parts.includes("mod");
  const needsShift = parts.includes("shift");
  const needsAlt = parts.includes("alt");
  const key = parts.find((p) => !MODIFIER_KEYS.has(p));
  if (!key) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (needsMod !== mod) return false;
  if (needsShift !== e.shiftKey) return false;
  if (needsAlt !== e.altKey) return false;
  return e.key.toLowerCase() === key;
}

const MAC_PLATFORM = /Mac|iPhone|iPad/.test(navigator.platform);

/** 把绑定字符串格式化为展示用（如 ⌘+Shift+B） */
export function formatBinding(binding: string): string {
  const parts = binding.toLowerCase().split("+");
  return parts
    .map((p) => {
      if (p === "mod") return MAC_PLATFORM ? "⌘" : "Ctrl";
      if (p === "shift") return MAC_PLATFORM ? "⇧" : "Shift";
      if (p === "alt") return MAC_PLATFORM ? "⌥" : "Alt";
      // 单字符按键大写显示（如 f → F）
      if (p.length === 1) return p.toUpperCase();
      return p;
    })
    .join("+");
}

/** 从键盘事件捕获绑定字符串。返回 null 表示尚未捕获（如仅按了修饰键） */
export function captureFromEvent(e: KeyboardEvent): string | null {
  // 仅按修饰键不算捕获
  if (MODIFIER_KEYS.has(e.key.toLowerCase())) return null;
  // 必须有 mod（Ctrl/Cmd）才能绑定
  if (!(e.ctrlKey || e.metaKey)) return null;
  const parts: string[] = ["mod"];
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");
  // 单字符直接小写，特殊键取小写名
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(key);
  return parts.join("+");
}

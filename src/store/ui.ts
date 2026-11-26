// UI 状态管理
// 跟踪侧边栏、大纲面板等 UI 元素的可见性，配合全局快捷键切换。
// 状态持久化到 localStorage，下次启动恢复用户偏好。

import { create } from "zustand";
import { loadJSON, writeJSON } from "../lib/storage";

/** 侧边栏可折叠区块标识（issue #167：折叠状态持久化） */
export type SidebarSectionId = "recents" | "bookmarks" | "snapshots";

/** 各区块是否展开 */
export type SidebarSectionExpanded = Record<SidebarSectionId, boolean>;

/** 非阻塞提示（草稿超限等）：不打断输入，自动消失 */
export interface UINotice {
  id: number;
  text: string;
}

export interface UIState {
  /** 侧边栏是否可见 */
  sidebarVisible: boolean;
  /** 大纲面板是否可见 */
  outlineVisible: boolean;
  /** 禅模式：隐藏所有 UI，仅保留编辑器 */
  zenMode: boolean;
  /** 侧边栏区块（最近打开/书签/可恢复文件）的展开状态（issue #167） */
  sectionExpanded: SidebarSectionExpanded;
  /** 切换侧边栏可见性 */
  toggleSidebar: () => void;
  /** 切换大纲面板可见性 */
  toggleOutline: () => void;
  /** 直接设置侧边栏可见性 */
  setSidebarVisible: (v: boolean) => void;
  /** 直接设置大纲面板可见性 */
  setOutlineVisible: (v: boolean) => void;
  /** 切换禅模式 */
  toggleZenMode: () => void;
  /** 直接设置禅模式 */
  setZenMode: (v: boolean) => void;
  /** 切换指定侧边栏区块的展开/折叠（issue #167） */
  toggleSectionExpanded: (section: SidebarSectionId) => void;
  /** 当前非阻塞提示（不持久化） */
  notice: UINotice | null;
  /** 弹一条非阻塞提示；不能用于必须用户确认的事（那走 dialogs.showMessage） */
  showNotice: (text: string) => void;
  /** 关掉提示；传 id 时只关那一条，避免把后来的新提示误关 */
  dismissNotice: (id?: number) => void;
}

let noticeSeq = 0;

const STORAGE_KEY = "inkling-ui";

interface PersistedUI {
  sidebarVisible: boolean;
  outlineVisible: boolean;
  sectionExpanded: SidebarSectionExpanded;
}

const DEFAULT_SECTION_EXPANDED: SidebarSectionExpanded = {
  recents: true,
  bookmarks: true,
  snapshots: true,
};

const DEFAULTS: PersistedUI = {
  sidebarVisible: true,
  outlineVisible: true,
  sectionExpanded: DEFAULT_SECTION_EXPANDED,
};

/** 逐字段校验区块展开状态；非法/缺失字段回退默认（保持展开） */
function loadSectionExpanded(value: unknown): SidebarSectionExpanded {
  const src = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const result: SidebarSectionExpanded = { ...DEFAULT_SECTION_EXPANDED };
  (Object.keys(DEFAULT_SECTION_EXPANDED) as SidebarSectionId[]).forEach((id) => {
    if (typeof src[id] === "boolean") result[id] = src[id] as boolean;
  });
  return result;
}

function loadPersisted(): PersistedUI {
  const loaded = loadJSON<Partial<PersistedUI>>(STORAGE_KEY, DEFAULTS);
  return {
    sidebarVisible: typeof loaded?.sidebarVisible === "boolean" ? loaded.sidebarVisible : DEFAULTS.sidebarVisible,
    outlineVisible: typeof loaded?.outlineVisible === "boolean" ? loaded.outlineVisible : DEFAULTS.outlineVisible,
    sectionExpanded: loadSectionExpanded(loaded?.sectionExpanded),
  };
}

const initial = loadPersisted();

export const useUI = create<UIState>((set, get) => {
  /** 持久化当前全部可持久化字段（含区块折叠状态，issue #167） */
  const persistCurrent = (patch: Partial<Omit<PersistedUI, "sectionExpanded">> & { sectionExpanded?: SidebarSectionExpanded }) => {
    const state = get();
    writeJSON(STORAGE_KEY, {
      sidebarVisible: patch.sidebarVisible ?? state.sidebarVisible,
      outlineVisible: patch.outlineVisible ?? state.outlineVisible,
      sectionExpanded: patch.sectionExpanded ?? state.sectionExpanded,
    });
  };

  return {
    sidebarVisible: initial.sidebarVisible,
    outlineVisible: initial.outlineVisible,
    // 禅模式不持久化，默认从普通模式启动
    zenMode: false,
    sectionExpanded: initial.sectionExpanded,

    toggleSidebar: () => {
      const next = !get().sidebarVisible;
      set({ sidebarVisible: next });
      persistCurrent({ sidebarVisible: next });
    },
    toggleOutline: () => {
      const next = !get().outlineVisible;
      set({ outlineVisible: next });
      persistCurrent({ outlineVisible: next });
    },
    setSidebarVisible: (v) => {
      set({ sidebarVisible: v });
      persistCurrent({ sidebarVisible: v });
    },
    setOutlineVisible: (v) => {
      set({ outlineVisible: v });
      persistCurrent({ outlineVisible: v });
    },
    toggleZenMode: () => set({ zenMode: !get().zenMode }),
    setZenMode: (v) => set({ zenMode: v }),
    toggleSectionExpanded: (section) => {
      const next = { ...get().sectionExpanded, [section]: !get().sectionExpanded[section] };
      set({ sectionExpanded: next });
      persistCurrent({ sectionExpanded: next });
    },

    notice: null,
    showNotice: (text) => {
      noticeSeq += 1;
      set({ notice: { id: noticeSeq, text } });
    },
    dismissNotice: (id) => {
      const current = get().notice;
      if (!current) return;
      if (id !== undefined && current.id !== id) return;
      set({ notice: null });
    },
  };
});

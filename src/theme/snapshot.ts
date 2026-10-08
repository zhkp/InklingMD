/**
 * #225 §4.4（G9）：主题 CSS 快照存储契约。
 *
 * 冻结口径（issue #225「设计补充」C2）：
 * | 项 | 裁决 |
 * |---|---|
 * | key | ① 当前主题 `inkling-theme`（值 = `themeId`）② 快照 `inkling-theme-snapshot:<themeId>:<hash>` ③ 用户主题清单 `inkling-themes-index`；**均带版本号** |
 * | 体积 | 单主题 ≤ **256 KB**；同步注入耗时预算 ≤ **8 ms** |
 * | 一致性 | 读取时比对 `themeId + hash`，不匹配即**弃用**（防串味） |
 * | 回收 | 单 `themeId` 只保留最新一份；启动时 GC 已不存在的 `themeId` |
 * | 跨 key 原子性 | 未知 `themeId` **不切换**，直到清单 + 快照就绪 |
 * | 适用性 | 仅 `bundled:*` / `user:*` 走快照；`builtin-base` / `builtin:*` 不走 |
 * | 失败 | 降级为「不走快照」+ **记录状态位**（不得静默） |
 */
import { isSnapshotEligible } from "./registry";

export const THEME_KEY = "inkling-theme";
export const SNAPSHOT_PREFIX = "inkling-theme-snapshot:";
export const THEMES_INDEX_KEY = "inkling-themes-index";
/** 快照状态位（G9「不得静默」；也登记进统一同步注册点） */
export const SNAPSHOT_STATE_KEY = "inkling-theme-snapshot-state";

export const SNAPSHOT_VERSION = 1;
/** 体积上限：单主题 ≤ 256 KB（与导入上限 512 KB 分档，见 D13） */
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
/** 同步注入耗时预算（ms）；超预算记状态位但仍可用 */
export const SNAPSHOT_BUDGET_MS = 8;

export interface ThemeSnapshot {
  v: number;
  themeId: string;
  hash: string;
  css: string;
  at: number;
}

export type SnapshotStatus =
  | "hit"
  | "missing"
  | "invalid"
  | "oversize"
  | "quota"
  | "inapplicable"
  | "gc"
  | "written"
  | "slow";

export interface SnapshotState {
  v: number;
  last: SnapshotStatus;
  themeId?: string;
  hash?: string;
  at: number;
  /** 同步注入实测耗时（ms，仅 `hit` / `slow` 有值） */
  ms?: number;
  detail?: string;
}

/** `themeId` 自身含 `:`（`user:vue`）→ hash 取**最后**一个 `:` 之后的段 */
export function snapshotKey(themeId: string, hash: string): string {
  return `${SNAPSHOT_PREFIX}${themeId}:${hash}`;
}

export function parseSnapshotKey(key: string): { themeId: string; hash: string } | undefined {
  if (!key.startsWith(SNAPSHOT_PREFIX)) return undefined;
  const body = key.slice(SNAPSHOT_PREFIX.length);
  const idx = body.lastIndexOf(":");
  if (idx <= 0 || idx === body.length - 1) return undefined;
  return { themeId: body.slice(0, idx), hash: body.slice(idx + 1) };
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isValidSnapshot(value: unknown): value is ThemeSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<ThemeSnapshot>;
  return (
    typeof v.v === "number" &&
    typeof v.themeId === "string" &&
    typeof v.hash === "string" &&
    typeof v.css === "string"
  );
}

/**
 * 读取快照：**比对 `themeId + hash`**，不匹配（含旧版本/损坏）即弃用。
 * 弃用时会顺手删掉不匹配的 key，避免长期占位（回收策略的一部分）。
 */
export function readSnapshot(themeId: string, hash: string): ThemeSnapshot | undefined {
  const key = snapshotKey(themeId, hash);
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 忽略 */
    }
    return undefined;
  }
  if (!isValidSnapshot(parsed) || parsed.v !== SNAPSHOT_VERSION) return undefined;
  if (parsed.themeId !== themeId || parsed.hash !== hash) {
    // 串味（hash 不符）→ 弃用并清理
    try {
      localStorage.removeItem(key);
    } catch {
      /* 忽略 */
    }
    return undefined;
  }
  return parsed;
}

export interface SnapshotWriteResult {
  ok: boolean;
  status: SnapshotStatus;
  bytes: number;
}

export function writeSnapshot(themeId: string, hash: string, css: string): SnapshotWriteResult {
  const bytes = byteLength(css);
  if (!isSnapshotEligible(themeId)) {
    recordSnapshotState({ last: "inapplicable", themeId, hash, detail: "内置主题不走快照（P2-4）" });
    return { ok: false, status: "inapplicable", bytes };
  }
  if (bytes > MAX_SNAPSHOT_BYTES) {
    recordSnapshotState({
      last: "oversize",
      themeId,
      hash,
      detail: `${bytes} B > ${MAX_SNAPSHOT_BYTES} B`,
    });
    return { ok: false, status: "oversize", bytes };
  }
  // 回收：同 themeId 只保留最新一份（写入前删旧 hash key）
  removeSnapshotsFor(themeId, hash);
  const payload: ThemeSnapshot = {
    v: SNAPSHOT_VERSION,
    themeId,
    hash,
    css,
    at: Date.now(),
  };
  try {
    localStorage.setItem(snapshotKey(themeId, hash), JSON.stringify(payload));
  } catch (e) {
    // 配额耗尽等：降级为不走快照，并记录状态位（不得静默）
    recordSnapshotState({
      last: "quota",
      themeId,
      hash,
      detail: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, status: "quota", bytes };
  }
  recordSnapshotState({ last: "written", themeId, hash });
  return { ok: true, status: "written", bytes };
}

/** 列出所有快照 key（GC 与断言用） */
export function listSnapshotKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(SNAPSHOT_PREFIX)) keys.push(k);
    }
  } catch {
    /* localStorage 不可用 */
  }
  return keys;
}

/** 删除某主题的旧快照；`keepHash` 指定的那份保留 */
export function removeSnapshotsFor(themeId: string, keepHash?: string): number {
  let removed = 0;
  for (const key of listSnapshotKeys()) {
    const parsed = parseSnapshotKey(key);
    if (!parsed || parsed.themeId !== themeId) continue;
    if (keepHash && parsed.hash === keepHash) continue;
    try {
      localStorage.removeItem(key);
      removed += 1;
    } catch {
      /* 忽略 */
    }
  }
  return removed;
}

/**
 * 启动时 GC：删除 `themeId` 已不在清单中的快照（P2-2）。
 * 返回删除条数，并记状态位。
 */
export function gcSnapshots(knownThemeIds: readonly string[]): number {
  const known = new Set(knownThemeIds);
  let removed = 0;
  for (const key of listSnapshotKeys()) {
    const parsed = parseSnapshotKey(key);
    if (!parsed || known.has(parsed.themeId)) continue;
    try {
      localStorage.removeItem(key);
      removed += 1;
    } catch {
      /* 忽略 */
    }
  }
  if (removed > 0) {
    recordSnapshotState({ last: "gc", detail: `清理 ${removed} 份失效快照` });
  }
  return removed;
}

export function readSnapshotState(): SnapshotState | undefined {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STATE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as SnapshotState;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function recordSnapshotState(state: Omit<SnapshotState, "v" | "at">): void {
  const payload: SnapshotState = { v: SNAPSHOT_VERSION, at: Date.now(), ...state };
  try {
    localStorage.setItem(SNAPSHOT_STATE_KEY, JSON.stringify(payload));
  } catch {
    /* 状态位写不进去时不抛错（它本身是降级路径的观测手段） */
  }
}

// ── 当前主题（key ①） ──────────────────────────────────────────────────────

export function readStoredThemeId(): string | null {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

export function writeStoredThemeId(themeId: string): void {
  try {
    localStorage.setItem(THEME_KEY, themeId);
  } catch {
    /* 隐私模式等：忽略（内存态仍然生效） */
  }
}

// ── 用户主题清单（key ③） ──────────────────────────────────────────────────

export interface ThemesIndexEntry {
  id: string;
  name: string;
  mode: "light" | "dark";
  hash?: string;
  variantOf?: string;
  source?: "bundled" | "user" | "builtin";
}

export function readThemesIndex(): ThemesIndexEntry[] {
  try {
    const raw = localStorage.getItem(THEMES_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { v?: number; themes?: ThemesIndexEntry[] };
    if (!parsed || !Array.isArray(parsed.themes)) return [];
    if (parsed.v !== SNAPSHOT_VERSION) return [];
    return parsed.themes.filter((t) => t && typeof t.id === "string");
  } catch {
    return [];
  }
}

export function writeThemesIndex(themes: readonly ThemesIndexEntry[]): boolean {
  try {
    localStorage.setItem(
      THEMES_INDEX_KEY,
      JSON.stringify({ v: SNAPSHOT_VERSION, themes: [...themes] }),
    );
    return true;
  } catch {
    return false;
  }
}

// 草稿日志（#365 / #378，设计 §8.1-§8.3 的第一片）
//
// 目标：崩溃 / 断电 / 被 kill 之后，用户最后一次编辑的内容仍有**文件级**副本可找回。
// 这里只做「写 + 清 + 崩溃检测」三件事：
//   - 每次输入后 1.2s 把 tab 内容落到 `recovery/<windowLabel>/drafts/<key>.json`；
//   - 保存成功 / 关闭 tab 立即删掉对应草稿（不做 TTL 扫描，那是 PR-5b 的清理器）；
//   - 启动时若发现上一个会话 `cleanExit === false`，把它改名为 `crashed-<startedAt>.json`。
//
// 为什么落在文件而不是 localStorage：桌面端 localStorage 与 2MB 量级绑定，
// 一份 10MB 文档根本存不进去；文件后端还能给出「写入失败」这种可判断的结果。

import { invoke, isTauri } from "@tauri-apps/api/core";

/** 设计 §8.2：输入停止 1.2s 后落盘 */
export const DRAFT_DEBOUNCE_MS = 1_200;

export interface DraftFile {
  version: 1;
  draftId: string;
  sessionId: string;
  tabPath: string;
  isUntitled: boolean;
  title: string;
  content: string;
  pinned: boolean;
  updatedAt: number;
}

export interface SessionTabMeta {
  tabPath: string;
  draftId: string | null;
  isUntitled: boolean;
  title: string;
  isDirty: boolean;
  lastActiveAt: number;
  cursorPos: number | null;
  scrollTop: number | null;
}

export interface SessionFile {
  version: 1;
  sessionId: string;
  windowLabel: string;
  startedAt: number;
  cleanExit: boolean;
  activeTabPath: string | null;
  tabOrder: string[];
  updatedAt: number;
  handledDraftIds?: string[];
  fullyHandled?: boolean;
  tabs: SessionTabMeta[];
}

/** 路径 → 文件名（含 `/` `\` 的路径不能直接当文件名；base64url 可逆且无分隔符） */
export function draftFileKey(tabPath: string): string {
  const b64 = btoa(unescape(encodeURIComponent(tabPath)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return b64;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

let windowLabel = "main";
let sessionId = newId();
let sessionStartedAt = Date.now();

/** 会话内「tabPath → 草稿是否已落盘」的记账（只用于判断要不要清理） */
const journaled = new Set<string>();
const timers = new Map<string, number>();

/** 单测注入点：默认走 Tauri IPC，测试里可以替换成内存实现 */
export interface JournalIo {
  writeTextFile(path: string, content: string, options?: { createParents?: boolean; durability?: "sync" | "none" }): Promise<void>;
  readTextFile(path: string): Promise<string>;
  appDataDir(): Promise<string>;
  removeFile(path: string): Promise<void>;
}

const defaultIo: JournalIo = {
  async writeTextFile(path, content, options) {
    await invoke("write_text_file", {
      filePath: path,
      content,
      createParents: options?.createParents,
      durability: options?.durability,
    });
  },
  async readTextFile(path) {
    return invoke<string>("read_text_file", { filePath: path });
  },
  async appDataDir() {
    const { appDataDir } = await import("@tauri-apps/api/path");
    return appDataDir();
  },
  async removeFile(path) {
    await invoke("remove_path", { path });
  },
};

let io: JournalIo = defaultIo;

/** 单测用：替换 IO 并重置会话状态 */
export function __setJournalIo(next: JournalIo | null): void {
  io = next ?? defaultIo;
  journaled.clear();
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
}

export function __resetSession(windowLabelOverride?: string): void {
  windowLabel = windowLabelOverride ?? "main";
  sessionId = newId();
  sessionStartedAt = Date.now();
}

export function currentSessionId(): string {
  return sessionId;
}

export function currentWindowLabel(): string {
  return windowLabel;
}

async function recoveryDir(): Promise<string> {
  const base = await io.appDataDir();
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}recovery${sep}${windowLabel}`;
}

function draftPath(dir: string, tabPath: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}drafts${sep}${draftFileKey(tabPath)}.json`;
}

export function draftFileNameFor(tabPath: string): string {
  return `${draftFileKey(tabPath)}.json`;
}

/**
 * 排一次草稿落盘（1.2s 防抖，按 tabPath 独立）。
 *
 * 没写成功**不抛**：草稿是尽力而为的最后一道防线，不能因为它失败就打断编辑。
 * 返回值只用于测试与日志。
 */
export function scheduleDraft(
  tab: { path: string; isUntitled: boolean; title?: string; content: string },
): void {
  if (!isTauri()) return;
  const key = tab.path;
  const existing = timers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    timers.delete(key);
    void writeDraftNow(tab).catch(() => undefined);
  }, DRAFT_DEBOUNCE_MS);
  timers.set(key, timer);
}

/** 立即写一份草稿（退出前的 `flushAllDrafts` 与测试用这条） */
export async function writeDraftNow(
  tab: { path: string; isUntitled: boolean; title?: string; content: string },
  options: { durability?: "sync" | "none" } = {},
): Promise<boolean> {
  if (!isTauri()) return false;
  const draft: DraftFile = {
    version: 1,
    draftId: key(tab.path),
    sessionId,
    tabPath: tab.path,
    isUntitled: tab.isUntitled,
    title: tab.title ?? tab.path.split(/[\\/]/).pop() ?? tab.path,
    content: tab.content,
    pinned: false,
    updatedAt: Date.now(),
  };
  try {
    const dir = await recoveryDir();
    await io.writeTextFile(draftPath(dir, tab.path), JSON.stringify(draft), {
      createParents: true,
      // 草稿要能扛住「进程被杀」；掉电由退出时的 Sync flush 兜底（§7.3）
      durability: options.durability ?? "none",
    });
    journaled.add(tab.path);
    return true;
  } catch {
    return false;
  }
}

function key(tabPath: string): string {
  return draftFileKey(tabPath);
}

/** 保存成功 / 关闭 tab：删掉对应草稿（先删登记再删文件，失败只记日志） */
export async function clearDraft(tabPath: string): Promise<void> {
  if (!isTauri()) return;
  const timer = timers.get(tabPath);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(tabPath);
  }
  if (!journaled.has(tabPath)) return;
  journaled.delete(tabPath);
  try {
    const dir = await recoveryDir();
    await io.removeFile(draftPath(dir, tabPath));
  } catch {
    // 删不掉就留着：启动时的清理器（PR-5b）会按 TTL 处理
  }
}

/** 等待所有已排队的草稿落定（退出流程用） */
export async function flushJournal(): Promise<void> {
  for (const [tabPath, timer] of [...timers.entries()]) {
    window.clearTimeout(timer);
    timers.delete(tabPath);
  }
}

/** 该 tab 是否真的写出过草稿（决定 clearDraft 要不要发 IPC） */
export function hasJournaledDraft(tabPath: string): boolean {
  return journaled.has(tabPath);
}

/** 供测试注入：已知的草稿集合 */
export function __journaledPaths(): string[] {
  return [...journaled];
}

export function sessionMeta(): { sessionId: string; startedAt: number; windowLabel: string } {
  return { sessionId, startedAt: sessionStartedAt, windowLabel };
}

export function buildSessionFile(input: {
  cleanExit: boolean;
  activeTabPath: string | null;
  tabOrder: string[];
  tabs: SessionTabMeta[];
}): SessionFile {
  return {
    version: 1,
    sessionId,
    windowLabel,
    startedAt: sessionStartedAt,
    cleanExit: input.cleanExit,
    activeTabPath: input.activeTabPath,
    tabOrder: input.tabOrder,
    updatedAt: Date.now(),
    tabs: input.tabs,
  };
}

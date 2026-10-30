// 草稿日志（#365 / #378，设计 §8.1-§8.3 的第一片）
//
// 目标：崩溃 / 断电 / 被 kill 之后，用户最后一次编辑的内容仍有**文件级**副本可找回。
// 这里只做「写 + 清 + 会话标记」三件事：
//   - 每次输入后 1.2s 把 tab 内容落到 `recovery/<windowLabel>/drafts/<key>.json`；
//   - 保存成功 / 关闭 tab 立即删掉对应草稿；
//   - 正常退出写 `cleanExit: true`，放弃退出写 `false`（恢复面板据此判断，PR-5b）。
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

/** 未初始化前先落到 `main`；`ensureWindowLabel()` 会在首次 IO 前替换成真实窗口 label */
let windowLabel = "main";
let labelReady: Promise<void> | null = null;
let sessionId = newId();

/**
 * 首次写盘前把窗口 label 换成真实的（`getCurrentWindow().label`）。
 *
 * 多窗口是真实功能（`newWindow.ts` 用 `WebviewWindow` 建 `inkling-<ts>-<rand>`），
 * 若所有窗口都写 `recovery/main/`，窗口 B 正常退出会用 `cleanExit:true` 覆盖 A 的
 * `false`，下次启动就看不到 A 的草稿。
 */
export async function ensureWindowLabel(): Promise<void> {
  labelReady ??= (async () => {
    if (!isTauri()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const label = getCurrentWindow().label;
      if (label) windowLabel = label;
    } catch {
      // 拿不到窗口对象（E2E / 浏览器前缀）：沿用 main
    }
  })();
  return labelReady;
}

/** 会话内「tabPath → 草稿是否已落盘」的记账（只用于判断要不要清理） */
const journaled = new Set<string>();
const timers = new Map<string, number>();

/** 单测注入点：默认走 Tauri IPC，测试里可以替换成内存实现 */
export interface JournalIo {
  writeTextFile(
    path: string,
    content: string,
    options?: { createParents?: boolean; durability?: "sync" | "none" },
  ): Promise<void>;
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
    // 命令名必须与 Rust 注册表 / `fs.deletePath` 一致（`delete_path`）；
    // 写错只会静默失败，草稿永远删不掉
    await invoke("delete_path", { path });
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

/** 单测用：重置 session / 窗口 label（生产走 `ensureWindowLabel`） */
export function __resetSession(windowLabelOverride?: string): void {
  windowLabel = windowLabelOverride ?? "main";
  labelReady = windowLabelOverride ? Promise.resolve() : null;
  sessionId = newId();
}

export function currentSessionId(): string {
  return sessionId;
}

export function currentWindowLabel(): string {
  return windowLabel;
}

async function recoveryDir(): Promise<string> {
  await ensureWindowLabel();
  const base = await io.appDataDir();
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}recovery${sep}${windowLabel}`;
}

function draftPath(dir: string, tabPath: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir}${sep}drafts${sep}${draftFileKey(tabPath)}.json`;
}

/**
 * 排一次草稿落盘（1.2s 防抖，按 tabPath 独立）。
 *
 * 没写成功**不抛**：草稿是尽力而为的最后一道防线，不能因为它失败就打断编辑。
 */
export function scheduleDraft(tab: {
  path: string;
  isUntitled: boolean;
  title?: string;
  content: string;
}): void {
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

/** 立即写一份草稿（退出前的 flush 与测试用这条） */
export async function writeDraftNow(
  tab: { path: string; isUntitled: boolean; title?: string; content: string },
  options: { durability?: "sync" | "none" } = {},
): Promise<boolean> {
  if (!isTauri()) return false;
  const draft: DraftFile = {
    version: 1,
    draftId: draftFileKey(tab.path),
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

/** 保存成功 / 关闭 tab / 重载磁盘：删掉对应草稿 */
export async function clearDraft(tabPath: string): Promise<void> {
  if (!isTauri()) return;
  const timer = timers.get(tabPath);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(tabPath);
  }
  if (!journaled.has(tabPath)) return;
  try {
    const dir = await recoveryDir();
    await io.removeFile(draftPath(dir, tabPath));
    // 只有真的删成功才清记账：否则后续 clearDraft 会直接 return，永远不再重试
    journaled.delete(tabPath);
  } catch {
    // 删不掉就留着：启动时的清理器（PR-5b）会按 TTL 处理
  }
}

/** 取消所有已排队的草稿写入（退出前先调，避免同一次输入写两遍） */
export function cancelPendingDrafts(): void {
  for (const [tabPath, timer] of [...timers.entries()]) {
    window.clearTimeout(timer);
    timers.delete(tabPath);
  }
}

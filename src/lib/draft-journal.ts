// 草稿日志（#365 / #378 / #409，设计 §8.1-§8.3）
//
// 目标：崩溃 / 断电 / 被 kill 之后，用户最后一次编辑的内容仍有**文件级**副本可找回。
// 职责：
//   - 每次输入后 1.2s 把 tab 内容落到 `recovery/<windowLabel>/drafts/<key>.json`；
//   - 保存成功 / 关闭 tab 立即删掉对应草稿；
//   - 正常退出写 `cleanExit: true`，放弃退出写 `false`（恢复面板据此判断，PR-5b）；
//   - #409 配额：单条草稿 10MB（按序列化后的 JSON 的 UTF-8 字节），超限跳过 + 非阻塞提示；
//   - 记录每次写盘结果（`ok` / `oversize` / `error`），供退出链路区分「主动跳过」与「写盘故障」。
//
// 为什么落在文件而不是 localStorage：桌面端 localStorage 与 2MB 量级绑定，
// 一份 10MB 文档根本存不进去；文件后端还能给出「写入失败」这种可判断的结果。

import { invoke, isTauri } from "@tauri-apps/api/core";

/** 设计 §8.2：输入停止 1.2s 后落盘 */
export const DRAFT_DEBOUNCE_MS = 1_200;

/** 设计 §8.3：桌面单条草稿上限，按**序列化后的 JSON** 的 UTF-8 字节计（信封也计入） */
export const DRAFT_MAX_BYTES = 10 * 1024 * 1024;
/** 设计 §8.3：桌面临时草稿总量上限；超了只淘汰「已 handled 的 crashed 会话副本」 */
const DRAFT_TOTAL_BYTES = 32 * 1024 * 1024;
let maxDraftTotalBytes = DRAFT_TOTAL_BYTES;

/** 当前生效的总量上限（配额检查用它，测试可缩小） */
export function draftTotalBytes(): number {
  return maxDraftTotalBytes;
}

/** 单测用：缩小总量上限，避免为了越过 32MB 在测试里造几十兆正文 */
export function __setDraftTotalBytes(next: number | null): void {
  maxDraftTotalBytes = next ?? DRAFT_TOTAL_BYTES;
}
/** 提示文案用的是设计口径（10MB），故意不跟随 `__setDraftMaxBytes` 的测试注入 */
const DRAFT_MAX_MB = DRAFT_MAX_BYTES / (1024 * 1024);

/**
 * 一次写盘的结果。
 *
 * `oversize` 是「主动跳过」，与 IO 失败必须分开：把它算成写盘故障会让
 * `journalHealth` 误降，其它明明有副本的文档在退出确认里也会被说成「永久丢失」。
 */
type DraftWriteOutcome = "ok" | "oversize" | "error";
export const lastDraftWriteOutcome = new Map<string, DraftWriteOutcome>();

/**
 * draftId(tabPath) → 盘上是否存在可信副本（退出确认据此判断「有没有副本」）。
 *
 * 写入点：`writeDraftNow` 写成功即 true；`flushAllDrafts` 再按本次结果覆盖
 * （超限但旧副本仍在时保持 true，见 `keepsOldCopy`）。
 * 清理点：`clearDraft` 真的删掉副本后 delete —— 否则一条历史 `true` 会让
 * `countDraftlessTabs()` 把「副本已不存在」的 tab 误判成有副本、放行退出。
 */
export const lastDraftWriteOk = new Map<string, boolean>();

let maxDraftBytes = DRAFT_MAX_BYTES;
/** 超限提示按 path 只出一次；重新写成功后清掉，文档再次变大时才会再提示 */
const oversizeNotified = new Set<string>();

const defaultNotify = (text: string): void => {
  void import("../store/ui").then(({ useUI }) => useUI.getState().showNotice(text));
};
let notify = defaultNotify;

/** 单测用：替换非阻塞提示通道（默认转发到全局提示条） */
export function __setNoticeSink(next: ((text: string) => void) | null): void {
  notify = next ?? defaultNotify;
}

/** 单测用：缩小上限，便于用小字符串覆盖多字节 / 信封 / 边界 */
export function __setDraftMaxBytes(next: number | null): void {
  maxDraftBytes = next ?? DRAFT_MAX_BYTES;
  // 改了上限就等于换了一套判定：提示去重必须重新武装，避免用例之间互相污染
  oversizeNotified.clear();
}

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
/** 本次运行开始时间：会话标记里记它，归档文件名才能稳定指向「哪一次运行」 */
const sessionStartedAt = Date.now();

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

/**
 * 单测注入点：默认走 Tauri IPC，测试里可以替换成内存实现。
 *
 * 这里**不放读取**：草稿读取由 `session-recovery` 的 `defaultIo.readTextFile` 走
 * `read_recovery_file`（12MB + 恢复区守卫）；本模块只负责写 / 清。
 */
export interface JournalIo {
  writeTextFile(
    path: string,
    content: string,
    options?: { createParents?: boolean; durability?: "sync" | "none" },
  ): Promise<void>;
  appDataDir(): Promise<string>;
  removeFile(path: string): Promise<void>;
}

const defaultIo: JournalIo = {
  async writeTextFile(path, content, options) {
    // 走恢复区专用通道（`write_recovery_file`）：它固定 createParents、不需要 expected，
    // 与文档保存的 `write_text_file` 契约分开，避免误用到「可能被外部程序改写」的路径上
    const { writeRecoveryFile } = await import("./fs");
    await writeRecoveryFile(path, content, options?.durability === "sync" ? "sync" : "none");
  },
  async appDataDir() {
    // #404：与应用数据根同源（便携模式下去掉 `@tauri-apps/api/path` 的系统目录假设）
    const { appDataRoot } = await import("./appDataRoot");
    return appDataRoot();
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
  lastDraftWriteOutcome.clear();
  lastDraftWriteOk.clear();
  oversizeNotified.clear();
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

/** 本次运行的开始时间（会话标记里记它，归档文件名 `crashed-<startedAt>` 用） */
export function currentSessionStartedAt(): number {
  return sessionStartedAt;
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
  // 快路径：UTF-8 字节数恒 ≥ UTF-16 字符数，字符数已经超上限就不必真的序列化
  // （否则一份几十 MB 的文档会先被 JSON.stringify 再拒绝，白吃一份内存）
  if (tab.content.length > maxDraftBytes) return rejectOversize(tab.path);
  try {
    // `draftFileKey` 用 `encodeURIComponent`：孤立代理项等非法路径会抛 URIError。
    // 放进 try 内，让这种路径只表现为「这条草稿没写成」，而不是让 flushAllDrafts 整体 reject。
    const now = Date.now();
    const draft: DraftFile = {
      version: 1,
      draftId: draftFileKey(tab.path),
      sessionId,
      tabPath: tab.path,
      isUntitled: tab.isUntitled,
      title: tab.title ?? tab.path.split(/[\\/]/).pop() ?? tab.path,
      content: tab.content,
      pinned: false,
      updatedAt: now,
    };
    const payload = JSON.stringify(draft);
    // 设计 §8.3 的 10MB 按**序列化后的 JSON** 计：信封（tabPath / title / 时间戳）
    // 与被转义的字符都算在内。只量 content 会放过「正文刚好 10MB + 信封」的文件，
    // 而那种文件正好会被 12MB 的恢复区读取上限兜住、但已经超出配额承诺
    if (utf8Bytes(payload) > maxDraftBytes) return rejectOversize(tab.path);
    const dir = await recoveryDir();
    await io.writeTextFile(draftPath(dir, tab.path), payload, {
      createParents: true,
      // 草稿要能扛住「进程被杀」；掉电由退出时的 Sync flush 兜底（§7.3）
      durability: options.durability ?? "none",
    });
    journaled.add(tab.path);
    lastDraftWriteOutcome.set(tab.path, "ok");
    lastDraftWriteOk.set(tab.path, true);
    // 重新写成功 = 副本恢复更新：下次再超限要重新提示，否则用户会以为副本还在写
    oversizeNotified.delete(tab.path);
    return true;
  } catch {
    lastDraftWriteOutcome.set(tab.path, "error");
    return false;
  }
}

/** 序列化后 JSON 的 UTF-8 字节数（多字节字符按真实字节算，不按字符数） */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 单条超限：不写盘、只提示一次。
 *
 * 不删已有草稿：文档变大前写下的那份副本仍是用户唯一可找回的内容，
 * 删掉就把「副本偏旧」变成「完全没有副本」。
 */
function rejectOversize(tabPath: string): false {
  lastDraftWriteOutcome.set(tabPath, "oversize");
  if (!oversizeNotified.has(tabPath)) {
    oversizeNotified.add(tabPath);
    notify(`该文档超过 ${DRAFT_MAX_MB} MB，未建立崩溃恢复副本`);
  }
  return false;
}

/** 保存成功 / 关闭 tab / 重载磁盘：删掉对应草稿 */
export async function clearDraft(tabPath: string): Promise<void> {
  if (!isTauri()) return;
  const timer = timers.get(tabPath);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timers.delete(tabPath);
  }
  if (!journaled.has(tabPath)) {
    // 超限路径从未写成功过：journaled 里没有它，但提示历史仍要清——否则关掉重开同一路径
    // 再超限时用户收不到「未建立崩溃恢复副本」。这里没有副本可删，清了不会被写成假话。
    oversizeNotified.delete(tabPath);
    return;
  }
  try {
    const dir = await recoveryDir();
    await io.removeFile(draftPath(dir, tabPath));
    // 只有真的删成功才清记账：否则后续 clearDraft 会直接 return，永远不再重试
    journaled.delete(tabPath);
    // 副本已不存在：写盘成功表必须同步清掉，否则退出确认会凭一条历史 true 放行
    lastDraftWriteOk.delete(tabPath);
    // 副本确实删掉了才重置提示历史：删失败时盘上还留着旧副本，不能假装「没有副本」
    oversizeNotified.delete(tabPath);
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

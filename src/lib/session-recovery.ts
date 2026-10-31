// 崩溃恢复（#365 / #378 第二片）
//
// 数据来源：`recovery/<windowLabel>/session.json`（上次是否正常退出）+ `drafts/*.json`。
// 三件事：
//   1. `beginSession()`：本次启动先落一个 `cleanExit:false` 的会话标记；
//   2. `findRecoverableDrafts()`：上次不是正常退出 → 把草稿读出来交给用户决定；
//   3. `cleanupExpiredDrafts()`：只清「超过 7 天且非 pinned」的，绝不碰近期副本。
//
// 恢复入口**不自动恢复**：用户必须明确选择「恢复 / 丢弃」，否则一份过期草稿会
// 悄悄覆盖他已经改过的文件。

import { isTauri } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { ensureWindowLabel, currentWindowLabel, draftFileKey } from "./draft-journal";
import { useWorkspace } from "../store/workspace";

/** 设计 §8.3：7 天 TTL；只清超期且非 pinned 的草稿 */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoverableDraft {
  draftId: string;
  tabPath: string;
  isUntitled: boolean;
  title: string;
  content: string;
  pinned: boolean;
  updatedAt: number;
}

export interface RecoveryIo {
  appDataDir(): Promise<string>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(
    path: string,
    content: string,
    options?: { createParents?: boolean; durability?: "sync" | "none" },
  ): Promise<void>;
  listDir(path: string): Promise<Array<{ name: string; isDir: boolean }>>;
  deletePath(path: string): Promise<void>;
}

const defaultIo: RecoveryIo = {
  appDataDir,
  async readTextFile(path) {
    const { readTextFile } = await import("./fs");
    return readTextFile(path);
  },
  async writeTextFile(path, content, options) {
    const { writeTextFile } = await import("./fs");
    await writeTextFile(path, content, {
      createParents: options?.createParents,
      durability: options?.durability,
    });
  },
  async listDir(path) {
    const { listDir } = await import("./fs");
    const tree = await listDir(path);
    return (tree.children ?? []).map((child) => ({ name: child.name, isDir: child.is_dir }));
  },
  async deletePath(path) {
    const { deletePath } = await import("./fs");
    await deletePath(path);
  },
};

let io: RecoveryIo = defaultIo;

export function __setRecoveryIo(next: RecoveryIo | null): void {
  io = next ?? defaultIo;
}

function sepOf(base: string): string {
  return base.includes("\\") ? "\\" : "/";
}

async function sessionPaths(): Promise<{ dir: string; session: string; drafts: string }> {
  await ensureWindowLabel();
  const base = await io.appDataDir();
  const sep = sepOf(base);
  const dir = `${base.replace(/[\\/]+$/, "")}${sep}recovery${sep}${currentWindowLabel()}`;
  return { dir, session: `${dir}${sep}session.json`, drafts: `${dir}${sep}drafts` };
}

interface SessionMarker {
  version?: number;
  windowLabel?: string;
  cleanExit?: boolean;
  savedAt?: number;
}

/** 读上次的会话标记；文件不存在 / 解析失败一律按「没有会话」处理（不猜） */
export async function readSessionMarker(): Promise<SessionMarker | null> {
  if (!isTauri()) return null;
  try {
    const { session } = await sessionPaths();
    const raw = await io.readTextFile(session);
    const parsed = JSON.parse(raw) as SessionMarker;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 本次启动先落 `cleanExit:false`，并**返回上一次的标记**。
 *
 * 顺序很重要：标记文件只有一份，若先写后读，读到的永远是自己刚写的 `false`，
 * 「上次正常退出不提示」就变成死代码。调用方必须用返回的旧标记去判断要不要恢复。
 */
export async function beginSession(now = Date.now()): Promise<SessionMarker | null> {
  if (!isTauri()) return null;
  const previous = await readSessionMarker();
  try {
    const { session } = await sessionPaths();
    await io.writeTextFile(
      session,
      JSON.stringify({
        version: 1,
        windowLabel: currentWindowLabel(),
        cleanExit: false,
        savedAt: now,
      }),
      { createParents: true, durability: "sync" },
    );
    return previous;
  } catch {
    return previous;
  }
}

/** 读出所有草稿（含内容）；只有上次非正常退出时才有意义 */
export async function listDrafts(): Promise<RecoverableDraft[]> {
  if (!isTauri()) return [];
  let names: string[];
  try {
    const { drafts } = await sessionPaths();
    const entries = await io.listDir(drafts);
    names = entries.filter((e) => !e.isDir && e.name.endsWith(".json")).map((e) => e.name);
  } catch {
    // 目录还不存在：正常（从没崩溃过）
    return [];
  }
  const dirSep = sepOf(await io.appDataDir());
  const draftsDir = (await sessionPaths()).drafts;
  const out: RecoverableDraft[] = [];
  for (const name of names) {
    try {
      const raw = await io.readTextFile(`${draftsDir}${dirSep}${name}`);
      const parsed = JSON.parse(raw) as Partial<RecoverableDraft>;
      if (!parsed || typeof parsed.content !== "string" || typeof parsed.tabPath !== "string") {
        continue;
      }
      out.push({
        draftId: parsed.draftId ?? name.replace(/\.json$/, ""),
        tabPath: parsed.tabPath,
        isUntitled: !!parsed.isUntitled,
        title: parsed.title ?? parsed.tabPath,
        content: parsed.content,
        pinned: !!parsed.pinned,
        updatedAt: Number(parsed.updatedAt ?? 0),
      });
    } catch {
      // 单条损坏不影响其它：跳过
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 找出「值得提示恢复」的草稿。
 *
 * 上次正常退出（`cleanExit === true`）→ 返回空：正常退出时草稿已被 markCleanExit 清掉，
 * 残留的只可能是删除失败的，不应该拿它打扰用户。
 */
export async function findRecoverableDrafts(
  previousMarker?: SessionMarker | null,
): Promise<RecoverableDraft[]> {
  // 传进来就用它（启动流程里 `beginSession()` 已经把标记覆盖成 false 了）
  const marker = previousMarker ?? (await readSessionMarker());
  if (marker?.cleanExit !== false) return [];
  return listDrafts();
}

export async function discardDrafts(drafts: RecoverableDraft[]): Promise<number> {
  if (!isTauri()) return 0;
  const sep = sepOf(await io.appDataDir());
  const { drafts: draftsDir } = await sessionPaths();
  let deleted = 0;
  for (const draft of drafts) {
    try {
      await io.deletePath(`${draftsDir}${sep}${draftFileKey(draft.tabPath)}.json`);
      deleted += 1;
    } catch {
      // 删不掉就留着：下次启动还会提示，不会静默丢内容
    }
  }
  return deleted;
}

/**
 * 把草稿恢复成 tab。
 *
 * 恢复出来的 tab 一律 `dirty: true` 且**不登记磁盘基线**（`diskStat` 为空）：
 * 崩溃前那份磁盘内容已经不可信，保存时会走「必须存在」的写盘并要求用户确认，
 * 不会静默覆盖用户在这期间对文件的修改。
 */
export async function applyRecovery(drafts: RecoverableDraft[]): Promise<number> {
  if (drafts.length === 0) return 0;
  const state = useWorkspace.getState();
  const existing = new Set(state.openTabs.map((t) => t.path));
  const candidates = drafts.filter((d) => !existing.has(d.tabPath));
  if (candidates.length === 0) return 0;

  const { readDocument } = await import("./fs");
  const restored = [];
  for (const draft of candidates) {
    // 有路径的草稿必须先取一次「当前磁盘基线」：否则 `saveTab` 的一致性预检
    // 因为基线为空而永远判「没冲突」，用户点恢复再保存就会静默覆盖外部改动
    let diskContent: string | undefined;
    let diskStat: { mtimeUs: number; size: number } | undefined;
    let diskMtime: number | undefined;
    if (!draft.isUntitled) {
      try {
        const snapshot = await readDocument(draft.tabPath);
        diskContent = snapshot.content;
        diskStat = snapshot.stat;
        diskMtime = snapshot.stat.mtimeUs / 1000;
      } catch {
        // 文件已不在：留空基线，保存时会走「必须存在」的写盘并被拒
      }
    }
    restored.push({
      path: draft.tabPath,
      content: draft.content,
      dirty: true,
      isUntitled: draft.isUntitled,
      lastSavedAt: null,
      cursorPos: null,
      scrollTop: null,
      diskContent,
      diskStat,
      diskMtime,
    });
  }

  const first = restored[0];
  useWorkspace.setState({
    openTabs: [...state.openTabs, ...restored],
    activeTabPath: first.path,
    // 与 mainTabPatch 的约定一致：无标题草稿也有虚拟路径（untitled-N）
    currentFile: first.path,
    currentContent: first.content,
    dirty: true,
  } as never);
  return restored.length;
}

/** 只清「超过 TTL 且非 pinned」的草稿；返回删除条数 */
export async function cleanupExpiredDrafts(
  now = Date.now(),
  ttlMs = DRAFT_TTL_MS,
): Promise<number> {
  const drafts = await listDrafts();
  const expired = drafts.filter((d) => !d.pinned && d.updatedAt > 0 && now - d.updatedAt > ttlMs);
  if (expired.length === 0) return 0;
  return discardDrafts(expired);
}

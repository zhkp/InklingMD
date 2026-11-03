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
import { detectEol } from "./eol";
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
    const { writeRecoveryFile } = await import("./fs");
    await writeRecoveryFile(path, content, options?.durability === "sync" ? "sync" : "none");
  },
  async listDir(path) {
    // `list_dir_files` 只列一层，正好是草稿目录需要的粒度（`drafts/*.json`）
    const { listDirFiles } = await import("./fs");
    const entries = await listDirFiles(path);
    return entries.map((e) => ({ name: e.name, isDir: e.isDir }));
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
 * 恢复出来的 tab 一律 `dirty: true`。对**有路径**的草稿会读一次当前磁盘内容作为基线
 * （`diskContent` / `diskStat` / `diskMtime`）——之后磁盘若再变更，保存会走
 * 「将覆盖外部修改」的冲突确认；文件已不存在则留空基线，保存被 `mustExist` 拒绝，
 * 不会静默覆盖用户在这期间对文件的修改。
 */
export async function applyRecovery(
  drafts: RecoverableDraft[],
): Promise<{ restored: number; restoredPaths: string[] }> {
  if (drafts.length === 0) return { restored: 0, restoredPaths: [] };
  const state = useWorkspace.getState();
  const { readDocument } = await import("./fs");
  const restored = [];
  /** 合并进已打开 tab 的 path：内容已被接手，但仍要排除在本次 TTL 清理之外 */
  const mergedPaths: string[] = [];
  for (const draft of drafts) {
    // 已打开的 tab 走合并：不能因为「这个文件已经开着」就把草稿丢掉，
    // 也不能无条件用草稿覆盖用户手上正在改的内容
    if (state.openTabs.some((t) => t.path === draft.tabPath)) {
      if (mergeDraftIntoExistingTab(draft) === "merged") mergedPaths.push(draft.tabPath);
      continue;
    }
    // 有路径的草稿必须先取一次「当前磁盘基线」：否则 `saveTab` 的一致性预检
    // 因为基线为空而永远判「没冲突」，用户点恢复再保存就会静默覆盖外部改动
    let diskContent: string | undefined;
    let diskStat: { mtimeUs: number; size: number } | undefined;
    let diskMtime: number | undefined;
    let eol: ReturnType<typeof detectEol> | undefined;
    if (!draft.isUntitled) {
      try {
        const snapshot = await readDocument(draft.tabPath);
        diskContent = snapshot.content;
        diskStat = snapshot.stat;
        diskMtime = snapshot.stat.mtimeUs / 1000;
        // 换行风格必须跟磁盘一致：恢复出的 tab 没有这份元信息时，
        // 保存会用 LF 重写整份 CRLF 文件（#401 刚做完的换行保真就白做了）
        eol = detectEol(snapshot.content);
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
      // 与 openFile 同源：不填就会按 LF 写回，整份 CRLF 文件被重写
      eol: eol?.eol,
      eolMixed: eol?.mixed,
      finalNewline: eol?.finalNewline,
      // 用户还没动过：不排自动保存（否则 2s 后把停机期间的外部修改静默覆盖）
      recovered: true,
    });
  }

  if (restored.length > 0) {
    const first = restored[0];
    // 必须重取：循环里的 mergeDraftIntoExistingTab 已经改过 openTabs，
    // 用进入函数时那份快照整体替换会把合并结果回滚（内容还在草稿里，但 tab 又变干净）
    const latest = useWorkspace.getState();
    useWorkspace.setState({
      openTabs: [...latest.openTabs, ...restored],
      activeTabPath: first.path,
      // 与 mainTabPatch 的约定一致：无标题草稿也有虚拟路径（untitled-N）
      currentFile: first.path,
      currentContent: first.content,
      dirty: true,
      // 新激活的 tab 是「未保存的新内容」：旧 tab 的保存状态不能继承过来
      saving: false,
      saveError: null,
      conflictPending: false,
      lastSavedAt: null,
    } as never);
  }
  return {
    restored: restored.length,
    restoredPaths: [...restored.map((tab) => tab.path), ...mergedPaths],
  };
}

/**
 * 把草稿合并进**已打开**的 tab。
 *
 * 只在该 tab 是干净的（没有本地修改）时合并：否则用户手上有一份可能更新的内容，
 * 用草稿覆盖它就是拿旧副本砸新内容。保留草稿文件，交给「保存成功」或 TTL 收尾。
 */
export function mergeDraftIntoExistingTab(
  draft: RecoverableDraft,
): "merged" | "kept-existing" {
  const state = useWorkspace.getState();
  const tab = state.openTabs.find((t) => t.path === draft.tabPath);
  if (!tab) return "kept-existing";
  if (tab.dirty || tab.content === draft.content) return "kept-existing";

  const openTabs = state.openTabs.map((t) =>
    t.path === draft.tabPath
        ? { ...t, content: draft.content, dirty: true, recovered: true }
        : t,
  );
  const isActive = state.activeTabPath === draft.tabPath;
  useWorkspace.setState({
    openTabs,
    ...(isActive ? { currentContent: draft.content, dirty: true } : {}),
  } as never);
  return "merged";
}

/**
 * 只清「超过 TTL 且非 pinned」的草稿；返回删除条数。
 *
 * `exclude` 里的 path 一律不删：刚被用户「恢复」的草稿可能已经很旧，但那份内容
 * 现在只在编辑器里（下次编辑前不会写新草稿），删了等于一次崩溃就全丢。
 */
export async function cleanupExpiredDrafts(
  now = Date.now(),
  ttlMs = DRAFT_TTL_MS,
  options: { exclude?: Set<string> } = {},
): Promise<number> {
  const drafts = await listDrafts();
  const expired = drafts.filter(
    (d) =>
      !d.pinned &&
      d.updatedAt > 0 &&
      now - d.updatedAt > ttlMs &&
      !options.exclude?.has(d.tabPath),
  );
  if (expired.length === 0) return 0;
  return discardDrafts(expired);
}

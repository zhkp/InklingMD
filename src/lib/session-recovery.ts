// 崩溃恢复（#365 / #378 第二片）
//
// 数据来源：`recovery/<windowLabel>/session.json`（上次是否正常退出）+ `drafts/*.json`。
// 三件事：
//   1. `beginSession()`：本次启动先落一个 `cleanExit:false` 的会话标记；
//   2. `findRecoverableDrafts()`：上次不是正常退出 → 把草稿读出来交给用户决定；
//   3. `cleanupExpiredDrafts()`：只清「已归档会话里被用户处理过」且超 7 天的；
//      本次会话的、未处理过的崩溃副本、pinned 一律保留。
//
// 恢复入口**不自动恢复**：用户必须明确选择「恢复 / 丢弃」，否则一份过期草稿会
// 悄悄覆盖他已经改过的文件。

import { isTauri } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import {
  currentSessionId,
  currentWindowLabel,
  draftFileKey,
  ensureWindowLabel,
} from "./draft-journal";
import { detectEol } from "./eol";
import { useWorkspace } from "../store/workspace";

/** 设计 §8.3：7 天 TTL（是否可清还取决于会话归属与 handled，见 cleanupExpiredDrafts） */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoverableDraft {
  draftId: string;
  /** 写这份草稿的会话：清理与「已处理」判定都按会话维度，不能跨会话按路径匹配 */
  sessionId: string;
  tabPath: string;
  isUntitled: boolean;
  title: string;
  content: string;
  pinned: boolean;
  updatedAt: number;
}

/** 归档的一次「未正常退出」会话（`recovery/<label>/crashed-<startedAt>.json`） */
export interface CrashedSession {
  version: 1;
  sessionId: string;
  windowLabel: string;
  startedAt: number;
  archivedAt: number;
  cleanExit: false;
  /** 归档时属于该会话的草稿路径（用于判断「是否全部处理完」） */
  draftPaths: string[];
  /**
   * 已处理的草稿：**本实现存的是 `tabPath`**（设计 §8.1 写的是 draft id，
   * 目前 draftId 就是 `base64url(tabPath)`，两者等价；改名时要一起改）。
   */
  handledDraftIds: string[];
  fullyHandled: boolean;
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
  /** 会话身份：归档与 cleaned-up 都靠它区分「哪一次运行」 */
  sessionId?: string;
  startedAt?: number;
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
        sessionId: currentSessionId(),
        startedAt: now,
        cleanExit: false,
        savedAt: now,
      }),
      { createParents: true, durability: "sync" },
    );
  } catch {
    // 写不进去也要把旧标记交回去：本次仍能恢复，只是这次崩溃不会有归档
    return previous;
  }
  // 归档必须在「读完旧标记、写完新标记」之后做；`sessionId` 相同说明那是本次
  // 运行自己刚写的（StrictMode 双跑 effect），不能自我归档
  await archivePreviousSession(previous, now);
  return previous;
}

async function crashedFiles(): Promise<Array<{ file: string; data: CrashedSession }>> {
  try {
    const { dir } = await sessionPaths();
    const sep = sepOf(dir);
    const out: Array<{ file: string; data: CrashedSession }> = [];
    for (const entry of await io.listDir(dir)) {
      if (entry.isDir || !entry.name.startsWith("crashed-") || !entry.name.endsWith(".json")) {
        continue;
      }
      const file = `${dir}${sep}${entry.name}`;
      try {
        const raw = JSON.parse(await io.readTextFile(file)) as Partial<CrashedSession>;
        // 旧版本 / 半写坏的归档：缺数组字段就当空，别让整个清理抛 TypeError
        if (!raw || typeof raw.sessionId !== "string") continue;
        out.push({
          file,
          data: {
            version: 1,
            sessionId: raw.sessionId,
            windowLabel: raw.windowLabel ?? "",
            startedAt: Number(raw.startedAt ?? 0),
            archivedAt: Number(raw.archivedAt ?? 0),
            cleanExit: false,
            draftPaths: Array.isArray(raw.draftPaths) ? raw.draftPaths : [],
            handledDraftIds: Array.isArray(raw.handledDraftIds) ? raw.handledDraftIds : [],
            fullyHandled: !!raw.fullyHandled,
          },
        });
      } catch {
        // 单条损坏跳过：不让一个坏归档拖垮清理
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 把上一次「未正常退出」的会话归档成 `crashed-<startedAt>.json`。
 *
 * `draftPaths` 只收**属于该会话**的草稿（按 DraftFile.sessionId 过滤），
 * 这样「已处理」判定才不会被后来会话的同名路径污染。
 *
 * 唯一例外：旧版本写的标记没有 `sessionId`（`legacy-*` 分支），只能把
 * 「不是本次会话」的草稿都收进来——这类归档的 handled 匹配会失准，
 * 所以清理时对它们只保留不清（见 `cleanupExpiredDrafts` 的 `!crash` 分支）。
 */
export async function archivePreviousSession(
  previous: SessionMarker | null,
  now = Date.now(),
): Promise<string | null> {
  if (!previous || previous.cleanExit !== false) return null;
  // 同一次运行自己刚写的标记：不归档（StrictMode 会双跑 effect）
  if (previous.sessionId && previous.sessionId === currentSessionId()) return null;

  const rawStartedAt = Number(previous.startedAt ?? previous.savedAt ?? now);
  // 非数字会让文件名变成 `crashed-NaN.json`，不同会话互相覆盖
  const startedAt = Number.isFinite(rawStartedAt) ? rawStartedAt : now;
  const legacySession = !previous.sessionId;
  const sessionId = previous.sessionId ?? `legacy-${startedAt}`;
  const draftPaths = (await listDrafts())
    .filter((d) => (legacySession ? d.sessionId !== currentSessionId() : d.sessionId === sessionId))
    .map((d) => d.tabPath);

  const { dir } = await sessionPaths();
  const sep = sepOf(dir);
  const file = `${dir}${sep}crashed-${startedAt}.json`;
  const payload: CrashedSession = {
    version: 1,
    sessionId,
    windowLabel: currentWindowLabel(),
    startedAt,
    archivedAt: now,
    cleanExit: false,
    draftPaths,
    handledDraftIds: [],
    // 没有草稿可处理的归档直接算「处理完」，否则它会永远留着
    fullyHandled: draftPaths.length === 0,
  };
  try {
    await io.writeTextFile(file, JSON.stringify(payload), {
      createParents: true,
      durability: "sync",
    });
    return file;
  } catch {
    return null;
  }
}

/**
 * 标记这些草稿已被用户处理（恢复 / 丢弃）。
 *
 * 按**会话**写入各自的归档：旧归档里的同名路径不能给新会话的草稿授权删除。
 * 未出现在任何归档里的会话（无归档可写）只能靠 orphan 规则兜底，不会误删。
 */
export async function markDraftsHandled(
  drafts: Array<Pick<RecoverableDraft, "sessionId" | "tabPath">>,
  now = Date.now(),
): Promise<void> {
  if (drafts.length === 0) return;
  const bySession = new Map<string, string[]>();
  for (const draft of drafts) {
    if (!draft.sessionId) continue;
    bySession.set(draft.sessionId, [...(bySession.get(draft.sessionId) ?? []), draft.tabPath]);
  }
  if (bySession.size === 0) return;

  for (const { file, data } of await crashedFiles()) {
    const paths = bySession.get(data.sessionId);
    if (!paths) continue; // 不碰别的会话的归档
    const handled = new Set([...(data.handledDraftIds ?? []), ...paths]);
    try {
      await io.writeTextFile(
        file,
        JSON.stringify({
          ...data,
          handledDraftIds: [...handled],
          fullyHandled: data.draftPaths.every((p) => handled.has(p)),
          handledAt: now,
        }),
        { createParents: true, durability: "sync" },
      );
    } catch {
      // 写不进去就宁可下次再问一次，也不假装已处理
    }
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
        sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
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
 * 只清两类草稿（设计 §8.3）；返回删除条数。
 *
 * ① 属于某个**已归档会话**、该会话已把这条标记为 handled，**且已超 TTL**；
 * ② 孤儿（没有对应归档、也不是本次会话）且超过 TTL —— **本片未实现**：
 *    判孤儿需要 `session.tabs`，当前标记里没有；缺了它只会「多留」，不会误删。
 *
 * 本次会话的草稿永不自动清；已归档但**未处理**的崩溃副本也永不自动清
 * ——否则「很久没打开」就等于自动丢用户内容。`pinned` 一律豁免。
 * `exclude` 是本次刚恢复的 path（内容此刻只在编辑器里）。
 */
export async function cleanupExpiredDrafts(
  now = Date.now(),
  ttlMs = DRAFT_TTL_MS,
  options: { exclude?: Set<string> } = {},
): Promise<number> {
  const drafts = await listDrafts();
  const archived = new Map<string, CrashedSession>();
  for (const { data } of await crashedFiles()) archived.set(data.sessionId, data);
  const current = currentSessionId();

  const expired = drafts.filter((d) => {
    if (d.pinned || d.updatedAt <= 0 || now - d.updatedAt <= ttlMs) return false;
    if (options.exclude?.has(d.tabPath)) return false;
    if (!d.sessionId || d.sessionId === current) return false;
    const crash = archived.get(d.sessionId);
    // 没有归档（归档写失败 / 旧版本残留）：一律保留。
    // 「孤儿清理」需要 session.tabs 才能判定，本片不做——宁可占盘也不误删唯一副本
    if (!crash) return false;
    // 有归档：只在「用户已处理这条」时清
    return (crash.handledDraftIds ?? []).includes(d.tabPath);
  });
  if (expired.length === 0) return 0;
  return discardDrafts(expired);
}

// workspace 各 slice 共享的模块级工具：
// localStorage 持久化读写、路径工具、防过期覆盖的操作序号与请求去重表。
// 这些不是响应式状态，保留模块级单例语义（跨 slice 共享同一份数据）。

import type { DocumentSnapshot } from "../../lib/fs";
import { parentDir, rebasePathPrefix } from "../../lib/path";
import { loadJSON, writeJSON } from "../../lib/storage";

export { parentDir, rebasePathPrefix };

/** 最近打开文件列表的持久化 key */
export const RECENT_FILES_KEY = "inkling-recent-files";
const RECENT_FILES_MAX = 10;

/** 读取持久化的最近文件列表 */
export function loadRecentFiles(): string[] {
  const arr = loadJSON<string[]>(RECENT_FILES_KEY, [], Array.isArray);
  return arr.slice(0, RECENT_FILES_MAX);
}

/** 持久化最近文件列表 */
export function persistRecentFiles(files: string[]): void {
  writeJSON(RECENT_FILES_KEY, files.slice(0, RECENT_FILES_MAX));
}

/** 展开目录列表的持久化 key（未记录的目录默认折叠） */
export const EXPANDED_DIRS_KEY = "inkling-expanded-dirs-v2";

/** 读取持久化的展开目录列表 */
export function loadExpandedDirs(): Set<string> {
  const arr = loadJSON<string[]>(EXPANDED_DIRS_KEY, [], Array.isArray);
  return new Set(arr);
}

/** 持久化展开目录列表 */
export function persistExpandedDirs(dirs: Set<string>): void {
  writeJSON(EXPANDED_DIRS_KEY, [...dirs]);
}

/** 书签列表的持久化 key */
export const BOOKMARKS_KEY = "inkling-bookmarks";

/** 删除文件时未保存修改的内存快照备份 key */
export const DELETED_FILE_SNAPSHOTS_KEY = "inkling-deleted-snapshots";

/**
 * 快照列表变更的窗口内广播事件（issue #153）：
 * 健康探测与区块刷新改为事件驱动后，同窗口内的写入/移除/清空
 * 通过该事件通知 UI，替代原先每 2 秒的全量轮询。
 */
export const SNAPSHOTS_CHANGED_EVENT = "inkling-deleted-snapshots-changed";

/** 广播快照列表已变更（仅浏览器环境；测试环境 window 恒存在） */
function notifySnapshotsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SNAPSHOTS_CHANGED_EVENT));
  }
}

export interface DeletedFileSnapshot {
  path: string;
  content: string;
  deletedAt: number;
}

/** 快照条目上限 */
export const DELETED_SNAPSHOT_LIMIT = 20;

/** 单条快照占用的字符数（与 `probeSnapshotStorageHealth` 的估算口径一致） */
export function snapshotEntryChars(path: string, content: string): number {
  return path.length + content.length + 16;
}

/** 快照字符预算：localStorage 约 5MB，留一半余量给其它键 */
export function snapshotCharBudget(): number {
  return 1_000_000;
}

/**
 * 持久化被删除 dirty 文件的快照备份，返回是否成功写入。
 *
 * 写失败**只放弃本条**：绝不用「只保留最新一条」把其它已删文件的唯一副本清掉
 * （旧实现就是这样丢数据的）。调用方按「快照失败 → 保留 tab」处理。
 */
export function persistDeletedSnapshot(path: string, content: string): boolean {
  const list = loadJSON<DeletedFileSnapshot[]>(DELETED_FILE_SNAPSHOTS_KEY, [], Array.isArray);
  const next = [
    { path, content, deletedAt: Date.now() },
    ...list.filter((item) => item.path !== path),
  ].slice(0, DELETED_SNAPSHOT_LIMIT);
  const ok = writeJSON(DELETED_FILE_SNAPSHOTS_KEY, next);
  if (ok) notifySnapshotsChanged();
  return ok;
}

/** 读取被删除文件的快照备份 */
export function loadDeletedSnapshots(): DeletedFileSnapshot[] {
  return loadJSON<DeletedFileSnapshot[]>(DELETED_FILE_SNAPSHOTS_KEY, [], Array.isArray);
}

/** 健康探测专用哨兵键（issue #153）：只写 1 字节即可确认剩余写入能力，避免把数 MB 的快照列表整体重新序列化写回 */
const SNAPSHOT_HEALTH_PROBE_KEY = "inkling-deleted-snapshots-health-probe";

/** 估算当前快照占用的字符数与写入状态：sizeChars 越高越接近 localStorage 5MB 上限；writable=false 表明确认写入失败（配额已耗尽） */
export function probeSnapshotStorageHealth(): {
  sizeChars: number;
  entryCount: number;
  writable: boolean;
} {
  const list = loadDeletedSnapshots();
  const sizeChars = list.reduce(
    (acc, item) => acc + (item.path?.length ?? 0) + (item.content?.length ?? 0) + 16,
    0,
  );
  // 试探写一个极小哨兵值再移除，确认剩余写入能力（不触碰快照内容本身）
  let writable = true;
  try {
    localStorage.setItem(SNAPSHOT_HEALTH_PROBE_KEY, "1");
    localStorage.removeItem(SNAPSHOT_HEALTH_PROBE_KEY);
  } catch {
    writable = false;
  }
  return { sizeChars, entryCount: list.length, writable };
}

/** 清空被删除文件的快照备份 */
export function clearDeletedSnapshots(): void {
  writeJSON(DELETED_FILE_SNAPSHOTS_KEY, []);
  notifySnapshotsChanged();
}

/** 移除单条快照备份 */
export function removeDeletedSnapshot(path: string): void {
  const list = loadJSON<DeletedFileSnapshot[]>(DELETED_FILE_SNAPSHOTS_KEY, [], Array.isArray);
  writeJSON(
    DELETED_FILE_SNAPSHOTS_KEY,
    list.filter((item) => item.path !== path),
  );
  notifySnapshotsChanged();
}

/** 读取持久化的书签列表 */
export function loadBookmarks(): string[] {
  return loadJSON<string[]>(BOOKMARKS_KEY, [], Array.isArray);
}

/** 持久化书签列表 */
export function persistBookmarks(files: string[]): void {
  writeJSON(BOOKMARKS_KEY, files);
}

/** 把 path 推到列表头部并去重，截断到最大长度 */
export function pushRecent(list: string[], path: string): string[] {
  const next = [path, ...list.filter((p) => p !== path)];
  return next.slice(0, RECENT_FILES_MAX);
}

/**
 * 跨 slice 共享的操作序号（live-binding：ES 模块导入不可赋值，收敛为对象属性）：
 * - workspaceGeneration：工作区切换序号，较旧的异步结果不得覆盖后来打开的工作区
 * - mainFile：主面板文件选择序号，较旧的读取结果可以加入 tab，但不得抢回活跃状态
 * - splitFile：分屏文件选择序号，连续打开时只允许最后一次操作更新分屏
 * - workspaceContext：文件夹与单文件模式只接受最后一次切换结果
 */
export const intents = {
  workspaceGeneration: 0,
  mainFile: 0,
  splitFile: 0,
  workspaceContext: 0,
};

/** 同一目录的并发请求复用同一个 Promise，避免重复枚举 */
export const directoryRequests = new Map<string, Promise<void>>();

/** 加载中的目录发生文件变更时，合并为一次后续强制刷新 */
export const forcedDirectoryRequests = new Map<string, Promise<void>>();

/** 同一文件的并发读取复用一个 Promise，避免重复读取和重复创建 tab。
 *  值必须是**成对快照**（#362）：并发加入方共享同一份内容 + stat，一次读取只产生一个基线。 */
export const fileRequests = new Map<string, Promise<DocumentSnapshot>>();

/** 请求落定时的最终注册路径（issue #200 评审修复）：
 *  创建方在 .finally 内、删条目前写入；命中 existing 分支的并发加入方在各自
 *  追加的 .finally 里读取——Promise 反应按注册顺序执行，加入方必然晚于创建方，
 *  读取时必已填充。Weak 语义：请求被回收即自动消失，无需手动清理。 */
export const settledPathOfRequest = new WeakMap<Promise<DocumentSnapshot>, string>();

/**
 * 同 path 的 tab 建/合并互斥锁（#362）。
 *
 * 与 `fileRequests` 分开：那个条目在读取 settle 时就被删了，生命周期短于
 * 「建 tab / 合并 draft」。临界区是 `tabs.ts` 的 `createTabFromDisk`（由 `ensureTab`
 * 持锁进入）；任何新增的「为某个 path 建 tab 或合并 draft」逻辑都必须同样经
 * `ensureTab` / `withPathLock` 走这把锁，否则同 path 会建出两个 tab。
 */
export const pathLocks = new Map<string, Promise<void>>();

/**
 * 每 path 的「内容版本 + 最后编辑时间」（#364）。
 *
 * 自动保存的订阅键必须能区分「又编辑了一次」，只订阅 `dirty` 布尔做不到：
 * 保存完成后若保存期间有新输入，tab 仍是 dirty → 派生集合不变 → effect 不重跑 →
 * 该 path 再也不会排下一次保存；同一 path 继续编辑也不会重置 2s 防抖。
 *
 * 三条规则（评审已确认，改动请同步更新用例 `autosave-rev.test.ts`）：
 * 1. **唯一 bump 点**是内容真正变化的入口（`setContent` / `setContentFor`）；
 * 2. `closeTab` 删除、`onFileRenamed` 迁移（不是删除，否则 rename 后订阅键回退）；
 * 3. 保存成功后**不重置**——rev 只增不减，删掉或归零都会让订阅键回退。
 */
export const pathRevs = new Map<string, { contentRev: number; lastEditAt: number }>();

/** 内容真正变化时调用（不要用于保存成功 / 切 tab / 恢复） */
export function bumpPathRev(path: string): void {
  const prev = pathRevs.get(path);
  pathRevs.set(path, {
    contentRev: (prev?.contentRev ?? 0) + 1,
    lastEditAt: Date.now(),
  });
}

/** 订阅键与 `D_old` 用的读取口径：无条目按 0，不要 `!` 断言 */
export function getPathRev(path: string): number {
  return pathRevs.get(path)?.contentRev ?? 0;
}

/** 关闭 tab：条目消失（订阅键随之移除，effect 会重跑） */
export function dropPathRev(path: string): void {
  pathRevs.delete(path);
}

/** 改名 / 移动：把条目搬到新路径（保留 rev 与 lastEditAt） */
export function rebasePathRevs(from: string, to: string): void {
  for (const [path, rev] of [...pathRevs]) {
    const nextPath = rebasePathPrefix(path, from, to);
    if (nextPath === path) continue;
    pathRevs.delete(path);
    pathRevs.set(nextPath, rev);
  }
}

/**
 * 在 path 锁内串行执行 `run`。
 *
 * 锁只表达「串行」，不传播错误：前一笔失败也必须放行后一笔（否则该 path 的
 * 打开会永久挂住）。条目在本笔结束（成功或失败）后清理，且只删自己那一笔。
 */
export function withPathLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(path);
  // 无争用时同步进入：多一个微任务跳变会让「打开文件」的同步前缀（登记在途请求）
  // 推迟到下一个 tick，破坏调用方对「点击后立刻进入加载态」的既有断言。
  const start = prev ? prev.then(run, run) : run();
  const tail = start.then(
    () => undefined,
    () => undefined,
  );
  pathLocks.set(path, tail);
  void tail.then(() => {
    if (pathLocks.get(path) === tail) pathLocks.delete(path);
  });
  return start;
}

/**
 * 删除时仍在途读取的文件路径黑名单（issue #166）：
 * 文件读取在途时被删除，读取完成后 ensureTab 会照常创建「已删除文件」的
 * 干净 tab（后续编辑游离在快照保护之外）。删除时把在途路径记入此表，
 * ensureTab 完成后对照拦截并把读到的内容写入恢复快照。
 * 值为删除时间戳；在途读取完成的窗口极短，超时条目自动失效，
 * 避免误拦同名文件重建后的正常打开。
 */
export const deletedDuringLoad = new Map<string, number>();

/** deletedDuringLoad 条目有效期：远超正常在途读取耗时即可 */
export const DELETED_DURING_LOAD_TTL = 60_000;

/** 记录一个「删除时在途读取」的路径 */
export function markDeletedDuringLoad(path: string): void {
  deletedDuringLoad.set(path, Date.now());
}

/** 检查路径是否刚在读取在途时被删除；过期条目顺带清理 */
export function wasDeletedDuringLoad(path: string): boolean {
  const deletedAt = deletedDuringLoad.get(path);
  if (deletedAt === undefined) return false;
  if (Date.now() - deletedAt > DELETED_DURING_LOAD_TTL) {
    deletedDuringLoad.delete(path);
    return false;
  }
  return true;
}

/** 消费（移除）一条删除记录（拦截判定后调用，一次性语义） */
export function consumeDeletedDuringLoad(path: string): void {
  deletedDuringLoad.delete(path);
}
/**
 * 文件 / 目录改名后迁移黑名单的键。
 *
 * 这张表的键是**路径**，落定时的查表用的却是请求当前的注册路径
 * （`readFileOnce` 按请求身份取 `registeredPath`，`ensureTab` 兜底再查一次）。
 * `onFileRenamed` 把在途请求迁到新路径之后，黑名单如果还留在旧路径，
 * 两次查表都会 miss：已删除文件照常建出干净 tab、读到的内容也不进恢复快照，
 * 等于把 #166 的保护整条打掉。所以两者必须一起迁。
 */
export function rebaseDeletedDuringLoad(from: string, to: string): void {
  for (const [path, deletedAt] of [...deletedDuringLoad]) {
    const nextPath = rebasePathPrefix(path, from, to);
    if (nextPath === path) continue;
    deletedDuringLoad.delete(path);
    deletedDuringLoad.set(nextPath, deletedAt);
  }
}

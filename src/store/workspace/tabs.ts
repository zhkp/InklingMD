// workspace slice：标签页 / 活跃文档镜像 / 分屏
// openTabs 是唯一数据源；currentFile / currentContent / dirty 等始终是「活跃 tab」
// 的镜像，切换 tab 时同步更新，保持下游组件接口不变。
// 文件读取（openingFiles / fileOpenErrors）与保存（saving / saveError）也在此维护。

import type { StateCreator } from "zustand";
import { isTauri } from "@tauri-apps/api/core";
import {
  fileMtime,
  fileStat,
  readDocument,
  readTextFile,
  saveDocument,
  writeTextFile,
} from "../../lib/fs";
import type { DocumentSnapshot, FileStat } from "../../lib/fs";
import { formatCmdError } from "../../lib/cmd-error";
import { isSamePath } from "../../lib/path-utils";
import { clearDraft, scheduleDraft } from "../../lib/draft-journal";
import { evaluateBaseline, reconcileDiskContent } from "../../lib/save-guard";
import { writeErrorCode, type WriteErrorCode } from "../../lib/writeErrors";
import { flushAllMarkdownPublishers } from "../../components/Editor/markdown-publisher";
import { runWysiwygAnchorSampler } from "../../lib/wysiwyg-anchor-sampler";
import { useConflict } from "../conflict";
import {
  bumpPathRev,
  consumeDeletedDuringLoad,
  dropPathRev,
  fileRequests,
  intents,
  parentDir,
  persistDeletedSnapshot,
  persistRecentFiles,
  pushRecent,
  rebasePathRevs,
  settledPathOfRequest,
  wasDeletedDuringLoad,
  withPathLock,
} from "./shared";
import type { OpenTab, WorkspaceState } from "./types";

/**
 * 过渡期双写（设计 §4.3）：`diskMtime` 一律由成对读取的 `diskStat` 换算，
 * 保证两者对同一文件永远成对。PR-2 删除 `diskMtime` 时一并删除本函数。
 */
function mtimeMsOf(stat: FileStat): number {
  return stat.mtimeUs / 1000;
}

// ── 保存串行队列（#364） ────────────────────────────────────────────────────
// `saveQueue`：已入队、尚未启动；`inflightSaves`：已启动、到 adopt 完成。
// 意图升级必须**同时**查两张表：排队中尚未启动的保存不在 inflight 里，
// 只查 inflight 会让交互保存直接入队排在后面，用户按 Ctrl+S 看起来没反应。
const saveQueue = new Map<string, Promise<void>>();
const inflightSaves = new Map<string, Promise<void>>();
/** 全局串行链：保证任意时刻只有一个 tab 在写盘 */
let saveChain: Promise<void> = Promise.resolve();

/**
 * 入队一次保存；返回的 promise 在该次保存（含 store adopt）完成后 resolve。
 *
 * 空闲时**立刻启动**（不经过 microtask）：`saveTab` 必须在返回前同步置 `saving`，
 * 否则重入守卫（issue #91）与「Ctrl+S 后立刻再按」的语义都会变。
 * 只有已有保存在跑时才排到链尾，保证同一时刻只有一个 tab 在写盘。
 */
function enqueueSave(path: string, task: () => Promise<void>): Promise<void> {
  const start = (): Promise<void> => {
    saveQueue.delete(path);
    const running = task();
    inflightSaves.set(path, running);
    return running.finally(() => {
      if (inflightSaves.get(path) === running) inflightSaves.delete(path);
    });
  };

  // 判空闲必须同时看排队表：队列里可能已有「已排队、尚未启动」的项
  if (inflightSaves.size === 0 && saveQueue.size === 0) {
    const done = start();
    saveChain = done.catch(() => undefined);
    return done;
  }

  const queued = saveChain.catch(() => undefined).then(start);
  saveChain = queued.catch(() => undefined);
  saveQueue.set(path, queued);
  return queued;
}

/** 标签页 / 活跃文档 / 分屏 slice */
export interface TabsSlice {
  /** 已打开的标签页列表 */
  openTabs: OpenTab[];
  /** 当前活跃标签页路径（null 表示无活跃 tab） */
  activeTabPath: string | null;

  // 以下为活跃 tab 的镜像，便于现有组件直接订阅
  /** 当前打开的文件路径（null 表示未打开） */
  currentFile: string | null;
  /** 当前文件内容 */
  currentContent: string;
  /** 文件是否被修改（未保存） */
  dirty: boolean;
  /** 保存中标志 */
  saving: boolean;
  /** 最近一次保存的错误（null 表示无错误） */
  saveError: string | null;
  /** 自动保存遇冲突暂停标志（非模态，点击可触发冲突处理） */
  conflictPending: boolean;
  /** 最近一次保存时间戳（ms） */
  lastSavedAt: number | null;
  /** 当前光标所在标题的 slug（用于大纲高亮，null 表示无） */
  currentHeadingSlug: string | null;

  /** 正在读取的文件路径集合 */
  openingFiles: Set<string>;
  /** 文件读取错误（按路径记录，点击文件可重试） */
  fileOpenErrors: Map<string, string>;

  // 分屏：右侧第二面板，独立展示另一个已打开的 tab（只读对照为主）
  /** 分屏面板展示的文件路径（null 表示未分屏） */
  splitFile: string | null;
  /** 分屏面板展示的文件内容（从对应 tab 实时同步） */
  splitContent: string;
  /** 在分屏面板打开一个已存在的 tab 作为对照（若未打开则先 openFile） */
  splitOpen: (filePath: string) => Promise<void>;
  /** 关闭分屏面板 */
  splitClose: () => void;
  /** 在分屏面板与主面板之间交换文件（把当前主文件挪到分屏，分屏文件挪到主） */
  splitSwap: () => void;

  /** 打开文件：已打开则切换到对应 tab，否则读取内容新增 tab。不改变当前工作区模式 */
  openFile: (filePath: string) => Promise<void>;
  /**
   * 强制从磁盘重读文件内容并刷新对应 tab（外部修改后「重新加载」用）。
   * 与 openFile 的区别：openFile 对已打开的 tab 直接复用缓存内容，不会重读磁盘。
   * 未打开的文件退化为 openFile 行为。
   */
  reloadFile: (filePath: string) => Promise<void>;
  /**
   * 以单文件模式打开一个 md：不构建文件树，但把 rootPath 设为该文件父目录，
   * workspaceMode 置为 "file"。
   * 用于"打开文件"入口——支持散落在不同文件夹的多个 md 作为标签页。
   */
  openFileStandalone: (filePath: string) => Promise<void>;
  /**
   * 新建未命名草稿标签页（Ctrl+N）。不关联磁盘文件，内容为空。
   * 首次 Ctrl+S 保存时弹另存为对话框选择保存位置，保存后转为普通文件 tab。
   */
  newTab: () => void;
  /**
   * 以指定内容新建未命名草稿标签页（用于恢复被删除文件等场景）。
   */
  openUntitledTabWithContent: (initialContent: string) => void;
  /** 切换活跃标签页 */
  switchTab: (filePath: string) => void;
  /**
   * 核验单个 tab 的磁盘状态（#362 §4.4）：stat 分类 → 基线判定 → 成对读盘 →
   * 先比内容 → adopt / 静默重载 / 冲突。`switchTab` 与 watcher 共用同一份实现。
   * `interactive=false`（后台 tab）时不弹窗，只标记 `conflictPending`。
   */
  verifyTabOnDisk: (
    filePath: string,
    options?: { interactive?: boolean; markBackgroundConflict?: boolean },
  ) => Promise<void>;
  /** 关闭标签页（若关闭的是活跃 tab，自动激活相邻 tab） */
  closeTab: (filePath: string) => void;
  /** 关闭除指定 tab 外的所有 tab（不处理未保存确认，由调用方负责） */
  closeOthers: (keepPath: string) => void;
  /** 关闭指定 tab 右侧的所有 tab（不含指定 tab 本身） */
  closeToRight: (fromPath: string) => void;
  /** 关闭所有 tab */
  closeAll: () => void;
  /** 拖拽重排：把 fromPath 的 tab 移到 toPath 之前 */
  reorderTabs: (fromPath: string, toPath: string) => void;
  /** 更新当前内容（编辑器变更时调用） */
  setContent: (content: string) => void;
  /** 更新指定 tab 的内容（异步发布必须绑定文件，避免 tab 切换后串写，PR #34） */
  setContentFor: (path: string, content: string) => void;
  /** 更新指定分屏文件的内容（绑定文件，避免 swap/close 后串写，PR #34） */
  setSplitContentFor: (path: string, content: string) => void;
  /** 保存当前文件到磁盘 */
  /**
   * 保存指定 tab（#364）：**不要求它是活跃 tab**。所有镜像更新（`currentContent` /
   * 顶层 `dirty` / `saveError`）只在目标恰好是活跃 tab 时才写。
   */
  saveTab: (
    path: string,
    options?: { interactive?: boolean },
  ) => Promise<void>;
  /** 兼容入口：保存当前活跃 tab */
  saveCurrent: (options?: { interactive?: boolean }) => Promise<void>;
  /** 等待在途保存结束；给 path 时只等该 path（同时覆盖排队中尚未启动的任务） */
  waitForSaves: (path?: string) => Promise<void>;
  /** 该 path 是否有已启动、尚未 adopt 完成的保存 */
  isSaveInFlight: (path: string) => boolean;
  /** 设置当前光标所在标题 slug（编辑器选区变化时调用） */
  setCurrentHeadingSlug: (slug: string | null) => void;
  /** 保存指定 tab 的编辑位置（光标 pos + 滚动 offset）。绑定文件路径，
   *  避免切 tab 后旧编辑器销毁期 flush 串写到新 active tab（issue #30） */
  saveCursorState: (path: string, pos: number, scrollTop: number) => void;
  /** 读取指定 tab 的编辑位置（用于编辑器 ready 后恢复） */
  getCursorStateFor: (path: string) => { pos: number | null; scrollTop: number | null };
  /** 设置指定 tab 的基线磁盘内容（用于解决外部冲突后同步基线） */
  setTabDiskContent: (path: string, diskContent: string) => void;
  /** 设置指定 tab 的源码模式开关；path 省略则作用于当前 activeTabPath */
  setTabSourceMode: (enabled: boolean, path?: string) => void;
  /** 读取指定 tab 是否源码模式；path 省略则读 activeTabPath */
  getTabSourceMode: (path?: string) => boolean;
  /** 切换指定 tab 源码模式 */
  toggleTabSourceMode: (path?: string) => void;
}

export const createTabsSlice: StateCreator<WorkspaceState, [], [], TabsSlice> = (
  set,
  get,
) => {
  /**
   * 按请求自身身份查找其注册路径（issue #177）：
   * 读取在途时重命名会把条目从旧路径迁移到新路径，闭包捕获的旧路径
   * 查表必然失配。按身份遍历在途表（规模恒等于并发打开数，极小），
   * 确保无论迁移与否都能清理到位。
   */
  const findRequestPath = (request: Promise<DocumentSnapshot>): string | null => {
    for (const [path, req] of fileRequests) {
      if (req === request) return path;
    }
    return null;
  };

  /** 读取文件并维护逐文件加载状态；同一路径的并发调用共享同一请求。
   *  onSettledPath：settle 时回传请求当前注册路径（issue #200）——读取在途
   *  发生重命名会把条目迁到新路径，调用方据此把 tab 建到新路径而非旧路径。
   *
   *  #362：返回值是**成对快照**（内容 + 产生它的磁盘身份）。并发加入方共享同一份
   *  pair，因此一次读取只产生一个基线；绝不出现「旧内容 + 新 stat」被登记为基线。 */
  const readFileOnce = (
    filePath: string,
    onSettledPath?: (registeredPath: string) => void,
  ): Promise<DocumentSnapshot> => {
    const existing = fileRequests.get(filePath);
    if (existing) {
      // issue #200 评审修复：同路径并发（树中快速双击、主面板与分屏同开）
      // 命中共享请求时，加入方的 onSettledPath 不得被静默丢弃——在途重命名
      // 后加入方同样需要落定路径，否则仍按旧路径建幽灵 tab、删除黑名单对照
      // 失配。落定路径由创建方在删条目前写入 settledPathOfRequest，此处读取
      // 必然已填充；未命中（理论不可达）时回退到发起路径，等价旧行为。
      return existing.finally(() => {
        onSettledPath?.(settledPathOfRequest.get(existing) ?? filePath);
      });
    }

    set((current) => {
      const openingFiles = new Set(current.openingFiles);
      const fileOpenErrors = new Map(current.fileOpenErrors);
      openingFiles.add(filePath);
      fileOpenErrors.delete(filePath);
      return { openingFiles, fileOpenErrors };
    });

    let request: Promise<DocumentSnapshot>;
    request = Promise.resolve()
      .then(async () => {
        const snapshot = await readDocument(filePath);
        // issue #166 复合（#200 评审）：「读取在途被删除」（含先重命名再删除）
        // 的拦截统一放在请求体内——按身份查当前注册路径，命中即恢复快照并
        // 拒绝。所有并发等待方共享同一次拒绝，不会出现黑名单被创建方消费后、
        // 加入方仍为已删除文件建出漏网 tab 的窗口。
        const registeredPath = findRequestPath(request);
        if (registeredPath !== null && wasDeletedDuringLoad(registeredPath)) {
          consumeDeletedDuringLoad(registeredPath);
          persistDeletedSnapshot(registeredPath, snapshot.content);
          throw new Error(`文件在加载期间被外部删除，已创建恢复备份：${registeredPath}`);
        }
        return snapshot;
      })
      .catch((error) => {
        const registeredPath = findRequestPath(request);
        if (registeredPath !== null) {
          set((current) => {
            const fileOpenErrors = new Map(current.fileOpenErrors);
            fileOpenErrors.set(
              registeredPath,
              error instanceof Error ? error.message : String(error),
            );
            return { fileOpenErrors };
          });
        }
        throw error;
      })
      .finally(() => {
        // issue #177：按请求身份清理而非按闭包捕获的路径查表——
        // 重命名迁移后条目在新路径下，同样要删除缓存并清除加载态，
        // 否则重开会命中陈旧（或已拒绝）的缓存 Promise
        const registeredPath = findRequestPath(request);
        if (registeredPath === null) return;
        // issue #200：删除条目前先把最终注册路径写入请求级 WeakMap 并回传
        // （迁移后 ≠ 发起路径）。.finally 先于 await 方与加入方反应执行，
        // settle 后读取必能拿到迁移结果。
        settledPathOfRequest.set(request, registeredPath);
        onSettledPath?.(registeredPath);
        fileRequests.delete(registeredPath);
        set((current) => {
          if (!current.openingFiles.has(registeredPath)) return {};
          const openingFiles = new Set(current.openingFiles);
          openingFiles.delete(registeredPath);
          return { openingFiles };
        });
      });
    fileRequests.set(filePath, request);
    return request;
  };

  /**
   * 确保文件已加入标签页，但不改变主面板或分屏的活跃文件。
   *
   * 同 path 用 `pathLocks` 串行（#362）：锁的实际临界区是 `createTabFromDisk`
   * （读盘 + 建 tab 的唯一入口），凡是要为某个 path 建 tab 或合并 draft 的路径
   * 都必须走 `ensureTab` / `createTabFromDisk` 拿同一把锁，否则「读盘完成到建 tab
   * 之间」会建出两个同 path tab。锁由 `withPathLock` 在 settle 后释放，
   * 任一步抛错都不会挂住该 path。
   */
  const ensureTab = async (requestedPath: string): Promise<OpenTab> => {
    const existing = get().openTabs.find((tab) => tab.path === requestedPath);
    if (existing) return existing;
    // 已有同路径在途读取：直接加入它（readFileOnce 内按请求去重，共享同一份 pair，
    // issue #200 的「并发只读一次」依赖这条）。取锁会等请求结束才进入，反而
    // 让加入方另起一次磁盘读取。
    if (fileRequests.has(requestedPath)) return createTabFromDisk(requestedPath);
    return withPathLock(requestedPath, () => createTabFromDisk(requestedPath));
  };

  /** `ensureTab` 的锁内实现：一次成对读取 → 建 tab（内容与 stat 同源） */
  const createTabFromDisk = async (requestedPath: string): Promise<OpenTab> => {
    // 锁内复查：等待锁期间可能已由前一笔建好 tab
    const alreadyOpen = get().openTabs.find((tab) => tab.path === requestedPath);
    if (alreadyOpen) return alreadyOpen;

    // issue #200：读取在途时路径被重命名，onFileRenamed 会把在途条目迁到
    // 新路径。完成后以 settle 时的注册路径建 tab（tabPath），否则按闭包捕获
    // 的旧路径建 tab 会出现「幽灵 tab」（文件已不在旧路径，后续保存会在
    // 旧路径重建文件造成数据分叉）。未重命名时 tabPath === requestedPath。
    let tabPath = requestedPath;
    const snapshot = await readFileOnce(requestedPath, (settled) => {
      tabPath = settled;
    });

    // issue #166：读取在途期间文件被外部删除时，不得为「已删除文件」
    // 照常创建干净 tab（后续编辑将游离在快照保护之外）——把刚读到的
    // 内容写入恢复快照并拒绝建 tab。
    // 主拦截在 readFileOnce 请求体内（见上，所有并发等待方共享同一拒绝）；
    // 黑名单登记落在请求级检查之后、本续体之前的极窄窗口内时，此守卫兜底。
    // 黑名单按删除瞬间 fileRequests 的注册路径登记：若先重命名后删除，
    if (wasDeletedDuringLoad(tabPath)) {
      consumeDeletedDuringLoad(tabPath);
      persistDeletedSnapshot(tabPath, snapshot.content);
      set((current) => {
        const fileOpenErrors = new Map(current.fileOpenErrors);
        fileOpenErrors.set(tabPath, "文件在加载期间被外部删除，已创建恢复备份");
        return { fileOpenErrors };
      });
      throw new Error("文件在加载期间被外部删除");
    }

    let resolvedTab: OpenTab | undefined;
    set((current) => {
      // 按最终路径复查：并发请求（旧路径与迁移后新路径）可能已先建 tab
      const currentTab = current.openTabs.find((tab) => tab.path === tabPath);
      if (currentTab) {
        resolvedTab = currentTab;
        return {};
      }

      resolvedTab = {
        path: tabPath,
        content: snapshot.content,
        dirty: false,
        lastSavedAt: null,
        // 基线与内容来自同一份 pair：不再有"读完内容再单独取一次 mtime"的窗口（R1）
        diskContent: snapshot.content,
        diskStat: snapshot.stat,
        diskMtime: mtimeMsOf(snapshot.stat),
        cursorPos: null,
        scrollTop: null,
      };
      return { openTabs: [...current.openTabs, resolvedTab] };
    });
    return resolvedTab!;
  };

  /**
   * 把一次成对读取的结果登记为基线（#362 M2 的 adopt 出口）。
   *
   * 只有「知道我写的那份内容」时才允许 adopt：`snap.content` 与 `snap.stat` 同源，
   * 所以 `diskContent`/`diskStat`/`diskMtime` 三者一起写，过渡期不产生漂移。
   * `clearDirty` 仅用于 `same-as-write`（磁盘已等于编辑器内容，再存一次是无意义写盘）。
   */
  const adoptDiskBaseline = (
    path: string,
    snapshot: DocumentSnapshot,
    flags?: { clearDirty?: boolean },
  ): void => {
    set((current) => {
      const target = current.openTabs.find((t) => t.path === path);
      if (!target) return {};
      const openTabs = current.openTabs.map((t) =>
        t.path === path
          ? {
              ...t,
              diskContent: snapshot.content,
              diskStat: snapshot.stat,
              diskMtime: mtimeMsOf(snapshot.stat),
              deletedOnDisk: false,
              saveError: null,
              ...(flags?.clearDirty
                ? { dirty: false, conflictPending: false }
                : {}),
            }
          : t,
      );
      const active = openTabs.find((t) => t.path === current.activeTabPath);
      return {
        openTabs,
        ...(current.activeTabPath === path && active
          ? {
              dirty: active.dirty,
              saveError: null,
              conflictPending: !!active.conflictPending,
            }
          : {}),
      };
    });
  };

  /**
   * 磁盘上已不存在：进删除态并清掉 **stat 基线**（#362 M3 / §4.4 ②）。
   *
   * `diskContent` 保留：文件被重建时它是"仅 touch"判定的依据；清掉会让
   * 同样内容的重新出现被误报成冲突。stat 必须清，否则下一轮会把缺失文件
   * 误判成"没变"。
   */
  const markDeletedOnDisk = (path: string): void => {
    set((current) => {
      const openTabs = current.openTabs.map((t) =>
        t.path === path
          ? { ...t, deletedOnDisk: true, diskStat: undefined, diskMtime: undefined }
          : t,
      );
      const active = openTabs.find((t) => t.path === current.activeTabPath);
      return { openTabs, ...(current.activeTabPath === path && active ? { dirty: active.dirty } : {}) };
    });
  };

  /** 非删除类错误（权限 / IO）：只报错，**保留基线**（§6.4），不标删除态 */
  const markTabError = (path: string, message: string): void => {
    set((current) => {
      const openTabs = current.openTabs.map((t) =>
        t.path === path ? { ...t, saveError: message } : t,
      );
      return current.activeTabPath === path
        ? { openTabs, saveError: message }
        : { openTabs };
    });
  };

  /** 构造主面板激活状态；目标已在分屏时同步关闭分屏，避免重复展示 */
  const mainTabPatch = (
    current: WorkspaceState,
    tab: OpenTab,
  ): Partial<WorkspaceState> => {
    const closesSplit = current.splitFile === tab.path;
    if (closesSplit) intents.splitFile += 1;
    return {
      activeTabPath: tab.path,
      currentFile: tab.path,
      currentContent: tab.content,
      dirty: tab.dirty,
      // 顶层 saving 是活跃 tab 的镜像：切换 tab 后以新 tab 的实际保存状态为准，
      // 不再残留上一个 tab 挂起的保存状态（issue #148）
      saving: !!tab.saving,
      saveError: null,
      conflictPending: !!tab.conflictPending,
      lastSavedAt: tab.lastSavedAt,
      currentHeadingSlug: null,
      ...(closesSplit ? { splitFile: null, splitContent: "" } : {}),
    };
  };

  /** 按操作序号激活主面板；过期请求只保留为后台标签页 */
  const activateMainTab = (filePath: string, intent: number): void => {
    let nextRecent: string[] | null = null;
    set((current) => {
      if (intent !== intents.mainFile) return {};
      const tab = current.openTabs.find((candidate) => candidate.path === filePath);
      if (!tab) return {};

      nextRecent = pushRecent(current.recentFiles, filePath);
      const fileOpenErrors = new Map(current.fileOpenErrors);
      fileOpenErrors.delete(filePath);
      return {
        ...mainTabPatch(current, tab),
        recentFiles: nextRecent,
        fileOpenErrors,
      };
    });
    if (nextRecent) persistRecentFiles(nextRecent);
  };

  /**
   * 维护按 tab 的保存中状态，并把顶层 saving 镜像同步为「活跃 tab」的实际状态
   * （issue #148）：某个 tab 的保存挂在对话框期间，其他 tab 的保存不被互斥闸拦截。
   */
  const applyTabSaving = (targetPath: string, value: boolean) => {
    set((current) => {
      const openTabs = current.openTabs.map((t) =>
        t.path === targetPath ? { ...t, saving: value } : t,
      );
      const activeTab = openTabs.find((t) => t.path === current.activeTabPath);
      return { openTabs, saving: activeTab?.saving ?? false };
    });
  };

  /**
   * 写盘发现文件已不在原处（issue #363）：标记 tab，自动保存据此暂停。
   *
   * 与 `markDeletedOnDisk` 共用同一份实现（#362 §12 ④）：必须**同时清掉 stat 基线**，
   * 否则下一轮 `evaluateBaseline` 拿旧基线仍判「未变」，删除态会被当成正常文件放过去。
   */
  const markMissingOnDisk = (targetPath: string) => {
    markDeletedOnDisk(targetPath);
  };

  /** 写盘回执判为冲突（#362）：标记冲突待处理，自动保存据此暂停 */
  const markConflictPending = (targetPath: string) => {
    set((current) => {
      const openTabs = current.openTabs.map((t) =>
        t.path === targetPath ? { ...t, conflictPending: true } : t,
      );
      return current.activeTabPath === targetPath
        ? { openTabs, conflictPending: true }
        : { openTabs };
    });
  };

  /**
   * 交互式保存遇到「文件已不在原处」时由用户决定去向（issue #363）：
   * 在原位置重新创建 / 另存为 / 取消。返回最终写入的路径，取消返回 null。
   * 写盘失败照常抛出，由 saveCurrent 统一记 saveError。
   */
  const resolveMissingFileSave = async (
    savePath: string,
    code: WriteErrorCode,
    content: string,
  ): Promise<{ path: string; stat: FileStat } | null> => {
    const { message, save } = await import("@tauri-apps/plugin-dialog");
    const name = savePath.split(/[\\/]/).pop();
    const RECREATE = "重新创建";
    const SAVE_AS = "另存为…";
    const CANCEL = "取消";
    // 原路径或其所在文件夹路径被占用时无法原地重建，只提供另存为
    const canRecreate = code !== "NOT_A_FILE" && code !== "PARENT_NOT_DIR";
    const reasons: Record<WriteErrorCode, string> = {
      TARGET_MISSING: `「${name}」已不在原位置（可能已被删除、移动或重命名）。`,
      PARENT_MISSING: `「${name}」所在的文件夹已不存在（可能已被删除、移动，或磁盘已断开）。`,
      NOT_A_FILE: `「${name}」的原路径已被其他内容（如同名文件夹）占用。`,
      PARENT_NOT_DIR: `「${name}」所在的文件夹路径已被同名文件占用。`,
    };
    const reason = reasons[code];
    const options = canRecreate
      ? `你可以在原位置重新创建${code === "PARENT_MISSING" ? "（将同时重建文件夹）" : ""}、另存为到其他位置，或取消（保留编辑内容，暂不写入磁盘）。`
      : "你可以另存为到其他位置，或取消（保留编辑内容，暂不写入磁盘）。";
    let choice: string;
    try {
      choice = await message(`${reason}\n为避免误把文件写回，自动保存已暂停。\n\n${options}`, {
        title: "文件已不在原位置",
        kind: "warning",
        buttons: canRecreate
          ? { yes: RECREATE, no: SAVE_AS, cancel: CANCEL }
          : { ok: SAVE_AS, cancel: CANCEL },
      });
    } catch {
      // 弹窗异常视为取消：不写盘，编辑内容保留
      return null;
    }
    // 自定义按钮在不同平台可能回传按钮文字或 Yes/No/Ok
    const wantsRecreate = canRecreate && (choice === RECREATE || choice === "Yes");
    const wantsSaveAs =
      choice === SAVE_AS || (canRecreate ? choice === "No" : choice === "Ok");

    if (wantsRecreate) {
      // 文档写入统一走写引擎（回执 + 半失败登记）：`createParentDirs` 只在这条
      // 「用户明确确认重建」的路径上为 true，是它唯一的生产调用方
      const outcome = await saveDocument(savePath, content, { createParentDirs: true }).catch(
        async (err: unknown) => {
          // 引擎抛错（NotAFile / create_dir_all 失败等）必须在这里收口：
          // 否则异常冒到 saveCurrent 的 catch，会拿**旧路径**再弹一次「原文件不在了」
          await message(`重新创建「${name}」失败：${formatCmdError(err).message}`, {
            title: "重新创建失败",
            kind: "warning",
          });
          return null;
        },
      );
      if (!outcome) return null;
      if (outcome.kind !== "written") {
        // 期间文件被别人建出来（CreateExclusive → conflict）等：必须告诉用户，
        // 不能「点了重新创建，界面毫无反应」
        await message(
          outcome.kind === "conflict"
            ? `「${name}」在此期间已被其他程序创建，未覆盖。请重新选择操作。`
            : `「${name}」重新创建失败，请重试或另存为。`,
          { title: "重新创建失败", kind: "warning" },
        );
        return null;
      }
      return { path: savePath, stat: outcome.stat };
    }
    if (!wantsSaveAs) return null;

    const picked = await save({
      defaultPath: savePath,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (!picked) return null;
    if (!isSamePath(picked, savePath) && get().openTabs.some((t) => isSamePath(t.path, picked))) {
      await message(`「${picked.split(/[\\/]/).pop()}」已在其他标签页打开，请先关闭它或选择其他位置。`, {
        title: "另存为",
        kind: "warning",
      });
      return null;
    }
    // 原生保存对话框已经问过「是否替换」，这里的 overwriteExisting 就是那次同意：
    // 否则 CreateExclusive 会对已存在目标一律 conflict，「另存为覆盖旧文件」直接不可用。
    // **例外**：用户把目标选回「原路径」时不算覆盖（那个路径上的文件刚被删/改名），
    // 按 CreateExclusive 处理，与「重新创建」保持同一竞态保护（期间被重建 → conflict）
    const savedAs = await saveDocument(picked, content, {
      overwriteExisting: !isSamePath(picked, savePath),
    }).catch(async (err: unknown) => {
      // 与重建分支同理：异常必须在这里收口，否则冒到 saveCurrent 的 catch 会拿旧路径
      // 再弹一次「原文件不在了」，把「目标目录被占位」这类错误归因到错误的文件上
      await message(`写入「${picked.split(/[\\/]/).pop()}」失败：${formatCmdError(err).message}`, {
        title: "另存为",
        kind: "warning",
      });
      return null;
    });
    if (!savedAs) return null;
    if (savedAs.kind !== "written") {
      await message(`写入「${picked.split(/[\\/]/).pop()}」失败，请重试或选择其他位置。`, {
        title: "另存为",
        kind: "warning",
      });
      return null;
    }
    return { path: picked, stat: savedAs.stat };
  };

  return {
    openTabs: [],
    activeTabPath: null,
    currentFile: null,
    currentContent: "",
    dirty: false,
    saving: false,
    saveError: null,
    conflictPending: false,
    lastSavedAt: null,
    currentHeadingSlug: null,
    openingFiles: new Set(),
    fileOpenErrors: new Map(),

    // 分屏状态
    splitFile: null,
    splitContent: "",

    openFile: async (filePath) => {
      const intent = ++intents.mainFile;
      const tab = await ensureTab(filePath);
      // 以实际落定的 tab 路径激活（issue #200：在途重命名后 tab 建在新路径）
      activateMainTab(tab.path, intent);
    },

    reloadFile: async (filePath) => {
      // 未打开的文件退化为普通打开
      if (!get().openTabs.some((t) => t.path === filePath)) {
        await get().openFile(filePath);
        return;
      }
      try {
        // 直接读磁盘，绕过 tab 缓存（openFile 对已打开 tab 复用缓存，无法真正重载）。
        // #362：一次成对读取——内容与 stat 同源，不允许多打一次 fileMtime（R2）
        const snapshot = await readDocument(filePath);
        // #365：用户明确「丢弃本地修改，重载磁盘」→ 草稿里那份内容已被丢弃，
        // 不清掉会让恢复面板给出「可恢复」的假提示。这里 await：重载是低频动作，
        // 而「重载完草稿还在」会让 5b 立刻给出过期的恢复提示
        await clearDraft(filePath);
        set((current) => {
          const openTabs = current.openTabs.map((t) =>
            t.path === filePath
              ? {
                  ...t,
                  content: snapshot.content,
                  dirty: false,
                  diskContent: snapshot.content,
                  diskStat: snapshot.stat,
                  diskMtime: mtimeMsOf(snapshot.stat),
                  deletedOnDisk: false,
                  saveError: null,
                  // 重载即以磁盘内容为准，冲突已解决（issue #164）：
                  // 否则状态栏持续误报"外部冲突"且指示器点击无效
                  conflictPending: false,
                  revision: (t.revision || 0) + 1,
                }
              : t,
          );
          const patch: Partial<WorkspaceState> = { openTabs };
          if (current.activeTabPath === filePath) {
            patch.currentContent = snapshot.content;
            patch.dirty = false;
            patch.saveError = null;
            patch.conflictPending = false;
          }
          if (current.splitFile === filePath) {
            patch.splitContent = snapshot.content;
          }
          return patch;
        });
      } catch (err) {
        console.warn(`reloadFile 读取失败: ${filePath}`, err);
        const shape = formatCmdError(err);
        set({ saveError: `文件重载失败（可能已被删除）：${shape.message}` });
      }
    },

    openFileStandalone: async (filePath) => {
      const ownsWorkspaceContext = get().workspaceMode !== "folder";
      const contextIntent = ownsWorkspaceContext ? ++intents.workspaceContext : null;
      if (ownsWorkspaceContext) {
        // 单文件入口晚于尚未完成的文件夹打开时，以最新的用户操作为准
        intents.workspaceGeneration += 1;
        set({ workspaceLoading: false, loadingDirs: new Set() });
      }
      // 先用 openFile 完成 tab 读取/切换/recent 更新
      await get().openFile(filePath);
      // 单文件模式：不构建文件树，但保留父目录作为当前文件上下文。
      // 仅当当前不是 folder 模式时才设为 file 模式，避免覆盖已打开的文件夹工作区。
      const { workspaceMode, activeTabPath } = get();
      if (
        !ownsWorkspaceContext ||
        contextIntent !== intents.workspaceContext ||
        workspaceMode === "folder" ||
        activeTabPath !== filePath
      ) {
        return;
      }
      const parent = parentDir(filePath);
      set({ rootPath: parent, workspaceMode: "file", tree: null });
    },

    newTab: () => {
      get().openUntitledTabWithContent("");
    },

    openUntitledTabWithContent: (initialContent: string) => {
      flushAllMarkdownPublishers();
      intents.mainFile += 1;
      const { openTabs } = get();
      // 生成唯一虚拟路径 untitled-1, untitled-2...（避免与已打开草稿重名）
      let n = 1;
      const existing = new Set(openTabs.map((t) => t.path));
      while (existing.has(`untitled-${n}`)) n++;
      const path = `untitled-${n}`;
      const tab: OpenTab = {
        path,
        content: initialContent,
        dirty: initialContent.length > 0,
        lastSavedAt: null,
        cursorPos: null,
        scrollTop: null,
        isUntitled: true,
      };
      set({
        openTabs: [...get().openTabs, tab],
        activeTabPath: path,
        currentFile: path,
        currentContent: initialContent,
        dirty: initialContent.length > 0,
        saveError: null,
        lastSavedAt: null,
      });
    },

    splitOpen: async (filePath) => {
      const intent = ++intents.splitFile;
      const tab = await ensureTab(filePath);
      if (intent !== intents.splitFile) return;
      // 不让分屏文件与主文件相同（无对照意义）——用落定路径判断
      if (tab.path === get().currentFile) return;
      set({ splitFile: tab.path, splitContent: tab.content });
    },

    splitClose: () => {
      intents.splitFile += 1;
      set({ splitFile: null, splitContent: "" });
    },

    splitSwap: () => {
      flushAllMarkdownPublishers();
      const { splitFile, currentFile, openTabs } = get();
      if (!splitFile || !currentFile) return;
      const mainTab = openTabs.find((t) => t.path === currentFile);
      const splitTab = openTabs.find((t) => t.path === splitFile);
      if (!mainTab || !splitTab) return;
      // 主面板切换到原分屏文件，分屏切换到原主文件
      get().switchTab(splitFile);
      const latestMainTab = get().openTabs.find((t) => t.path === currentFile);
      set({ splitFile: currentFile, splitContent: latestMainTab?.content ?? mainTab.content });
    },

    verifyTabOnDisk: async (filePath, options) => {
      const interactive = options?.interactive ?? true;
      const initial = get().openTabs.find((t) => t.path === filePath);
      if (!initial || initial.isUntitled) return;
      // 浏览器 mock 的 stat 已保真（#362），但检测路径只在桌面端启用：
      // E2E 覆盖不到这条链路，避免在浏览器里引入未验证的行为
      if (!isTauri()) return;
      // 在途保存时不核验：写完会自己登记基线，中途读盘只会制造假冲突
      if (initial.saving) return;
      // 后台已标记冲突：不再重复核验。否则每轮轮询都会走「stat → 全量读盘 → reconcile」
      // 一整条链路（10MB 文档 = 每 3 秒一次全量 IO + 一次订阅重渲染），
      // 只要用户不处理就一直持续。切回时 `switchTab` 的 interactive=true 会补弹。
      if (!interactive && initial.conflictPending) return;
      // 只有当**同一文件**的冲突对话框已经打开时才跳过；
      // 后台 tab 被标记 conflictPending 后，用户切回来时必须补弹（否则唯一出口是 Ctrl+S）
      if (useConflict.getState().conflict?.filePath === filePath) return;

      // ① stat 分类：notFound / notAFile 才是删除态，其余只报错、保留基线
      let current: FileStat | null = null;
      let statCode = "io";
      let statMessage = "";
      try {
        current = await fileStat(filePath);
      } catch (err) {
        const shape = formatCmdError(err);
        statCode = shape.code;
        statMessage = shape.message;
      }

      // ② 每个 await 之后都重取 tab（并发保存可能已更新基线、或 tab 已关闭）
      const tabAfterStat = get().openTabs.find((t) => t.path === filePath);
      if (!tabAfterStat) return;

      if (!current) {
        if (statCode === "notFound" || statCode === "notAFile") markDeletedOnDisk(filePath);
        else markTabError(filePath, statMessage);
        return;
      }

      if (tabAfterStat.deletedOnDisk) {
        set((state) => ({
          openTabs: state.openTabs.map((t) =>
            t.path === filePath ? { ...t, deletedOnDisk: false } : t,
          ),
        }));
      } else if (evaluateBaseline(tabAfterStat.diskStat, current) === "unchanged") {
        return;
      }

      // ③ 变了才成对读盘
      let snapshot: DocumentSnapshot;
      try {
        snapshot = await readDocument(filePath);
      } catch (err) {
        const shape = formatCmdError(err);
        if (shape.code === "notFound" || shape.code === "notAFile") markDeletedOnDisk(filePath);
        else markTabError(filePath, shape.message);
        return;
      }

      // ④ 读盘往返期间可能有新输入/并发保存：先 flush，再取最新 tab 作为比较对象
      flushAllMarkdownPublishers();
      const tabAfterRead = get().openTabs.find((t) => t.path === filePath);
      if (!tabAfterRead) return;

      // ⑤ 先比内容：磁盘就是编辑器内容 → 视为已保存；内容 == 旧基线 → 只是 touch
      const verdict = reconcileDiskContent(
        snapshot.content,
        tabAfterRead.content,
        tabAfterRead.diskContent,
      );
      if (verdict.kind === "same-as-write") {
        adoptDiskBaseline(filePath, snapshot, { clearDirty: true });
        return;
      }
      if (verdict.kind === "touch-only") {
        adoptDiskBaseline(filePath, snapshot);
        return;
      }

      // ⑥ 后台 tab 不打扰用户：干净则静默对齐，dirty 保留编辑（watcher 可要求标记待处理，
      // 切走场景（switchTab）则不标记——那时用户刚离开，下一次切回会重新核验并弹窗）
      if (!interactive || get().activeTabPath !== filePath) {
        if (!tabAfterRead.dirty) await get().reloadFile(filePath);
        else if (options?.markBackgroundConflict) markConflictPending(filePath);
        return;
      }
      if (!tabAfterRead.dirty) {
        await get().reloadFile(filePath);
        return;
      }

      // ⑦ 真冲突：对话框不能拿过期内容，再 flush 一次并重取，并再次确认仍活跃
      flushAllMarkdownPublishers();
      const tabForDialog = get().openTabs.find((t) => t.path === filePath);
      if (!tabForDialog) return;
      if (get().activeTabPath !== filePath) return;
      set((state) => {
        const openTabs = state.openTabs.map((t) =>
          t.path === filePath
            ?               // 读到内容即证明文件在磁盘上存在：必须退出删除态，
              // 否则保存链路会一直按"已被删除"暂停（"删除后同 stat 重建"正是这条）。
              //
              // 同时把 stat 身份推进到刚读到的这一版：否则 watcher 每 3s 都会发现
              // "基线又变了"，用户点「继续编辑」关掉对话框后会被反复弹（同一版只问一次）。
              // **但 `diskMtime` 故意留在旧值**：`saveCurrent` 的写前比对用它，
              // 保留旧值才能让用户下次 Ctrl+S 仍被提示「将覆盖外部修改」——
              // 若一并推进，冲突就变成静默覆盖了。
              { ...t, conflictPending: true, deletedOnDisk: false, diskStat: snapshot.stat }
            : t,
        );
        return state.activeTabPath === filePath
          ? { openTabs, conflictPending: true }
          : { openTabs };
      });
      useConflict.getState().openConflict({
        filePath,
        localContent: tabForDialog.content,
        diskContent: snapshot.content,
        detectedAt: Date.now(),
      });
    },

    switchTab: (filePath) => {
      flushAllMarkdownPublishers();
      const tab = get().openTabs.find((t) => t.path === filePath);
      if (!tab) return;
      intents.mainFile += 1;
      // 切换 tab 时重置大纲高亮，等编辑器更新后由 tracker 重新计算
      set((current) => mainTabPatch(current, tab));
      // 这里**不**顺手保存离开的 tab：一次机会式写盘会在「切走」这个用户无感的时刻
      // 制造冲突标记/删除标记（评审 R2 明确要求后台 tab 不得被置 conflictPending）。
      // 后台 tab 的落盘由按 path 独立防抖的调度器负责（#364 §7.2）。

      // 切换激活时核验磁盘状态（#362 §4.4）：实现见 `verifyTabOnDisk`，
      // 与 watcher 共用同一份逻辑，避免两处判定漂移
      void get().verifyTabOnDisk(filePath);
    },

    closeTab: (filePath) => {
      flushAllMarkdownPublishers();
      const { openTabs, activeTabPath } = get();
      const idx = openTabs.findIndex((t) => t.path === filePath);
      if (idx === -1) return;
      // #365：关闭即清掉草稿（用户已明确不要这个 tab）
      void clearDraft(filePath);
      // #364：关闭即移除订阅键条目（否则 pathRevs 只增不减）
      dropPathRev(filePath);
      const nextTabs = openTabs.filter((t) => t.path !== filePath);
      // 若关闭的是分屏文件，同步关闭分屏面板
      const splitClosing = get().splitFile === filePath;
      if (activeTabPath === filePath) intents.mainFile += 1;
      if (splitClosing) intents.splitFile += 1;

      // 关闭的是活跃 tab：选择相邻 tab 激活
      if (activeTabPath === filePath) {
        if (nextTabs.length === 0) {
          // 没有剩余 tab
          set({
            openTabs: nextTabs,
            activeTabPath: null,
            currentFile: null,
            currentContent: "",
            dirty: false,
            lastSavedAt: null,
            saveError: null,
            currentHeadingSlug: null,
          });
        } else {
          // 优先激活右边的（原 idx 位置），越界则取最后一个
          const nextIdx = Math.min(idx, nextTabs.length - 1);
          const next = nextTabs[nextIdx];
          set((current) => ({
            openTabs: nextTabs,
            ...mainTabPatch(current, next),
          }));
        }
      } else {
        // 关闭的不是活跃 tab，只更新列表
        set({ openTabs: nextTabs });
      }
      // 若关闭的是分屏文件，同步关闭分屏面板
      if (splitClosing) set({ splitFile: null, splitContent: "" });
    },

    closeOthers: (keepPath) => {
      flushAllMarkdownPublishers();
      const { openTabs, splitFile } = get();
      const keep = openTabs.find((t) => t.path === keepPath);
      if (!keep) return;
      // #364：批量关闭也要清 pathRevs，否则重开同路径会从旧 rev 起步
      for (const t of openTabs) if (t.path !== keepPath) dropPathRev(t.path);
      intents.mainFile += 1;
      if (splitFile && splitFile !== keepPath) intents.splitFile += 1;
      set((current) => ({
        openTabs: [keep],
        ...mainTabPatch(current, keep),
        splitFile: null,
        splitContent: "",
      }));
    },

    closeToRight: (fromPath) => {
      flushAllMarkdownPublishers();
      const { openTabs, activeTabPath, splitFile } = get();
      const idx = openTabs.findIndex((t) => t.path === fromPath);
      if (idx === -1) return;
      intents.mainFile += 1;
      const nextTabs = openTabs.slice(0, idx + 1);
      for (const t of openTabs.slice(idx + 1)) dropPathRev(t.path);
      const splitRemoved = !!splitFile && !nextTabs.some((tab) => tab.path === splitFile);
      if (splitRemoved) intents.splitFile += 1;
      // 若活跃 tab 被关掉了，激活 fromPath
      const activeTab = nextTabs.find((t) => t.path === activeTabPath);
      if (activeTab) {
        set({
          openTabs: nextTabs,
          ...(splitRemoved ? { splitFile: null, splitContent: "" } : {}),
        });
      } else {
        const fallback = openTabs[idx];
        set((current) => ({
          openTabs: nextTabs,
          ...mainTabPatch(current, fallback),
          ...(splitRemoved ? { splitFile: null, splitContent: "" } : {}),
        }));
      }
    },

    closeAll: () => {
      flushAllMarkdownPublishers();
      // #364：批量关闭也要清 pathRevs，否则重开同路径会从旧 rev 起步
      for (const t of get().openTabs) dropPathRev(t.path);
      intents.mainFile += 1;
      intents.splitFile += 1;
      set({
        openTabs: [],
        activeTabPath: null,
        currentFile: null,
        currentContent: "",
        dirty: false,
        lastSavedAt: null,
        saveError: null,
        currentHeadingSlug: null,
        splitFile: null,
        splitContent: "",
      });
    },

    reorderTabs: (fromPath, toPath) => {
      if (fromPath === toPath) return;
      const { openTabs } = get();
      const fromIdx = openTabs.findIndex((t) => t.path === fromPath);
      const toIdx = openTabs.findIndex((t) => t.path === toPath);
      if (fromIdx === -1 || toIdx === -1) return;
      const next = [...openTabs];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      set({ openTabs: next });
    },

    setContent: (content) => {
      const { currentContent, activeTabPath, openTabs } = get();
      if (content === currentContent) return;
      // #364：内容真正变化才 bump（唯一 bump 点之一）；保存成功不重置
      if (activeTabPath) {
        bumpPathRev(activeTabPath);
        // #365：编辑即排一次草稿落盘（1.2s 防抖）——崩溃 / 被 kill 后还能找回。
        // `isUntitled` 必须取 tab 的真实值：写死 false 会让无标题草稿被当成「有路径的文档」恢复
        const activeTab = openTabs.find((t) => t.path === activeTabPath);
        scheduleDraft({ path: activeTabPath, isUntitled: !!activeTab?.isUntitled, content });
      }
      // 更新活跃 tab 的内容与 dirty
      if (activeTabPath) {
        const nextTabs = openTabs.map((t) =>
          t.path === activeTabPath ? { ...t, content, dirty: true } : t,
        );
        set({ openTabs: nextTabs, currentContent: content, dirty: true });
      } else {
        set({ currentContent: content, dirty: true });
      }
    },

    setContentFor: (path, content) => {
      const { activeTabPath, openTabs } = get();
      const tab = openTabs.find((t) => t.path === path);
      if (!tab || tab.content === content) return;
      // #364：内容真正变化才 bump（唯一 bump 点之一）
      bumpPathRev(path);
      scheduleDraft({ path, isUntitled: !!tab.isUntitled, content });
      const nextTabs = openTabs.map((t) =>
        t.path === path ? { ...t, content, dirty: true } : t,
      );
      // 同步所有当前拥有该 path 的镜像：活跃 tab 用 currentContent、
      // 分屏用 splitContent。swap 后的迟到 flush 可能指向新主/新分屏文件，
      // 只写 openTabs 会让另一侧编辑器拿到旧值并在下次编辑时覆盖（PR #34）
      const patch: Partial<WorkspaceState> = { openTabs: nextTabs };
      if (path === activeTabPath) {
        patch.currentContent = content;
        patch.dirty = true;
      }
      const { splitFile, splitContent } = get();
      if (path === splitFile && content !== splitContent) {
        patch.splitContent = content;
      }
      set(patch);
    },

    setSplitContentFor: (path, content) => {
      get().setContentFor(path, content);
    },

    saveTab: async (filePath, options) => {
      const interactive = options?.interactive ?? true;

      // 意图升级（#364 §7.1）：排队中或已在途的保存不能把这次调用吞掉。
      // 非交互直接搭车；交互要先等旧的（可能失败）跑完，再以交互模式执行一次——
      // 否则用户按 Ctrl+S 什么都没发生。
      if (saveQueue.has(filePath) || inflightSaves.has(filePath)) {
        const doing = inflightSaves.get(filePath) ?? saveQueue.get(filePath);
        if (!interactive) return doing ?? Promise.resolve();
        try {
          await doing;
        } catch {
          // 旧的非交互保存失败不能连带吞掉这次交互保存
        }
        const after = get().openTabs.find((t) => t.path === filePath);
        if (!after || (!after.dirty && !after.conflictPending && !after.deletedOnDisk)) return;
      }

      const run = async () => {
      flushAllMarkdownPublishers();
      const { openTabs } = get();
      // 目标可以是**后台 tab**（#364）：下面的镜像更新都按「是不是活跃 tab」判定
      const activeTabPath = filePath;
      const tab = openTabs.find((t) => t.path === activeTabPath);
      if (!tab) return;
      const dirty = tab.dirty;
      // 保存互斥按 tab 判定（issue #148）：其他 tab 的保存挂在对话框期间，
      // 不应吞掉本 tab 的保存；同一 tab 的重复保存仍被拦截防重入
      // 文件已不在原处时，干净 tab 的交互保存也要放行：用户可借此重新创建
      // 或另存为被误删的文件（Codex 复审：否则状态栏「文件已删除」入口点了没反应）
      const recoveringDeleted = interactive && !!tab.deletedOnDisk;
      if ((!dirty && !recoveringDeleted) || tab.saving) return;
      // issue #363：文件已不在原处时自动保存暂停，等用户处理（Ctrl+S / 状态栏入口）
      // 或文件恢复后由监听器解除标记
      if (!interactive && tab.deletedOnDisk) return;
      // 冲突待处理：非交互保存直接返回，否则调度器每 2s 会「写 → 冲突 → 弹窗」空转
      if (!interactive && tab.conflictPending) return;

      // 立即置位本 tab 的 saving，防止重入（例如弹窗期间定时保存触发）
      applyTabSaving(activeTabPath, true);
      // 只清「目标就是活跃 tab」的错误提示：后台 tab 的保存不能抹掉用户正在看的报错
      if (get().activeTabPath === activeTabPath) set({ saveError: null });

      let savePath = tab.path;
      // 记录本次保存发起时快照内容
      const contentToSave = tab.content;
      /** 用户在上面「是否覆盖外部修改」里确认过：只放宽回执的身份比对，不放宽目标存在性 */
      let overwriteConfirmed = false;

      try {
        // 未命名草稿：首次保存弹另存为对话框选择保存位置
        if (tab.isUntitled) {
          if (!interactive) {
            // 非交互模式（如自动保存）：未命名文件跳过弹窗保存
            applyTabSaving(activeTabPath, false);
            return;
          }
          if (!isTauri()) {
            // 浏览器 mock 模式：直接用原虚拟路径写内存
            savePath = tab.path;
          } else {
            const { save } = await import("@tauri-apps/plugin-dialog");
            const picked = await save({
              defaultPath: "未命名.md",
              filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
            });
            if (!picked) {
              applyTabSaving(activeTabPath, false);
              return; // 用户取消
            }
            savePath = picked;
          }
        } else if (isTauri()) {
          // 普通文件保存前与磁盘基线比对：优先比对 mtime 快速路径；
          // 仅在 mtime 变动（或无法获取 mtime）时才读取磁盘全文比对，防止大文件每按一次 Ctrl+S 产生双倍 IO 与全文字符串比较
          let shouldCheckConflict = false;
          let mtimeChanged = true;
          try {
            if (tab.diskMtime !== undefined) {
              const currentMtime = await fileMtime(savePath);
              if (Math.abs(currentMtime - tab.diskMtime) < 5) {
                // mtime 一致，快速路径命中，无需读取全文
                mtimeChanged = false;
              }
            }
          } catch {
            // 获取 mtime 失败（如文件被删），回退到内容读取
            mtimeChanged = true;
          }

          if (mtimeChanged) {
            try {
              const latestOnDisk = await readTextFile(savePath);
              if (tab.diskContent !== undefined && latestOnDisk !== tab.diskContent) {
                shouldCheckConflict = true;
              }
            } catch {
              // 文件可能被删除或不可读：交给下方 mustExist 写盘判定（issue #363），
              // 文件已不在原处时写盘被拒、转入「已删除」处理，绝不悄悄写回
            }
          }

          if (shouldCheckConflict) {
            if (!interactive) {
              // 自动保存等非交互场景遇到冲突，标记 conflictPending 供状态栏展示，静默跳过不覆盖
              set((current) => {
                const openTabs = current.openTabs.map((t) =>
                  t.path === activeTabPath ? { ...t, conflictPending: true, saving: false } : t,
                );
                const activeTab = openTabs.find((t) => t.path === current.activeTabPath);
                return {
                  openTabs,
                  saving: activeTab?.saving ?? false,
                  conflictPending:
                    current.activeTabPath === activeTabPath ? true : current.conflictPending,
                };
              });
              return;
            }
            try {
              const { ask } = await import("@tauri-apps/plugin-dialog");
              const confirmed = await ask(
                "文件已被外部程序修改。覆盖保存将丢失外部修改，是否继续覆盖？",
                { title: "保存冲突提示", kind: "warning" },
              );
              if (!confirmed) {
                applyTabSaving(activeTabPath, false);
                return;
              }
              // 确认覆盖：只置位 overwriteConfirmed。Rust 侧据此跳过身份比对
              // （但保留「目标必须存在」），所以不必再读一次盘取最新身份
              overwriteConfirmed = true;
            } catch {
              // 弹窗异常或被 reject/取消时，视为放弃覆盖并安全退出
              applyTabSaving(activeTabPath, false);
              return;
            }
          }
        }

        // issue #150：目标路径已在其他 tab 打开时走合并路径——
        // 不能把草稿 tab 直接改名为已存在的 path（两个同 path tab 会导致
        // TabsBar key 重复、按 path find/filter 的编辑写错项、关闭删双份）。
        // 语义：草稿内容写入目标文件，并入已有 tab 并关闭草稿、激活目标。
        // 排除正在保存的 tab 自身：普通文件保存时 savePath === activeTabPath，
        // 只有「另一个」同 path tab 才构成需要合并的重复
        const mergeTarget = get().openTabs.find(
          (t) => t.path === savePath && t.path !== activeTabPath,
        );
        if (mergeTarget) {
          // 复审修复：入口快照目标内容。异步窗口（冲突检测/写盘 await）期间
          // 用户可能切到目标 tab 继续输入——若完成时目标内容与快照不一致，
          // 说明窗口期有新编辑，合并 set 不得用草稿内容覆盖、不得清掉 dirty，
          // 与草稿侧 closeDraft 的保护对称（否则用户编辑被静默丢弃）
          const targetContentAtEntry = mergeTarget.content;
          if (mergeTarget.dirty) {
            // 目标 tab 有未保存内容，覆盖将丢失这些编辑，需用户确认
            try {
              const { ask } = await import("@tauri-apps/plugin-dialog");
              const confirmed = await ask(
                `文件「${savePath.split(/[\\/]/).pop()}」已打开且有未保存的内容，保存将覆盖这些内容。是否继续？`,
                { title: "另存为覆盖确认", kind: "warning" },
              );
              if (!confirmed) {
                applyTabSaving(activeTabPath, false);
                return;
              }
            } catch {
              // 弹窗异常视为放弃覆盖，安全退出
              applyTabSaving(activeTabPath, false);
              return;
            }
          }

          // review 修复：合并路径不得绕过外部修改冲突检测——
          // 用目标 tab 的磁盘基线跑与常规保存一致的 mtime 快速路径 + 全文比对，
          // 否则「外部改过 A + 草稿另存为 A」会静默覆盖外部编辑
          if (isTauri()) {
            let mergeMtimeChanged = true;
            try {
              if (mergeTarget.diskMtime !== undefined) {
                const currentMtime = await fileMtime(savePath);
                if (Math.abs(currentMtime - mergeTarget.diskMtime) < 5) {
                  mergeMtimeChanged = false;
                }
              }
            } catch {
              mergeMtimeChanged = true;
            }
            let mergeConflict = false;
            if (mergeMtimeChanged) {
              try {
                const latestOnDisk = await readTextFile(savePath);
                if (
                  mergeTarget.diskContent !== undefined &&
                  latestOnDisk !== mergeTarget.diskContent
                ) {
                  mergeConflict = true;
                }
              } catch {
                // 文件可能被删除或不可读，继续尝试写入
              }
            }
            if (mergeConflict) {
              if (!interactive) {
                // 自动保存等非交互场景：标记冲突、不静默覆盖
                set((current) => ({
                  openTabs: current.openTabs.map((t) =>
                    t.path === savePath ? { ...t, conflictPending: true } : t,
                  ),
                }));
                applyTabSaving(activeTabPath, false);
                return;
              }
              try {
                const { ask } = await import("@tauri-apps/plugin-dialog");
                const confirmed = await ask(
                  "目标文件已被外部程序修改。覆盖保存将丢失外部修改，是否继续覆盖？",
                  { title: "保存冲突提示", kind: "warning" },
                );
                if (!confirmed) {
                  applyTabSaving(activeTabPath, false);
                  return;
                }
              } catch {
                // 弹窗异常视为放弃覆盖，安全退出
                applyTabSaving(activeTabPath, false);
                return;
              }
            }
          }

          await writeTextFile(savePath, contentToSave);
          const mergedAt = Date.now();
          let mergedMtime: number | undefined;
          try {
            mergedMtime = await fileMtime(savePath);
          } catch {
            // 忽略 mtime 失败
          }
          // review 修复：异步窗口（对话框/写盘）结束后重新读取最新状态——
          // 期间用户可能切换/关闭了 tab，完成时尊重用户的选择，
          // 顶层镜像从实际活跃 tab 派生，不得无条件抢占（issue #148 模式）
          const latestState = get();
          const draft = latestState.openTabs.find((t) => t.path === activeTabPath);
          const targetStillOpen = latestState.openTabs.some((t) => t.path === savePath);
          // 写盘窗口期草稿若又有新编辑（内容不一致）则保留草稿，
          // 只合并已写盘内容，不丢弃新编辑
          const closeDraft = !draft || draft.content === contentToSave;
          const stillOnDraft = latestState.activeTabPath === activeTabPath;
          const nextRecent = pushRecent(latestState.recentFiles, savePath);
          persistRecentFiles(nextRecent);

          let nextTabs: OpenTab[];
          if (targetStillOpen) {
            nextTabs = latestState.openTabs
              .filter((t) => (closeDraft ? t.path !== activeTabPath : true))
              .map((t) => {
                if (t.path === savePath) {
                  // 复审修复：窗口期目标有新编辑（内容相对入口快照变化）时，
                  // 保留用户的在编辑器内容并保持 dirty（后续自动保存会落盘），
                  // 只同步确实已变的磁盘基线；脏确认弹窗只授权「确认那一刻」
                  // 的内容覆盖，不覆盖确认之后窗口期产生的新编辑
                  if (t.content !== targetContentAtEntry) {
                    return {
                      ...t,
                      dirty: true,
                      conflictPending: false,
                      saving: false,
                      lastSavedAt: mergedAt,
                      diskContent: contentToSave,
                      diskMtime: mergedMtime,
                    };
                  }
                  return {
                    ...t,
                    content: contentToSave,
                    dirty: false,
                    conflictPending: false,
                    saving: false,
                    lastSavedAt: mergedAt,
                    diskContent: contentToSave,
                    diskMtime: mergedMtime,
                  };
                }
                if (!closeDraft && t.path === activeTabPath) {
                  return { ...t, saving: false };
                }
                return t;
              });
          } else {
            // 目标 tab 在窗口期被关闭：回退改名语义，草稿承接已保存的路径，
            // 避免 activeTabPath 指向不存在的 tab
            nextTabs = latestState.openTabs.map((t) => {
              if (t.path === activeTabPath) {
                const isStillDirty = t.content !== contentToSave;
                return {
                  ...t,
                  path: savePath,
                  isUntitled: false,
                  dirty: isStillDirty,
                  conflictPending: false,
                  saving: false,
                  lastSavedAt: mergedAt,
                  diskContent: contentToSave,
                  diskMtime: mergedMtime,
                };
              }
              return t;
            });
          }

          // 仅当合并完成时用户仍停留在草稿上才激活合并结果；
          // 窗口期已切走（或关闭了草稿）则保留用户的选择
          const nextActivePath = stillOnDraft ? savePath : latestState.activeTabPath;
          const nextActiveTab = nextTabs.find((t) => t.path === nextActivePath);
          // review 修复：分屏是合并目标时，合并后对照内容已陈旧且主/分屏同文件
          // （splitOpen 守卫刻意阻止的状态）——关闭分屏（对照已无意义）；
          // 分屏是草稿本身时同样关闭
          const splitAffected =
            latestState.splitFile === activeTabPath ||
            latestState.splitFile === savePath;
          set({
            openTabs: nextTabs,
            activeTabPath: nextActivePath,
            currentFile: nextActivePath,
            currentContent: nextActiveTab?.content ?? "",
            dirty: nextActiveTab ? nextActiveTab.dirty : false,
            saving: nextActiveTab ? !!nextActiveTab.saving : false,
            conflictPending: nextActiveTab ? !!nextActiveTab.conflictPending : false,
            saveError: stillOnDraft ? null : latestState.saveError,
            lastSavedAt: stillOnDraft ? mergedAt : latestState.lastSavedAt,
            recentFiles: nextRecent,
            ...(splitAffected ? { splitFile: null, splitContent: "" } : {}),
          });
          return;
        }

        // 「已删除文件」经用户选择重新创建 / 另存为后，磁盘上多出一个文件
        let resolvedMissing = false;
        // 基线直接取写盘回执（#362 M1）：内容与磁盘身份来自同一次提交，
        // 不再「写完再 stat」——那中间的任意外写都会让基线指向别人的内容
        let savedStat: FileStat | undefined;
        /** 写后回执降级：内容可能被别人覆盖，不能当「已保存」 */
        let receiptUntrusted = false;
        try {
          if (tab.isUntitled) {
            // 草稿另存为：目标由用户在对话框选定，允许创建
            await writeTextFile(savePath, contentToSave);
            try {
              savedStat = await fileStat(savePath);
            } catch {
              // 取不到身份就留空基线，下次读盘重建
            }
          } else if (!tab.diskStat) {
            // 没有成对基线（旧 tab / 恢复出来的 tab）：退回「必须存在」的写盘，
            // 仍不允许复活已删文件，但没有身份可比，也就无法改判冲突
            await writeTextFile(savePath, contentToSave, { mustExist: true });
            try {
              savedStat = await fileStat(savePath);
            } catch {
              // 留空基线
            }
          } else {
            const attempt = (expected?: FileStat, overwrite = false) =>
              saveDocument(savePath, contentToSave, { expected, overwriteExisting: overwrite });

            // expected = 上次成对读到的磁盘身份：目标消失 → notFound，身份变了 → conflict。
            // 用户已确认覆盖时只置 `overwriteExisting`：Rust 侧跳过身份比对（但保留目标必须存在）
            let outcome = await attempt(tab.diskStat, overwriteConfirmed);
            if (outcome.kind === "conflict") {
              // 磁盘内容仍等于我们的基线 → 只是 mtime 变了（touch / 基线过期），
              // adopt 新身份后重试一次（M2 三路里的 touch-only，不打扰用户）
              const disk = await readDocument(savePath).catch(() => null);
              if (disk && tab.diskContent !== undefined && disk.content === tab.diskContent) {
                set((current) => ({
                  openTabs: current.openTabs.map((t) =>
                    t.path === activeTabPath ? { ...t, diskStat: disk.stat } : t,
                  ),
                }));
                outcome = await attempt(disk.stat);
              }
            }

            if (outcome.kind === "written") {
              // foreignWrite = 写后回执降级（写后 stat 与写入内容对不上，可能被别人覆盖）：
              // 不能当「已保存」——否则下一轮 watcher 会把干净 tab 静默重载，
              // 刚写下去的内容从编辑器消失且毫无提示。保持 dirty 并给可见提示
              if (outcome.foreignWrite) {
                receiptUntrusted = true;
                savedStat = undefined;
              } else {
                savedStat = outcome.stat;
              }
            } else if (outcome.kind === "conflict") {
              if (!interactive) {
                // 自动保存不打扰用户：只标记冲突待处理（下次切回/保存时再问）。
                markConflictPending(activeTabPath);
                applyTabSaving(activeTabPath, false);
                return;
              }
              // 回执说磁盘变了：读最新内容开冲突对话框（引擎已完成「同内容 → written」判定）
              const disk = await readDocument(savePath).catch(() => null);
              if (disk) {
                set((current) => ({
                  openTabs: current.openTabs.map((t) =>
                    t.path === activeTabPath ? { ...t, diskStat: disk.stat } : t,
                  ),
                }));
              }
              useConflict.getState().openConflict({
                filePath: savePath,
                localContent: contentToSave,
                diskContent: disk?.content ?? "",
                detectedAt: Date.now(),
              });
              if (outcome.tempPath) {
                const { showMessage } = await import("../../lib/dialogs");
                void showMessage(
                  `本次写入的内容保留在临时文件：${outcome.tempPath}` +
                    (outcome.registerFailed
                      ? "\n登记失败：重启后可能找不到，请立即另存。"
                      : ""),
                  { kind: "warning", title: "保存未完成" },
                );
              }
              applyTabSaving(activeTabPath, false);
              return;
            } else {
              // notFound / parentMissing / parentNotDir：文件已不在原处（#363），交给三选项。
              // 错误分类由 Rust 的 SaveOutcome 直接给出，**不做副作用写盘探测**
              // （探测若恰好赶上目录重现，会把内容真的写回旧路径）
              const code: WriteErrorCode =
                outcome.kind === "notFound"
                  ? "TARGET_MISSING"
                  : outcome.kind === "parentNotDir"
                    ? "PARENT_NOT_DIR"
                    : "PARENT_MISSING";
              markMissingOnDisk(activeTabPath);
              if (!interactive) {
                applyTabSaving(activeTabPath, false);
                return;
              }
              const resolved = await resolveMissingFileSave(savePath, code, contentToSave);
              if (!resolved) {
                applyTabSaving(activeTabPath, false);
                return;
              }
              savePath = resolved.path;
              savedStat = resolved.stat;
              resolvedMissing = true;
            }
          }
        } catch (e) {
          // 只处理「可归类的写盘异常」（权限 / Io / 半失败）；其余照旧上抛
          if (tab.isUntitled) throw e;
          const code = writeErrorCode(e);
          if (!code) throw e;
          markMissingOnDisk(activeTabPath);
          if (!interactive) {
            applyTabSaving(activeTabPath, false);
            return;
          }
          const resolved = await resolveMissingFileSave(savePath, code, contentToSave);
          if (!resolved) {
            applyTabSaving(activeTabPath, false);
            return;
          }
          savePath = resolved.path;
          savedStat = resolved.stat;
          resolvedMissing = true;
        }
        if (receiptUntrusted) {
          set({
            saveError: "保存可能未完成：写入后磁盘内容与预期不一致，请检查后另存副本。",
          });
        }
        const pathChanged = savePath !== activeTabPath;
        const now = Date.now();
        const savedMtime = savedStat ? mtimeMsOf(savedStat) : undefined;
        // 异步窗口结束后重新获取最新 store 状态，避免覆盖窗口期间其他 tab / 分屏并发发布的编辑内容
        const latestState = get();
        // 保存期间 tab 被改名：原路径已不在 openTabs 里。按「saving 且内容相同」的唯一候选接手，
        // 否则 `saving` 会永久卡在 true，该 tab 之后的所有保存都会被重入守卫拦掉
        const renamedAway =
          !latestState.openTabs.some((t) => t.path === activeTabPath) &&
          latestState.openTabs.filter((t) => t.saving && t.content === contentToSave).length === 1;
        const adoptionPath = renamedAway
          ? latestState.openTabs.find((t) => t.saving && t.content === contentToSave)!.path
          : activeTabPath;
        const nextTabs = latestState.openTabs.map((t) => {
          if (t.path === adoptionPath) {
            // 如果写盘期间内容又发生了新的修改，保持 dirty 为 true
            const isStillDirty = t.content !== contentToSave;
            return {
            ...t,
            // 改名场景保持新路径（不能再改回旧名）
            path: renamedAway ? t.path : savePath,
            isUntitled: false,
            // 回执不可信时保持 dirty，并保留旧基线（下一轮按冲突处理，不静默重载）
            dirty: isStillDirty || receiptUntrusted,
            conflictPending: false,
            saving: false,
            // 写成功即清掉该 tab 的失败痕迹（后台 tab 的 saveError 只落在自己身上）
            saveError: null,
            // 写盘成功即说明文件已（重新）落在 savePath 上
            deletedOnDisk: false,
            lastSavedAt: now,
            diskContent: receiptUntrusted ? t.diskContent : contentToSave,
            diskStat: receiptUntrusted ? t.diskStat : savedStat,
            diskMtime: receiptUntrusted ? t.diskMtime : savedMtime,
            };
          }
          return t;
        });
        // 草稿转正与「已删除文件另存为」都会让 tab 换到新路径
        const nextRecent = pathChanged ? pushRecent(latestState.recentFiles, savePath) : latestState.recentFiles;
        if (pathChanged) {
          persistRecentFiles(nextRecent);
          // #364：草稿转正 / 已删除文件另存为 → rev 跟着换到新路径（否则旧 key 泄漏）
          rebasePathRevs(activeTabPath, savePath);
        }

        const currentActiveTab = nextTabs.find((t) => t.path === (latestState.activeTabPath === activeTabPath ? savePath : latestState.activeTabPath));
        set({
          openTabs: nextTabs,
          activeTabPath: latestState.activeTabPath === activeTabPath ? savePath : latestState.activeTabPath,
          currentFile: latestState.currentFile === activeTabPath ? savePath : latestState.currentFile,
          // 顶层镜像从活跃 tab 的实际状态派生（issue #148）：
          // 本次保存的可能已不是当前活跃 tab，不能无条件清掉镜像
          saving: currentActiveTab ? !!currentActiveTab.saving : false,
          dirty: currentActiveTab ? currentActiveTab.dirty : false,
          conflictPending: currentActiveTab ? !!currentActiveTab.conflictPending : false,
          // 回执不可信时必须留下可见错误（否则用户以为存好了）
          saveError:
            latestState.activeTabPath === activeTabPath
              ? receiptUntrusted
                ? "保存可能未完成：写入后磁盘内容与预期不一致，请检查后另存副本。"
                : null
              : latestState.saveError,
          lastSavedAt: latestState.activeTabPath === activeTabPath ? now : latestState.lastSavedAt,
          recentFiles: nextRecent,
        });

        // 草稿转正 / 已删除文件重新创建或另存为后磁盘上多了一个文件：刷新它所在目录，
        // 让文件树与 Quick Open 索引一起更新 —— refreshTree 同时是索引的失效点，
        // 两者必须一起做，否则会形成「Quick Open 搜得到、文件树看不到」的新不一致
        //（#228 评审 P3-4）。单文件模式 / 未打开工作区时 refreshTree 自身会跳过。
        if (pathChanged || resolvedMissing) {
          void get().refreshTree(parentDir(savePath));
        }
        // #365：内容已经落盘 → 那份崩溃副本没有价值了。放在成功收尾而不是写盘前：
        // 写失败时草稿必须还在，否则用户既没存盘也没副本
        await clearDraft(activeTabPath);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        set((current) => {
          const openTabs = current.openTabs.map((t) =>
            // 失败信号必须落在 tab 自己身上：后台 tab 的失败不会写全局 saveError，
            // 调度器若只看全局字段就会把「每次都失败」当成成功，退避永不生效
            t.path === activeTabPath ? { ...t, saving: false, saveError: message } : t,
          );
          const activeTab = openTabs.find((t) => t.path === current.activeTabPath);
          return {
            openTabs,
            saving: activeTab?.saving ?? false,
            saveError: current.activeTabPath === activeTabPath ? message : current.saveError,
          };
        });
      }
      };
      // 串行队列只约束**调度器驱动的保存**（非交互）。交互保存必须立刻执行：
      // 某个 tab 卡在另存为对话框时，其它 tab 的 Ctrl+S 不能被一起挂住（issue #148）。
      // 但交互保存**同样要登记在途**：否则 `waitForSaves()` / `isSaveInFlight()` 看不到它，
      // 「按了 Ctrl+S 立刻关窗」会被判成「没保存」（#367 的核心场景）。
      if (!interactive) return enqueueSave(filePath, run);

      const running = run();
      inflightSaves.set(filePath, running);
      const done = running.finally(() => {
        if (inflightSaves.get(filePath) === running) inflightSaves.delete(filePath);
      });
      saveChain = saveChain.then(() => done).catch(() => undefined);
      return done;
    },

    saveCurrent: (options) => {
      const activePath = get().activeTabPath;
      return activePath ? get().saveTab(activePath, options) : Promise.resolve();
    },

    waitForSaves: async (targetPath) => {
      // 同时等「排队中尚未启动」与「已启动但在 adopt 前」——两者都挂在 saveChain 上
      if (targetPath) {
        await Promise.all(
          [inflightSaves.get(targetPath), saveQueue.get(targetPath)].filter(
            (p): p is Promise<void> => !!p,
          ),
        ).catch(() => undefined);
        return;
      }
      await saveChain.catch(() => undefined);
    },

    isSaveInFlight: (targetPath) => inflightSaves.has(targetPath),

    setCurrentHeadingSlug: (slug) => {
      if (slug === get().currentHeadingSlug) return;
      set({ currentHeadingSlug: slug });
    },

    saveCursorState: (path, pos, scrollTop) => {
      const { openTabs } = get();
      const tab = openTabs.find((t) => t.path === path);
      if (!tab) return;
      // 与已存值相同则不更新，避免无意义渲染
      if (tab.cursorPos === pos && tab.scrollTop === scrollTop) return;
      const nextTabs = openTabs.map((t) =>
        t.path === path ? { ...t, cursorPos: pos, scrollTop } : t,
      );
      set({ openTabs: nextTabs });
    },

    getCursorStateFor: (path) => {
      const tab = get().openTabs.find((t) => t.path === path);
      if (!tab) return { pos: null, scrollTop: null };
      return { pos: tab.cursorPos, scrollTop: tab.scrollTop };
    },

    setTabDiskContent: (path, diskContent) => {
      const nextTabs = get().openTabs.map((t) =>
        t.path === path ? { ...t, diskContent } : t,
      );
      set({ openTabs: nextTabs });
    },

    setTabSourceMode: (enabled, path) => {
      const target = path ?? get().activeTabPath;
      if (!target) return;
      // #212：从 WYSIWYG 进入源码方向的这一次翻转，须在状态更新（React
      // 重渲染把 .md-editor-wysiwyg 置 display:none）之前同步采样视口锚点
      // ——此刻几何现场读（posAtCoords/scrollHeight）全部可靠。切换由
      // click/keydown 离散事件触发，React 同步 flush：采样与切换 effect
      // 消费之间无滚动事件可插入，锚点必然新鲜（滚动进行中立即切换的竞争
      // 场景同样成立）。已处于源码模式（如解析失败回退的重复置位）则跳过。
      if (enabled && !get().openTabs.find((t) => t.path === target)?.sourceMode) {
        runWysiwygAnchorSampler(target);
      }
      const nextTabs = get().openTabs.map((t) =>
        t.path === target ? { ...t, sourceMode: enabled } : t,
      );
      set({ openTabs: nextTabs });
    },

    getTabSourceMode: (path) => {
      const target = path ?? get().activeTabPath;
      if (!target) return false;
      return get().openTabs.find((t) => t.path === target)?.sourceMode ?? false;
    },

    toggleTabSourceMode: (path) => {
      const target = path ?? get().activeTabPath;
      if (!target) return;
      const cur = get().getTabSourceMode(target);
      get().setTabSourceMode(!cur, target);
    },
  };
};

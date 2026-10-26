// workspace slice：文件树 / 工作区上下文
// 负责工作区根路径与模式、目录树按需加载、展开状态持久化，
// 以及文件系统事件（重命名 / 删除）后的跨领域状态同步。

import type { StateCreator } from "zustand";
import { listDir, type FileNode } from "../../lib/fs";
import { showMessage } from "../../lib/dialogs";
import { invalidateWorkspaceIndex } from "../../lib/workspaceIndex";
import { flushAllMarkdownPublishers } from "../../components/Editor/markdown-publisher";
import {
  collectDirectoryPaths,
  isPathWithin,
  mergeDirectoryListing,
} from "../../lib/fileTree";
import {
  DELETED_SNAPSHOT_LIMIT,
  directoryRequests,
  fileRequests,
  forcedDirectoryRequests,
  intents,
  loadDeletedSnapshots,
  loadExpandedDirs,
  markDeletedDuringLoad,
  parentDir,
  persistBookmarks,
  persistDeletedSnapshot,
  persistExpandedDirs,
  persistRecentFiles,
  rebaseDeletedDuringLoad,
  rebasePathPrefix,
  settledPathOfRequest,
  snapshotCharBudget,
  snapshotEntryChars,
} from "./shared";
import type { WorkspaceState } from "./types";

/** 文件树 / 工作区上下文 slice */
export interface FileTreeSlice {
  /** 工作区根路径（null 表示未打开） */
  rootPath: string | null;
  /**
   * 工作区模式：
   * - "folder"：打开了文件夹，tree 有效
   * - "file"：单文件模式，仅打开了散落的 md 文件，不构建文件树；rootPath 为当前文件父目录
   * - null：未打开任何东西
   */
  workspaceMode: "folder" | "file" | null;
  /** 文件树根节点 */
  tree: FileNode | null;
  /** 正在打开或切换工作区 */
  workspaceLoading: boolean;

  /** 展开的目录路径集合（持久化，未记录的目录默认折叠） */
  expandedDirs: Set<string>;
  /** 已完成单层枚举的目录路径集合 */
  loadedDirs: Set<string>;
  /** 正在枚举的目录路径集合 */
  loadingDirs: Set<string>;
  /** 目录枚举错误（按路径记录，点击错误行可重试） */
  directoryErrors: Map<string, string>;
  /** 切换目录展开状态并持久化 */
  toggleDirExpanded: (path: string) => void;
  /** 设置目录展开状态并持久化 */
  setDirExpanded: (path: string, expanded: boolean) => void;
  /** 查询目录是否展开（未记录时默认折叠） */
  isDirExpanded: (path: string) => boolean;
  /** 按需枚举一个目录的直接子项 */
  loadDirectory: (path: string, force?: boolean) => Promise<void>;

  /** 打开工作区：只读取根目录的直接子项 */
  openWorkspace: (dirPath: string) => Promise<void>;
  /** 刷新指定目录（省略路径时刷新工作区根目录） */
  refreshTree: (dirPath?: string) => Promise<void>;
  /** 文件被重命名时同步 tab 状态 */
  onFileRenamed: (from: string, to: string) => void;
  /**
   * 文件被删除时同步 tab 状态。
   * options.alsoBackup：除当前 dirty 的 tab 外也要写入恢复快照的路径——删除确认框
   * 停留期间自动保存可能已把它们存成干净状态，但用户确认时被承诺「会先备份」（#366）
   */
  onFileDeleted: (path: string, options?: { alsoBackup?: readonly string[] }) => void;
}

export const createFileTreeSlice: StateCreator<
  WorkspaceState,
  [],
  [],
  FileTreeSlice
> = (set, get) => ({
  rootPath: null,
  workspaceMode: null,
  tree: null,
  workspaceLoading: false,
  expandedDirs: loadExpandedDirs(),
  loadedDirs: new Set(),
  loadingDirs: new Set(),
  directoryErrors: new Map(),

  toggleDirExpanded: (path) => {
    const next = new Set(get().expandedDirs);
    if (!next.has(path)) next.add(path);
    else next.delete(path);
    set({ expandedDirs: next });
    persistExpandedDirs(next);
  },

  setDirExpanded: (path, expanded) => {
    const next = new Set(get().expandedDirs);
    if (expanded) next.add(path);
    else next.delete(path);
    set({ expandedDirs: next });
    persistExpandedDirs(next);
  },

  isDirExpanded: (path) => get().expandedDirs.has(path),

  loadDirectory: async (path, force = false) => {
    const state = get();
    if (
      !state.rootPath ||
      state.workspaceMode !== "folder" ||
      !isPathWithin(path, state.rootPath)
    ) {
      return;
    }
    if (!force && state.loadedDirs.has(path)) return;

    const generation = intents.workspaceGeneration;
    const requestKey = `${generation}\0${path}`;
    const existing = directoryRequests.get(requestKey);
    if (existing) {
      if (!force) return existing;
      const queued = forcedDirectoryRequests.get(requestKey);
      if (queued) return queued;

      const refresh = existing
        .catch(() => {})
        .then(() => {
          // 后续扫描开始前释放标记，使扫描期间的新变更可继续排队
          forcedDirectoryRequests.delete(requestKey);
          if (generation !== intents.workspaceGeneration) return;
          return get().loadDirectory(path, true);
        });
      forcedDirectoryRequests.set(requestKey, refresh);
      return refresh;
    }

    const request = (async () => {
      const loadingDirs = new Set(get().loadingDirs);
      const directoryErrors = new Map(get().directoryErrors);
      loadingDirs.add(path);
      directoryErrors.delete(path);
      set({ loadingDirs, directoryErrors });

      try {
        const listing = await listDir(path);
        if (generation !== intents.workspaceGeneration) return;

        set((current) => {
          if (
            !current.tree ||
            current.rootPath !== state.rootPath ||
            current.workspaceMode !== "folder"
          ) {
            return {};
          }

          const tree = mergeDirectoryListing(current.tree, listing);
          if (tree === current.tree) return {};

          const existingDirs = collectDirectoryPaths(tree);
          const loadedDirs = new Set(
            [...current.loadedDirs].filter((dir) => existingDirs.has(dir)),
          );
          loadedDirs.add(path);
          const errors = new Map(
            [...current.directoryErrors].filter(([dir]) => existingDirs.has(dir)),
          );
          errors.delete(path);
          return { tree, loadedDirs, directoryErrors: errors };
        });
      } catch (e) {
        const current = get();
        if (
          generation === intents.workspaceGeneration &&
          current.tree &&
          collectDirectoryPaths(current.tree).has(path)
        ) {
          const errors = new Map(current.directoryErrors);
          errors.set(path, e instanceof Error ? e.message : String(e));
          set({ directoryErrors: errors });
        }
        throw e;
      } finally {
        directoryRequests.delete(requestKey);
        if (generation === intents.workspaceGeneration) {
          const next = new Set(get().loadingDirs);
          next.delete(path);
          set({ loadingDirs: next });
        }
      }
    })();

    directoryRequests.set(requestKey, request);
    return request;
  },

  openWorkspace: async (dirPath) => {
    // 用户开始切换工作区后，旧的文件读取不得再抢占活跃 tab
    intents.mainFile += 1;
    const contextIntent = ++intents.workspaceContext;
    const generation = ++intents.workspaceGeneration;
    const expandedDirs = new Set(get().expandedDirs);
    expandedDirs.add(dirPath);
    set({
      workspaceLoading: true,
      loadingDirs: new Set([dirPath]),
    });
    try {
      const tree = await listDir(dirPath);
      if (
        generation !== intents.workspaceGeneration ||
        contextIntent !== intents.workspaceContext
      ) {
        return;
      }
      persistExpandedDirs(expandedDirs);
      set({
        rootPath: dirPath,
        workspaceMode: "folder",
        tree,
        workspaceLoading: false,
        expandedDirs,
        loadedDirs: new Set([dirPath]),
        loadingDirs: new Set(),
        directoryErrors: new Map(),
      });
    } catch (e) {
      if (
        generation !== intents.workspaceGeneration ||
        contextIntent !== intents.workspaceContext
      ) {
        return;
      }
      set({ workspaceLoading: false, loadingDirs: new Set() });
      throw e;
    }
  },

  refreshTree: async (dirPath) => {
    const { rootPath, workspaceMode } = get();
    // 单文件模式不构建文件树，跳过刷新
    if (!rootPath || workspaceMode !== "folder") return;
    try {
      await get().loadDirectory(dirPath ?? rootPath, true);
      // 文件树内容已变化，Quick Open 的候选缓存随之失效（#228）
      invalidateWorkspaceIndex();
    } catch {
      // 刷新失败忽略，不阻塞用户操作
    }
  },

  onFileRenamed: (from, to) => {
    const {
      openTabs,
      activeTabPath,
      splitFile,
      recentFiles,
      bookmarks,
      expandedDirs,
      loadedDirs,
      loadingDirs,
      directoryErrors,
      openingFiles,
      fileOpenErrors,
    } = get();

    // 目录改名时子文件 tab 一并迁移（issue #363）：只迁同路径 tab 会让子文件 tab
    // 指向已不存在的旧路径，后续保存在旧位置重建目录、造成内容分叉
    const nextTabs = openTabs.map((t) => {
      const path = rebasePathPrefix(t.path, from, to);
      return path === t.path ? t : { ...t, path };
    });

    // 文件夹改名时其下的最近文件与书签一并迁移（#366），口径同 tab 迁移
    const rf = recentFiles.map((p) => rebasePathPrefix(p, from, to));
    const bk = bookmarks.map((p) => rebasePathPrefix(p, from, to));

    const nextExpanded = new Set(
      [...expandedDirs].map((path) => rebasePathPrefix(path, from, to)),
    );
    const nextLoaded = new Set(
      [...loadedDirs].filter((dir) => !isPathWithin(dir, from) && !isPathWithin(dir, to)),
    );
    const nextLoading = new Set(
      [...loadingDirs].map((path) => rebasePathPrefix(path, from, to)),
    );
    const nextErrors = new Map(
      [...directoryErrors].map(([path, err]) => [rebasePathPrefix(path, from, to), err]),
    );

    // 迁移 openingFiles 和 fileOpenErrors 映射状态。
    // 目录改名时子路径同样要迁（#366）：只处理 from 会让子文件的「正在打开」
    // 与错误标记留在已不存在的旧路径上
    const nextOpeningFiles = new Set(
      [...openingFiles].map((path) => rebasePathPrefix(path, from, to)),
    );
    const nextFileOpenErrors = new Map(
      [...fileOpenErrors].map(([path, err]) => [rebasePathPrefix(path, from, to), err]),
    );

    // 迁移 fileRequests Promise 映射。
    // 目录改名时子文件的在途读取也要迁（#363/#366）：不迁的话读取落定后
    // ensureTab 仍按旧路径建 tab，后续保存会在旧位置重建目录、造成内容分叉
    for (const [inFlightPath, request] of [...fileRequests]) {
      const nextPath = rebasePathPrefix(inFlightPath, from, to);
      if (nextPath === inFlightPath) continue;
      fileRequests.delete(inFlightPath);
      fileRequests.set(nextPath, request);
      // 加入方通过 settledPathOfRequest 拿到落定路径（issue #200），必须同步改，
      // 否则共享同一请求的调用方仍会拿到旧路径
      settledPathOfRequest.set(request, nextPath);
    }
    // #166 的「读取在途被删除」黑名单也是按路径记录，且落定后按新注册路径查表：
    // 请求迁走而黑名单不迁，会出现「删除 → 改名 → 落定」时双双 miss，
    // 为已删除文件建出干净 tab 且不写恢复快照
    rebaseDeletedDuringLoad(from, to);

    const patch: Partial<WorkspaceState> = {
      openTabs: nextTabs,
      recentFiles: rf,
      bookmarks: bk,
      expandedDirs: nextExpanded,
      loadedDirs: nextLoaded,
      loadingDirs: nextLoading,
      directoryErrors: nextErrors,
      openingFiles: nextOpeningFiles,
      fileOpenErrors: nextFileOpenErrors,
    };

    if (activeTabPath && isPathWithin(activeTabPath, from)) {
      const nextActive = rebasePathPrefix(activeTabPath, from, to);
      patch.activeTabPath = nextActive;
      patch.currentFile = nextActive;
    }
    if (splitFile && isPathWithin(splitFile, from)) {
      patch.splitFile = rebasePathPrefix(splitFile, from, to);
    }

    // 单次原子 set 更新所有状态
    set(patch);

    persistRecentFiles(rf);
    persistBookmarks(bk);
    persistExpandedDirs(nextExpanded);
    void get().refreshTree(parentDir(from));
  },

  onFileDeleted: (path, options) => {
    // issue #166：快照采集前先发布编辑器序列化防抖——用户刚输入但
    // 150ms 防抖未发布时，tab.content/currentContent 仍是旧内容，
    // 直接采集会让最近的编辑游离在快照保护之外
    // （原先依赖的 closeTab flush 发生在快照采集之后，来不及）
    flushAllMarkdownPublishers();
    const { openTabs, currentContent, expandedDirs, loadedDirs, loadingDirs, directoryErrors } = get();

    // issue #166：读取在途时文件被删除——把在途路径记入黑名单，
    // 读取完成后 ensureTab 对照拦截漏网 tab（目录删除时覆盖子文件）
    for (const inFlightPath of fileRequests.keys()) {
      if (inFlightPath === path || isPathWithin(inFlightPath, path)) {
        markDeletedDuringLoad(inFlightPath);
      }
    }

    // 内存保护：被删除文件含未保存内容（或调用方承诺过要备份）时，先写入临时快照
    const affectedTabs = openTabs.filter((t) => isPathWithin(t.path, path));
    const alsoBackup = new Set(options?.alsoBackup ?? []);
    const backupTabs = affectedTabs.filter((t) => t.dirty || alsoBackup.has(t.path));

    // 每个旧路径都打 tombstone（#362 §5.4）：写盘在途时删除/改名，落定后绝不能
    // 快照配额：条目数 + 字符预算双条件。超额时**整批不写、保留 tab**，
    // 绝不「淘汰旧的换新的」——那会删掉其它已删文件的唯一副本
    const required = new Map<string, string>();
    for (const tab of backupTabs) {
      required.set(tab.path, tab.path === get().activeTabPath ? currentContent : (tab.content ?? ""));
    }
    const existingSnapshots = loadDeletedSnapshots();
    const existingPaths = new Set(existingSnapshots.map((s) => s.path));
    let usedEntries = existingSnapshots.length;
    let usedChars = existingSnapshots.reduce(
      (acc, s) => acc + snapshotEntryChars(s.path, s.content),
      0,
    );
    for (const [snapshotPath, snapshotContent] of required) {
      if (existingPaths.has(snapshotPath)) continue; // 同 path 会被覆盖，不重复占额
      usedEntries += 1;
      usedChars += snapshotEntryChars(snapshotPath, snapshotContent);
    }
    const quotaOk =
      usedEntries <= DELETED_SNAPSHOT_LIMIT && usedChars <= snapshotCharBudget();

    /** 快照失败的 tab 保留（标记已删除），不关闭 */
    const keptTabs = new Set<string>();
    for (const tab of backupTabs) {
      const contentToSave = required.get(tab.path) ?? "";
      const saved = quotaOk && persistDeletedSnapshot(tab.path, contentToSave);
      if (!saved) {
        console.warn(`[workspace] 写入已删除文件快照失败（可能超出配额）：${tab.path}`);
        keptTabs.add(tab.path);
      }
    }
    if (keptTabs.size > 0) {
      void showMessage(
        !quotaOk
          ? "未保存文件过多，已保留标签页、未写恢复备份。请逐个「另存为」以免丢失内容。"
          : `删除时有 ${keptTabs.size} 个未保存文件未能创建恢复备份（存储空间不足），已保留标签页。`,
        { kind: "error", title: "恢复备份写入失败" },
      );
    }

    // 删除目录时其下所有子文件 tab 一并关闭（#366 / #363）：只关同路径 tab 会留下
    // 指向已删除路径的 tab，后续保存可能把整个目录重建出来。dirty 内容已在上方存快照；
    // 快照写失败的保留 tab（deletedOnDisk），让用户能另存出去
    for (const tab of affectedTabs) {
      if (keptTabs.has(tab.path)) {
        set((current) => ({
          openTabs: current.openTabs.map((t) =>
            t.path === tab.path ? { ...t, deletedOnDisk: true, dirty: true } : t,
          ),
        }));
        continue;
      }
      get().closeTab(tab.path);
    }
    // 同步 recentFiles（移除被删除文件及其目录下的子项，#366）
    const rf = get().recentFiles.filter((p) => !isPathWithin(p, path));
    set({ recentFiles: rf });
    persistRecentFiles(rf);
    // 同步 bookmarks（移除被删除文件及其目录下的子项）
    const bk = get().bookmarks.filter((p) => !isPathWithin(p, path));
    const nextExpanded = new Set(
      [...expandedDirs].filter((dir) => !isPathWithin(dir, path)),
    );
    const nextLoaded = new Set([...loadedDirs].filter((dir) => !isPathWithin(dir, path)));
    const nextLoading = new Set(
      [...loadingDirs].filter((dir) => !isPathWithin(dir, path)),
    );
    const nextErrors = new Map(
      [...directoryErrors].filter(([dir]) => !isPathWithin(dir, path)),
    );
    set({
      bookmarks: bk,
      expandedDirs: nextExpanded,
      loadedDirs: nextLoaded,
      loadingDirs: nextLoading,
      directoryErrors: nextErrors,
    });
    persistBookmarks(bk);
    persistExpandedDirs(nextExpanded);
    void get().refreshTree(parentDir(path));
  },
});

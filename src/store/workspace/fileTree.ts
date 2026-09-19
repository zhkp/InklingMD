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
  directoryRequests,
  fileRequests,
  forcedDirectoryRequests,
  intents,
  loadExpandedDirs,
  markDeletedDuringLoad,
  parentDir,
  persistBookmarks,
  persistDeletedSnapshot,
  persistExpandedDirs,
  persistRecentFiles,
  rebasePathPrefix,
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
  /** 文件被删除时同步 tab 状态 */
  onFileDeleted: (path: string) => void;
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

    const nextTabs = openTabs.map((t) =>
      t.path === from ? { ...t, path: to } : t,
    );

    const rf = recentFiles.map((p) => (p === from ? to : p));
    const bk = bookmarks.map((p) =>
      p === from ? to : p.startsWith(from + "/") || p.startsWith(from + "\\")
        ? to + p.slice(from.length)
        : p,
    );

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

    // 迁移 openingFiles 和 fileOpenErrors 映射状态
    const nextOpeningFiles = new Set(openingFiles);
    if (nextOpeningFiles.has(from)) {
      nextOpeningFiles.delete(from);
      nextOpeningFiles.add(to);
    }

    const nextFileOpenErrors = new Map(fileOpenErrors);
    if (nextFileOpenErrors.has(from)) {
      const err = nextFileOpenErrors.get(from)!;
      nextFileOpenErrors.delete(from);
      nextFileOpenErrors.set(to, err);
    }

    // 迁移 fileRequests Promise 映射
    if (fileRequests.has(from)) {
      const req = fileRequests.get(from)!;
      fileRequests.delete(from);
      fileRequests.set(to, req);
    }

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

    if (activeTabPath === from) {
      patch.activeTabPath = to;
      patch.currentFile = to;
    }
    if (splitFile === from) {
      patch.splitFile = to;
    }

    // 单次原子 set 更新所有状态
    set(patch);

    persistRecentFiles(rf);
    persistBookmarks(bk);
    persistExpandedDirs(nextExpanded);
    void get().refreshTree(parentDir(from));
  },

  onFileDeleted: (path) => {
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

    // 内存保护：若被删除文件包含未保存的 dirty 内容，先写入临时快照
    const affectedTabs = openTabs.filter(
      (t) => t.path === path || t.path.startsWith(path + "/") || t.path.startsWith(path + "\\"),
    );
    let failedSnapshots = 0;
    for (const tab of affectedTabs) {
      if (tab.dirty) {
        const contentToSave = tab.path === get().activeTabPath ? currentContent : (tab.content ?? "");
        const saved = persistDeletedSnapshot(tab.path, contentToSave);
        if (!saved) {
          console.warn(`[workspace] 写入已删除文件快照失败（可能超出配额）：${tab.path}`);
          failedSnapshots += 1;
        }
      }
    }
    if (failedSnapshots > 0) {
      const msg = failedSnapshots === affectedTabs.filter((t) => t.dirty).length
        ? "删除时未能为未保存文件创建恢复备份（存储空间不足），这些文件的未保存内容将丢失。"
        : `删除时有 ${failedSnapshots} 个未保存文件未能创建恢复备份（存储空间不足），其内容无法恢复。`;
      void showMessage(msg, { kind: "error", title: "恢复备份写入失败" });
    }

    const affected = openTabs.find((t) => t.path === path);
    if (affected) {
      get().closeTab(path);
    }
    // 同步 recentFiles
    const rf = get().recentFiles.filter((p) => p !== path);
    set({ recentFiles: rf });
    persistRecentFiles(rf);
    // 同步 bookmarks（移除被删除文件及其目录下的子项）
    const bk = get().bookmarks.filter(
      (p) => p !== path && !p.startsWith(path + "/") && !p.startsWith(path + "\\"),
    );
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

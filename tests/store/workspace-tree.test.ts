// 工作区文件树状态测试
// 覆盖单层加载、目录/文件请求去重、工作区切换竞态和局部刷新

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileNode } from "../../src/lib/fs";

const { listDirMock, readTextFileMock, writeTextFileMock } = vi.hoisted(() => ({
  listDirMock: vi.fn(),
  readTextFileMock: vi.fn(),
  writeTextFileMock: vi.fn(),
}));

vi.mock("../../src/lib/fs", () => ({
  listDir: listDirMock,
  readTextFile: readTextFileMock,
  // store 的文档读取走 readDocument（#362 成对读取）：行为仍由 readTextFile mock 驱动，
  // 内容与 stat 成对返回，避免「旧内容 + 新 stat」。本文件只验证请求去重与竞态，
  // 故 stat 取固定值。
  readDocument: async (path: string) => ({
    content: await readTextFileMock(path),
    stat: { mtimeUs: 1_700_000_000_000_000, size: 1 },
  }),
  writeTextFile: writeTextFileMock,
}));

import { useWorkspace, type OpenTab } from "../../src/store/workspace";

function dir(path: string, children: FileNode[] = []): FileNode {
  return {
    name: path.split("/").pop() ?? path,
    path,
    is_dir: true,
    children,
  };
}

function file(path: string): FileNode {
  return {
    name: path.split("/").pop() ?? path,
    path,
    is_dir: false,
    children: [],
  };
}

function tab(path: string, content = `# ${path}`): OpenTab {
  return {
    path,
    content,
    dirty: false,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  listDirMock.mockReset();
  readTextFileMock.mockReset();
  writeTextFileMock.mockReset();
  readTextFileMock.mockResolvedValue("# test");
  writeTextFileMock.mockResolvedValue(undefined);
  useWorkspace.setState({
    rootPath: null,
    workspaceMode: null,
    tree: null,
    workspaceLoading: false,
    openingFiles: new Set(),
    fileOpenErrors: new Map(),
    expandedDirs: new Set(),
    loadedDirs: new Set(),
    loadingDirs: new Set(),
    directoryErrors: new Map(),
    openTabs: [],
    activeTabPath: null,
    currentFile: null,
    currentContent: "",
    dirty: false,
    saving: false,
    saveError: null,
    lastSavedAt: null,
    currentHeadingSlug: null,
    splitFile: null,
    splitContent: "",
    recentFiles: [],
    bookmarks: [],
  });
});

describe("工作区按需加载", () => {
  it("打开工作区只读取根目录一层，并默认只展开根目录", async () => {
    listDirMock.mockResolvedValue(dir("/workspace", [dir("/workspace/docs")]));

    await useWorkspace.getState().openWorkspace("/workspace");

    expect(listDirMock).toHaveBeenCalledTimes(1);
    expect(listDirMock).toHaveBeenCalledWith("/workspace");
    expect(useWorkspace.getState().loadedDirs).toEqual(new Set(["/workspace"]));
    expect(useWorkspace.getState().expandedDirs.has("/workspace")).toBe(true);
    expect(useWorkspace.getState().expandedDirs.has("/workspace/docs")).toBe(false);
  });

  it("同一目录的并发加载只枚举一次", async () => {
    const listing = deferred<FileNode>();
    listDirMock.mockReturnValue(listing.promise);
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: dir("/workspace", [dir("/workspace/docs")]),
      expandedDirs: new Set(["/workspace", "/workspace/docs"]),
      loadedDirs: new Set(["/workspace"]),
    });

    const first = useWorkspace.getState().loadDirectory("/workspace/docs");
    const second = useWorkspace.getState().loadDirectory("/workspace/docs");
    expect(listDirMock).toHaveBeenCalledTimes(1);

    listing.resolve(dir("/workspace/docs", [file("/workspace/docs/readme.md")]));
    await Promise.all([first, second]);

    expect(useWorkspace.getState().loadedDirs.has("/workspace/docs")).toBe(true);
    expect(useWorkspace.getState().tree?.children[0].children[0].name).toBe("readme.md");
  });

  it("目录连续发生强制刷新时，每轮扫描后继续追赶最新变更", async () => {
    const initial = deferred<FileNode>();
    const firstRefresh = deferred<FileNode>();
    const finalRefresh = deferred<FileNode>();
    listDirMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(firstRefresh.promise)
      .mockReturnValueOnce(finalRefresh.promise);
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: dir("/workspace", [dir("/workspace/docs")]),
      loadedDirs: new Set(["/workspace"]),
    });

    const load = useWorkspace.getState().loadDirectory("/workspace/docs");
    const refresh = useWorkspace.getState().refreshTree("/workspace/docs");
    expect(listDirMock).toHaveBeenCalledTimes(1);

    initial.resolve(dir("/workspace/docs"));
    await vi.waitFor(() => expect(listDirMock).toHaveBeenCalledTimes(2));
    const trailingRefresh = useWorkspace.getState().refreshTree("/workspace/docs");
    firstRefresh.resolve(dir("/workspace/docs", [file("/workspace/docs/stale.md")]));
    await vi.waitFor(() => expect(listDirMock).toHaveBeenCalledTimes(3));
    finalRefresh.resolve(dir("/workspace/docs", [file("/workspace/docs/new.md")]));
    await Promise.all([load, refresh, trailingRefresh]);

    expect(useWorkspace.getState().tree?.children[0].children[0].name).toBe("new.md");
  });

  it("目录加载失败后清理加载状态并允许重试", async () => {
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: dir("/workspace", [dir("/workspace/docs")]),
      loadedDirs: new Set(["/workspace"]),
    });
    listDirMock.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      useWorkspace.getState().loadDirectory("/workspace/docs"),
    ).rejects.toThrow("permission denied");
    expect(useWorkspace.getState().loadingDirs.has("/workspace/docs")).toBe(false);
    expect(useWorkspace.getState().directoryErrors.get("/workspace/docs")).toBe(
      "permission denied",
    );

    listDirMock.mockResolvedValueOnce(dir("/workspace/docs"));
    await useWorkspace.getState().loadDirectory("/workspace/docs");
    expect(listDirMock).toHaveBeenCalledTimes(2);
    expect(useWorkspace.getState().directoryErrors.has("/workspace/docs")).toBe(false);
  });

  it("较旧的工作区结果不会覆盖后来打开的工作区", async () => {
    const first = deferred<FileNode>();
    const second = deferred<FileNode>();
    listDirMock.mockImplementation((path: string) =>
      path === "/first" ? first.promise : second.promise,
    );

    const openFirst = useWorkspace.getState().openWorkspace("/first");
    const openSecond = useWorkspace.getState().openWorkspace("/second");
    second.resolve(dir("/second", [file("/second/current.md")]));
    await openSecond;
    first.resolve(dir("/first", [file("/first/stale.md")]));
    await openFirst;

    expect(useWorkspace.getState().rootPath).toBe("/second");
    expect(useWorkspace.getState().tree?.path).toBe("/second");
  });

  it("打开新工作区失败时保留原有工作区", async () => {
    const previousTree = dir("/workspace", [file("/workspace/kept.md")]);
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: previousTree,
      expandedDirs: new Set(["/workspace"]),
      loadedDirs: new Set(["/workspace"]),
    });
    listDirMock.mockRejectedValue(new Error("permission denied"));

    await expect(useWorkspace.getState().openWorkspace("/forbidden")).rejects.toThrow(
      "permission denied",
    );

    expect(useWorkspace.getState().rootPath).toBe("/workspace");
    expect(useWorkspace.getState().tree).toBe(previousTree);
    expect(useWorkspace.getState().expandedDirs).toEqual(new Set(["/workspace"]));
    expect(useWorkspace.getState().workspaceLoading).toBe(false);
  });

  it("刷新父目录时保留已经加载的子树", async () => {
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: dir("/workspace", [
        dir("/workspace/docs", [
          dir("/workspace/docs/guide", [file("/workspace/docs/guide/a.md")]),
        ]),
      ]),
      loadedDirs: new Set([
        "/workspace",
        "/workspace/docs",
        "/workspace/docs/guide",
      ]),
    });
    listDirMock.mockResolvedValue(
      dir("/workspace", [dir("/workspace/docs"), file("/workspace/root.md")]),
    );

    await useWorkspace.getState().refreshTree();

    expect(useWorkspace.getState().tree?.children[0].children[0].children[0].name).toBe(
      "a.md",
    );
    expect(useWorkspace.getState().loadedDirs.has("/workspace/docs/guide")).toBe(true);
  });

  it("打开文件不会重新枚举工作区", async () => {
    await useWorkspace.getState().openFile("/workspace/readme.md");

    expect(readTextFileMock).toHaveBeenCalledWith("/workspace/readme.md");
    expect(listDirMock).not.toHaveBeenCalled();
  });

  it("删除目录时清理该路径下的加载与展开状态", async () => {
    listDirMock.mockResolvedValue(dir("/workspace"));
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: dir("/workspace", [dir("/workspace/docs")]),
      expandedDirs: new Set(["/workspace", "/workspace/docs", "/workspace/docs/guide"]),
      loadedDirs: new Set(["/workspace", "/workspace/docs", "/workspace/docs/guide"]),
      loadingDirs: new Set(["/workspace/docs/guide"]),
      directoryErrors: new Map([["/workspace/docs", "failed"]]),
    });

    useWorkspace.getState().onFileDeleted("/workspace/docs");

    expect(useWorkspace.getState().expandedDirs).toEqual(new Set(["/workspace"]));
    expect(useWorkspace.getState().loadedDirs).toEqual(new Set(["/workspace"]));
    expect(useWorkspace.getState().loadingDirs.has("/workspace/docs/guide")).toBe(false);
    expect(useWorkspace.getState().directoryErrors).toEqual(new Map());
    await vi.waitFor(() => expect(useWorkspace.getState().tree?.children).toEqual([]));
    expect(useWorkspace.getState().loadingDirs).toEqual(new Set());
  });

  it("目录重命名时迁移展开偏好，并让新路径重新加载", async () => {
    listDirMock.mockResolvedValue(dir("/workspace", [dir("/workspace/notes")]));
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: dir("/workspace", [dir("/workspace/docs")]),
      expandedDirs: new Set(["/workspace", "/workspace/docs", "/workspace/docs/guide"]),
      loadedDirs: new Set(["/workspace", "/workspace/docs", "/workspace/docs/guide"]),
    });

    useWorkspace.getState().onFileRenamed("/workspace/docs", "/workspace/notes");

    expect(useWorkspace.getState().expandedDirs).toEqual(
      new Set(["/workspace", "/workspace/notes", "/workspace/notes/guide"]),
    );
    expect(useWorkspace.getState().loadedDirs).toEqual(new Set(["/workspace"]));
    await vi.waitFor(() =>
      expect(useWorkspace.getState().tree?.children[0].path).toBe("/workspace/notes"),
    );
  });
});

describe("文件读取与标签页竞态", () => {
  it("读取未打开文件时不进入工作区加载态且保留文件树", async () => {
    const reading = deferred<string>();
    readTextFileMock.mockReturnValueOnce(reading.promise);
    const previousTree = dir("/workspace", [file("/workspace/readme.md")]);
    const previousExpanded = new Set(["/workspace"]);
    const previousLoaded = new Set(["/workspace"]);
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: previousTree,
      expandedDirs: previousExpanded,
      loadedDirs: previousLoaded,
    });

    const opening = useWorkspace.getState().openFile("/workspace/readme.md");
    await Promise.resolve();
    const pendingState = useWorkspace.getState();
    const pendingReadCount = readTextFileMock.mock.calls.length;
    const pendingListCount = listDirMock.mock.calls.length;

    reading.resolve("# readme");
    await opening;

    expect(pendingState.workspaceLoading).toBe(false);
    expect(pendingState.openingFiles).toEqual(new Set(["/workspace/readme.md"]));
    expect(pendingState.tree).toBe(previousTree);
    expect(pendingState.expandedDirs).toBe(previousExpanded);
    expect(pendingState.loadedDirs).toBe(previousLoaded);
    expect(pendingReadCount).toBe(1);
    expect(pendingListCount).toBe(0);
    expect(useWorkspace.getState().workspaceLoading).toBe(false);
    expect(useWorkspace.getState().openingFiles).toEqual(new Set());
    expect(useWorkspace.getState().tree).toBe(previousTree);
    expect(listDirMock).not.toHaveBeenCalled();
  });

  it("同一文件的并发打开只读取一次并创建一个标签页", async () => {
    const reading = deferred<string>();
    readTextFileMock.mockReturnValueOnce(reading.promise);

    const first = useWorkspace.getState().openFile("/workspace/readme.md");
    const second = useWorkspace.getState().openFile("/workspace/readme.md");
    await Promise.resolve();
    const pendingReadCount = readTextFileMock.mock.calls.length;
    const pendingFiles = useWorkspace.getState().openingFiles;

    reading.resolve("# shared");
    await Promise.all([first, second]);

    const state = useWorkspace.getState();
    expect(pendingReadCount).toBe(1);
    expect(pendingFiles).toEqual(new Set(["/workspace/readme.md"]));
    expect(readTextFileMock).toHaveBeenCalledTimes(1);
    expect(state.openTabs.filter((item) => item.path === "/workspace/readme.md")).toHaveLength(
      1,
    );
    expect(state.activeTabPath).toBe("/workspace/readme.md");
    expect(state.openingFiles).toEqual(new Set());
  });

  it("文件 A 晚于文件 B 完成时仍保持最后点击的 B 为活跃项", async () => {
    const readingA = deferred<string>();
    const readingB = deferred<string>();
    readTextFileMock.mockImplementation((path: string) => {
      if (path === "/workspace/a.md") return readingA.promise;
      if (path === "/workspace/b.md") return readingB.promise;
      throw new Error(`unexpected path: ${path}`);
    });

    const openA = useWorkspace.getState().openFile("/workspace/a.md");
    const openB = useWorkspace.getState().openFile("/workspace/b.md");
    await Promise.resolve();

    readingB.resolve("# B");
    await openB;
    const activeAfterB = useWorkspace.getState().activeTabPath;
    readingA.resolve("# A");
    await openA;

    const state = useWorkspace.getState();
    expect(readTextFileMock).toHaveBeenCalledTimes(2);
    expect(activeAfterB).toBe("/workspace/b.md");
    expect(state.activeTabPath).toBe("/workspace/b.md");
    expect(new Set(state.openTabs.map((item) => item.path))).toEqual(
      new Set(["/workspace/a.md", "/workspace/b.md"]),
    );
    expect(state.openingFiles).toEqual(new Set());
  });

  it("文件 A 读取期间切换到已打开文件 C 后不会被 A 抢回焦点", async () => {
    const readingA = deferred<string>();
    readTextFileMock.mockReturnValueOnce(readingA.promise);
    const keptTab = tab("/workspace/c.md", "# C");
    useWorkspace.setState({
      openTabs: [keptTab],
      activeTabPath: keptTab.path,
      currentFile: keptTab.path,
      currentContent: keptTab.content,
    });

    const openA = useWorkspace.getState().openFile("/workspace/a.md");
    useWorkspace.getState().switchTab(keptTab.path);
    await Promise.resolve();
    readingA.resolve("# A");
    await openA;

    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBe(keptTab.path);
    expect(state.currentFile).toBe(keptTab.path);
    expect(state.currentContent).toBe(keptTab.content);
    expect(state.openTabs.some((item) => item.path === "/workspace/a.md")).toBe(true);
    expect(state.openingFiles).toEqual(new Set());
  });

  it("文件读取失败时保留文件树和编辑器并允许重试", async () => {
    const reading = deferred<string>();
    readTextFileMock
      .mockReturnValueOnce(reading.promise)
      .mockResolvedValueOnce("# recovered");
    const previousTree = dir("/workspace", [file("/workspace/a.md")]);
    const keptTab = tab("/workspace/c.md", "# kept");
    const previousTabs = [keptTab];
    const previousRecent = [keptTab.path];
    useWorkspace.setState({
      rootPath: "/workspace",
      workspaceMode: "folder",
      tree: previousTree,
      openTabs: previousTabs,
      activeTabPath: keptTab.path,
      currentFile: keptTab.path,
      currentContent: keptTab.content,
      recentFiles: previousRecent,
    });

    const opening = useWorkspace.getState().openFile("/workspace/a.md");
    const rejected = expect(opening).rejects.toThrow("permission denied");
    await Promise.resolve();
    reading.reject(new Error("permission denied"));
    await rejected;

    const failedState = useWorkspace.getState();
    expect(failedState.tree).toBe(previousTree);
    expect(failedState.openTabs).toBe(previousTabs);
    expect(failedState.activeTabPath).toBe(keptTab.path);
    expect(failedState.currentFile).toBe(keptTab.path);
    expect(failedState.currentContent).toBe(keptTab.content);
    expect(failedState.recentFiles).toBe(previousRecent);
    expect(failedState.openingFiles.has("/workspace/a.md")).toBe(false);
    expect(failedState.fileOpenErrors.get("/workspace/a.md")).toBe(
      "permission denied",
    );
    expect(listDirMock).not.toHaveBeenCalled();

    await useWorkspace.getState().openFile("/workspace/a.md");

    const recoveredState = useWorkspace.getState();
    expect(readTextFileMock).toHaveBeenCalledTimes(2);
    expect(recoveredState.fileOpenErrors.has("/workspace/a.md")).toBe(false);
    expect(recoveredState.openingFiles).toEqual(new Set());
    expect(recoveredState.activeTabPath).toBe("/workspace/a.md");
    expect(recoveredState.currentContent).toBe("# recovered");
  });
});

describe("分屏与工作区上下文竞态", () => {
  it("主面板与分屏并发选择同一文件时关闭重复分屏", async () => {
    const reading = deferred<string>();
    readTextFileMock.mockReturnValueOnce(reading.promise);
    const mainTab = tab("/workspace/main.md", "# main");
    useWorkspace.setState({
      openTabs: [mainTab],
      activeTabPath: mainTab.path,
      currentFile: mainTab.path,
      currentContent: mainTab.content,
    });

    const openingSplit = useWorkspace.getState().splitOpen("/workspace/shared.md");
    const openingMain = useWorkspace.getState().openFile("/workspace/shared.md");
    await Promise.resolve();
    reading.resolve("# shared");
    await Promise.all([openingSplit, openingMain]);

    const state = useWorkspace.getState();
    expect(readTextFileMock).toHaveBeenCalledTimes(1);
    expect(state.activeTabPath).toBe("/workspace/shared.md");
    expect(state.splitFile).toBeNull();
    expect(state.splitContent).toBe("");
  });

  it("切换或仅保留分屏文件时关闭重复分屏", () => {
    const mainTab = tab("/workspace/main.md", "# main");
    const splitTab = tab("/workspace/split.md", "# split");
    useWorkspace.setState({
      openTabs: [mainTab, splitTab],
      activeTabPath: mainTab.path,
      currentFile: mainTab.path,
      currentContent: mainTab.content,
      splitFile: splitTab.path,
      splitContent: splitTab.content,
    });

    useWorkspace.getState().switchTab(splitTab.path);
    expect(useWorkspace.getState().splitFile).toBeNull();

    useWorkspace.setState({
      openTabs: [mainTab, splitTab],
      activeTabPath: mainTab.path,
      currentFile: mainTab.path,
      currentContent: mainTab.content,
      splitFile: splitTab.path,
      splitContent: splitTab.content,
    });
    useWorkspace.getState().closeOthers(splitTab.path);

    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBe(splitTab.path);
    expect(state.openTabs).toEqual([splitTab]);
    expect(state.splitFile).toBeNull();
    expect(state.splitContent).toBe("");
  });

  it("分屏并发打开只接受最新结果且关闭后不会被未完成读取重开", async () => {
    const readingA = deferred<string>();
    const readingB = deferred<string>();
    const readingD = deferred<string>();
    const requests = new Map([
      ["/workspace/a.md", readingA],
      ["/workspace/b.md", readingB],
      ["/workspace/d.md", readingD],
    ]);
    readTextFileMock.mockImplementation((path: string) => {
      const request = requests.get(path);
      if (!request) throw new Error(`unexpected path: ${path}`);
      return request.promise;
    });
    const mainTab = tab("/workspace/main.md", "# main");
    const selectedTab = tab("/workspace/selected.md", "# selected");
    useWorkspace.setState({
      openTabs: [mainTab, selectedTab],
      activeTabPath: mainTab.path,
      currentFile: mainTab.path,
      currentContent: mainTab.content,
    });

    const openA = useWorkspace.getState().splitOpen("/workspace/a.md");
    const openB = useWorkspace.getState().splitOpen("/workspace/b.md");
    useWorkspace.getState().switchTab(selectedTab.path);
    await Promise.resolve();
    readingB.resolve("# B");
    await openB;
    const splitAfterB = useWorkspace.getState().splitFile;
    readingA.resolve("# A");
    await openA;
    const splitAfterA = useWorkspace.getState().splitFile;

    const openD = useWorkspace.getState().splitOpen("/workspace/d.md");
    await Promise.resolve();
    useWorkspace.getState().splitClose();
    readingD.resolve("# D");
    await openD;

    const state = useWorkspace.getState();
    expect(splitAfterB).toBe("/workspace/b.md");
    expect(splitAfterA).toBe("/workspace/b.md");
    expect(state.splitFile).toBeNull();
    expect(state.splitContent).toBe("");
    expect(state.activeTabPath).toBe(selectedTab.path);
    expect(state.currentContent).toBe(selectedTab.content);
    expect(readTextFileMock).toHaveBeenCalledTimes(3);
    expect(state.openingFiles).toEqual(new Set());
  });

  it("工作区加载中后打开的单文件上下文优先", async () => {
    const workspaceListing = deferred<FileNode>();
    const fileReading = deferred<string>();
    listDirMock.mockReturnValueOnce(workspaceListing.promise);
    readTextFileMock.mockReturnValueOnce(fileReading.promise);

    const openingWorkspace = useWorkspace.getState().openWorkspace("/old-workspace");
    const openingFile = useWorkspace
      .getState()
      .openFileStandalone("/notes/latest.md");
    await Promise.resolve();
    fileReading.resolve("# latest");
    await openingFile;
    workspaceListing.resolve(dir("/old-workspace", [file("/old-workspace/stale.md")]));
    await openingWorkspace;

    const state = useWorkspace.getState();
    expect(state.workspaceMode).toBe("file");
    expect(state.rootPath).toBe("/notes");
    expect(state.tree).toBeNull();
    expect(state.activeTabPath).toBe("/notes/latest.md");
    expect(state.currentContent).toBe("# latest");
    expect(state.workspaceLoading).toBe(false);
    expect(state.openingFiles).toEqual(new Set());
  });

  it("单文件读取中后打开的文件夹上下文优先", async () => {
    const fileReading = deferred<string>();
    const workspaceListing = deferred<FileNode>();
    readTextFileMock.mockReturnValueOnce(fileReading.promise);
    listDirMock.mockReturnValueOnce(workspaceListing.promise);

    const openingFile = useWorkspace
      .getState()
      .openFileStandalone("/notes/stale.md");
    const openingWorkspace = useWorkspace.getState().openWorkspace("/workspace");
    await Promise.resolve();
    workspaceListing.resolve(dir("/workspace", [file("/workspace/current.md")]));
    await openingWorkspace;
    fileReading.resolve("# stale");
    await openingFile;

    const state = useWorkspace.getState();
    expect(state.workspaceMode).toBe("folder");
    expect(state.rootPath).toBe("/workspace");
    expect(state.tree?.path).toBe("/workspace");
    expect(state.activeTabPath).toBeNull();
    expect(state.currentFile).toBeNull();
    expect(state.openTabs.some((item) => item.path === "/notes/stale.md")).toBe(true);
    expect(state.workspaceLoading).toBe(false);
    expect(state.openingFiles).toEqual(new Set());
  });
});

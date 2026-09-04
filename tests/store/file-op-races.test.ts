// #177 重命名与在途文件读取竞态 + #166 删除文件快照的两处竞态
//
// #177：读取在途时重命名，onFileRenamed 把 fileRequests/openingFiles 从旧路径
// 迁到新路径，但 .catch/.finally 闭包按旧路径查表 → 已完成/已拒绝的 Promise
// 永久缓存（重开拿陈旧内容、失败后永远打不开）+ 加载态卡死。
// 修复后清理按请求自身身份，测试验证：清理到位、重开重读磁盘、失败可重试。
//
// #166：(a) 删除快照采集发生在编辑器序列化防抖发布之前 → 快照是旧内容；
// 修复为采集前先 flush。测试用「发布最后编辑」的 flush mock 验证时序。
// (b) 读取在途时删除 → 读取完成后 ensureTab 照常建漏网 tab；
// 修复为黑名单拦截 + 读到的内容写入恢复快照。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { readTextFileMock, fileMtimeMock, listDirMock } = vi.hoisted(() => ({
  readTextFileMock: vi.fn(),
  fileMtimeMock: vi.fn(),
  listDirMock: vi.fn(),
}));

vi.mock("../../src/lib/fs", () => ({
  readTextFile: readTextFileMock,
  fileMtime: fileMtimeMock,
  listDir: listDirMock,
}));

vi.mock("../../src/lib/dialogs", () => ({
  showMessage: vi.fn().mockResolvedValue(undefined),
  askConfirmation: vi.fn().mockResolvedValue(false),
}));

// flush 由测试按场景注入行为（默认空操作）
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { useWorkspace } from "../../src/store/workspace";
import {
  deletedDuringLoad,
  fileRequests,
  loadDeletedSnapshots,
} from "../../src/store/workspace/shared";
import { flushAllMarkdownPublishers } from "../../src/components/Editor/markdown-publisher";
import type { OpenTab } from "../../src/store/workspace";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dirtyTab(path: string, content: string): OpenTab {
  return {
    path,
    content,
    dirty: true,
    lastSavedAt: null,
    diskContent: "# 磁盘基线",
    cursorPos: null,
    scrollTop: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  readTextFileMock.mockReset();
  fileMtimeMock.mockReset();
  listDirMock.mockReset();
  fileMtimeMock.mockResolvedValue(1_700_000_000_000);
  listDirMock.mockResolvedValue([]);
  fileRequests.clear();
  deletedDuringLoad.clear();
  useWorkspace.setState({
    rootPath: "/w",
    workspaceMode: "folder",
    tree: null,
    workspaceLoading: false,
    openTabs: [],
    activeTabPath: null,
    currentFile: null,
    currentContent: "",
    dirty: false,
    saving: false,
    saveError: null,
    lastSavedAt: null,
    conflictPending: false,
    currentHeadingSlug: null,
    splitFile: null,
    splitContent: "",
    openingFiles: new Set(),
    fileOpenErrors: new Map(),
    recentFiles: [],
    bookmarks: [],
    expandedDirs: new Set(),
    loadedDirs: new Set(),
    loadingDirs: new Set(),
    directoryErrors: new Map(),
  });
});

describe("#177 重命名与在途读取竞态", () => {
  it("读取在途时重命名：完成后加载态清除、在途表清空（不再永久卡死）", async () => {
    const content = deferred<string>();
    readTextFileMock.mockReturnValue(content.promise);

    const opening = useWorkspace.getState().openFile("/w/a.md");
    opening.catch(() => {});
    expect(useWorkspace.getState().openingFiles.has("/w/a.md")).toBe(true);

    // 在途时重命名：fileRequests/openingFiles 迁移到新路径
    useWorkspace.getState().onFileRenamed("/w/a.md", "/w/b.md");
    expect(fileRequests.has("/w/b.md")).toBe(true);
    expect(useWorkspace.getState().openingFiles.has("/w/b.md")).toBe(true);

    content.resolve("# 内容");
    await opening;

    // 修复前：闭包按旧路径查表失配 → 条目永不清理；修复后按身份清理到位
    expect(fileRequests.size).toBe(0);
    expect(useWorkspace.getState().openingFiles.size).toBe(0);
  });

  it("重命名后重新打开读磁盘最新内容（不命中陈旧缓存）", async () => {
    const first = deferred<string>();
    readTextFileMock.mockReturnValueOnce(first.promise);

    const opening = useWorkspace.getState().openFile("/w/a.md");
    opening.catch(() => {});
    useWorkspace.getState().onFileRenamed("/w/a.md", "/w/b.md");
    first.resolve("# 重命名瞬间读到的旧内容");
    await opening;
    expect(readTextFileMock).toHaveBeenCalledTimes(1);

    // 关闭后重开（新路径）：修复前命中缓存的已解析 Promise，不会发起新读取；
    // 修复后条目已清理，重开必须重新读盘
    useWorkspace.setState({ openTabs: [], activeTabPath: null, currentFile: null });
    const second = deferred<string>();
    readTextFileMock.mockReturnValueOnce(second.promise);

    const reopening = useWorkspace.getState().openFile("/w/b.md");
    // 同步断言：发起了新请求（在途表重新登记），而非复用陈旧缓存
    expect(fileRequests.has("/w/b.md")).toBe(true);
    second.resolve("# 磁盘最新内容");
    await reopening;

    expect(readTextFileMock).toHaveBeenCalledTimes(2); // 真实重读磁盘
    expect(readTextFileMock).toHaveBeenLastCalledWith("/w/b.md");
    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/w/b.md");
    expect(tab?.content).toBe("# 磁盘最新内容");
  });

  it("在途读取失败 + 重命名：错误记到新路径，且可重试打开（拒绝缓存被清理）", async () => {
    const failing = deferred<string>();
    readTextFileMock.mockReturnValueOnce(failing.promise);

    const opening = useWorkspace.getState().openFile("/w/a.md");
    const caught = opening.catch((e: unknown) => e);
    useWorkspace.getState().onFileRenamed("/w/a.md", "/w/b.md");
    failing.reject(new Error("file locked"));
    await expect(caught).resolves.toBeTruthy();

    // 错误记录在迁移后的新路径；加载态与在途表均清理
    expect(useWorkspace.getState().fileOpenErrors.get("/w/b.md")).toBe("file locked");
    expect(fileRequests.size).toBe(0);
    expect(useWorkspace.getState().openingFiles.size).toBe(0);

    // 修复前：缓存的 rejected Promise 使文件永远打不开；修复后可重试
    const retry = deferred<string>();
    readTextFileMock.mockReturnValueOnce(retry.promise);
    const retrying = useWorkspace.getState().openFile("/w/b.md");
    // 同步断言：发起了新请求，而非复用缓存的已拒绝 Promise
    expect(fileRequests.has("/w/b.md")).toBe(true);
    retry.resolve("# 恢复后的内容");
    await retrying;
    expect(readTextFileMock).toHaveBeenCalledTimes(2);
    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/w/b.md");
    expect(tab?.content).toBe("# 恢复后的内容");
  });
});

describe("#166 删除文件快照竞态", () => {
  it("快照采集前先 flush 发布防抖：快照内容是最后编辑而非发布前旧内容", () => {
    // 模拟：用户刚输入，编辑器序列化仍在 150ms 防抖窗口内——
    // store 里还是发布前旧内容；flush 才把最后编辑发布进 store
    useWorkspace.setState({
      openTabs: [dirtyTab("/w/del.md", "# 发布前的旧内容")],
      activeTabPath: "/w/del.md",
      currentFile: "/w/del.md",
      currentContent: "# 发布前的旧内容",
      dirty: true,
    });
    vi.mocked(flushAllMarkdownPublishers).mockImplementation(() => {
      useWorkspace.setState((s) => ({
        currentContent: "# 最后编辑的内容",
        openTabs: s.openTabs.map((t) =>
          t.path === "/w/del.md" ? { ...t, content: "# 最后编辑的内容" } : t,
        ),
      }));
    });

    useWorkspace.getState().onFileDeleted("/w/del.md");

    expect(vi.mocked(flushAllMarkdownPublishers)).toHaveBeenCalled();
    const snapshots = loadDeletedSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].path).toBe("/w/del.md");
    // 关键断言：快照拿到的是 flush 后的最后编辑，而非采集时的旧内容
    expect(snapshots[0].content).toBe("# 最后编辑的内容");
  });

  it("读取在途时删除：完成后不建漏网 tab，读到的内容写入恢复快照", async () => {
    const inflight = deferred<string>();
    readTextFileMock.mockReturnValue(inflight.promise);

    const opening = useWorkspace.getState().openFile("/w/a.md");
    const caught = opening.catch((e: unknown) => e);
    expect(fileRequests.has("/w/a.md")).toBe(true);

    // 在途时删除：无 tab 可快照，但黑名单记下了在途路径
    useWorkspace.getState().onFileDeleted("/w/a.md");
    expect(deletedDuringLoad.has("/w/a.md")).toBe(true);

    inflight.resolve("# 在途读到的内容");
    await expect(caught).resolves.toBeTruthy();

    // 不创建「已删除文件」的干净 tab
    expect(useWorkspace.getState().openTabs.find((t) => t.path === "/w/a.md")).toBeUndefined();
    // 读到的内容进入恢复快照（后续编辑不再游离于保护之外）
    const snapshots = loadDeletedSnapshots();
    expect(snapshots.some((s) => s.path === "/w/a.md" && s.content === "# 在途读到的内容")).toBe(true);
    // 黑名单一次性消费；打开错误给出原因
    expect(deletedDuringLoad.size).toBe(0);
    expect(useWorkspace.getState().fileOpenErrors.get("/w/a.md")).toContain("被外部删除");
  });

  it("黑名单消费后同名文件重建可正常打开（不误拦）", async () => {
    const inflight = deferred<string>();
    readTextFileMock.mockReturnValueOnce(inflight.promise);
    const opening = useWorkspace.getState().openFile("/w/a.md");
    opening.catch(() => {});
    useWorkspace.getState().onFileDeleted("/w/a.md");
    inflight.resolve("# 旧内容");
    await opening.catch(() => {});
    expect(readTextFileMock).toHaveBeenCalledTimes(1);

    // 重建同名文件后重新打开：黑名单已消费，正常读盘建 tab
    const fresh = deferred<string>();
    readTextFileMock.mockReturnValueOnce(fresh.promise);
    const reopening = useWorkspace.getState().openFile("/w/a.md");
    // 同步断言：黑名单未误拦，发起了新读取
    expect(fileRequests.has("/w/a.md")).toBe(true);
    fresh.resolve("# 重建后的内容");
    await reopening;
    expect(readTextFileMock).toHaveBeenCalledTimes(2);
    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/w/a.md");
    expect(tab?.content).toBe("# 重建后的内容");
  });

  it("目录删除同样拦截其下在途读取的文件", async () => {
    const inflight = deferred<string>();
    readTextFileMock.mockReturnValue(inflight.promise);
    const opening = useWorkspace.getState().openFile("/w/notes/x.md");
    const caught = opening.catch((e: unknown) => e);

    useWorkspace.getState().onFileDeleted("/w/notes");
    expect(deletedDuringLoad.has("/w/notes/x.md")).toBe(true);

    inflight.resolve("# 子文件内容");
    await expect(caught).resolves.toBeTruthy();

    expect(useWorkspace.getState().openTabs.find((t) => t.path === "/w/notes/x.md")).toBeUndefined();
    expect(
      loadDeletedSnapshots().some((s) => s.path === "/w/notes/x.md" && s.content === "# 子文件内容"),
    ).toBe(true);
  });

  it("黑名单条目超时失效：不影响迟到的正常打开", async () => {
    // 直接写入一条 61 秒前的过期记录（远超 60s TTL）
    deletedDuringLoad.set("/w/old.md", Date.now() - 61_000);

    const fresh = deferred<string>();
    readTextFileMock.mockReturnValue(fresh.promise);
    const opening = useWorkspace.getState().openFile("/w/old.md");
    fresh.resolve("# 正常内容");
    await opening;

    // 过期黑名单被忽略并清理，tab 正常创建
    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/w/old.md");
    expect(tab?.content).toBe("# 正常内容");
    expect(deletedDuringLoad.has("/w/old.md")).toBe(false);
  });
});

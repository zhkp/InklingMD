// #362 读路径：打开链路的「成对基线」契约
//
// readFileOnce 的签名从 `Promise<string>` 改成 `Promise<DocumentSnapshot>` 之后，
// 本文件只锁 #362 自己新增的东西：
//   * 一次读取产出的 `diskContent` / `diskStat` / `diskMtime` 必须同源，
//     不得读完内容再补一次 mtime/stat（那正是「旧内容 + 新 stat」的缺陷）；
//   * 在途重命名后仍以同一份 pair 建基线（#200 的路径归属由 file-op-races 覆盖）。
//
// #166（打开期间被删除 → 快照 + 不建 tab）与 #200 的并发去重留在
// `tests/store/file-op-races.test.ts`，避免同一语义两套断言。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { readDocumentMock, fileStatMock, fileMtimeMock } = vi.hoisted(() => ({
  readDocumentMock: vi.fn(),
  fileStatMock: vi.fn(),
  fileMtimeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("../../src/lib/fs", () => ({
  readDocument: readDocumentMock,
  fileStat: fileStatMock,
  fileMtime: fileMtimeMock,
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { useWorkspace } from "../../src/store/workspace";
import { deletedDuringLoad, fileRequests, pathLocks } from "../../src/store/workspace/shared";
import type { DocumentSnapshot } from "../../src/lib/fs";

const DOC = "/w/a.md";
const snapshot = (content: string, mtimeUs: number): DocumentSnapshot => ({
  content,
  stat: { mtimeUs, size: new TextEncoder().encode(content).byteLength },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  readDocumentMock.mockReset();
  fileStatMock.mockReset();
  fileMtimeMock.mockReset();
  fileRequests.clear();
  pathLocks.clear();
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
  } as never);
});

describe("打开文件：基线与内容同源（#362）", () => {
  it("tab 的 diskContent / diskStat / diskMtime 全部来自同一份快照，不额外取 stat", async () => {
    const snap = snapshot("# 内容", 1_700_000_000_123_456);
    readDocumentMock.mockResolvedValue(snap);

    await useWorkspace.getState().openFile(DOC);

    expect(readDocumentMock).toHaveBeenCalledTimes(1);
    expect(readDocumentMock).toHaveBeenCalledWith(DOC);
    // 不允许多打一次 mtime/stat IPC（旧实现读完内容再取 mtime，就是 R1 的窗口）
    expect(fileMtimeMock).not.toHaveBeenCalled();
    expect(fileStatMock).not.toHaveBeenCalled();

    const tab = useWorkspace.getState().openTabs[0];
    expect(tab.content).toBe("# 内容");
    expect(tab.diskContent).toBe("# 内容");
    expect(tab.diskStat).toEqual(snap.stat);
    // 过渡期双写：diskMtime 由 diskStat 换算，两者必须成对
    expect(tab.diskMtime).toBe(snap.stat.mtimeUs / 1000);
    expect(tab.dirty).toBe(false);
  });

  // 「打开期间被删除」（#166：不建 tab + 写恢复快照 + 黑名单一次性消费）与
  // 「同路径并发只读一次」（#200）已由 tests/store/file-op-races.test.ts 覆盖，
  // 这里只锁 #362 新增的契约：**基线必须来自同一份 pair**。

  it("打开期间被重命名：tab 建在新路径，基线来自同一份 pair（#200）", async () => {
    const pending = deferred<DocumentSnapshot>();
    readDocumentMock.mockReturnValue(pending.promise);
    const snap = snapshot("# 重命名后", 2_000);

    const opening = useWorkspace.getState().openFile(DOC);
    useWorkspace.getState().onFileRenamed(DOC, "/w/b.md");
    pending.resolve(snap);

    await opening;

    const state = useWorkspace.getState();
    expect(state.openTabs).toHaveLength(1);
    expect(state.openTabs[0].path).toBe("/w/b.md");
    expect(state.activeTabPath).toBe("/w/b.md");
    expect(state.openTabs[0].diskStat).toEqual(snap.stat);
    expect(state.openTabs[0].diskMtime).toBe(2);
    expect(state.openTabs[0].content).toBe("# 重命名后");
  });

});

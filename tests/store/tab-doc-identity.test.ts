// tab 文档身份 docId（#431 评审）
//
// 路径不能当身份：关闭后重开同一路径是新文档（pending 图片上传必须失效）；
// 同一路径重复 openFile 则应复用现有 tab（身份连续）。可视化回归见
// tests/unit/image-upload-doc-guard.test.ts 的 stillSameDocument 用例。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { readDocumentMock } = vi.hoisted(() => ({ readDocumentMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => path,
}));

vi.mock("../../src/lib/fs", () => ({
  readDocument: readDocumentMock,
  fileStat: vi.fn(),
  fileMtime: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

vi.mock("../../src/lib/draft-journal", () => ({
  clearDraft: vi.fn(async () => {}),
  scheduleDraft: vi.fn(),
}));

vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { useWorkspace } from "../../src/store/workspace";
import { fileRequests, pathLocks } from "../../src/store/workspace/shared";

const DOC = "/w/note.md";
const snap = { content: "# note", stat: { mtimeUs: 1, size: 6 } };

beforeEach(() => {
  vi.clearAllMocks();
  readDocumentMock.mockResolvedValue(snap);
  fileRequests.clear();
  pathLocks.clear();
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

describe("tab 文档身份 docId（#431 评审）", () => {
  it("关闭后重开同一路径：分配新的 docId（pending 上传身份失效）", async () => {
    await useWorkspace.getState().openFile(DOC);
    const first = useWorkspace.getState().openTabs[0].docId;
    expect(first).toBeTruthy();

    useWorkspace.getState().closeTab(DOC);
    expect(useWorkspace.getState().openTabs).toHaveLength(0);

    await useWorkspace.getState().openFile(DOC);
    const second = useWorkspace.getState().openTabs[0].docId;
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("同一路径重复打开复用现有 tab：docId 不变（编辑/上传上下文连续）", async () => {
    await useWorkspace.getState().openFile(DOC);
    const first = useWorkspace.getState().openTabs[0].docId;

    await useWorkspace.getState().openFile(DOC);

    expect(useWorkspace.getState().openTabs).toHaveLength(1);
    expect(useWorkspace.getState().openTabs[0].docId).toBe(first);
    expect(readDocumentMock).toHaveBeenCalledTimes(1);
  });
});

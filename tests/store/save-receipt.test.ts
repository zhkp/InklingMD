// #362 写路径：saveCurrent 对写盘回执三类结果的处理（评审 #394 第 7 条）
//
// 这些分支此前只有「mock 成永远 written」的桩，等于没测。这里用可控的
// saveDocument 返回精确驱动三条路径：conflict / touch-only 重试 / 半失败(tempPath)。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { saveDocumentMock, readDocumentMock, writeTextFileMock, showMessageMock, fileMtimeMock, readTextFileMock, messageMock, saveDialogMock, askMock } = vi.hoisted(() => ({
  saveDocumentMock: vi.fn(),
  readDocumentMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  showMessageMock: vi.fn(),
  fileMtimeMock: vi.fn(),
  readTextFileMock: vi.fn(),
  messageMock: vi.fn(),
  saveDialogMock: vi.fn(),
  askMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: askMock,
  save: saveDialogMock,
  message: messageMock,
}));
vi.mock("../../src/lib/fs", () => ({
  saveDocument: saveDocumentMock,
  writeTextFile: writeTextFileMock,
  readDocument: readDocumentMock,
  readTextFile: readTextFileMock,
  fileMtime: fileMtimeMock,
  fileStat: vi.fn(),
}));
vi.mock("../../src/lib/dialogs", () => ({
  showMessage: showMessageMock,
  askConfirmation: vi.fn(),
}));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { useWorkspace } from "../../src/store/workspace";
import { useConflict } from "../../src/store/conflict";

const DOC = "/w/note.md";
const BASE = { mtimeUs: 1_000_000, size: 4 };
const PICKED: OpenTab = {
  path: DOC,
  content: "本地编辑",
  dirty: true,
  lastSavedAt: null,
  diskContent: "基线",
  diskStat: BASE,
  diskMtime: 1,
  cursorPos: 0,
  scrollTop: 0,
};

function reset(over: Partial<OpenTab> = {}) {
  useWorkspace.setState({
    openTabs: [{ ...PICKED, ...over }],
    activeTabPath: DOC,
    currentFile: DOC,
    currentContent: PICKED.content,
    dirty: true,
    saving: false,
    conflictPending: false,
    saveError: null,
    recentFiles: [],
  });
  useConflict.setState({ conflict: null });
}

describe("saveCurrent 写盘回执（#362）", () => {
  beforeEach(() => {
    saveDocumentMock.mockReset();
    readDocumentMock.mockReset();
    writeTextFileMock.mockReset().mockResolvedValue(undefined);
    showMessageMock.mockReset();
    fileMtimeMock.mockReset().mockResolvedValue(1);
    readTextFileMock.mockReset().mockResolvedValue("基线");
    messageMock.mockReset();
    saveDialogMock.mockReset();
    askMock.mockReset();
    reset();
  });

  it("回执 conflict：不覆盖磁盘，内容保留并开冲突框", async () => {
    const openConflict = vi.fn();
    useConflict.setState({ conflict: null, openConflict });
    saveDocumentMock.mockResolvedValue({
      kind: "conflict",
      disk: { mtimeUs: 2_000_000, size: 9 },
      registerFailed: false,
    });
    readDocumentMock.mockResolvedValue({
      content: "外部内容",
      stat: { mtimeUs: 2_000_000, size: 9 },
    });

    await useWorkspace.getState().saveCurrent();

    // 不允许退回旧实现（无条件写盘）；回执 conflict 时一次都不该写
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(openConflict).toHaveBeenCalledTimes(1);
    expect(openConflict).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: DOC, diskContent: "外部内容" }),
    );
    const tab = useWorkspace.getState().openTabs[0];
    expect(tab.content).toBe("本地编辑");
    expect(tab.dirty).toBe(true);
  });

  it("回执 conflict 但磁盘内容等于旧基线（仅 touch）：adopt 后重试一次并写成功", async () => {
    saveDocumentMock
      .mockResolvedValueOnce({ kind: "conflict", disk: { mtimeUs: 3_000_000, size: 4 }, registerFailed: false })
      .mockResolvedValueOnce({ kind: "written", stat: { mtimeUs: 4_000_000, size: 12 }, foreignWrite: false });
    readDocumentMock.mockResolvedValue({ content: "基线", stat: { mtimeUs: 3_000_000, size: 4 } });

    await useWorkspace.getState().saveCurrent();

    expect(saveDocumentMock).toHaveBeenCalledTimes(2);
    // 第二次必须用 adopt 后的新身份，否则会再次判冲突
    expect(saveDocumentMock).toHaveBeenLastCalledWith(DOC, "本地编辑", {
      expected: { mtimeUs: 3_000_000, size: 4 },
      overwriteExisting: false,
    });
    const tab = useWorkspace.getState().openTabs[0];
    expect(tab.dirty).toBe(false);
    expect(tab.diskStat).toEqual({ mtimeUs: 4_000_000, size: 12 });
  });

  it("半失败（tempPath）：提示 temp 路径且不把 tab 当已保存", async () => {
    const openConflict = vi.fn();
    useConflict.setState({ conflict: null, openConflict });
    saveDocumentMock.mockResolvedValue({
      kind: "conflict",
      disk: { mtimeUs: 2_000_000, size: 9 },
      tempPath: "/w/.note.md.tmp.1-0",
      registerFailed: true,
    });
    readDocumentMock.mockResolvedValue({
      content: "外部内容",
      stat: { mtimeUs: 2_000_000, size: 9 },
    });

    await useWorkspace.getState().saveCurrent();

    expect(showMessageMock).toHaveBeenCalledWith(
      expect.stringContaining("/w/.note.md.tmp.1-0"),
      expect.objectContaining({ kind: "warning" }),
    );
    // registerFailed 必须提示「重启后可能找不到」
    expect(showMessageMock.mock.calls[0][0]).toContain("重启后可能找不到");
    expect(useWorkspace.getState().openTabs[0].dirty).toBe(true);
  });

  it("回执 notFound 且用户选「重新创建」：走写引擎一次（createParentDirs），不重复写", async () => {
    // 第一次：回执 notFound（文件已不在原处）；第二次：用户确认后由写引擎重建并返回回执
    saveDocumentMock
      .mockResolvedValueOnce({ kind: "notFound" })
      .mockResolvedValueOnce({
        kind: "written",
        stat: { mtimeUs: 9_000_000, size: 12 },
        foreignWrite: false,
      });
    messageMock.mockResolvedValue("重新创建");

    await useWorkspace.getState().saveCurrent();

    // 重建也走写引擎（唯一开启 createParentDirs 的入口），不再用 writeTextFile 旁路
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(saveDocumentMock).toHaveBeenCalledTimes(2);
    // 重建不带 expected、也不带 overwriteExisting → Rust 侧走 CreateExclusive：
    // 若这期间文件又被别人建出来，会得到 conflict 而不是静默覆盖
    expect(saveDocumentMock).toHaveBeenLastCalledWith(DOC, "本地编辑", {
      createParentDirs: true,
    });
    const tab = useWorkspace.getState().openTabs[0];
    expect(tab.deletedOnDisk).toBe(false);
    expect(tab.dirty).toBe(false);
    // 基线直接取重建回执，不再补一次 fileStat
    expect(tab.diskStat).toEqual({ mtimeUs: 9_000_000, size: 12 });
  });

  it("回执 foreignWrite（写后身份不可信）：保持 dirty 并给可见错误，不静默当成功", async () => {
    saveDocumentMock.mockResolvedValue({
      kind: "written",
      stat: { mtimeUs: 5_000_000, size: 12 },
      foreignWrite: true,
    });

    await useWorkspace.getState().saveCurrent();

    const state = useWorkspace.getState();
    expect(state.dirty).toBe(true);
    expect(state.saveError).toContain("保存可能未完成");
    // 基线不推进：下一轮会重新读盘判定，而不是用可疑身份
    expect(state.openTabs[0].diskStat).toEqual(BASE);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { isTauriMock, saveMock, askMock, writeTextFileMock, fileMtimeMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => true),
  saveMock: vi.fn(),
  askMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  fileMtimeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: isTauriMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock, ask: askMock }));
vi.mock("../../src/lib/fs", () => ({
  writeTextFile: writeTextFileMock,
  readTextFile: vi.fn(),
  fileMtime: fileMtimeMock,
}));

import { useWorkspace } from "../../src/store/workspace";
import { ask } from "@tauri-apps/plugin-dialog";

const untitledPath = "untitled-testing";
function untitled(content = "draft"): OpenTab {
  return {
    path: untitledPath,
    content,
    dirty: true,
    isUntitled: true,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
  };
}

function reset(content = "draft") {
  useWorkspace.setState({
    openTabs: [untitled(content)],
    activeTabPath: untitledPath,
    currentFile: untitledPath,
    currentContent: content,
    dirty: true,
    saving: false,
    saveError: null,
    recentFiles: [],
  });
}

describe("saveCurrent untitled first-save migration", () => {
  beforeEach(() => {
    saveMock.mockReset().mockResolvedValue("/docs/saved.md");
    writeTextFileMock.mockReset().mockResolvedValue(undefined);
    fileMtimeMock.mockReset().mockResolvedValue(1_234);
    isTauriMock.mockReturnValue(true);
    localStorage.clear();
    reset();
  });

  it("writes the selected path and migrates all active tab mirrors", async () => {
    await useWorkspace.getState().saveCurrent();
    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/saved.md", "draft");
    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBe("/docs/saved.md");
    expect(state.currentFile).toBe("/docs/saved.md");
    expect(state.openTabs[0]).toMatchObject({
      path: "/docs/saved.md", isUntitled: false, dirty: false, diskMtime: 1_234,
    });
    expect(state.recentFiles).toContain("/docs/saved.md");
  });

  it("keeps the untitled tab dirty when the dialog is cancelled", async () => {
    saveMock.mockResolvedValue(null);
    await useWorkspace.getState().saveCurrent();
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().openTabs[0]).toMatchObject({
      path: untitledPath, isUntitled: true, dirty: true,
    });
  });

  it("can retry after a write failure", async () => {
    writeTextFileMock.mockRejectedValueOnce(new Error("permission denied"));
    await useWorkspace.getState().saveCurrent();
    expect(useWorkspace.getState().saveError).toBe("permission denied");
    expect(useWorkspace.getState().openTabs[0].isUntitled).toBe(true);
    await useWorkspace.getState().saveCurrent();
    expect(writeTextFileMock).toHaveBeenCalledTimes(2);
    expect(useWorkspace.getState().activeTabPath).toBe("/docs/saved.md");
  });

  it("keeps later edits dirty while the first write is pending", async () => {
    let release!: () => void;
    writeTextFileMock.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const saving = useWorkspace.getState().saveCurrent();
    await vi.waitFor(() => expect(writeTextFileMock).toHaveBeenCalled());
    useWorkspace.getState().setContent("draft plus later edit");
    release();
    await saving;
    expect(useWorkspace.getState().currentContent).toBe("draft plus later edit");
    expect(useWorkspace.getState().dirty).toBe(true);
  });

  it("does not open a dialog during non-interactive auto-save", async () => {
    await useWorkspace.getState().saveCurrent({ interactive: false });
    expect(saveMock).not.toHaveBeenCalled();
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().dirty).toBe(true);
  });
});

describe("saveCurrent 另存为到已打开路径的合并 (#150)", () => {
  function existingTab(dirty: boolean): OpenTab {
    return {
      path: "/docs/saved.md",
      content: "# 已打开文件的旧内容",
      dirty,
      isUntitled: false,
      lastSavedAt: dirty ? null : Date.now(),
      diskContent: "# 已打开文件的旧内容",
      cursorPos: null,
      scrollTop: null,
    };
  }

  function resetWithExisting(dirty: boolean) {
    useWorkspace.setState({
      openTabs: [existingTab(dirty), untitled("draft")],
      activeTabPath: untitledPath,
      currentFile: untitledPath,
      currentContent: "draft",
      dirty: true,
      saving: false,
      saveError: null,
      recentFiles: [],
    });
  }

  beforeEach(() => {
    saveMock.mockReset().mockResolvedValue("/docs/saved.md");
    askMock.mockReset();
    writeTextFileMock.mockReset().mockResolvedValue(undefined);
    fileMtimeMock.mockReset().mockResolvedValue(1_234);
    isTauriMock.mockReturnValue(true);
    localStorage.clear();
  });

  it("目标路径已在干净 tab 打开：合并为一个 tab，草稿关闭，不产生重复", async () => {
    resetWithExisting(false);
    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/saved.md", "draft");
    const state = useWorkspace.getState();
    const samePathTabs = state.openTabs.filter((t) => t.path === "/docs/saved.md");
    expect(samePathTabs).toHaveLength(1); // 关键：不再出现两个同 path tab
    expect(state.openTabs.some((t) => t.path === untitledPath)).toBe(false); // 草稿已关闭
    expect(state.activeTabPath).toBe("/docs/saved.md");
    expect(samePathTabs[0]).toMatchObject({
      content: "draft",
      dirty: false,
      diskContent: "draft",
      diskMtime: 1_234,
    });
    expect(state.recentFiles).toContain("/docs/saved.md");
  });

  it("目标 tab 有未保存内容：先弹确认，拒绝则双方原样保留", async () => {
    vi.mocked(ask).mockResolvedValueOnce(false);
    resetWithExisting(true);
    await useWorkspace.getState().saveCurrent();

    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("saved.md"),
      expect.objectContaining({ kind: "warning" }),
    );
    expect(writeTextFileMock).not.toHaveBeenCalled();
    const state = useWorkspace.getState();
    expect(state.openTabs).toHaveLength(2); // 两个 tab 都保留
    expect(state.openTabs.find((t) => t.path === untitledPath)).toMatchObject({
      isUntitled: true,
      dirty: true,
      saving: false,
    });
    expect(state.openTabs.find((t) => t.path === "/docs/saved.md")).toMatchObject({
      content: "# 已打开文件的旧内容",
      dirty: true,
    });
    expect(state.activeTabPath).toBe(untitledPath); // 焦点回到草稿
  });

  it("目标 tab 有未保存内容：确认后覆盖合并", async () => {
    vi.mocked(ask).mockResolvedValueOnce(true);
    resetWithExisting(true);
    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/saved.md", "draft");
    const state = useWorkspace.getState();
    expect(state.openTabs.filter((t) => t.path === "/docs/saved.md")).toHaveLength(1);
    expect(state.openTabs.some((t) => t.path === untitledPath)).toBe(false);
    expect(state.activeTabPath).toBe("/docs/saved.md");
    expect(state.openTabs[0]).toMatchObject({ content: "draft", dirty: false });
  });
});

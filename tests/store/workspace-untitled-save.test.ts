import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { isTauriMock, saveMock, askMock, writeTextFileMock, readTextFileMock, fileMtimeMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => true),
  saveMock: vi.fn(),
  askMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  readTextFileMock: vi.fn(),
  fileMtimeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: isTauriMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock, ask: askMock }));
vi.mock("../../src/lib/fs", () => ({
  writeTextFile: writeTextFileMock,
  readTextFile: readTextFileMock,
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
      // 与 beforeEach 的 fileMtime 基线一致：命中 mtime 快速路径，
      // 常规合并用例不触发外部修改冲突确认
      diskMtime: 1_234,
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

  it("写盘窗口期用户切走：不抢占激活态、内容镜像不被踩（issue #148 模式）", async () => {
    const tabC: OpenTab = {
      path: "/docs/c.md",
      content: "# C 的内容",
      dirty: false,
      isUntitled: false,
      lastSavedAt: Date.now(),
      diskContent: "# C 的内容",
      diskMtime: 1_234,
      cursorPos: null,
      scrollTop: null,
    };
    useWorkspace.setState({
      openTabs: [existingTab(false), tabC, untitled("draft")],
      activeTabPath: untitledPath,
      currentFile: untitledPath,
      currentContent: "draft",
      dirty: true,
      saving: false,
      saveError: null,
      recentFiles: [],
    });
    let release!: () => void;
    writeTextFileMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const saving = useWorkspace.getState().saveCurrent();
    await vi.waitFor(() => expect(writeTextFileMock).toHaveBeenCalled());
    // 写盘窗口期用户切到 tab C（对话框期间 webview 仍可交互）
    useWorkspace.getState().switchTab("/docs/c.md");
    release();
    await saving;

    const state = useWorkspace.getState();
    // 用户选择被保留：不拽回合并 tab，顶层镜像来自实际活跃的 C
    expect(state.activeTabPath).toBe("/docs/c.md");
    expect(state.currentFile).toBe("/docs/c.md");
    expect(state.currentContent).toBe("# C 的内容");
    // 合并本身完成：目标已更新、草稿已关闭
    expect(state.openTabs.find((t) => t.path === "/docs/saved.md")).toMatchObject({
      content: "draft",
      dirty: false,
    });
    expect(state.openTabs.some((t) => t.path === untitledPath)).toBe(false);
  });

  it("外部修改过目标文件：合并前弹冲突确认，拒绝则不写盘、双方保留", async () => {
    fileMtimeMock.mockResolvedValue(9_999); // 与目标基线 1_234 不一致 → 走全文比对
    readTextFileMock.mockResolvedValue("# 外部程序修改后的内容");
    vi.mocked(ask).mockResolvedValueOnce(false);
    resetWithExisting(false);

    await useWorkspace.getState().saveCurrent();

    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("外部程序修改"),
      expect.objectContaining({ kind: "warning" }),
    );
    expect(writeTextFileMock).not.toHaveBeenCalled();
    const state = useWorkspace.getState();
    expect(state.openTabs).toHaveLength(2); // 草稿与目标都保留
    expect(state.activeTabPath).toBe(untitledPath);
    expect(state.openTabs.find((t) => t.path === untitledPath)).toMatchObject({ dirty: true });
  });

  it("外部修改过目标文件：确认覆盖后正常合并", async () => {
    fileMtimeMock.mockResolvedValue(9_999);
    readTextFileMock.mockResolvedValue("# 外部程序修改后的内容");
    vi.mocked(ask).mockResolvedValueOnce(true);
    resetWithExisting(false);

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/saved.md", "draft");
    const state = useWorkspace.getState();
    expect(state.openTabs.filter((t) => t.path === "/docs/saved.md")).toHaveLength(1);
    expect(state.openTabs.some((t) => t.path === untitledPath)).toBe(false);
    expect(state.activeTabPath).toBe("/docs/saved.md");
  });

  it("目标 tab 在写盘窗口期被关闭：草稿改名承接路径，激活态不损坏", async () => {
    resetWithExisting(false);
    let release!: () => void;
    writeTextFileMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const saving = useWorkspace.getState().saveCurrent();
    await vi.waitFor(() => expect(writeTextFileMock).toHaveBeenCalled());
    // 窗口期用户关闭了目标 tab（干净，无确认）
    useWorkspace.getState().closeTab("/docs/saved.md");
    release();
    await saving;

    const state = useWorkspace.getState();
    // 草稿承接已保存的路径（回退改名语义），激活态不指向不存在的 tab
    expect(state.openTabs).toHaveLength(1);
    expect(state.activeTabPath).toBe("/docs/saved.md");
    expect(state.openTabs[0]).toMatchObject({
      path: "/docs/saved.md",
      isUntitled: false,
      content: "draft",
      dirty: false,
    });
  });

  it("分屏正展示合并目标：合并后关闭分屏（对照已无意义，避免主/分屏同文件）", async () => {
    resetWithExisting(false);
    useWorkspace.setState({
      splitFile: "/docs/saved.md",
      splitContent: "# 已打开文件的旧内容",
    });

    await useWorkspace.getState().saveCurrent();

    const state = useWorkspace.getState();
    expect(state.splitFile).toBeNull();
    expect(state.splitContent).toBe("");
    expect(state.openTabs.filter((t) => t.path === "/docs/saved.md")).toHaveLength(1);
    expect(state.activeTabPath).toBe("/docs/saved.md");
  });
});

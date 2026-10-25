// 保存冲突保护测试（v2.3.8 修复 #59 的保存前基线比对）
// 验证：普通文件保存前读磁盘与 diskContent 基线比对；
// - 外部已修改 → 弹确认，用户拒绝则不保存
// - 外部已修改 → 用户确认覆盖则保存并更新基线
// - 磁盘与基线一致 → 直接保存不弹确认

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { readTextFileMock, writeTextFileMock, fileMtimeMock, askMock, isTauriMock } = vi.hoisted(() => ({
  readTextFileMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  fileMtimeMock: vi.fn(),
  askMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: askMock,
  save: vi.fn(),
}));

vi.mock("../../src/lib/fs", () => ({
  readTextFile: readTextFileMock,
  writeTextFile: writeTextFileMock,
  fileMtime: fileMtimeMock,
  // #362：reloadFile 走成对读取；switchTab 核验用 fileStat（本文件只测保存前比对，
  // stat 取固定值让基线判定稳定）
  readDocument: async (path: string) => ({
    content: await readTextFileMock(path),
    stat: { mtimeUs: 1_700_000_000_000_000, size: 1 },
  }),
  fileStat: async () => ({ mtimeUs: 1_700_000_000_000_000, size: 1 }),
}));

import { useWorkspace } from "../../src/store/workspace";
import { WriteError } from "../../src/lib/writeErrors";

function tab(path: string, content: string, diskContent: string): OpenTab {
  return {
    path,
    content,
    cursorPos: null,
    scrollTop: null,
    dirty: true,
    isUntitled: false,
    diskContent,
    diskMtime: 1_000,
    lastSavedAt: null,
  };
}

function setState(next: Partial<ReturnType<typeof useWorkspace.getState>>) {
  useWorkspace.setState(next as any);
}

describe("saveCurrent 外部修改冲突保护", () => {
  beforeEach(() => {
    readTextFileMock.mockReset();
    writeTextFileMock.mockReset();
    fileMtimeMock.mockReset().mockResolvedValue(1_000);
    askMock.mockReset();
    isTauriMock.mockReset();
    isTauriMock.mockReturnValue(true);
    readTextFileMock.mockResolvedValue("磁盘基线");
    writeTextFileMock.mockResolvedValue(undefined);
    askMock.mockResolvedValue(false);
    setState({
      openTabs: [tab("/docs/a.md", "本地编辑", "磁盘基线")],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: "本地编辑",
      dirty: true,
      saving: false,
      saveError: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("磁盘内容与基线一致：直接保存，不弹确认", async () => {
    await useWorkspace.getState().saveCurrent();

    expect(askMock).not.toHaveBeenCalled();
    expect(fileMtimeMock).toHaveBeenCalledWith("/docs/a.md");
    expect(readTextFileMock).not.toHaveBeenCalled();
    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", "本地编辑", { mustExist: true });
    const s = useWorkspace.getState();
    expect(s.dirty).toBe(false);
    // 保存后基线更新为本次写入内容
    expect(s.openTabs.find((t) => t.path === "/docs/a.md")?.diskContent).toBe("本地编辑");
  });

  it("磁盘被外部修改：用户拒绝覆盖则不保存", async () => {
    fileMtimeMock.mockResolvedValue(2_000);
    readTextFileMock.mockResolvedValue("外部新内容");
    askMock.mockResolvedValue(false);

    await useWorkspace.getState().saveCurrent();

    expect(askMock).toHaveBeenCalledTimes(1);
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().dirty).toBe(true);
  });

  it("磁盘被外部修改：用户确认覆盖则保存并更新基线", async () => {
    fileMtimeMock.mockResolvedValue(2_000);
    readTextFileMock.mockResolvedValue("外部新内容");
    askMock.mockResolvedValue(true);

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", "本地编辑", { mustExist: true });
    expect(useWorkspace.getState().dirty).toBe(false);
    expect(
      useWorkspace.getState().openTabs.find((t) => t.path === "/docs/a.md")?.diskContent,
    ).toBe("本地编辑");
  });

  it("磁盘读取失败：不弹冲突确认，由 mustExist 写盘判定文件是否仍在原处（#363）", async () => {
    fileMtimeMock.mockResolvedValue(2_000);
    readTextFileMock.mockRejectedValue(new Error("文件不存在"));

    await useWorkspace.getState().saveCurrent();

    expect(askMock).not.toHaveBeenCalled();
    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", "本地编辑", { mustExist: true });
  });

  it("自动保存时文件已不在原处（#363）：不写回、不记 saveError，tab 标记已删除并保留编辑", async () => {
    fileMtimeMock.mockRejectedValue(new Error("文件不存在"));
    readTextFileMock.mockRejectedValue(new Error("文件不存在"));
    writeTextFileMock.mockRejectedValueOnce(new WriteError("TARGET_MISSING"));

    await useWorkspace.getState().saveCurrent({ interactive: false });

    const s = useWorkspace.getState();
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    expect(s.saveError).toBeNull();
    expect(s.saving).toBe(false);
    expect(s.dirty).toBe(true);
    expect(s.openTabs[0].deletedOnDisk).toBe(true);

    // 标记期间的自动保存直接跳过，不再发起写盘
    await useWorkspace.getState().saveCurrent({ interactive: false });
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
  });
  it("自动保存（非交互）：外部冲突时不弹窗，标记 conflictPending", async () => {
    fileMtimeMock.mockResolvedValue(2_000);
    readTextFileMock.mockResolvedValue("外部新内容");

    await useWorkspace.getState().saveCurrent({ interactive: false });

    expect(askMock).not.toHaveBeenCalled();
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().conflictPending).toBe(true);
    expect(useWorkspace.getState().openTabs[0].conflictPending).toBe(true);
  });

  it("mtime 获取失败时回退到磁盘全文比对", async () => {
    fileMtimeMock.mockRejectedValue(new Error("mtime unavailable"));
    readTextFileMock.mockResolvedValue("磁盘基线");
    await useWorkspace.getState().saveCurrent();
    expect(readTextFileMock).toHaveBeenCalledWith("/docs/a.md");
    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", "本地编辑", { mustExist: true });
  });

  it.each([
    { mtime: 1_004, readsDisk: false, label: "4ms remains inside tolerance" },
    { mtime: 1_005, readsDisk: true, label: "5ms reaches the fallback boundary" },
  ])("uses the documented mtime boundary: $label", async ({ mtime, readsDisk }) => {
    fileMtimeMock.mockResolvedValue(mtime);
    readTextFileMock.mockResolvedValue("磁盘基线");
    await useWorkspace.getState().saveCurrent();
    expect(readTextFileMock).toHaveBeenCalledTimes(readsDisk ? 1 : 0);
  });

  it("写盘失败后下一次自动保存可重试并清除错误", async () => {
    writeTextFileMock
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    await useWorkspace.getState().saveCurrent({ interactive: false });
    expect(useWorkspace.getState().saveError).toBe("disk full");
    expect(useWorkspace.getState().dirty).toBe(true);

    await useWorkspace.getState().saveCurrent({ interactive: false });
    expect(writeTextFileMock).toHaveBeenCalledTimes(2);
    expect(useWorkspace.getState().saveError).toBeNull();
    expect(useWorkspace.getState().dirty).toBe(false);
  });

  it("detects a competing window write through the shared file mtime and baseline", async () => {
    // This store instance represents window B. Window A has already written a
    // different body and advanced the filesystem mtime since B loaded the file.
    fileMtimeMock.mockResolvedValue(1_010);
    readTextFileMock.mockResolvedValue("window A content");
    askMock.mockResolvedValue(false);

    await useWorkspace.getState().saveCurrent();

    expect(fileMtimeMock).toHaveBeenCalledWith("/docs/a.md");
    expect(readTextFileMock).toHaveBeenCalledWith("/docs/a.md");
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().dirty).toBe(true);
  });
});

describe("reloadFile 强制重载", () => {
  beforeEach(() => {
    readTextFileMock.mockReset();
    writeTextFileMock.mockReset();
    fileMtimeMock.mockReset().mockResolvedValue(1_000);
    isTauriMock.mockReset();
    isTauriMock.mockReturnValue(true);
    readTextFileMock.mockResolvedValue("磁盘最新内容");
    setState({
      openTabs: [tab("/docs/a.md", "本地编辑", "磁盘基线")],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: "本地编辑",
      dirty: true,
      splitFile: null,
      splitContent: "",
      saving: false,
      saveError: null,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("强制从磁盘重读并清掉 dirty，递增 tab revision", async () => {
    await useWorkspace.getState().reloadFile("/docs/a.md");

    expect(readTextFileMock).toHaveBeenCalledWith("/docs/a.md");
    const s = useWorkspace.getState();
    expect(s.currentContent).toBe("磁盘最新内容");
    expect(s.dirty).toBe(false);
    const t = s.openTabs.find((x) => x.path === "/docs/a.md")!;
    expect(t.content).toBe("磁盘最新内容");
    expect(t.dirty).toBe(false);
    // 重载后基线同步为磁盘内容，后续保存不再误报冲突
    expect(t.diskContent).toBe("磁盘最新内容");
    expect(t.revision).toBe(1);
  });

  it("非活跃 tab 重载不动主面板镜像，分屏展示时同步分屏内容", async () => {
    setState({
      openTabs: [tab("/docs/a.md", "本地编辑", "磁盘基线")],
      activeTabPath: "/docs/a.md",
      currentContent: "本地编辑",
      splitFile: "/docs/a.md",
      splitContent: "本地编辑",
      dirty: true,
    });

    await useWorkspace.getState().reloadFile("/docs/a.md");

    // 同一文件既是主面板又是分屏：两侧都应刷新
    const s = useWorkspace.getState();
    expect(s.splitContent).toBe("磁盘最新内容");
    expect(s.currentContent).toBe("磁盘最新内容");
  });

  it("未打开的文件退化为 openFile", async () => {
    const openFileSpy = vi.spyOn(useWorkspace.getState(), "openFile");
    await useWorkspace.getState().reloadFile("/docs/not-open.md");
    expect(openFileSpy).toHaveBeenCalledWith("/docs/not-open.md");
    openFileSpy.mockRestore();
  });

  it("setTabDiskContent 正确更新指定 tab 的 diskContent", () => {
    useWorkspace.getState().setTabDiskContent("/docs/a.md", "更新后的磁盘基线");
    const t = useWorkspace.getState().openTabs.find((x) => x.path === "/docs/a.md");
    expect(t?.diskContent).toBe("更新后的磁盘基线");
  });
});

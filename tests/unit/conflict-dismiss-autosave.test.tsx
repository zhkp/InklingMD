// 冲突「继续编辑（dismiss）」的暂停语义锁定测试（issue #149）
//
// 设计语义：ConflictDialog 的「继续编辑（稍后自行保存会覆盖磁盘）」= 用户明确选择
// **稍后自行**覆盖磁盘，因此 handleDismiss 有意 **不清除** conflictPending：
//   1. 只同步 tab 的磁盘基线（setTabDiskContent），让后续手动保存不再被判为冲突、静默落盘；
//   2. conflictPending 保留 → 自动保存持续暂停（不自动替用户覆盖磁盘）+
//      状态栏持续可见 + 指示器可点击触发 saveCurrent({ interactive: true })。
// 反之若 dismiss 清掉标志，自动保存会在 2s 内恢复并自动覆盖磁盘，与用户「稍后自行保存」
// 的选择直接矛盾。
//
// 本文件锁定三段行为：dismiss 后保持暂停 → 暂停期间自动保存不触发 →
// 手动保存（基线已同步，静默）成功后清除标志并恢复自动保存。
// 对照组用例证明「基线同步」是静默保存的前提，避免该断言变成恒真。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const {
  readTextFileMock,
  writeTextFileMock,
  fileMtimeMock,
  listDirMock,
  askMock,
  isTauriMock,
} = vi.hoisted(() => ({
  readTextFileMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  fileMtimeMock: vi.fn(),
  listDirMock: vi.fn(),
  askMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  ask: askMock,
}));

vi.mock("../../src/lib/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/fs")>();
  return {
    ...actual,
    readTextFile: readTextFileMock,
    writeTextFile: writeTextFileMock,
    fileMtime: fileMtimeMock,
    listDir: listDirMock,
  };
});

vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { ConflictDialog } from "../../src/components/FileConflict/ConflictDialog";
import { useAutoSave } from "../../src/lib/useAutoSave";
import { useConflict } from "../../src/store/conflict";
import { useWorkspace } from "../../src/store/workspace";
import type { OpenTab } from "../../src/store/workspace";

const FILE = "/docs/note.md";
const OTHER = "/docs/other.md";
/** 本地未保存内容 */
const LOCAL = "本地未保存内容";
/** 外部程序改写后的磁盘内容（冲突检测时读取） */
const DISK = "磁盘被外部改写后的内容";
/** 本地记录的上一次磁盘基线（已过期，与 DISK 不一致 → 判为冲突） */
const STALE_BASELINE = "磁盘旧基线";
const BASELINE_MTIME = 1000;
const DISK_MTIME = 2000;

function makeTab(path: string, content: string, extra?: Partial<OpenTab>): OpenTab {
  return {
    path,
    content,
    dirty: true,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
    isUntitled: false,
    ...extra,
  };
}

/** 同时挂载自动保存 hook 与冲突对话框，复现真实应用的组合 */
function Host() {
  useAutoSave();
  return <ConflictDialog />;
}

describe("冲突「继续编辑」保持自动保存暂停（issue #149 dismiss 语义）", () => {
  /** 模拟磁盘内容：写入成功后磁盘内容随之更新，后续冲突检测读到的是最新值 */
  let disk = DISK;

  beforeEach(() => {
    vi.useFakeTimers();
    disk = DISK;
    isTauriMock.mockReturnValue(true);
    readTextFileMock.mockImplementation(async () => disk);
    writeTextFileMock.mockImplementation(async (_path: string, content: string) => {
      disk = content;
    });
    fileMtimeMock.mockResolvedValue(DISK_MTIME);
    listDirMock.mockResolvedValue({
      name: "docs",
      path: "/docs",
      is_dir: true,
      children: [],
    });
    askMock.mockResolvedValue(true);

    useWorkspace.setState({
      openTabs: [
        makeTab(FILE, LOCAL, {
          diskContent: STALE_BASELINE,
          diskMtime: BASELINE_MTIME,
          conflictPending: true,
        }),
      ],
      activeTabPath: FILE,
      currentFile: FILE,
      currentContent: LOCAL,
      dirty: true,
      saving: false,
      saveError: null,
      conflictPending: true,
      splitFile: null,
      splitContent: "",
    } as never);

    useConflict.getState().openConflict({
      filePath: FILE,
      localContent: LOCAL,
      diskContent: DISK,
      detectedAt: Date.now(),
    });
  });

  afterEach(() => {
    cleanup();
    useConflict.getState().dismiss();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("dismiss 后 conflictPending 保持：自动保存不触发，手动保存成功后清除并恢复", async () => {
    render(<Host />);

    // ① 点击「继续编辑」：对话框关闭，基线同步为磁盘内容，但暂停标志有意保留
    fireEvent.click(screen.getByRole("button", { name: /继续编辑/ }));

    expect(useConflict.getState().conflict).toBeNull();
    expect(useWorkspace.getState().conflictPending).toBe(true);
    expect(useWorkspace.getState().openTabs[0].conflictPending).toBe(true);
    // 基线同步：后续手动保存不再被判为冲突
    expect(useWorkspace.getState().openTabs[0].diskContent).toBe(DISK);

    // ② 暂停期间：远超常规 2s 防抖与退避上限也不触发自动保存，
    //    即不自动替用户覆盖磁盘上的外部修改
    await act(async () => {
      vi.advanceTimersByTime(30000);
    });
    expect(writeTextFileMock).not.toHaveBeenCalled();

    // ③ 用户自己保存：基线已同步 → 静默落盘，不再弹覆盖确认
    await act(async () => {
      await useWorkspace.getState().saveCurrent({ interactive: true });
    });

    expect(askMock).not.toHaveBeenCalled();
    expect(writeTextFileMock).toHaveBeenCalledWith(FILE, LOCAL, { mustExist: true });
    const afterSave = useWorkspace.getState();
    expect(afterSave.conflictPending).toBe(false);
    expect(afterSave.openTabs[0].conflictPending).toBe(false);
    expect(afterSave.dirty).toBe(false);
    expect(afterSave.openTabs[0].diskContent).toBe(LOCAL);

    // ④ 冲突解决后自动保存恢复：继续编辑 → 2s 防抖后自动落盘
    await act(async () => {
      useWorkspace.getState().setContent(`${LOCAL}（再编辑）`);
    });
    await act(async () => {
      vi.advanceTimersByTime(1999);
    });
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(writeTextFileMock).toHaveBeenCalledTimes(2);
    expect(writeTextFileMock).toHaveBeenLastCalledWith(FILE, `${LOCAL}（再编辑）`, { mustExist: true });
    expect(useWorkspace.getState().conflictPending).toBe(false);
  });

  it("对照组：未同步基线时手动保存会先弹覆盖确认框（证明基线同步是静默保存的前提）", async () => {
    render(<Host />);

    // 不点「继续编辑」，基线仍是过期的 STALE_BASELINE
    await act(async () => {
      await useWorkspace.getState().saveCurrent({ interactive: true });
    });

    expect(askMock).toHaveBeenCalledTimes(1);
    expect(writeTextFileMock).toHaveBeenCalledWith(FILE, LOCAL, { mustExist: true });
  });

  it("dismiss 保持的暂停态在切换标签页后不丢失", async () => {
    useWorkspace.setState({
      openTabs: [
        makeTab(FILE, LOCAL, {
          diskContent: DISK,
          diskMtime: DISK_MTIME,
          conflictPending: true,
        }),
        makeTab(OTHER, "其他内容", { diskContent: "其他内容", diskMtime: DISK_MTIME }),
      ],
      activeTabPath: FILE,
      currentFile: FILE,
      conflictPending: true,
    } as never);

    // 切到无冲突的 tab：顶层镜像跟随活跃 tab 变为 false
    await act(async () => {
      useWorkspace.getState().switchTab(OTHER);
      vi.advanceTimersByTime(0);
    });
    expect(useWorkspace.getState().conflictPending).toBe(false);

    // 切回冲突 tab：暂停态从 tab 自身状态恢复，不因切换丢失
    await act(async () => {
      useWorkspace.getState().switchTab(FILE);
      vi.advanceTimersByTime(0);
    });
    expect(useWorkspace.getState().conflictPending).toBe(true);
    expect(useWorkspace.getState().openTabs[0].conflictPending).toBe(true);
  });
});

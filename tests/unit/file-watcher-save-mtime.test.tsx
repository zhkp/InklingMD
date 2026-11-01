// #362：watcher 自身写盘不误报（旧实现靠「保存后 2 秒忽略窗 + knownMtimes」，
// 重写后不再需要这两层：保存回执把写盘后的新身份直接登记成基线，stat 比对自然命中）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFileWatcher } from "../../src/lib/useFileWatcher";
import { useWorkspace } from "../../src/store/workspace";
import { useConflict } from "../../src/store/conflict";
import * as fs from "../../src/lib/fs";
import * as tauriCore from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn() }));

vi.mock("../../src/lib/fs", () => ({
  fileMtime: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  fileStat: vi.fn(),
  readDocument: vi.fn(),
}));

vi.mock("../../src/lib/dialogs", () => ({
  askConfirmation: vi.fn(),
  showMessage: vi.fn(),
}));

vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

const DOC = "/workspace/note.md";
const OPEN_STAT = { mtimeUs: 1_760_000_000_000_000, size: 9 };
const SAVED_STAT = { mtimeUs: 1_760_000_005_000_000, size: 15 };
const EXTERNAL_STAT = { mtimeUs: 1_760_000_090_000_000, size: 25 };

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const pollOnce = async () => {
  window.dispatchEvent(new Event("focus"));
  await flush();
  await flush();
  await flush();
};

const makeTab = (over: Record<string, unknown> = {}) => ({
  path: DOC,
  content: "# 标题\n\n正文",
  dirty: false,
  diskContent: "# 标题\n\n正文",
  diskStat: OPEN_STAT,
  diskMtime: OPEN_STAT.mtimeUs / 1000,
  deletedOnDisk: false,
  lastSavedAt: null,
  cursorPos: 0,
  scrollTop: 0,
  ...over,
});

describe("useFileWatcher 自身写盘不误报（#362 回执基线）", () => {
  beforeEach(() => {
    vi.mocked(tauriCore.isTauri).mockReturnValue(true);
    vi.mocked(fs.fileStat).mockResolvedValue(OPEN_STAT);
    vi.mocked(fs.readDocument).mockResolvedValue({ content: "# 磁盘", stat: OPEN_STAT });
    useWorkspace.setState({
      openTabs: [makeTab()],
      currentFile: DOC,
      activeTabPath: DOC,
      currentContent: "# 标题\n\n正文",
      dirty: false,
      lastSavedAt: null,
    });
    useConflict.setState({ conflict: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("自家保存后（回执已登记基线）：轮询不读盘、不弹窗", async () => {
    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    // 模拟一次保存完成：基线换成回执里的新身份
    useWorkspace.setState({
      openTabs: [makeTab({ diskStat: SAVED_STAT, lastSavedAt: Date.now() })],
      lastSavedAt: Date.now(),
    });
    vi.mocked(fs.fileStat).mockResolvedValue(SAVED_STAT);
    await pollOnce();

    expect(fs.readDocument).not.toHaveBeenCalled();
    expect(useConflict.getState().conflict).toBeNull();
    unmount();
  });

  it("自家保存之后又被外部修改：仍能识别（不会被回执基线吞掉）", async () => {
    const openConflictSpy = vi.fn();
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });
    useWorkspace.setState({
      openTabs: [makeTab({ content: "# 本地未保存", dirty: true })],
      currentContent: "# 本地未保存",
      dirty: true,
    });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    vi.mocked(fs.fileStat).mockResolvedValue(EXTERNAL_STAT);
    vi.mocked(fs.readDocument).mockResolvedValue({
      content: "# 外部程序写的内容",
      stat: EXTERNAL_STAT,
    });
    await pollOnce();

    expect(openConflictSpy).toHaveBeenCalledTimes(1);
    expect(openConflictSpy).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: DOC, diskContent: "# 外部程序写的内容" }),
    );
    unmount();
  });

  it("干净 tab 的外写：静默重载，不打扰用户", async () => {
    const reloadMock = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ reloadFile: reloadMock });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    vi.mocked(fs.fileStat).mockResolvedValue(EXTERNAL_STAT);
    await pollOnce();

    expect(reloadMock).toHaveBeenCalledWith(DOC);
    unmount();
  });
});

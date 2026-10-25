// #362 重写后的 watcher 契约
//
// 旧实现靠 `knownMtimes` + 2 秒忽略窗 + “干净就问是否重载”。重写后：
// - 判定只有一条：`fileStat` 与 tab.diskStat 比对（`verifyTabOnDisk`）；
// - 干净 tab 外部修改 → **静默重载**（不再弹确认，也就没有“确认框停留期间变脏”的竞态）；
// - dirty tab → 冲突对话框，localContent 取 flush 后的最新内容；
// - 后台 tab → 不弹窗，只置 conflictPending（切回时再问）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFileWatcher } from "../../src/lib/useFileWatcher";
import { useWorkspace } from "../../src/store/workspace";
import { useConflict } from "../../src/store/conflict";
import * as fs from "../../src/lib/fs";
import * as tauriCore from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
}));

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

import { flushAllMarkdownPublishers } from "../../src/components/Editor/markdown-publisher";

const DOC = "/workspace/note.md";
const OPEN_STAT = { mtimeUs: 1_760_000_000_000_000, size: 9 };
const EXTERNAL_STAT = { mtimeUs: 1_760_000_060_000_000, size: 21 };

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
  cursorPos: 12,
  scrollTop: 0,
  ...over,
});

describe("useFileWatcher（#362 重写后的判定）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriCore.isTauri).mockReturnValue(true);
    vi.mocked(fs.fileStat).mockResolvedValue(OPEN_STAT);
    vi.mocked(fs.readDocument).mockResolvedValue({
      content: "# 外部磁盘内容",
      stat: EXTERNAL_STAT,
    });
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

  it("基线未变：不读盘、不动内容", async () => {
    const reloadMock = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ reloadFile: reloadMock });
    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    expect(fs.fileStat).toHaveBeenCalled();
    expect(fs.readDocument).not.toHaveBeenCalled();
    expect(reloadMock).not.toHaveBeenCalled();
    unmount();
  });

  it("干净 tab 被外部修改：静默重载，不弹确认框", async () => {
    const reloadMock = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({ reloadFile: reloadMock });
    vi.mocked(fs.fileStat).mockResolvedValue(EXTERNAL_STAT);
    const openConflictSpy = vi.fn();
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    expect(reloadMock).toHaveBeenCalledWith(DOC);
    expect(openConflictSpy).not.toHaveBeenCalled();
    unmount();
  });

  it("dirty tab 被外部修改：冲突对话框的 localContent 取 flush 后的最新内容", async () => {
    const openConflictSpy = vi.fn();
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });
    useWorkspace.setState({
      dirty: true,
      openTabs: [makeTab({ dirty: true, content: "# 标题\n\n本地未保存" })],
    });
    vi.mocked(fs.fileStat).mockResolvedValue(EXTERNAL_STAT);

    const tail = "# 标题\n\n读盘期间输入的尾部";
    vi.mocked(flushAllMarkdownPublishers).mockImplementation(() => {
      useWorkspace.setState((s) => ({
        currentContent: tail,
        openTabs: s.openTabs.map((t) => (t.path === DOC ? { ...t, content: tail } : t)),
      }));
    });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    expect(openConflictSpy).toHaveBeenCalledTimes(1);
    expect(openConflictSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: DOC,
        diskContent: "# 外部磁盘内容",
        localContent: tail,
      }),
    );
    unmount();
  });

  it("后台 dirty tab 被外部修改：不弹窗，只置 conflictPending", async () => {
    const OTHER = "/workspace/other.md";
    const openConflictSpy = vi.fn();
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });
    useWorkspace.setState({
      openTabs: [
        makeTab({ path: OTHER, dirty: true, content: "# 后台未保存", diskContent: "# 后台" }),
        makeTab({ dirty: false }),
      ],
      currentFile: DOC,
      activeTabPath: DOC,
    });
    vi.mocked(fs.fileStat).mockImplementation(async (p: string) =>
      p === OTHER ? EXTERNAL_STAT : OPEN_STAT,
    );
    vi.mocked(fs.readDocument).mockImplementation(async (p: string) =>
      p === OTHER
        ? { content: "# 后台外部内容", stat: EXTERNAL_STAT }
        : { content: "# 标题\n\n正文", stat: OPEN_STAT },
    );

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    expect(openConflictSpy).not.toHaveBeenCalled();
    const other = useWorkspace.getState().openTabs.find((t) => t.path === OTHER);
    expect(other?.conflictPending).toBe(true);
    // 后台内容不被磁盘覆盖
    expect(other?.content).toBe("# 后台未保存");
    unmount();
  });

  it("stat 报 notFound：进删除态并清基线", async () => {
    vi.mocked(fs.fileStat).mockRejectedValue({ code: "notFound", message: "文件不存在" });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce();

    const tab = useWorkspace.getState().openTabs[0];
    expect(tab.deletedOnDisk).toBe(true);
    expect(tab.diskStat).toBeUndefined();
    unmount();
  });
});

// #170 useFileWatcher 重载决策竞态
//
// 背景：编辑器序列化有 150ms 防抖，store 的 dirty 只是镜像——用户刚输入但
// 尚未发布时 dirty=false。此时外部修改会走「干净→询问重载」，重载无条件
// 覆盖把刚输入的内容丢掉；确认框停留期间防抖发布同样使内容变脏，重载仍
// 无条件覆盖（旧编辑器销毁时 destroy→flush 还会写回旧序列化）。
//
// 修复后：决策前统一 flushAllMarkdownPublishers()，让 dirty 反映真实状态；
// 确认框通过后重载前复核 dirty，变脏则改走冲突对话框而非无条件重载。
//
// 验证：
// - 防抖未发布编辑：决策前 flush → 走冲突对话框（本地编辑不丢），不出现
//   干净的「重新加载」询问
// - 确认框停留期间发布：复核变脏 → 改走冲突对话框，不调用 reloadFile
// - 真正干净且无新编辑：确认后正常 reloadFile

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useFileWatcher } from "../../src/lib/useFileWatcher";
import { useWorkspace } from "../../src/store/workspace";
import { useConflict } from "../../src/store/conflict";
import * as fs from "../../src/lib/fs";
import * as dialogs from "../../src/lib/dialogs";
import * as tauriCore from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: vi.fn(),
}));

vi.mock("../../src/lib/fs", () => ({
  fileMtime: vi.fn(),
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
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
/** 首次打开文件时读到的磁盘 mtime */
const OPEN_MTIME = 1_760_000_000_000;
/** 外部程序改动后的 mtime：与基线相差一分钟，明显不是自家写盘 */
const EXTERNAL_MTIME = OPEN_MTIME + 60_000;

/** 让 check() 内部的 await 链全部落地（真实定时器，flush 微任务 + 宏任务） */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const pollOnce = async () => {
  window.dispatchEvent(new Event("focus"));
  await flush();
  await flush();
  await flush();
};

const makeTab = () => ({
  path: DOC,
  content: "# 标题\n\n正文",
  dirty: false,
  diskContent: "# 标题\n\n正文",
  diskMtime: OPEN_MTIME,
  deletedOnDisk: false,
  lastSavedAt: null,
  cursorPos: 12,
  scrollTop: 0,
});

describe("useFileWatcher 重载决策防丢编辑（issue #170）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriCore.isTauri).mockReturnValue(true);
    vi.mocked(dialogs.askConfirmation).mockResolvedValue(false);
    vi.mocked(fs.fileMtime).mockResolvedValue(OPEN_MTIME);
    vi.mocked(fs.readTextFile).mockResolvedValue("# 外部磁盘内容");

    useWorkspace.setState({
      openTabs: [makeTab()],
      currentFile: DOC,
      currentContent: "# 标题\n\n正文",
      dirty: false,
      lastSavedAt: null,
    });
    useConflict.setState({ conflict: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("防抖窗口内的编辑不再被『重新加载』询问吞掉：决策前 flush 转冲突对话框", async () => {
    const openConflictSpy = vi.fn();
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce(); // 首轮：注册已知 mtime 基线

    // 外部程序改写文件
    vi.mocked(fs.fileMtime).mockResolvedValue(EXTERNAL_MTIME);
    // 用户刚输入、仍在 150ms 防抖窗口：store 镜像仍干净，flush 才把最后编辑发布
    vi.mocked(flushAllMarkdownPublishers).mockImplementation(() => {
      useWorkspace.setState((s) => ({
        dirty: true,
        currentContent: "# 标题\n\n刚刚输入的正文",
        openTabs: s.openTabs.map((t) =>
          t.path === DOC ? { ...t, content: "# 标题\n\n刚刚输入的正文", dirty: true } : t,
        ),
      }));
    });

    await pollOnce();

    // 关键：不走干净的「重新加载」confirm（那会丢编辑），而是冲突对话框
    expect(dialogs.askConfirmation).not.toHaveBeenCalled();
    expect(openConflictSpy).toHaveBeenCalledTimes(1);
    expect(openConflictSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: DOC,
        diskContent: "# 外部磁盘内容",
      }),
    );
    unmount();
  });

  it("确认框停留期间防抖发布：重载前复核变脏，改走冲突对话框而非无条件重载", async () => {
    const openConflictSpy = vi.fn();
    const reloadMock = vi.fn().mockResolvedValue(undefined);
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });
    useWorkspace.setState({ reloadFile: reloadMock });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce(); // 注册基线

    vi.mocked(fs.fileMtime).mockResolvedValue(EXTERNAL_MTIME);
    // 决策时确实干净（flush 无副作用）→ 进入干净询问；用户停留在确认框期间
    // 150ms 防抖把编辑发布进 store（dirty 变 true），随后点「重新加载」
    vi.mocked(dialogs.askConfirmation).mockImplementation(async () => {
      useWorkspace.setState((s) => ({
        dirty: true,
        currentContent: "# 标题\n\n弹窗期间发布的编辑",
        openTabs: s.openTabs.map((t) =>
          t.path === DOC ? { ...t, content: "# 标题\n\n弹窗期间发布的编辑", dirty: true } : t,
        ),
      }));
      return true;
    });

    await pollOnce();

    expect(dialogs.askConfirmation).toHaveBeenCalledTimes(1);
    // 复核发现内容已变脏 → 不重载（否则无条件覆盖刚发布的编辑），改走冲突对话框
    expect(reloadMock).not.toHaveBeenCalled();
    expect(openConflictSpy).toHaveBeenCalledTimes(1);
    expect(openConflictSpy).toHaveBeenCalledWith(expect.objectContaining({ filePath: DOC }));
    unmount();
  });

  it("真正干净且确认框期间无新编辑：确认后正常 reloadFile", async () => {
    const openConflictSpy = vi.fn();
    const reloadMock = vi.fn().mockResolvedValue(undefined);
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });
    useWorkspace.setState({ reloadFile: reloadMock });

    const { unmount } = renderHook(() => useFileWatcher());
    await pollOnce(); // 注册基线

    vi.mocked(fs.fileMtime).mockResolvedValue(EXTERNAL_MTIME);
    vi.mocked(dialogs.askConfirmation).mockResolvedValue(true); // 干净重载，无新编辑

    await pollOnce();

    expect(dialogs.askConfirmation).toHaveBeenCalledTimes(1);
    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect(reloadMock).toHaveBeenCalledWith(DOC);
    expect(openConflictSpy).not.toHaveBeenCalled();
    unmount();
  });
});

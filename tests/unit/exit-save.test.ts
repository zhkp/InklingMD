import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { onCloseRequestedMock, destroyMock, messageMock, flushMock } = vi.hoisted(() => ({
  onCloseRequestedMock: vi.fn(),
  destroyMock: vi.fn(),
  messageMock: vi.fn(),
  flushMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: onCloseRequestedMock, destroy: destroyMock }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: messageMock, ask: vi.fn() }));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: flushMock,
}));
// 退出/会话底座在单测里不写真实 app data 目录
vi.mock("../../src/lib/exit-session", () => ({
  flushAllDrafts: vi.fn(async () => undefined),
  hasRecoverableDraft: () => false,
  markCleanExit: vi.fn(async () => true),
  markUncleanExit: vi.fn(async () => true),
  journalHealth: "healthy",
  lastDraftWriteOk: new Map(),
}));

import { useExitHandler } from "../../src/lib/useExitHandler";
import { useWorkspace } from "../../src/store/workspace";

type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;
let closeHandler: CloseHandler;

const RETRY = "重试保存";
const DISCARD = "放弃并退出";
const CANCEL = "取消退出";

function tab(path: string): OpenTab {
  return {
    path,
    content: `${path} modified`,
    diskContent: path,
    dirty: true,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
  };
}

function installState(tabs = [tab("/one.md"), tab("/two.md")]) {
  const switchTab = vi.fn((path: string) => {
    const target = useWorkspace.getState().openTabs.find((item) => item.path === path)!;
    useWorkspace.setState({
      activeTabPath: path,
      currentFile: path,
      currentContent: target.content,
      dirty: target.dirty,
    });
  });
  /** 按 path 保存：默认成功并清 dirty（用 path 参数，不再依赖「活跃 tab」） */
  const saveTab = vi.fn(async (path: string) => {
    useWorkspace.setState((state) => {
      const openTabs = state.openTabs.map((item) =>
        item.path === path ? { ...item, dirty: false } : item,
      );
      const active = openTabs.find((item) => item.path === state.activeTabPath);
      return { openTabs, dirty: active?.dirty ?? false };
    });
  });
  useWorkspace.setState({
    openTabs: tabs,
    activeTabPath: tabs[0]?.path ?? null,
    currentFile: tabs[0]?.path ?? null,
    currentContent: tabs[0]?.content ?? "",
    dirty: tabs[0]?.dirty ?? false,
    switchTab,
    saveTab,
    waitForSaves: async () => undefined,
    isSaveInFlight: () => false,
  });
  return { switchTab, saveTab };
}

describe("real window close handler", () => {
  beforeEach(() => {
    onCloseRequestedMock.mockReset().mockImplementation(async (handler: CloseHandler) => {
      closeHandler = handler;
      return vi.fn();
    });
    destroyMock.mockReset().mockResolvedValue(undefined);
    messageMock.mockReset().mockResolvedValue(CANCEL);
    flushMock.mockReset();
  });

  async function mount() {
    renderHook(() => useExitHandler());
    await vi.waitFor(() => expect(onCloseRequestedMock).toHaveBeenCalled());
  }

  it("flushes and saves every dirty tab before destroying the window", async () => {
    const { saveTab } = installState();
    await mount();
    const preventDefault = vi.fn();
    await act(() => closeHandler({ preventDefault }));

    expect(preventDefault).toHaveBeenCalled();
    expect(flushMock).toHaveBeenCalled();
    expect(saveTab).toHaveBeenCalledTimes(2);
    expect(saveTab).toHaveBeenCalledWith("/one.md", { interactive: true });
    expect(saveTab).toHaveBeenCalledWith("/two.md", { interactive: true });
    expect(useWorkspace.getState().openTabs.every((item) => !item.dirty)).toBe(true);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("offers 重试/放弃/取消 when a save rejects, and still exits on 放弃", async () => {
    const { saveTab } = installState();
    saveTab.mockRejectedValueOnce(new Error("first failed"));
    messageMock.mockResolvedValue(DISCARD);
    await mount();
    await act(() => closeHandler({ preventDefault: vi.fn() }));

    // 第一个 tab 失败 + 第二个成功 → 仍有未解决项 → 三选一
    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("未能保存"),
      expect.objectContaining({ buttons: expect.objectContaining({ no: DISCARD }) }),
    );
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("取消退出时恢复原活跃 tab 且不 destroy", async () => {
    const { switchTab } = installState();
    // saveTab 成功但 tab 仍 dirty（模拟「保存写不进磁盘」）
    useWorkspace.setState({ saveTab: vi.fn(async () => undefined) });
    messageMock.mockResolvedValue(CANCEL);
    await mount();
    await act(() => closeHandler({ preventDefault: vi.fn() }));

    expect(messageMock).toHaveBeenCalledWith(
      expect.stringContaining("未能保存"),
      expect.any(Object),
    );
    expect(switchTab).toHaveBeenLastCalledWith("/one.md");
    expect(destroyMock).not.toHaveBeenCalled();
  });

  it("第 3 轮仍失败时不再询问，直接进「放弃」分支", async () => {
    installState();
    useWorkspace.setState({ saveTab: vi.fn(async () => undefined) });
    // 前两次都选「重试」，第三次不再询问（attempt > 2）→ 直接走放弃确认
    messageMock
      .mockResolvedValueOnce(RETRY)
      .mockResolvedValueOnce(RETRY)
      .mockResolvedValue(DISCARD);
    await mount();
    await act(() => closeHandler({ preventDefault: vi.fn() }));

    const asked = messageMock.mock.calls.filter((c) => String(c[0]).includes("未能保存"));
    expect(asked).toHaveLength(2);
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("确认对话框抛错时按取消处理，绝不 destroy", async () => {
    installState();
    useWorkspace.setState({ saveTab: vi.fn(async () => undefined) });
    messageMock.mockRejectedValue(new Error("dialog unavailable"));
    await mount();
    await act(() => closeHandler({ preventDefault: vi.fn() }));

    expect(destroyMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().activeTabPath).toBe("/one.md");
  });

  it("ignores a second close request while the first save is pending", async () => {
    const { saveTab } = installState([tab("/one.md")]);
    let release!: () => void;
    saveTab.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            useWorkspace.setState({
              openTabs: [{ ...useWorkspace.getState().openTabs[0], dirty: false }],
              dirty: false,
            });
            resolve();
          };
        }),
    );
    await mount();
    const first = closeHandler({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(saveTab).toHaveBeenCalledTimes(1));
    await closeHandler({ preventDefault: vi.fn() });
    expect(saveTab).toHaveBeenCalledTimes(1);
    expect(destroyMock).not.toHaveBeenCalled();
    release();
    await first;
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("flushes publishers on beforeunload", async () => {
    installState([]);
    await mount();
    window.dispatchEvent(new Event("beforeunload"));
    expect(flushMock).toHaveBeenCalledTimes(1);
  });
});

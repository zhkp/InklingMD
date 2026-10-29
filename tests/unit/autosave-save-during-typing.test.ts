// #364 复审阻塞 1 / 2：两件此前「说了但没被证明」的事
//
// ① 订阅键里的 rev 是**必需**的：dirty 恒为 1、只有 rev 变化时，2s 防抖必须被重置。
// ② Ctrl+S 保存期间继续输入，保存落定后必须**再排一次**自动保存
//    （此前只有调度器路径成立，交互路径落定后不再排任何定时器 —— 输入既不落盘也不再自动保存）。

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { OpenTab } from "../../src/store/workspace";

const { saveDocumentMock } = vi.hoisted(() => ({ saveDocumentMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), message: vi.fn(), ask: vi.fn() }));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));
vi.mock("../../src/lib/fs", () => ({
  saveDocument: saveDocumentMock,
  readDocument: vi.fn(),
  readTextFile: vi.fn(async () => "基线"),
  writeTextFile: vi.fn(),
  fileStat: vi.fn(async () => ({ mtimeUs: 1_000, size: 3 })),
  fileMtime: vi.fn(async () => 1),
}));

import { useAutoSave } from "../../src/lib/useAutoSave";
import { useWorkspace } from "../../src/store/workspace";
import { pathRevs } from "../../src/store/workspace/shared";

const DOC = "/w/doc.md";

function tab(extra: Partial<OpenTab> = {}): OpenTab {
  return {
    path: DOC,
    content: "v1",
    dirty: true,
    lastSavedAt: null,
    diskContent: "基线",
    diskStat: { mtimeUs: 1_000, size: 2 },
    diskMtime: 1,
    cursorPos: null,
    scrollTop: null,
    ...extra,
  };
}

/** 每个用例都要拿到「真实的 saveTab」（beforeEach 会把它换掉） */
const realSaveTab = useWorkspace.getState().saveTab;

beforeEach(() => {
  vi.useFakeTimers();
  pathRevs.clear();
  saveDocumentMock.mockReset();
  useWorkspace.setState({
    openTabs: [tab()],
    activeTabPath: DOC,
    currentFile: DOC,
    currentContent: "v1",
    dirty: true,
    saving: false,
    saveError: null,
    conflictPending: false,
    saveTab: realSaveTab,
  } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#364 调度键与「保存期间继续输入」", () => {
  it("dirty 恒为 1、只有 rev 变化时，防抖必须被重置（删掉 rev 会红）", async () => {
    const saveTabMock = vi.fn(async () => undefined);
    useWorkspace.setState({ saveTab: saveTabMock as never });
    const { rerender } = renderHook(() => useAutoSave());
    rerender();

    // 第一段：1.5s 后又有输入（rev 1），dirty 保持 true
    await act(async () => {
      vi.advanceTimersByTime(1_500);
    });
    await act(async () => {
      useWorkspace.getState().setContent("v1-again");
      rerender();
    });

    // 若订阅键里没有 rev，第一次的 2s 定时器会在 2.0s 触发 → 此刻已写一次
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(saveTabMock).not.toHaveBeenCalled();

    // rev 之后重新计满 2s → 写一次
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(saveTabMock).toHaveBeenCalledTimes(1);
  });

  it("Ctrl+S 保存期间继续输入：落定后必须再排一次自动保存", async () => {
    const saveTabMock = vi.fn(async () => undefined);
    useWorkspace.setState({ saveTab: saveTabMock as never });

    // 起点：dirty 且**保存中**（Ctrl+S 在途）。调度器此刻跳过，因此没有任何定时器。
    await act(async () => {
      useWorkspace.setState({
        openTabs: [tab({ dirty: true, saving: true, content: "v1-typed" })],
        dirty: true,
        saving: true,
      } as never);
    });
    const { rerender } = renderHook(() => useAutoSave());
    rerender();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(saveTabMock).not.toHaveBeenCalled();

    // 保存落定：saving=false + lastSavedAt 前进，但内容仍是新的（dirty 保持 true、rev 不变）
    await act(async () => {
      useWorkspace.setState((state) => ({
        openTabs: state.openTabs.map((t) =>
          t.path === DOC ? { ...t, saving: false, lastSavedAt: Date.now() } : t,
        ),
        saving: false,
      }));
      rerender();
    });

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });

    // 没有「保存完成」这个订阅信号时，这里会是 0 —— 用户的输入既不落盘也不再自动保存
    expect(saveTabMock).toHaveBeenCalledTimes(1);
    expect(saveTabMock).toHaveBeenCalledWith(DOC, { interactive: false });
  });
});

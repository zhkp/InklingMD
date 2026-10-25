import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { writeTextFileMock, fileMtimeMock, flushMock } = vi.hoisted(() => ({
  writeTextFileMock: vi.fn(),
  fileMtimeMock: vi.fn(),
  flushMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), save: vi.fn() }));
vi.mock("../../src/lib/fs", () => ({
  fileMtime: fileMtimeMock,
  readTextFile: vi.fn(),
  writeTextFile: writeTextFileMock,
  // #362：保存走 save_document（写盘回执），委派给 writeTextFile mock 保持既有断言
  saveDocument: async (path: string, content: string) => {
    await writeTextFileMock(path, content, { mustExist: true });
    return {
      kind: "written",
      stat: { mtimeUs: 1_700_000_000_000_000, size: 1 },
      foreignWrite: false,
    };
  },
}));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: flushMock,
}));

import { useAutoSave } from "../../src/lib/useAutoSave";
import { useWorkspace } from "../../src/store/workspace";

describe("useAutoSave failure retry integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    writeTextFileMock.mockReset()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    fileMtimeMock.mockReset().mockResolvedValue(1_000);
    flushMock.mockReset();
    useWorkspace.setState({
      openTabs: [{
        path: "/docs/retry.md",
        content: "edited",
        dirty: true,
        isUntitled: false,
        diskContent: "original",
        diskMtime: 1_000,
        lastSavedAt: null,
        cursorPos: null,
        scrollTop: null,
      }],
      activeTabPath: "/docs/retry.md",
      currentFile: "/docs/retry.md",
      currentContent: "edited",
      dirty: true,
      saving: false,
      saveError: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("automatically retries a failed write after exponential backoff and clears the error", async () => {
    renderHook(() => useAutoSave());

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState()).toMatchObject({ dirty: true, saveError: "disk full" });

    await act(async () => { await vi.advanceTimersByTimeAsync(3_999); });
    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(writeTextFileMock).toHaveBeenCalledTimes(2);
    expect(useWorkspace.getState()).toMatchObject({ dirty: false, saveError: null });
    expect(flushMock).toHaveBeenCalled();
  });
});

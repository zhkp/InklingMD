import { describe, it, expect, vi, beforeEach } from "vitest";
import { useWorkspace } from "../../src/store/workspace";
import * as fs from "../../src/lib/fs";

vi.mock("../../src/lib/fs", () => ({
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
  resolveImageSrc: vi.fn((p: string) => p),
  // #362：保存走 save_document（写盘回执）。本用例断言的是「保存抛错后的状态机」，
  // 这里把回执实现成「调用 writeTextFile 并透传其拒绝」，观察面与旧实现一致
  saveDocument: async (path: string, content: string, options: { expected?: unknown } = {}) => {
    await vi.mocked(fs.writeTextFile)(path, content, options.expected ? { mustExist: true } : undefined);
    return {
      kind: "written",
      stat: { mtimeUs: 1_700_000_000_000_000, size: 1 },
      foreignWrite: false,
    };
  },
}));

describe("Issue #91: Save re-entrancy guard and exception handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspace.setState({
      openTabs: [
        {
          path: "/test/doc.md",
          dirty: true,
          content: "# Hello Modified",
          isUntitled: false,
          lastSavedAt: Date.now(),
          cursorPos: 0,
          scrollTop: 0,
        },
      ],
      activeTabPath: "/test/doc.md",
      currentFile: "/test/doc.md",
      currentContent: "# Hello Modified",
      dirty: true,
      saving: false,
      saveError: null,
    });
  });

  it("should prevent re-entrant save calls when saving is already in progress", async () => {
    let resolveWrite: () => void = () => {};
    const writePromise = new Promise<void>((res) => {
      resolveWrite = res;
    });

    vi.mocked(fs.writeTextFile).mockImplementationOnce(() => writePromise);

    // 发起第一次保存
    const savePromise1 = useWorkspace.getState().saveCurrent();
    expect(useWorkspace.getState().saving).toBe(true);

    // 在保存未完成时发起第二次保存
    const savePromise2 = useWorkspace.getState().saveCurrent();

    // 第二次应该被直接拦截返回，不会再次调用 writeTextFile
    await savePromise2;
    expect(vi.mocked(fs.writeTextFile)).toHaveBeenCalledTimes(1);

    // 完成第一次写入
    resolveWrite();
    await savePromise1;

    expect(useWorkspace.getState().saving).toBe(false);
    expect(useWorkspace.getState().saveError).toBeNull();
  });

  it("should release saving flag when save operation throws an exception", async () => {
    vi.mocked(fs.writeTextFile).mockRejectedValueOnce(new Error("Disk I/O error"));

    await useWorkspace.getState().saveCurrent();

    expect(useWorkspace.getState().saving).toBe(false);
    expect(useWorkspace.getState().saveError).toContain("Disk I/O error");
  });
});

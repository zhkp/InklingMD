import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/fs", () => ({
  readTextFile: vi.fn().mockResolvedValue("reloaded disk content"),
  // #362：reloadFile / ensureTab 走成对读取
  readDocument: vi.fn().mockResolvedValue({
    content: "reloaded disk content",
    stat: { mtimeUs: 1_700_000_000_000_000, size: 20 },
  }),
  fileStat: vi.fn().mockResolvedValue({ mtimeUs: 1_700_000_000_000_000, size: 20 }),
  writeTextFile: vi.fn().mockResolvedValue(undefined),
  exists: vi.fn().mockResolvedValue(true),
  watchFileChanges: vi.fn(),
  resolveImageSrc: vi.fn(),
}));

import { useWorkspace } from "../../src/store/workspace";

describe("Tabs Store: reloadFile & openingFiles 健壮性测试", () => {
  it("reloadFile 成功后更新内容并递增 revision 字段", async () => {
    useWorkspace.setState({
      openTabs: [
        {
          path: "/test/doc.md",
          content: "initial",
          dirty: true,
          isUntitled: false,
          lastSavedAt: null,
          cursorPos: null,
          scrollTop: null,
          diskContent: "initial",
          revision: 0,
        },
      ],
      activeTabPath: "/test/doc.md",
      currentContent: "initial",
      dirty: true,
    });

    const store = useWorkspace.getState();
    expect(store.openTabs[0].revision).toBe(0);

    // 调用 reloadFile
    await store.reloadFile("/test/doc.md");

    const updated = useWorkspace.getState();
    expect(updated.openTabs[0].content).toBe("reloaded disk content");
    expect(updated.openTabs[0].diskContent).toBe("reloaded disk content");
    expect(updated.openTabs[0].dirty).toBe(false);
    expect(updated.openTabs[0].revision).toBe(1);
    expect(updated.currentContent).toBe("reloaded disk content");
    expect(updated.dirty).toBe(false);
  });

  it("openingFiles 在打开文件失败时通过 finally 清理", async () => {
    useWorkspace.setState({
      openingFiles: new Set(["/invalid/path.md"]),
    });

    // 验证 openingFiles 初始状态
    expect(useWorkspace.getState().openingFiles.has("/invalid/path.md")).toBe(true);

    try {
      await useWorkspace.getState().openFile("/non_existent_file_xxx_12345.md");
    } catch {
      // 异常预期
    }

    // 确保被清理
    expect(useWorkspace.getState().openingFiles.has("/non_existent_file_xxx_12345.md")).toBe(false);
  });
});

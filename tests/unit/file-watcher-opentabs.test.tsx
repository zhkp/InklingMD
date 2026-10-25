import { describe, it, expect, vi, beforeEach } from "vitest";
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
  // #362：switchTab 核验改用 fileStat + 成对读取
  fileStat: vi.fn(),
  readDocument: vi.fn(),
}));

describe("useFileWatcher & deletedOnDisk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tauriCore.isTauri).mockReturnValue(true);

    useWorkspace.setState({
      openTabs: [
        {
          path: "/workspace/doc1.md",
          content: "# Doc 1",
          dirty: false,
          diskMtime: 1000,
          deletedOnDisk: false,
          lastSavedAt: null,
          cursorPos: 0,
          scrollTop: 0,
        },
        {
          path: "/workspace/doc2.md",
          content: "# Doc 2",
          dirty: false,
          diskMtime: 1000,
          deletedOnDisk: false,
          lastSavedAt: null,
          cursorPos: 0,
          scrollTop: 0,
        },
      ],
      currentFile: "/workspace/doc1.md",
      currentContent: "# Doc 1",
      dirty: false,
    });
    useConflict.setState({ conflict: null });
  });

  it("marks tab as deletedOnDisk when fileMtime throws error", async () => {
    vi.mocked(fs.fileMtime).mockImplementation(async (path: string) => {
      if (path === "/workspace/doc2.md") {
        throw new Error("File not found");
      }
      return 1000;
    });

    renderHook(() => useFileWatcher());

    // Trigger focus to execute check
    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      const tabs = useWorkspace.getState().openTabs;
      const tab2 = tabs.find((t) => t.path === "/workspace/doc2.md");
      expect(tab2?.deletedOnDisk).toBe(true);
      const tab1 = tabs.find((t) => t.path === "/workspace/doc1.md");
      expect(tab1?.deletedOnDisk).toBe(false);
    });
  });

  it("switchTab verifies file presence on disk", async () => {
    // #362：删除态只由结构化 notFound 触发（其他 IO 错误只报错、不标删除）
    vi.mocked(fs.fileStat).mockRejectedValueOnce({ code: "notFound", message: "文件不存在" });

    useWorkspace.getState().switchTab("/workspace/doc2.md");

    await vi.waitFor(() => {
      const tab2 = useWorkspace.getState().openTabs.find((t) => t.path === "/workspace/doc2.md");
      expect(tab2?.deletedOnDisk).toBe(true);
      // 删除态必须清掉 stat 基线，否则下一轮会被当成"没变"
      expect(tab2?.diskStat).toBeUndefined();
    });
  });

  it("#124 盲区1：后台 tab 被外部修改且本地无改动 → switchTab 走 reloadFile 以磁盘为准", async () => {
    useWorkspace.setState({
      openTabs: [
        {
          path: "/workspace/doc1.md",
          content: "# Doc 1",
          dirty: false,
          diskMtime: 1000,
          diskContent: "# Doc 1",
          deletedOnDisk: false,
          lastSavedAt: null,
          cursorPos: 0,
          scrollTop: 0,
        },
        {
          path: "/workspace/doc2.md",
          content: "# Doc 2（旧缓存）",
          dirty: false,
          diskMtime: 1000,
          diskContent: "# Doc 2（旧缓存）",
          deletedOnDisk: false,
          lastSavedAt: null,
          cursorPos: 0,
          scrollTop: 0,
        },
      ],
      currentFile: "/workspace/doc1.md",
      currentContent: "# Doc 1",
      dirty: false,
    });
    // 磁盘上 doc2 的 mtime 变了（外部修改），非 ENOENT
    vi.mocked(fs.fileStat).mockResolvedValue({ mtimeUs: 3_000_000, size: 26 });
    vi.mocked(fs.readDocument).mockResolvedValue({
      content: "# Doc 2（磁盘最新）",
      stat: { mtimeUs: 3_000_000, size: 26 },
    });

    useWorkspace.getState().switchTab("/workspace/doc2.md");

    await vi.waitFor(() => {
      const tab2 = useWorkspace.getState().openTabs.find((t) => t.path === "/workspace/doc2.md");
      // 磁盘内容为准：缓存被重载覆盖，dirty 清空、基线同步为磁盘
      expect(tab2?.content).toBe("# Doc 2（磁盘最新）");
      expect(tab2?.diskContent).toBe("# Doc 2（磁盘最新）");
      expect(tab2?.dirty).toBe(false);
      expect(useWorkspace.getState().currentContent).toBe("# Doc 2（磁盘最新）");
    });
  });

  it("#124 盲区1：后台 tab 被外部修改且有本地改动 → switchTab 置 conflictPending 并调冲突流程", async () => {
    useWorkspace.setState({
      openTabs: [
        {
          path: "/workspace/doc1.md",
          content: "# Doc 1",
          dirty: false,
          diskMtime: 1000,
          diskContent: "# Doc 1",
          deletedOnDisk: false,
          lastSavedAt: null,
          cursorPos: 0,
          scrollTop: 0,
        },
        {
          path: "/workspace/doc2.md",
          content: "# Doc 2（本地未保存改动）",
          dirty: true,
          diskMtime: 1000,
          diskContent: "# Doc 2（磁盘基线）",
          deletedOnDisk: false,
          lastSavedAt: null,
          cursorPos: 0,
          scrollTop: 0,
        },
      ],
      currentFile: "/workspace/doc1.md",
      currentContent: "# Doc 1",
      dirty: false,
    });
    const openConflictSpy = vi.fn();
    useConflict.setState({ conflict: null, openConflict: openConflictSpy });
    // 磁盘 mtime 变化 + 成对读取磁盘最新内容
    vi.mocked(fs.fileStat).mockResolvedValue({ mtimeUs: 3_000_000, size: 26 });
    vi.mocked(fs.readDocument).mockResolvedValue({
      content: "# Doc 2（磁盘最新）",
      stat: { mtimeUs: 3_000_000, size: 26 },
    });

    useWorkspace.getState().switchTab("/workspace/doc2.md");

    await vi.waitFor(() => {
      // 本地有改动 → 不静默重载，置 conflictPending 让状态栏可见
      const tab2 = useWorkspace.getState().openTabs.find((t) => t.path === "/workspace/doc2.md");
      expect(useWorkspace.getState().conflictPending).toBe(true);
      expect(tab2?.conflictPending).toBe(true);
      // 并调起冲突对话框，携带本地内容与磁盘内容
      expect(openConflictSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          filePath: "/workspace/doc2.md",
          localContent: "# Doc 2（本地未保存改动）",
          diskContent: "# Doc 2（磁盘最新）",
        }),
      );
    });
  });
});

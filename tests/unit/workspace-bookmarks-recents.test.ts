import { describe, it, expect, beforeEach } from "vitest";
import { useWorkspace } from "../../src/store/workspace";
import {
  loadBookmarks,
  persistBookmarks,
  loadRecentFiles,
  persistRecentFiles,
  pushRecent,
  parentDir,
  rebasePathPrefix,
} from "../../src/store/workspace/shared";

describe("Workspace Bookmarks & Recents Slices", () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspace.setState({
      bookmarks: [],
      recentFiles: [],
    });
  });

  describe("shared workspace utils", () => {
    it("pushRecent should prepend item and deduplicate", () => {
      const list = ["/a.md", "/b.md", "/c.md"];
      const updated = pushRecent(list, "/b.md");
      expect(updated).toEqual(["/b.md", "/a.md", "/c.md"]);
    });

    it("pushRecent should limit to 10 items", () => {
      const list = Array.from({ length: 10 }, (_, i) => `/${i}.md`);
      const updated = pushRecent(list, "/new.md");
      expect(updated.length).toBe(10);
      expect(updated[0]).toBe("/new.md");
      expect(updated.includes("/9.md")).toBe(false);
    });

    it("parentDir should return parent directory correctly", () => {
      expect(parentDir("/foo/bar/baz.md")).toBe("/foo/bar");
      expect(parentDir("C:\\foo\\bar\\baz.md")).toBe("C:\\foo\\bar");
      expect(parentDir("/file.md")).toBe("/");
      expect(parentDir("simple.md")).toBe("simple.md");
    });

    it("rebasePathPrefix should rewrite path when within directory", () => {
      expect(rebasePathPrefix("/old/dir/file.md", "/old/dir", "/new/dir")).toBe("/new/dir/file.md");
      expect(rebasePathPrefix("/other/file.md", "/old/dir", "/new/dir")).toBe("/other/file.md");
    });

    it("loadBookmarks & persistBookmarks should sync with localStorage", () => {
      persistBookmarks(["/b1.md", "/b2.md"]);
      expect(loadBookmarks()).toEqual(["/b1.md", "/b2.md"]);
    });

    it("loadRecentFiles & persistRecentFiles should sync with localStorage", () => {
      persistRecentFiles(["/r1.md", "/r2.md"]);
      expect(loadRecentFiles()).toEqual(["/r1.md", "/r2.md"]);
    });
  });

  describe("BookmarksSlice in store", () => {
    it("toggleBookmark should add and remove bookmark", () => {
      const store = useWorkspace.getState();
      expect(store.isBookmarked("/test/doc.md")).toBe(false);

      // 切换添加
      store.toggleBookmark("/test/doc.md");
      expect(useWorkspace.getState().isBookmarked("/test/doc.md")).toBe(true);
      expect(useWorkspace.getState().bookmarks).toEqual(["/test/doc.md"]);

      // 切换移除
      useWorkspace.getState().toggleBookmark("/test/doc.md");
      expect(useWorkspace.getState().isBookmarked("/test/doc.md")).toBe(false);
      expect(useWorkspace.getState().bookmarks).toEqual([]);
    });
  });

  describe("RecentsSlice in store（#370 评审：草稿虚拟路径不得入最近列表）", () => {
    it("激活未命名草稿不写入 recentFiles（草稿关闭后不会留下打不开的幽灵项）", async () => {
      localStorage.clear();
      useWorkspace.setState({
        openTabs: [
          {
            path: "untitled-1",
            content: "# 草稿",
            dirty: true,
            isUntitled: true,
            lastSavedAt: null,
            cursorPos: null,
            scrollTop: null,
          },
        ],
        activeTabPath: "untitled-1",
        currentFile: "untitled-1",
        currentContent: "# 草稿",
        recentFiles: [],
        rootPath: "/ws",
        workspaceMode: "file",
      } as never);

      // 全局搜索点击草稿命中走 openFile，verify 它不污染最近列表
      await useWorkspace.getState().openFile("untitled-1");

      expect(useWorkspace.getState().recentFiles).not.toContain("untitled-1");
      expect(useWorkspace.getState().activeTabPath).toBe("untitled-1");
      // 持久化层同样不得出现虚拟路径
      expect(loadRecentFiles()).not.toContain("untitled-1");
    });

    it("对照组：激活真实文件仍会写入 recentFiles（证明上面的断言不是恒真）", async () => {
      localStorage.clear();
      useWorkspace.setState({
        openTabs: [
          {
            path: "/ws/real.md",
            content: "# 真实文件",
            dirty: false,
            isUntitled: false,
            lastSavedAt: null,
            cursorPos: null,
            scrollTop: null,
          },
        ],
        activeTabPath: null,
        currentFile: null,
        currentContent: "",
        recentFiles: [],
        rootPath: "/ws",
        workspaceMode: "folder",
      } as never);

      await useWorkspace.getState().openFile("/ws/real.md");

      expect(useWorkspace.getState().recentFiles).toEqual(["/ws/real.md"]);
      expect(loadRecentFiles()).toEqual(["/ws/real.md"]);
    });
  });
});

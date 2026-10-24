// issue #366 / #363：删除或重命名文件夹时，最近文件与书签里该文件夹下的子路径
// 必须一并清理 / 迁移（此前最近文件只处理同路径，书签用不带大小写口径的前缀匹配）。
import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "../../src/store/workspace";

beforeEach(() => {
  useWorkspace.setState({
    openTabs: [],
    activeTabPath: null,
    currentFile: null,
    splitFile: null,
    recentFiles: ["/w/notes/a.md", "/w/notes/sub/b.md", "/w/notes-old/c.md", "/w/other.md"],
    bookmarks: ["/w/notes/a.md", "/w/notes-old/c.md", "/w/other.md"],
    rootPath: "/w",
    workspaceMode: null,
  });
});

describe("#366 文件夹删除 / 重命名时同步最近文件与书签", () => {
  it("删除文件夹：移除其下所有最近文件与书签，同前缀兄弟目录不受影响", () => {
    useWorkspace.getState().onFileDeleted("/w/notes");
    const s = useWorkspace.getState();
    expect(s.recentFiles).toEqual(["/w/notes-old/c.md", "/w/other.md"]);
    expect(s.bookmarks).toEqual(["/w/notes-old/c.md", "/w/other.md"]);
  });

  it("重命名文件夹：其下最近文件与书签迁到新路径，同前缀兄弟目录不受影响", () => {
    useWorkspace.getState().onFileRenamed("/w/notes", "/w/docs");
    const s = useWorkspace.getState();
    expect(s.recentFiles).toEqual(["/w/docs/a.md", "/w/docs/sub/b.md", "/w/notes-old/c.md", "/w/other.md"]);
    expect(s.bookmarks).toEqual(["/w/docs/a.md", "/w/notes-old/c.md", "/w/other.md"]);
  });

  it("Windows 路径大小写不同也视为同一文件夹", () => {
    useWorkspace.setState({
      recentFiles: ["C:\\Work\\Notes\\a.md", "C:\\Work\\other.md"],
      bookmarks: ["C:\\Work\\Notes\\a.md"],
    });
    useWorkspace.getState().onFileDeleted("c:\\work\\notes");
    const s = useWorkspace.getState();
    expect(s.recentFiles).toEqual(["C:\\Work\\other.md"]);
    expect(s.bookmarks).toEqual([]);
  });
});

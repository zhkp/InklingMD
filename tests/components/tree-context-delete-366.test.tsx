// issue #366：文件树删除文件夹时，确认框一次说清对已打开文件的影响——
// 打开中的子文件 tab 会关闭、未保存修改会先备份到「可恢复文件」、备份空间
// 不足时明确警告会丢失；删除成功后展开「可恢复文件」区块，便于找回。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpenTab } from "../../src/store/workspace";

const h = vi.hoisted(() => ({
  askConfirmation: vi.fn(),
  showMessage: vi.fn(),
  deletePath: vi.fn(),
  writable: true,
}));

vi.mock("../../src/lib/dialogs", () => ({
  askConfirmation: (...a: unknown[]) => h.askConfirmation(...a),
  showMessage: (...a: unknown[]) => h.showMessage(...a),
}));
vi.mock("../../src/lib/fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/fs")>()),
  deletePath: (...a: unknown[]) => h.deletePath(...a),
}));
vi.mock("../../src/store/workspace/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/store/workspace/shared")>()),
  probeSnapshotStorageHealth: () => ({ sizeChars: 0, entryCount: 0, writable: h.writable }),
}));

import { TreeContextMenu } from "../../src/components/Sidebar/TreeContextMenu";
import { useWorkspace } from "../../src/store/workspace";
import { useUI } from "../../src/store/ui";

const tab = (path: string, dirty = false): OpenTab => ({
  path,
  content: `content of ${path}`,
  dirty,
  lastSavedAt: null,
  cursorPos: null,
  scrollTop: null,
});

function renderMenu(node: { name: string; path: string; is_dir: boolean }) {
  const onClose = vi.fn();
  render(<TreeContextMenu payload={{ node: { ...node, children: [] }, x: 0, y: 0 }} onClose={onClose} />);
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  return onClose;
}

const onFileDeleted = vi.fn();

beforeEach(() => {
  h.askConfirmation.mockReset().mockResolvedValue(true);
  h.showMessage.mockReset().mockResolvedValue(undefined);
  h.deletePath.mockReset().mockResolvedValue(undefined);
  h.writable = true;
  onFileDeleted.mockReset();
  useWorkspace.setState({
    rootPath: "/w",
    openTabs: [
      tab("/w/notes/a.md", true),
      tab("/w/notes/sub/b.md"),
      tab("/w/notes/sub/c.md", true),
      // 同前缀的兄弟目录不属于被删文件夹
      tab("/w/notes-old/x.md", true),
      tab("/w/other.md", true),
    ],
    onFileDeleted,
  });
  useUI.setState((s) => ({ sectionExpanded: { ...s.sectionExpanded, snapshots: false } }));
});

describe("#366 删除文件夹的确认与反馈", () => {
  it("只弹一次确认，准确说明打开中的文件会关闭、未保存修改会备份（不误算同前缀兄弟目录）", async () => {
    renderMenu({ name: "notes", path: "/w/notes", is_dir: true });
    await waitFor(() => expect(h.deletePath).toHaveBeenCalledWith("/w/notes"));

    expect(h.askConfirmation).toHaveBeenCalledTimes(1);
    const msg = h.askConfirmation.mock.calls[0][0] as string;
    expect(msg).toContain("确定删除文件夹「notes」及其所有内容吗？");
    expect(msg).toContain("3 个文件正在编辑器中打开");
    expect(msg).toContain("2 个有未保存的修改");
    expect(msg).toContain("a.md");
    expect(msg).toContain("c.md");
    expect(msg).toContain("可恢复文件");
    expect(msg).not.toContain("x.md");
    expect(msg).not.toContain("丢失");
    expect(onFileDeleted).toHaveBeenCalledWith("/w/notes", { alsoBackup: ["/w/notes/a.md", "/w/notes/sub/c.md"] });
  });

  it("删除成功且有未保存文件：展开「可恢复文件」区块", async () => {
    renderMenu({ name: "notes", path: "/w/notes", is_dir: true });
    await waitFor(() => expect(onFileDeleted).toHaveBeenCalled());
    expect(useUI.getState().sectionExpanded.snapshots).toBe(true);
  });

  it("备份存储空间不足：确认框明确警告未保存修改会永久丢失", async () => {
    h.writable = false;
    renderMenu({ name: "notes", path: "/w/notes", is_dir: true });
    await waitFor(() => expect(h.askConfirmation).toHaveBeenCalled());
    const msg = h.askConfirmation.mock.calls[0][0] as string;
    expect(msg).toContain("备份存储空间不足");
    expect(msg).toContain("永久丢失");
  });

  it("用户取消：不删除、不关闭 tab", async () => {
    h.askConfirmation.mockResolvedValue(false);
    const onClose = renderMenu({ name: "notes", path: "/w/notes", is_dir: true });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(h.deletePath).not.toHaveBeenCalled();
    expect(onFileDeleted).not.toHaveBeenCalled();
  });

  it("文件夹内没有打开的文件：只问是否删除，不附加多余说明", async () => {
    renderMenu({ name: "empty", path: "/w/empty", is_dir: true });
    await waitFor(() => expect(h.deletePath).toHaveBeenCalled());
    expect(h.askConfirmation).toHaveBeenCalledTimes(1);
    expect(h.askConfirmation.mock.calls[0][0]).toBe("确定删除文件夹「empty」及其所有内容吗？");
    expect(useUI.getState().sectionExpanded.snapshots).toBe(false);
  });

  it("删除单个未保存文件：一次确认，说明会备份到「可恢复文件」", async () => {
    renderMenu({ name: "other.md", path: "/w/other.md", is_dir: false });
    await waitFor(() => expect(h.deletePath).toHaveBeenCalledWith("/w/other.md"));
    expect(h.askConfirmation).toHaveBeenCalledTimes(1);
    const msg = h.askConfirmation.mock.calls[0][0] as string;
    expect(msg).toContain("确定删除「other.md」吗？");
    expect(msg).toContain("「other.md」有未保存的修改");
    expect(msg).toContain("可恢复文件");
    expect(useUI.getState().sectionExpanded.snapshots).toBe(true);
  });
});

describe("#366 确认框停留期间自动保存（真实应用 E2E 发现的竞态）", () => {
  it("提示时未保存、确认前已被自动保存：仍按确认框的承诺备份到「可恢复文件」", async () => {
    const { loadDeletedSnapshots } = await import("../../src/store/workspace/shared");
    const realOnFileDeleted = useWorkspace.getInitialState().onFileDeleted;
    useWorkspace.setState({
      openTabs: [tab("/w/notes/a.md", true), tab("/w/other.md")],
      activeTabPath: "/w/other.md",
      onFileDeleted: realOnFileDeleted,
    });
    // 原生确认框不阻塞 JS：用户阅读期间 2s 自动保存把 a.md 存成干净状态
    h.askConfirmation.mockImplementation(async () => {
      useWorkspace.setState((s) => ({
        openTabs: s.openTabs.map((t) => ({ ...t, dirty: false })),
      }));
      return true;
    });

    renderMenu({ name: "notes", path: "/w/notes", is_dir: true });
    await waitFor(() => expect(h.deletePath).toHaveBeenCalled());
    await waitFor(() =>
      expect(loadDeletedSnapshots().map((s) => s.path)).toContain("/w/notes/a.md"),
    );
    expect(loadDeletedSnapshots().find((s) => s.path === "/w/notes/a.md")?.content).toBe(
      "content of /w/notes/a.md",
    );
    expect(useWorkspace.getState().openTabs.map((t) => t.path)).toEqual(["/w/other.md"]);
  });
});

// 文件冲突对话框组件测试
// 覆盖：三选项渲染、差异视图切换、另存副本调用链、丢弃重载、继续编辑

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { writeTextFileMock, listDirMock, reloadFileMock, alertMock } = vi.hoisted(() => ({
  writeTextFileMock: vi.fn(),
  listDirMock: vi.fn(),
  reloadFileMock: vi.fn(),
  alertMock: vi.fn(),
}));

vi.mock("../../src/lib/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/fs")>();
  return {
    ...actual,
    writeTextFile: writeTextFileMock,
    listDir: listDirMock,
  };
});

import { ConflictDialog } from "../../src/components/FileConflict/ConflictDialog";
import { useConflict } from "../../src/store/conflict";
import { useWorkspace } from "../../src/store/workspace";

describe("ConflictDialog", () => {
  beforeEach(() => {
    vi.stubGlobal("alert", alertMock);
    listDirMock.mockResolvedValue({
      name: "docs",
      path: "/docs",
      is_dir: true,
      children: [],
    });
    writeTextFileMock.mockResolvedValue(undefined);
    reloadFileMock.mockResolvedValue(undefined);
    useWorkspace.setState({ reloadFile: reloadFileMock });
  });

  afterEach(() => {
    cleanup();
    useConflict.getState().dismiss();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function openConflict() {
    useConflict.getState().openConflict({
      filePath: "/docs/note.md",
      localContent: "本地版本",
      diskContent: "磁盘版本",
      detectedAt: Date.now(),
    });
  }

  it("无冲突时不渲染", () => {
    const { container } = render(<ConflictDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("展示四选项与未保存警告", () => {
    openConflict();
    render(<ConflictDialog />);
    expect(screen.getByText("文件已被外部修改")).toBeTruthy();
    expect(screen.getByText("未保存的修改")).toBeTruthy();
    expect(screen.getByText("保留本地并另存副本（.backup.md）")).toBeTruthy();
    expect(screen.getByText("查看差异对比")).toBeTruthy();
    expect(screen.getByText("丢弃本地修改，重载磁盘")).toBeTruthy();
    expect(screen.getByText(/继续编辑/)).toBeTruthy();
  });

  it("另存副本：写入 backup 文件并重载磁盘", async () => {
    openConflict();
    render(<ConflictDialog />);
    fireEvent.click(screen.getByText("保留本地并另存副本（.backup.md）"));
    await waitFor(() => {
      expect(writeTextFileMock).toHaveBeenCalledWith("/docs/note.backup.md", "本地版本");
      expect(reloadFileMock).toHaveBeenCalledWith("/docs/note.md");
      expect(alertMock).toHaveBeenCalledWith(expect.stringContaining("note.backup.md"));
    });
    expect(useConflict.getState().conflict).toBeNull();
  });

  it("backup 路径被占用时递增编号", async () => {
    listDirMock.mockResolvedValue({
      name: "docs",
      path: "/docs",
      is_dir: true,
      children: [{ name: "note.backup.md", path: "/docs/note.backup.md", is_dir: false, children: [] }],
    });
    openConflict();
    render(<ConflictDialog />);
    fireEvent.click(screen.getByText("保留本地并另存副本（.backup.md）"));
    await waitFor(() => {
      expect(writeTextFileMock).toHaveBeenCalledWith("/docs/note.backup.2.md", "本地版本");
    });
  });

  it("丢弃本地修改：仅重载磁盘", async () => {
    openConflict();
    render(<ConflictDialog />);
    fireEvent.click(screen.getByText("丢弃本地修改，重载磁盘"));
    await waitFor(() => {
      expect(writeTextFileMock).not.toHaveBeenCalled();
      expect(reloadFileMock).toHaveBeenCalledWith("/docs/note.md");
    });
    expect(useConflict.getState().conflict).toBeNull();
  });

  it("查看差异：显示行级 diff 与差异计数", () => {
    openConflict();
    render(<ConflictDialog />);
    fireEvent.click(screen.getByText("查看差异对比"));
    expect(screen.getByText("差异对比 — note.md")).toBeTruthy();
    expect(screen.getByText("2 行差异")).toBeTruthy();
    expect(screen.getByText("本地版本")).toBeTruthy();
    expect(screen.getByText("磁盘版本")).toBeTruthy();
    expect(screen.getByText("− 本地（未保存）")).toBeTruthy();
    expect(screen.getByText("+ 磁盘（外部修改）")).toBeTruthy();
  });

  it("差异视图返回选项后可继续选择", async () => {
    openConflict();
    render(<ConflictDialog />);
    fireEvent.click(screen.getByText("查看差异对比"));
    fireEvent.click(screen.getByRole("button", { name: "返回选项" }));
    expect(screen.getByText("文件已被外部修改")).toBeTruthy();
    fireEvent.click(screen.getByText("丢弃本地修改，重载磁盘"));
    await waitFor(() => {
      expect(reloadFileMock).toHaveBeenCalled();
    });
  });

  it("继续编辑：关闭对话框并更新 tab 的 diskContent 基线", () => {
    const setTabDiskContentMock = vi.fn();
    useWorkspace.setState({ setTabDiskContent: setTabDiskContentMock });
    openConflict();
    render(<ConflictDialog />);
    fireEvent.click(screen.getByRole("button", { name: /继续编辑/ }));
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(reloadFileMock).not.toHaveBeenCalled();
    expect(setTabDiskContentMock).toHaveBeenCalledWith("/docs/note.md", "磁盘版本");
    expect(useConflict.getState().conflict).toBeNull();
  });

  it("打开时焦点移入主操作按钮（另存副本）", () => {
    openConflict();
    render(<ConflictDialog />);
    const primary = screen.getByText("保留本地并另存副本（.backup.md）") as HTMLButtonElement;
    expect(document.activeElement).toBe(primary);
  });

  it("Esc 等价「继续编辑」：同步磁盘基线并关闭，不触发写入/重载", () => {
    const setTabDiskContentMock = vi.fn();
    useWorkspace.setState({ setTabDiskContent: setTabDiskContentMock });
    openConflict();
    render(<ConflictDialog />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(reloadFileMock).not.toHaveBeenCalled();
    expect(setTabDiskContentMock).toHaveBeenCalledWith("/docs/note.md", "磁盘版本");
    expect(useConflict.getState().conflict).toBeNull();
  });

  it("差异视图 Esc 先退回选项，再 Esc 才关闭", () => {
    const setTabDiskContentMock = vi.fn();
    useWorkspace.setState({ setTabDiskContent: setTabDiskContentMock });
    openConflict();
    render(<ConflictDialog />);
    fireEvent.click(screen.getByText("查看差异对比"));
    expect(screen.getByText("差异对比 — note.md")).toBeTruthy();

    // 差异视图中第一次 Esc：退回选项（对话框保持打开）
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("文件已被外部修改")).toBeTruthy();
    expect(useConflict.getState().conflict).not.toBeNull();

    // 回到主视图后 Esc：等价「继续编辑」
    fireEvent.keyDown(window, { key: "Escape" });
    expect(setTabDiskContentMock).toHaveBeenCalledWith("/docs/note.md", "磁盘版本");
    expect(useConflict.getState().conflict).toBeNull();
  });
});

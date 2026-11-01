// 冲突「保留本地并另存副本」的换行保真测试（issue #368 评审 P2）
//
// localContent 是编辑器内部 LF 表示；CRLF 文件发生外部冲突后，用户选
// 「保留本地并另存副本」时，副本必须按原文件换行风格还原写盘——否则
// 备份副本变成 LF，与原文件对比时再次产生整文件 EOL diff（#368 在冲突
// 旁路复发）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const {
  readTextFileMock,
  writeTextFileMock,
  fileMtimeMock,
  listDirMock,
  isTauriMock,
  messageMock,
} = vi.hoisted(() => ({
  readTextFileMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  fileMtimeMock: vi.fn(),
  listDirMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
  messageMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  ask: vi.fn(),
  message: messageMock,
}));

vi.mock("../../src/lib/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/fs")>();
  return {
    ...actual,
    readTextFile: readTextFileMock,
    writeTextFile: writeTextFileMock,
    fileMtime: fileMtimeMock,
    listDir: listDirMock,
  };
});

vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { ConflictDialog } from "../../src/components/FileConflict/ConflictDialog";
import { useConflict } from "../../src/store/conflict";
import { useWorkspace } from "../../src/store/workspace";

const FILE = "/docs/crlf-note.md";
/** 本地未保存内容（编辑器内部 LF 表示） */
const LOCAL = "# 标题\n\n本地编辑过的段落。\n";

describe("冲突另存副本的换行保真（#368 评审 P2）", () => {
  beforeEach(() => {
    isTauriMock.mockReturnValue(true);
    readTextFileMock.mockResolvedValue("# 磁盘外部版本\n");
    writeTextFileMock.mockResolvedValue(undefined);
    fileMtimeMock.mockResolvedValue(2000);
    listDirMock.mockResolvedValue({
      name: "docs",
      path: "/docs",
      is_dir: true,
      children: [],
    });
    messageMock.mockResolvedValue(undefined);

    useWorkspace.setState({
      openTabs: [
        {
          path: FILE,
          content: LOCAL,
          dirty: true,
          lastSavedAt: null,
          cursorPos: null,
          scrollTop: null,
          isUntitled: false,
          diskContent: "# 旧基线\r\n",
          diskMtime: 1000,
          conflictPending: true,
          eol: "crlf" as const,
        },
      ],
      activeTabPath: FILE,
      currentFile: FILE,
      currentContent: LOCAL,
      dirty: true,
      conflictPending: true,
      saving: false,
      saveError: null,
    } as never);

    useConflict.getState().openConflict({
      filePath: FILE,
      localContent: LOCAL,
      diskContent: "# 磁盘外部版本\n",
      detectedAt: Date.now(),
    });
  });

  afterEach(() => {
    cleanup();
    useConflict.getState().dismiss();
    vi.clearAllMocks();
  });

  it("CRLF 文件冲突另存副本：副本字节仍为 CRLF（LF 本地内容按原风格还原）", async () => {
    render(<ConflictDialog />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保留本地并另存副本/ }));
    });

    expect(writeTextFileMock).toHaveBeenCalledTimes(1);
    const [backupPath, written] = writeTextFileMock.mock.calls[0];
    expect(backupPath).toMatch(/crlf-note\.backup\.md$/);
    // 副本内容 = 本地内容按 crlf 还原后的字节
    expect(written).toBe("# 标题\r\n\r\n本地编辑过的段落。\r\n");
    // 不允许残留孤立 LF
    expect(written).not.toMatch(/(?<!\r)\n/);
  });

  it("LF 文件（无 eol 元数据 / eol=lf）冲突另存副本：不引入 CR", async () => {
    useWorkspace.setState({
      openTabs: [
        {
          path: FILE,
          content: LOCAL,
          dirty: true,
          lastSavedAt: null,
          cursorPos: null,
          scrollTop: null,
          isUntitled: false,
          conflictPending: true,
          eol: "lf" as const,
        },
      ],
      activeTabPath: FILE,
    } as never);

    render(<ConflictDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保留本地并另存副本/ }));
    });

    const [, written] = writeTextFileMock.mock.calls[0];
    expect(written).toBe(LOCAL);
  });

  it("差异视图：CRLF 磁盘内容与 LF 本地内容只差一行 → 显示「2 行差异」而非整篇", async () => {
    // 本地 3 行（LF），磁盘 3 行（CRLF），仅第 3 行不同。
    // 未归一换行时每行尾的 \r 会让全部行不等，changed 变成 6（3 remove + 3 add）
    useConflict.getState().dismiss();
    useConflict.getState().openConflict({
      filePath: FILE,
      localContent: "# 标题\n\n本地编辑过的段落。\n",
      diskContent: "# 标题\r\n\r\n磁盘外部版本\r\n",
      detectedAt: Date.now(),
    });

    render(<ConflictDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /查看差异对比/ }));
    });

    // UI 计数口径 = 非 equal 条目数（1 条 remove + 1 条 add）
    expect(screen.getByText("2 行差异")).toBeTruthy();
  });

  it("差异视图：两侧仅换行符不同 → 0 行差异 + 「内容一致」文案可达", async () => {
    useConflict.getState().dismiss();
    useConflict.getState().openConflict({
      filePath: FILE,
      localContent: "a\nb\n",
      diskContent: "a\r\nb\r\n",
      detectedAt: Date.now(),
    });

    render(<ConflictDialog />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /查看差异对比/ }));
    });

    expect(
      screen.getByText("内容一致（仅换行符或末尾空行差异）"),
    ).toBeTruthy();
  });
});

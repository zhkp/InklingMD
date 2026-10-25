// #123 数据安全：删除文件时快照写入失败 → 用户可见告警 + 存储健康探测
//
// 验证：
// - onFileDeleted 中 persistDeletedSnapshot 返回 false（localStorage 配额溢出）时，
//   中止静默、向用户展示「恢复备份写入失败」告警（showMessage error 弹窗）
// - probeSnapshotStorageHealth 在 setItem 抛异常时返回 writable:false

import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspace } from "../../src/store/workspace";
import {
  persistDeletedSnapshot,
  probeSnapshotStorageHealth,
  clearDeletedSnapshots,
} from "../../src/store/workspace/shared";
import { showMessage } from "../../src/lib/dialogs";

const { listDirMock } = vi.hoisted(() => ({
  listDirMock: vi.fn(),
}));

vi.mock("../../src/lib/fs", () => ({
  listDir: listDirMock,
}));

vi.mock("../../src/lib/dialogs", () => ({
  showMessage: vi.fn(),
  askConfirmation: vi.fn(),
}));

import type { OpenTab } from "../../src/store/workspace";

function tab(path: string, content: string, dirty: boolean): OpenTab {
  return {
    path,
    content,
    dirty,
    lastSavedAt: dirty ? null : Date.now(),
    diskContent: "# 磁盘基线",
    cursorPos: null,
    scrollTop: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  clearDeletedSnapshots();
  listDirMock.mockReset();
  listDirMock.mockResolvedValue([]);
  vi.mocked(showMessage).mockResolvedValue(undefined as never);
  useWorkspace.setState({
    rootPath: "/workspace",
    workspaceMode: "folder",
    openTabs: [],
    activeTabPath: null,
    currentFile: null,
    currentContent: "",
    dirty: false,
    saving: false,
    saveError: null,
    recentFiles: [],
    bookmarks: [],
    expandedDirs: new Set(),
    loadedDirs: new Set(),
    loadingDirs: new Set(),
    directoryErrors: new Map(),
  });
});

describe("#123 删除快照写入失败的用户可见告警", () => {
  it("persistDeletedSnapshot 返回 false 时，onFileDeleted 向用户展示错误告警而非静默", () => {
    useWorkspace.setState({
      openTabs: [tab("/workspace/note.md", "# 未保存内容", true)],
      activeTabPath: "/workspace/note.md",
      currentFile: "/workspace/note.md",
      currentContent: "# 未保存内容",
      dirty: true,
    });
    // 模拟 localStorage 配额溢出：writeJSON / persistDeletedSnapshot 全部写入失败
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    useWorkspace.getState().onFileDeleted("/workspace/note.md");

    // #362：快照写失败不再关 tab（那会连内容一起丢掉）——保留 tab 并标记已删除，
    // 让用户能把内容另存出去
    const tabs = useWorkspace.getState().openTabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].deletedOnDisk).toBe(true);
    expect(tabs[0].dirty).toBe(true);
    expect(showMessage).toHaveBeenCalledWith(
      expect.stringContaining("未能创建恢复备份"),
      expect.objectContaining({ kind: "error", title: "恢复备份写入失败" }),
    );
  });

  it("快照写入成功时不做任何告警", () => {
    useWorkspace.setState({
      openTabs: [tab("/workspace/note.md", "# 未保存内容", true)],
      activeTabPath: "/workspace/note.md",
      currentFile: "/workspace/note.md",
      currentContent: "# 未保存内容",
      dirty: true,
    });

    useWorkspace.getState().onFileDeleted("/workspace/note.md");

    expect(showMessage).not.toHaveBeenCalled();
    expect(persistDeletedSnapshot("/workspace/next.md", "x")).toBe(true);
  });
});

describe("#123 probeSnapshotStorageHealth 健康探测", () => {
  it("setItem 抛异常时返回 writable:false（供 DeletedSnapshots 面板展示不可写告警）", () => {
    useWorkspace.setState({
      openTabs: [tab("/workspace/a.md", "# 未保存内容", true)],
      activeTabPath: "/workspace/a.md",
      dirty: true,
    });
    useWorkspace.getState().onFileDeleted("/workspace/a.md"); // 先落一份快照

    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError", "QuotaExceededError");
    });

    const health = probeSnapshotStorageHealth();
    expect(health.writable).toBe(false);
    expect(health.entryCount).toBe(1);
  });

  it("存储正常时返回 writable:true 并估算占用字符数", () => {
    expect(persistDeletedSnapshot("/workspace/a.md", "你好世界")).toBe(true);
    const health = probeSnapshotStorageHealth();
    expect(health.writable).toBe(true);
    expect(health.entryCount).toBe(1);
    expect(health.sizeChars).toBeGreaterThan(0);
  });
});
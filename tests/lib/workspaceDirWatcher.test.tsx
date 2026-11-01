// 工作区目录外部变更监听单测（issue #369）
//
// 覆盖对象：src/lib/workspaceDirWatcher.ts
// - directoryEntriesChanged：条目签名集对比（名称 + 是否目录）；
// - scanExpandedDirs：注入 mock listDir 驱动一轮扫描，锁定「只报变化的已展开
//   目录」「loadingDirs 让路」「listDir 失败跳过」「陈旧路径跳过」「非 folder
//   模式不扫描」；
// - useWorkspaceDirWatcher：3 秒轮询 / focus 即时检查驱动 refreshTree 出口。

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWorkspace, type WorkspaceState } from "../../src/store/workspace";
import {
  directoryEntriesChanged,
  scanExpandedDirs,
  useWorkspaceDirWatcher,
} from "../../src/lib/workspaceDirWatcher";
import * as fsApi from "../../src/lib/fs";
import type { FileNode } from "../../src/lib/fs";

function node(path: string, name: string, isDir: boolean, children: FileNode[] = []): FileNode {
  return { name, path, is_dir: isDir, children };
}

function seedWorkspace(overrides: Partial<WorkspaceState> = {}) {
  useWorkspace.setState({
    rootPath: "/ws",
    workspaceMode: "folder",
    tree: node("/ws", "ws", true, [
      node("/ws/notes", "notes", true),
      node("/ws/a.md", "a.md", false),
    ]),
    expandedDirs: new Set(["/ws"]),
    loadedDirs: new Set(["/ws"]),
    loadingDirs: new Set(),
    workspaceIndexVersion: 0,
    ...overrides,
  });
}

/** 根目录最新磁盘枚举（children 与 store 树同构） */
function rootListing(children: FileNode[]): FileNode {
  return node("/ws", "ws", true, children);
}

describe("directoryEntriesChanged（条目签名集对比）", () => {
  it("条目集相同（顺序无关）→ 无变化", () => {
    const a = [node("/ws/a.md", "a.md", false), node("/ws/notes", "notes", true)];
    const b = [node("/ws/notes", "notes", true), node("/ws/a.md", "a.md", false)];
    expect(directoryEntriesChanged(a, b)).toBe(false);
  });

  it("新增 / 删除条目 → 有变化", () => {
    const base = [node("/ws/a.md", "a.md", false)];
    const added = [node("/ws/a.md", "a.md", false), node("/ws/new.md", "new.md", false)];
    expect(directoryEntriesChanged(base, added)).toBe(true);
    expect(directoryEntriesChanged(added, base)).toBe(true);
  });

  it("同名但类型变化（文件 ↔ 目录）→ 有变化", () => {
    const file = [node("/ws/x", "x", false)];
    const dir = [node("/ws/x", "x", true)];
    expect(directoryEntriesChanged(file, dir)).toBe(true);
  });
});

describe("scanExpandedDirs（一轮扫描）", () => {
  let listDirMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listDirMock = vi.fn();
    seedWorkspace();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("无外部变更：不报告任何目录", async () => {
    listDirMock.mockResolvedValue(
      rootListing([node("/ws/notes", "notes", true), node("/ws/a.md", "a.md", false)]),
    );
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual([]);
    expect(listDirMock).toHaveBeenCalledTimes(1);
  });

  it("外部新增文件：报告所在目录", async () => {
    listDirMock.mockResolvedValue(
      rootListing([
        node("/ws/notes", "notes", true),
        node("/ws/a.md", "a.md", false),
        node("/ws/external-new.md", "external-new.md", false),
      ]),
    );
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual(["/ws"]);
  });

  it("外部删除文件：报告所在目录", async () => {
    listDirMock.mockResolvedValue(rootListing([node("/ws/notes", "notes", true)]));
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual(["/ws"]);
  });

  it("外部重命名（名称变化）：报告所在目录", async () => {
    listDirMock.mockResolvedValue(
      rootListing([node("/ws/notes", "notes", true), node("/ws/renamed.md", "renamed.md", false)]),
    );
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual(["/ws"]);
  });

  it("只扫已展开目录：未展开的子目录不产生 listDir 调用", async () => {
    listDirMock.mockResolvedValue(rootListing([node("/ws/a.md", "a.md", false)]));
    await scanExpandedDirs(listDirMock, useWorkspace.getState);
    expect(listDirMock).toHaveBeenCalledTimes(1);
    expect(listDirMock).toHaveBeenCalledWith("/ws");
  });

  it("工作区根被折叠（expandedDirs 不含根）时仍扫描根：根级外部变更不漏", async () => {
    // 根行可折叠；折叠后 expandedDirs 不再含 rootPath，但 Quick Open 索引
    // 仍须随根级外部变更失效，因此根必须始终参与浅扫
    seedWorkspace({ expandedDirs: new Set() });
    listDirMock.mockResolvedValue(
      rootListing([
        node("/ws/notes", "notes", true),
        node("/ws/a.md", "a.md", false),
        node("/ws/root-collapsed-new.md", "root-collapsed-new.md", false),
      ]),
    );

    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual(["/ws"]);
    expect(listDirMock).toHaveBeenCalledWith("/ws");
  });

  it("根折叠且无外部变更：不报告（不会因强制扫描根而产生误刷新）", async () => {
    seedWorkspace({ expandedDirs: new Set() });
    listDirMock.mockResolvedValue(
      rootListing([node("/ws/notes", "notes", true), node("/ws/a.md", "a.md", false)]),
    );
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual([]);
  });

  it("枚举在途（loadingDirs）的目录本轮让路", async () => {
    seedWorkspace({ loadingDirs: new Set(["/ws"]) });
    listDirMock.mockResolvedValue(
      rootListing([node("/ws/external-new.md", "external-new.md", false)]),
    );
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual([]);
    expect(listDirMock).not.toHaveBeenCalled();
  });

  it("listDir 失败（目录被删/无权限）静默跳过，不报告", async () => {
    listDirMock.mockRejectedValue(new Error("路径不存在"));
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual([]);
  });

  it("expandedDirs 中的陈旧路径（不在当前树）不扫描", async () => {
    seedWorkspace({ expandedDirs: new Set(["/ws", "/other-workspace/docs"]) });
    listDirMock.mockResolvedValue(
      rootListing([node("/ws/notes", "notes", true), node("/ws/a.md", "a.md", false)]),
    );
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual([]);
    expect(listDirMock).toHaveBeenCalledTimes(1);
    expect(listDirMock).not.toHaveBeenCalledWith("/other-workspace/docs");
  });

  it("非 folder 模式（单文件 / 未打开）不扫描", async () => {
    seedWorkspace({ workspaceMode: "file" });
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual([]);
    seedWorkspace({ rootPath: null, workspaceMode: null, tree: null });
    await expect(scanExpandedDirs(listDirMock, useWorkspace.getState)).resolves.toEqual([]);
    expect(listDirMock).not.toHaveBeenCalled();
  });
});

describe("useWorkspaceDirWatcher（轮询驱动）", () => {
  let listDirSpy: MockInstance;

  beforeEach(() => {
    // hook 内部直接调用模块导入的 listDir，须 spy 真实模块（每个用例重打，
    // setup.ts 的 restoreAllMocks 会在用例间拆掉上一个）
    listDirSpy = vi.spyOn(fsApi, "listDir");
    seedWorkspace();
    // refreshTree 出口替换为 spy：断言「变更目录走统一出口」，不实际枚举合并
    useWorkspace.setState({
      refreshTree: vi.fn().mockResolvedValue(undefined),
    } as Partial<WorkspaceState> as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("3 秒轮询发现外部新增文件后调用 refreshTree(变更目录)", async () => {
    vi.useFakeTimers();
    listDirSpy.mockResolvedValue(
      rootListing([
        node("/ws/notes", "notes", true),
        node("/ws/a.md", "a.md", false),
        node("/ws/agent-output.md", "agent-output.md", false),
      ]),
    );

    renderHook(() => useWorkspaceDirWatcher());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    const refreshTree = useWorkspace.getState().refreshTree as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(refreshTree).toHaveBeenCalledWith("/ws");
  });

  it("无外部变更不触发 refreshTree（不产生重复渲染）", async () => {
    vi.useFakeTimers();
    listDirSpy.mockResolvedValue(
      rootListing([node("/ws/notes", "notes", true), node("/ws/a.md", "a.md", false)]),
    );

    renderHook(() => useWorkspaceDirWatcher());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    const refreshTree = useWorkspace.getState().refreshTree as unknown as ReturnType<
      typeof vi.fn
    >;
    expect(refreshTree).not.toHaveBeenCalled();
  });

  it("窗口重新聚焦立即触发检查（不必等满 3 秒）", async () => {
    listDirSpy.mockResolvedValue(
      rootListing([
        node("/ws/notes", "notes", true),
        node("/ws/a.md", "a.md", false),
        node("/ws/focus-detected.md", "focus-detected.md", false),
      ]),
    );

    renderHook(() => useWorkspaceDirWatcher());
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    const refreshTree = useWorkspace.getState().refreshTree as unknown as ReturnType<
      typeof vi.fn
    >;
    await vi.waitFor(() => {
      expect(refreshTree).toHaveBeenCalledWith("/ws");
    });
  });

  it("卸载后停止轮询", async () => {
    vi.useFakeTimers();
    listDirSpy.mockResolvedValue(
      rootListing([node("/ws/notes", "notes", true), node("/ws/a.md", "a.md", false)]),
    );

    const { unmount } = renderHook(() => useWorkspaceDirWatcher());
    unmount();
    const callsBefore = listDirSpy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(listDirSpy.mock.calls.length).toBe(callsBefore);
  });
});

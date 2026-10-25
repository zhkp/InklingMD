// 侧边栏文件树测试
// 覆盖默认折叠、按需加载、单一动作监听器和大目录窗口化渲染

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { readTextFileMock } = vi.hoisted(() => ({
  readTextFileMock: vi.fn(),
}));

vi.mock("../../src/lib/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/fs")>();
  return {
    ...actual,
    readTextFile: readTextFileMock,
    // #362：打开文件走成对读取；内容仍由 readTextFile mock 驱动（断言不变），
    // stat 固定值——本文件只验证文件树 DOM / 滚动保持与错误提示。
    readDocument: async (path: string) => ({
      content: await readTextFileMock(path),
      stat: { mtimeUs: 1_700_000_000_000_000, size: 1 },
    }),
  };
});

import { Sidebar } from "../../src/components/Sidebar/Sidebar";
import { useWorkspace } from "../../src/store/workspace";
import type { FileNode } from "../../src/lib/fs";

const originalActions = {
  toggleDirExpanded: useWorkspace.getState().toggleDirExpanded,
  setDirExpanded: useWorkspace.getState().setDirExpanded,
  loadDirectory: useWorkspace.getState().loadDirectory,
  openFile: useWorkspace.getState().openFile,
  refreshTree: useWorkspace.getState().refreshTree,
};

function dir(path: string, children: FileNode[] = []): FileNode {
  return {
    name: path.split("/").pop() ?? path,
    path,
    is_dir: true,
    children,
  };
}

function file(path: string): FileNode {
  return {
    name: path.split("/").pop() ?? path,
    path,
    is_dir: false,
    children: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  readTextFileMock.mockReset();
  readTextFileMock.mockResolvedValue("# test");
  useWorkspace.setState({
    ...originalActions,
    rootPath: "/workspace",
    workspaceMode: "folder",
    tree: null,
    workspaceLoading: false,
    openingFiles: new Set(),
    fileOpenErrors: new Map(),
    expandedDirs: new Set(["/workspace"]),
    loadedDirs: new Set(["/workspace"]),
    loadingDirs: new Set(),
    directoryErrors: new Map(),
    openTabs: [],
    activeTabPath: null,
    currentFile: null,
    currentContent: "",
    dirty: false,
    saving: false,
    saveError: null,
    lastSavedAt: null,
    currentHeadingSlug: null,
    splitFile: null,
    splitContent: "",
    recentFiles: [],
    bookmarks: [],
  });
});

afterEach(() => cleanup());

describe("Sidebar 文件树", () => {
  it("普通目录默认折叠，点击后才显示已加载的后代", () => {
    useWorkspace.setState({
      tree: dir("/workspace", [
        dir("/workspace/docs", [file("/workspace/docs/readme.md")]),
      ]),
      loadedDirs: new Set(["/workspace", "/workspace/docs"]),
    });
    render(<Sidebar />);

    expect(screen.queryByText("readme.md")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("docs"));
    expect(screen.getByText("readme.md")).toBeInTheDocument();
  });

  it("首次展开目录只触发该目录的按需加载", () => {
    const loadDirectory = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({
      tree: dir("/workspace", [dir("/workspace/docs")]),
      loadDirectory,
    });
    render(<Sidebar />);

    fireEvent.click(screen.getByText("docs"));

    expect(loadDirectory).toHaveBeenCalledTimes(1);
    expect(loadDirectory).toHaveBeenCalledWith("/workspace/docs");
  });

  it("大量根目录文件只渲染视口附近的行", () => {
    const files = Array.from({ length: 10_000 }, (_, index) =>
      file(`/workspace/note-${index}.md`),
    );
    useWorkspace.setState({ tree: dir("/workspace", files) });

    const { container } = render(<Sidebar />);
    const renderedRows = container.querySelectorAll("[data-tree-row]");
    const spacer = container.querySelector<HTMLElement>(".workspace-tree-spacer");

    expect(renderedRows.length).toBeLessThan(100);
    expect(spacer?.style.height).toBe(`${10_001 * 28}px`);
  });

  it("文件树动作监听器数量不随节点数增长", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const files = Array.from({ length: 1_000 }, (_, index) =>
      file(`/workspace/note-${index}.md`),
    );
    useWorkspace.setState({ tree: dir("/workspace", files) });

    render(<Sidebar />);

    const actionListeners = addSpy.mock.calls.filter(
      ([eventName]) => eventName === "inkling-tree-action",
    );
    expect(actionListeners).toHaveLength(1);
  });

  it(".markdown 文件与 .md 文件一样可打开", () => {
    const openFile = vi.fn().mockResolvedValue(undefined);
    useWorkspace.setState({
      tree: dir("/workspace", [file("/workspace/guide.markdown")]),
      openFile,
    });
    render(<Sidebar />);

    fireEvent.click(screen.getByText("guide.markdown"));
    expect(openFile).toHaveBeenCalledWith("/workspace/guide.markdown");
  });

  it("读取未加载文件时保留文件树 DOM 与滚动位置", async () => {
    const content = deferred<string>();
    readTextFileMock.mockReturnValue(content.promise);
    const tree = dir("/workspace", [file("/workspace/slow.md")]);
    useWorkspace.setState({ tree });

    const { container } = render(<Sidebar />);
    const scroll = container.querySelector<HTMLElement>(".workspace-tree-scroll");
    expect(scroll).not.toBeNull();
    scroll!.scrollTop = 56;
    fireEvent.scroll(scroll!);

    fireEvent.click(screen.getByText("slow.md"));
    await waitFor(() => expect(readTextFileMock).toHaveBeenCalledTimes(1));

    expect(container.querySelector(".workspace-tree-scroll")).toBe(scroll);
    expect(scroll!.scrollTop).toBe(56);
    expect(useWorkspace.getState().tree).toBe(tree);
    expect(useWorkspace.getState().workspaceLoading).toBe(false);
    expect(screen.getByLabelText("正在打开")).toBeInTheDocument();
    expect(screen.getByText("slow.md").closest("button")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByText("slow.md").closest("button")).toBeEnabled();
    expect(screen.queryByText("加载中…")).not.toBeInTheDocument();

    await act(async () => content.resolve("# slow"));
    await waitFor(() => {
      expect(useWorkspace.getState().activeTabPath).toBe("/workspace/slow.md");
    });

    expect(container.querySelector(".workspace-tree-scroll")).toBe(scroll);
    expect(scroll!.scrollTop).toBe(56);
    expect(useWorkspace.getState().tree).toBe(tree);
    expect(screen.queryByLabelText("正在打开")).not.toBeInTheDocument();
  });

  it("文件读取失败后在原行提示错误并允许点击重试", async () => {
    readTextFileMock
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce("# retried");
    useWorkspace.setState({
      tree: dir("/workspace", [file("/workspace/retry.md")]),
    });

    const { container } = render(<Sidebar />);
    const scroll = container.querySelector(".workspace-tree-scroll");
    fireEvent.click(screen.getByText("retry.md"));

    await waitFor(() => {
      expect(screen.getByLabelText("打开失败，点击重试")).toBeInTheDocument();
    });
    expect(container.querySelector(".workspace-tree-scroll")).toBe(scroll);
    expect(screen.getByText("retry.md").closest("button")).toHaveAttribute(
      "title",
      "permission denied",
    );

    fireEvent.click(screen.getByText("retry.md"));
    await waitFor(() => {
      expect(useWorkspace.getState().activeTabPath).toBe("/workspace/retry.md");
    });

    expect(readTextFileMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".workspace-tree-scroll")).toBe(scroll);
    expect(screen.queryByLabelText("打开失败，点击重试")).not.toBeInTheDocument();
  });
});

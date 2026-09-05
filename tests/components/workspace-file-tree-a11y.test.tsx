// #188 文件树 treeitem aria-level 回归防护
// 运行时 DOM 实测曾确认所有 role=treeitem 的 aria-level 为 null，
// 屏幕阅读器无法感知目录层级。修复：WorkspaceFileTree 按展平深度输出
// aria-level={depth + 1}。此处直接渲染真实树，断言各行的层级属性。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, within } from "@testing-library/react";
import { WorkspaceFileTree } from "../../src/components/Sidebar/WorkspaceFileTree";
import { useWorkspace } from "../../src/store/workspace";
import type { FileNode } from "../../src/lib/fs";

function dir(name: string, path: string, children: FileNode[]): FileNode {
  return { name, path, is_dir: true, children };
}
function file(name: string, path: string): FileNode {
  return { name, path, is_dir: false, children: [] };
}

// /ws(d0, aria-level1)
// ├── sub(d1, aria-level2)
// │   └── note.md(d2, aria-level3)
// └── top.md(d1, aria-level2)
const tree: FileNode = dir("ws", "/ws", [
  dir("sub", "/ws/sub", [file("note.md", "/ws/sub/note.md")]),
  file("top.md", "/ws/top.md"),
]);

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspace.setState({
    expandedDirs: new Set(["/ws", "/ws/sub"]),
    loadedDirs: new Set(["/ws", "/ws/sub"]),
    loadingDirs: new Set<string>(),
    directoryErrors: new Map<string, string>(),
    fileOpenErrors: new Map<string, string>(),
    openingFiles: new Set<string>(),
    openTabs: [],
    currentFile: null,
    loadDirectory: vi.fn().mockResolvedValue(undefined),
    toggleDirExpanded: vi.fn(),
    openFile: vi.fn(),
  });
});

describe("#188 文件树 aria-level", () => {
  it("treeitem 按展平深度携带 aria-level（根=1，逐层递增）", () => {
    const { container } = render(<WorkspaceFileTree tree={tree} />);
    const items = within(container).queryAllByRole("treeitem");

    // 展平顺序：/ws、/ws/sub、/ws/sub/note.md、/ws/top.md
    expect(items.map((el) => el.getAttribute("aria-level"))).toEqual([
      "1",
      "2",
      "3",
      "2",
    ]);
  });

  it("折叠子目录时只渲染可见行的正确层级", () => {
    useWorkspace.setState({
      expandedDirs: new Set(["/ws"]), // sub 折叠
    });
    const { container } = render(<WorkspaceFileTree tree={tree} />);
    const items = within(container).queryAllByRole("treeitem");
    expect(items.map((el) => el.getAttribute("aria-level"))).toEqual(["1", "2", "2"]);
  });
});

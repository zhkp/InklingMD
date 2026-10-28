// #364 `pathRevs`：自动保存的订阅键必须能区分「又编辑了一次」
//
// 三条规则（设计 §7.2）：
// 1. 唯一 bump 点是内容真正变化的入口（`setContent` / `setContentFor`）；
// 2. `closeTab` 删除、`onFileRenamed` 迁移（不是删除）；
// 3. 保存成功后**不重置**——归零会让订阅键回退、effect 不重跑。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), message: vi.fn(), ask: vi.fn() }));
vi.mock("../../src/lib/fs", () => ({
  saveDocument: vi.fn(async (_p: string, content: string) => ({
    kind: "written",
    stat: { mtimeUs: 1_000, size: content.length },
    foreignWrite: false,
  })),
  readDocument: vi.fn(),
  readTextFile: vi.fn(async () => "基线"),
  writeTextFile: vi.fn(),
  fileStat: vi.fn(async () => ({ mtimeUs: 1_000, size: 1 })),
  fileMtime: vi.fn(async () => 1),
}));

import { useWorkspace } from "../../src/store/workspace";
import { getPathRev, pathRevs } from "../../src/store/workspace/shared";

const A = "/w/a.md";
const B = "/w/b.md";

function tab(path: string, extra: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    content: "",
    dirty: false,
    lastSavedAt: null,
    diskContent: "基线",
    diskStat: { mtimeUs: 1_000, size: 0 },
    diskMtime: 1,
    cursorPos: null,
    scrollTop: null,
    ...extra,
  };
}

beforeEach(() => {
  pathRevs.clear();
  useWorkspace.setState({
    openTabs: [tab(A), tab(B)],
    activeTabPath: A,
    currentFile: A,
    currentContent: "",
    dirty: false,
    splitFile: null,
    splitContent: "",
  } as never);
});

describe("pathRevs（#364）", () => {
  it("编辑一次 → rev +1；相同内容重复 set 不再 bump", () => {
    useWorkspace.getState().setContent("第一版");
    expect(getPathRev(A)).toBe(1);

    useWorkspace.getState().setContent("第一版");
    expect(getPathRev(A)).toBe(1);

    useWorkspace.getState().setContent("第二版");
    expect(getPathRev(A)).toBe(2);
  });

  it("保存成功 → rev 不变（不重置，否则订阅键回退、调度断裂）", async () => {
    useWorkspace.setState({ openTabs: [tab(A, { content: "改动", dirty: true })], dirty: true } as never);
    useWorkspace.getState().setContent("改动 2");
    const before = getPathRev(A);

    await useWorkspace.getState().saveTab(A, { interactive: true });

    expect(getPathRev(A)).toBe(before);
    expect(useWorkspace.getState().openTabs[0].dirty).toBe(false);
  });

  it("改名 → 新 key 继承旧 rev（不是删除）", () => {
    useWorkspace.getState().setContent("内容");
    const rev = getPathRev(A);
    expect(rev).toBeGreaterThan(0);

    useWorkspace.getState().onFileRenamed(A, "/w/renamed.md");

    expect(getPathRev("/w/renamed.md")).toBe(rev);
    expect(pathRevs.has(A)).toBe(false);
  });

  it("关闭 tab → key 消失", () => {
    useWorkspace.getState().setContent("内容");
    expect(pathRevs.has(A)).toBe(true);

    useWorkspace.getState().closeTab(A);

    expect(pathRevs.has(A)).toBe(false);
  });
});

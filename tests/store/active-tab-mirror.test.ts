// #383 评审 B1：活跃 tab 的三个出入口必须整体派生顶层镜像。
//
// 旧实现里 `newTab` 只写 `dirty`、`closeTab`（最后一个）与 `closeAll` 只清 `dirty`，
// 于是一个冲突中的活跃 tab 在这些出口后仍让状态栏显示「外部冲突（已暂停自动保存）」，
// 点击却因没有活跃 tab / 没有 dirty 而完全无效。
// 这三条断言在旧实现上都会失败（saving / conflictPending 残留）。

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

const A = "/w/a.md";
const B = "/w/b.md";

function tab(path: string, extra: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    content: "改动",
    dirty: true,
    lastSavedAt: null,
    diskContent: "基线",
    diskStat: { mtimeUs: 1_000, size: 3 },
    diskMtime: 1,
    cursorPos: null,
    scrollTop: null,
    ...extra,
  };
}

/** 顶层三个镜像必须与当前活跃 tab 完全一致（无活跃 tab 时全部为 false） */
function expectMirrorsFollowActiveTab() {
  const state = useWorkspace.getState();
  const active = state.openTabs.find((t) => t.path === state.activeTabPath);
  expect(state.dirty, "dirty 镜像").toBe(active?.dirty ?? false);
  expect(state.saving, "saving 镜像").toBe(!!active?.saving);
  expect(state.conflictPending, "conflictPending 镜像").toBe(!!active?.conflictPending);
}

beforeEach(() => {
  useWorkspace.setState({
    openTabs: [tab(A, { conflictPending: true })],
    activeTabPath: A,
    currentFile: A,
    currentContent: "改动",
    // 陈旧镜像：模拟活跃 tab 冲突待处理时，另一个在途保存留下的 saving
    dirty: true,
    saving: true,
    conflictPending: true,
    saveError: null,
    lastSavedAt: null,
    splitFile: null,
    splitContent: "",
  } as never);
});

describe("#383 活跃 tab 镜像：出入口必须整体派生（评审 B1）", () => {
  it("newTab：冲突中的活跃 tab 后新建草稿，saving / conflictPending 不残留", () => {
    useWorkspace.getState().newTab();

    const state = useWorkspace.getState();
    const active = state.openTabs.find((t) => t.path === state.activeTabPath);
    expect(active?.isUntitled, "新建的草稿应成为活跃 tab").toBe(true);
    expectMirrorsFollowActiveTab();
    // 空草稿没有冲突、也没有在途保存
    expect(state.dirty).toBe(false);
    expect(state.saving).toBe(false);
    expect(state.conflictPending).toBe(false);
  });

  it("closeTab 关闭最后一个 tab：dirty / saving / conflictPending 一并归零", () => {
    useWorkspace.getState().closeTab(A);

    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBeNull();
    expect(state.openTabs).toHaveLength(0);
    expectMirrorsFollowActiveTab();
    expect(state.dirty).toBe(false);
    expect(state.saving).toBe(false);
    expect(state.conflictPending).toBe(false);
  });

  it("closeAll：dirty / saving / conflictPending 一并归零", () => {
    useWorkspace.setState({
      openTabs: [tab(A, { conflictPending: true }), tab(B)],
    } as never);

    useWorkspace.getState().closeAll();

    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBeNull();
    expect(state.openTabs).toHaveLength(0);
    expectMirrorsFollowActiveTab();
    expect(state.dirty).toBe(false);
    expect(state.saving).toBe(false);
    expect(state.conflictPending).toBe(false);
  });
});

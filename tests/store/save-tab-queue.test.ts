// #364 `saveTab` / 串行队列 / 意图升级 / 可等待
//
// 这一组锁的是「按 path 保存」这件事本身：
// - 后台 tab 能被单独保存，且不改变活跃 tab 与镜像；
// - 非交互保存（调度器）串行入队；交互保存（Ctrl+S）不被别人的对话框/写盘卡住；
// - 在途/排队时按 Ctrl+S（意图升级）会再执行一次，而不是「搭车后什么都不做」；
// - `waitForSaves` / `isSaveInFlight` 覆盖到 store adopt。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { saveDocumentMock } = vi.hoisted(() => ({ saveDocumentMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), message: vi.fn(), ask: vi.fn() }));
vi.mock("../../src/lib/fs", () => ({
  saveDocument: saveDocumentMock,
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

function written(_path: string, content: string) {
  return { kind: "written" as const, stat: { mtimeUs: 2_000, size: content.length }, foreignWrite: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  saveDocumentMock.mockReset().mockImplementation(async (path: string, content: string) => written(path, content));
  useWorkspace.setState({
    openTabs: [tab(A), tab(B)],
    activeTabPath: A,
    currentFile: A,
    currentContent: "改动",
    dirty: true,
    saveError: null,
    conflictPending: false,
  } as never);
});

describe("saveTab（#364）", () => {
  it("保存后台 tab：写的是它的 path，活跃 tab 与镜像不变", async () => {
    await useWorkspace.getState().saveTab(B, { interactive: true });

    expect(saveDocumentMock).toHaveBeenCalledTimes(1);
    expect(saveDocumentMock.mock.calls[0][0]).toBe(B);
    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBe(A);
    expect(state.currentFile).toBe(A);
    expect(state.openTabs.find((t) => t.path === B)?.dirty).toBe(false);
    // 后台 tab 保存成功不该清掉活跃 tab 的 dirty 镜像
    expect(state.dirty).toBe(true);
  });

  it("非交互保存遇到 conflictPending 直接返回（调度器不空转）", async () => {
    useWorkspace.setState({
      openTabs: [tab(A), tab(B, { conflictPending: true })],
    } as never);

    await useWorkspace.getState().saveTab(B, { interactive: false });

    expect(saveDocumentMock).not.toHaveBeenCalled();
  });

  it("意图升级：非交互保存在途时按 Ctrl+S，会以交互模式再执行一次", async () => {
    const gate = deferred<{ kind: "written"; stat: { mtimeUs: number; size: number }; foreignWrite: boolean }>();
    saveDocumentMock.mockReturnValueOnce(gate.promise);

    const background = useWorkspace.getState().saveTab(B, { interactive: false });
    // 在途：isSaveInFlight 为 true
    expect(useWorkspace.getState().isSaveInFlight(B)).toBe(true);

    const interactive = useWorkspace.getState().saveTab(B, { interactive: true });

    // 在途期间又编辑了一次：第一次保存 adopt 时仍是 dirty，升级后的交互保存才有的可写
    useWorkspace.setState((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.path === B ? { ...t, content: "改动 2", dirty: true } : t,
      ),
      dirty: true,
    }));

    gate.resolve(written(B, "改动"));
    await background;
    await interactive;

    // 第一次非交互 + 升级后的交互各一次
    expect(saveDocumentMock).toHaveBeenCalledTimes(2);
    expect(useWorkspace.getState().isSaveInFlight(B)).toBe(false);
  });

  it("交互保存（Ctrl+S）也登记在途：isSaveInFlight / waitForSaves 都能等到", async () => {
    // 这条锁的是 #367 的核心场景：按下 Ctrl+S 立刻关窗，退出流程必须能等到这次写盘
    const gate = deferred<{ kind: "written"; stat: { mtimeUs: number; size: number }; foreignWrite: boolean }>();
    saveDocumentMock.mockReturnValueOnce(gate.promise);

    const saving = useWorkspace.getState().saveTab(B, { interactive: true });
    expect(useWorkspace.getState().isSaveInFlight(B)).toBe(true);

    let waited = false;
    const waiting = useWorkspace.getState().waitForSaves().then(() => {
      waited = true;
    });
    await Promise.resolve();
    expect(waited).toBe(false);

    gate.resolve(written(B, "改动"));
    await saving;
    await waiting;

    expect(waited).toBe(true);
    expect(useWorkspace.getState().isSaveInFlight(B)).toBe(false);
  });

  it("waitForSaves：等待在途保存到 adopt 完成，之后 tab 已干净", async () => {
    const gate = deferred<{ kind: "written"; stat: { mtimeUs: number; size: number }; foreignWrite: boolean }>();
    saveDocumentMock.mockReturnValueOnce(gate.promise);

    void useWorkspace.getState().saveTab(B, { interactive: false });
    const waiting = useWorkspace.getState().waitForSaves();

    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve(written(B, "改动"));
    await waiting;

    expect(settled).toBe(true);
    expect(useWorkspace.getState().openTabs.find((t) => t.path === B)?.dirty).toBe(false);
  });
});

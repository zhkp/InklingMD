// issue #363：文件在磁盘上已不存在（外部删除 / 改名 / 目录被删 / 应用内改名或删目录）时，
// 任何写盘入口（自动保存、Ctrl+S、切回 tab、退出、粘贴图片）都不得静默把它写回磁盘。
// 真实 store + useAutoSave + useFileWatcher + useExitHandler，invoke 接真实临时目录
// （tests/fixtures/realFsTauriBackend.ts），断言最终磁盘状态与 tab 状态。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

const h = vi.hoisted(() => ({
  backend: null as null | ReturnType<typeof import("../fixtures/realFsTauriBackend").createRealFsBackend>,
  messageMock: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  askMock: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  saveDialogMock: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
  closeHandler: null as null | ((e: { preventDefault: () => void }) => Promise<void>),
  destroyMock: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (p: string) => p,
  invoke: (cmd: string, args?: Record<string, unknown>) => h.backend!.invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/path", () => ({
  resolve: async (...parts: string[]) => nodePath.resolve(...parts),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: (...a: unknown[]) => h.askMock(...a),
  message: (...a: unknown[]) => h.messageMock(...a),
  save: (...a: unknown[]) => h.saveDialogMock(...a),
  confirm: async () => false,
}));
vi.mock("../../src/lib/dialogs", () => ({
  askConfirmation: async () => false,
  showMessage: async () => undefined,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: typeof h.closeHandler) => {
      h.closeHandler = handler;
      return () => undefined;
    },
    destroy: (...a: unknown[]) => h.destroyMock(...a),
  }),
}));

import { createRealFsBackend } from "../fixtures/realFsTauriBackend";
import { useWorkspace } from "../../src/store/workspace";
import { loadDeletedSnapshots } from "../../src/store/workspace/shared";
import { useAutoSave } from "../../src/lib/useAutoSave";
import { useFileWatcher } from "../../src/lib/useFileWatcher";
import { useExitHandler } from "../../src/lib/useExitHandler";
import { saveImageAsset } from "../../src/lib/assetStore";

let root: string;
const W = (...p: string[]) => nodePath.join(root, ...p);

const POLL = 3_100;
const AUTOSAVE = 2_100;

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function mountHooks() {
  return renderHook(() => {
    useAutoSave();
    useFileWatcher();
    useExitHandler();
  });
}
async function open(p: string) {
  await act(async () => {
    await useWorkspace.getState().openFile(p);
  });
}
function type(text: string) {
  act(() => {
    const s = useWorkspace.getState();
    s.setContent(s.currentContent + text);
  });
}
async function pressCtrlS() {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }));
    await vi.advanceTimersByTimeAsync(10);
  });
}
const tabOf = (p: string) => useWorkspace.getState().openTabs.find((t) => t.path === p);
const read = (p: string) => nodeFs.readFileSync(p, "utf8");

beforeEach(() => {
  root = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "issue363-"));
  h.backend = createRealFsBackend();
  h.messageMock = vi.fn(async () => "Cancel");
  h.askMock = vi.fn(async () => false);
  h.saveDialogMock = vi.fn(async () => null);
  h.destroyMock = vi.fn(async () => undefined);
  h.closeHandler = null;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  useWorkspace.setState({
    openTabs: [],
    activeTabPath: null,
    currentFile: null,
    currentContent: "",
    dirty: false,
    saving: false,
    conflictPending: false,
    saveError: null,
    lastSavedAt: null,
    splitFile: null,
    splitContent: "",
    recentFiles: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
  nodeFs.rmSync(root, { recursive: true, force: true });
});

describe("issue #363：外部删除 / 改名后自动保存不得写回", () => {
  it("干净 tab 的文件被外部删除，之后输入：不重建文件，tab 标记已删除且暂停自动保存", async () => {
    nodeFs.mkdirSync(W("docs"));
    nodeFs.writeFileSync(W("docs/a.md"), "原文");
    const hooks = mountHooks();
    await open(W("docs/a.md"));

    nodeFs.rmSync(W("docs/a.md"));
    await tick(POLL);
    expect(tabOf(W("docs/a.md"))?.deletedOnDisk).toBe(true);

    type("x");
    await tick(AUTOSAVE + 60_000);

    expect(nodeFs.existsSync(W("docs/a.md"))).toBe(false);
    expect(h.backend!.writesTo(W("docs/a.md"))).toHaveLength(0);
    const tab = tabOf(W("docs/a.md"))!;
    expect(tab.content).toBe("原文x");
    expect(tab.dirty).toBe(true);
    expect(tab.deletedOnDisk).toBe(true);
    hooks.unmount();
  });

  it("监听器尚未发现删除时自动保存先到点：写盘被拒并转入已删除状态，不再反复重试", async () => {
    nodeFs.writeFileSync(W("a.md"), "原文");
    const hooks = mountHooks();
    await open(W("a.md"));
    await tick(POLL); // 登记监听基线

    type("x");
    nodeFs.rmSync(W("a.md"));
    await tick(AUTOSAVE);
    expect(nodeFs.existsSync(W("a.md"))).toBe(false);
    expect(tabOf(W("a.md"))?.deletedOnDisk).toBe(true);

    await tick(60_000);
    expect(nodeFs.existsSync(W("a.md"))).toBe(false);
    expect(h.backend!.writesTo(W("a.md")).length).toBeLessThanOrEqual(1);
    hooks.unmount();
  });

  it("整个父目录被删：不重建目录链", async () => {
    nodeFs.mkdirSync(W("proj/docs"), { recursive: true });
    nodeFs.writeFileSync(W("proj/docs/a.md"), "A");
    nodeFs.writeFileSync(W("proj/docs/b.md"), "B");
    const hooks = mountHooks();
    await open(W("proj/docs/a.md"));

    nodeFs.rmSync(W("proj"), { recursive: true });
    await tick(POLL);
    type("x");
    await tick(AUTOSAVE + 10_000);

    expect(nodeFs.existsSync(W("proj"))).toBe(false);
    hooks.unmount();
  });

  it("外部改名 a.md → b.md：旧路径不复活，新文件不被改动", async () => {
    nodeFs.writeFileSync(W("a.md"), "v1");
    const hooks = mountHooks();
    await open(W("a.md"));

    nodeFs.renameSync(W("a.md"), W("b.md"));
    await tick(POLL);
    type("+edit");
    await tick(AUTOSAVE + 10_000);

    expect(nodeFs.existsSync(W("a.md"))).toBe(false);
    expect(read(W("b.md"))).toBe("v1");
    hooks.unmount();
  });

  it("后台 dirty tab 的文件被删，仅切回该 tab：不写回", async () => {
    nodeFs.writeFileSync(W("a.md"), "A");
    nodeFs.writeFileSync(W("b.md"), "B");
    const hooks = mountHooks();
    await open(W("a.md"));
    act(() => useWorkspace.getState().setContent("A 改"));
    await open(W("b.md"));
    await tick(AUTOSAVE);

    nodeFs.rmSync(W("a.md"));
    await tick(POLL);
    act(() => useWorkspace.getState().switchTab(W("a.md")));
    await tick(AUTOSAVE + 10_000);

    expect(nodeFs.existsSync(W("a.md"))).toBe(false);
    expect(tabOf(W("a.md"))?.deletedOnDisk).toBe(true);
    expect(tabOf(W("a.md"))?.content).toBe("A 改");
    hooks.unmount();
  });

  it("目标路径被同名目录占据：暂停自动保存，不进入无限静默重试", async () => {
    nodeFs.writeFileSync(W("a.md"), "A");
    const hooks = mountHooks();
    await open(W("a.md"));

    nodeFs.rmSync(W("a.md"));
    nodeFs.mkdirSync(W("a.md"));
    type("x");
    await tick(AUTOSAVE + 60_000);

    expect(h.backend!.writesTo(W("a.md")).length).toBeLessThanOrEqual(1);
    expect(tabOf(W("a.md"))?.deletedOnDisk).toBe(true);
    expect(nodeFs.statSync(W("a.md")).isDirectory()).toBe(true);
    hooks.unmount();
  });

  it("文件被恢复后（同内容）：已删除标记解除，自动保存恢复并正常落盘", async () => {
    nodeFs.writeFileSync(W("a.md"), "原文");
    const hooks = mountHooks();
    await open(W("a.md"));

    nodeFs.rmSync(W("a.md"));
    await tick(POLL);
    type("x");
    await tick(AUTOSAVE);
    expect(nodeFs.existsSync(W("a.md"))).toBe(false);

    nodeFs.writeFileSync(W("a.md"), "原文"); // 例如 git checkout 回来
    await tick(POLL);
    expect(tabOf(W("a.md"))?.deletedOnDisk).toBeFalsy();
    await tick(AUTOSAVE);

    expect(read(W("a.md"))).toBe("原文x");
    expect(tabOf(W("a.md"))?.dirty).toBe(false);
    hooks.unmount();
  });
});

describe("issue #363：手动保存与退出流程", () => {
  async function openThenDelete() {
    nodeFs.mkdirSync(W("docs"));
    nodeFs.writeFileSync(W("docs/a.md"), "A");
    const hooks = mountHooks();
    await open(W("docs/a.md"));
    nodeFs.rmSync(W("docs/a.md"));
    await tick(POLL);
    act(() => useWorkspace.getState().setContent("A2"));
    return hooks;
  }

  it("Ctrl+S 时询问用户；取消则不写盘、保留编辑", async () => {
    const hooks = await openThenDelete();
    h.messageMock.mockResolvedValue("Cancel");
    await pressCtrlS();

    expect(h.messageMock).toHaveBeenCalledTimes(1);
    expect(nodeFs.existsSync(W("docs/a.md"))).toBe(false);
    expect(tabOf(W("docs/a.md"))?.dirty).toBe(true);
    expect(useWorkspace.getState().saving).toBe(false);
    hooks.unmount();
  });

  it("Ctrl+S 选择「重新创建」：在原位置写入并解除已删除标记", async () => {
    const hooks = await openThenDelete();
    h.messageMock.mockResolvedValue("Yes");
    await pressCtrlS();

    expect(read(W("docs/a.md"))).toBe("A2");
    const tab = tabOf(W("docs/a.md"))!;
    expect(tab.dirty).toBe(false);
    expect(tab.deletedOnDisk).toBeFalsy();
    hooks.unmount();
  });

  it("Ctrl+S 选择「重新创建」且所在目录也被删：经用户同意后重建目录（自定义按钮文字返回值）", async () => {
    nodeFs.mkdirSync(W("gone"));
    nodeFs.writeFileSync(W("gone/a.md"), "A");
    const hooks = mountHooks();
    await open(W("gone/a.md"));
    nodeFs.rmSync(W("gone"), { recursive: true });
    await tick(POLL);
    act(() => useWorkspace.getState().setContent("A2"));

    h.messageMock.mockResolvedValue("重新创建");
    await pressCtrlS();

    expect(read(W("gone/a.md"))).toBe("A2");
    hooks.unmount();
  });

  it("Ctrl+S 选择「另存为」：写到新位置，tab 跟随新路径，原路径不复活", async () => {
    const hooks = await openThenDelete();
    h.messageMock.mockResolvedValue("No");
    h.saveDialogMock.mockResolvedValue(W("moved.md"));
    await pressCtrlS();

    expect(read(W("moved.md"))).toBe("A2");
    expect(nodeFs.existsSync(W("docs/a.md"))).toBe(false);
    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBe(W("moved.md"));
    expect(tabOf(W("moved.md"))?.dirty).toBe(false);
    expect(tabOf(W("moved.md"))?.deletedOnDisk).toBeFalsy();
    expect(tabOf(W("docs/a.md"))).toBeUndefined();
    hooks.unmount();
  });

  it("干净 tab 的文件被删（未做任何编辑）：Ctrl+S 仍弹出选择，可在原位置重新创建（Codex 复审）", async () => {
    nodeFs.writeFileSync(W("a.md"), "原文");
    const hooks = mountHooks();
    await open(W("a.md"));
    nodeFs.rmSync(W("a.md"));
    await tick(POLL);
    expect(tabOf(W("a.md"))?.dirty).toBe(false);
    expect(tabOf(W("a.md"))?.deletedOnDisk).toBe(true);

    h.messageMock.mockResolvedValue("Yes");
    await pressCtrlS();

    expect(h.messageMock).toHaveBeenCalledTimes(1);
    expect(read(W("a.md"))).toBe("原文");
    expect(tabOf(W("a.md"))?.deletedOnDisk).toBeFalsy();
    hooks.unmount();
  });

  it("干净 tab 未被删除时 Ctrl+S 仍是无操作（不因放行已删除文件而多写盘）", async () => {
    nodeFs.writeFileSync(W("a.md"), "原文");
    const hooks = mountHooks();
    await open(W("a.md"));
    await pressCtrlS();
    expect(h.backend!.writesTo(W("a.md"))).toHaveLength(0);
    expect(h.messageMock).not.toHaveBeenCalled();
    hooks.unmount();
  });

  it("所在文件夹路径被同名文件占用：不提供「重新创建」（必然失败），只能另存为或取消（Codex 复审）", async () => {
    nodeFs.mkdirSync(W("dir"));
    nodeFs.writeFileSync(W("dir/a.md"), "A");
    const hooks = mountHooks();
    await open(W("dir/a.md"));
    nodeFs.rmSync(W("dir"), { recursive: true });
    nodeFs.writeFileSync(W("dir"), "我是文件");
    await tick(POLL);
    act(() => useWorkspace.getState().setContent("A2"));

    h.messageMock.mockResolvedValue("Ok");
    h.saveDialogMock.mockResolvedValue(W("elsewhere.md"));
    await pressCtrlS();

    const [text, opts] = h.messageMock.mock.calls[0] as [string, { buttons: Record<string, string> }];
    expect(text).toContain("所在的文件夹路径已被同名文件占用");
    expect(opts.buttons).not.toHaveProperty("yes");
    expect(Object.values(opts.buttons)).not.toContain("重新创建");
    expect(read(W("elsewhere.md"))).toBe("A2");
    expect(read(W("dir"))).toBe("我是文件");
    hooks.unmount();
  });

  it("退出时 dirty 文件已被删：不静默写回；用户取消则不退出", async () => {
    nodeFs.writeFileSync(W("a.md"), "A");
    nodeFs.writeFileSync(W("b.md"), "B");
    const hooks = mountHooks();
    await open(W("a.md"));
    act(() => useWorkspace.getState().setContent("A2"));
    await open(W("b.md"));
    act(() => useWorkspace.getState().setContent("B2"));
    nodeFs.rmSync(W("a.md"));
    nodeFs.rmSync(W("b.md"));

    h.messageMock.mockResolvedValue("Cancel");
    h.askMock.mockResolvedValue(false);
    await act(async () => {
      await h.closeHandler!({ preventDefault: () => undefined });
    });

    // 退出路径与 Ctrl+S / 状态栏一致：每个「文件已不在原处」的 dirty tab 各弹一次
    // 三选项（`saveTab` 的 interactive 默认为 true），而不是静默跳过；
    // 之后还有一次「有 N 个文件未能保存」的重试 / 放弃 / 取消（#367 三选一）。
    expect(h.messageMock).toHaveBeenCalledTimes(3);
    expect(String(h.messageMock.mock.calls[2][0])).toContain("未能保存");
    expect(nodeFs.existsSync(W("a.md"))).toBe(false);
    expect(nodeFs.existsSync(W("b.md"))).toBe(false);
    expect(h.destroyMock).not.toHaveBeenCalled();
    // 取消后内容仍在编辑器里，未退出
    expect(tabOf(W("a.md"))?.content).toBe("A2");
    expect(tabOf(W("b.md"))?.content).toBe("B2");
    hooks.unmount();
  });
});

describe("issue #363 / #366：应用内改名、删除目录后的子文件 tab", () => {
  it("应用内重命名目录：子文件 tab 迁到新路径，后续保存写新路径，旧目录不复活", async () => {
    nodeFs.mkdirSync(W("old"));
    nodeFs.writeFileSync(W("old/a.md"), "A");
    nodeFs.writeFileSync(W("old/b.md"), "B");
    const hooks = mountHooks();
    await open(W("old/b.md"));
    await open(W("old/a.md"));

    await act(async () => {
      nodeFs.renameSync(W("old"), W("new"));
      useWorkspace.getState().onFileRenamed(W("old"), W("new"));
    });
    const state = useWorkspace.getState();
    expect(state.activeTabPath).toBe(W("new/a.md"));
    expect(state.currentFile).toBe(W("new/a.md"));
    expect(state.openTabs.map((t) => t.path).sort()).toEqual([W("new/a.md"), W("new/b.md")]);

    type("x");
    await tick(AUTOSAVE);
    expect(read(W("new/a.md"))).toBe("Ax");
    expect(nodeFs.existsSync(W("old"))).toBe(false);
    hooks.unmount();
  });

  it("应用内删除目录：子文件 tab 全部关闭，dirty 子文件留快照，目录不复活", async () => {
    nodeFs.mkdirSync(W("dir/sub"), { recursive: true });
    nodeFs.writeFileSync(W("dir/a.md"), "A");
    nodeFs.writeFileSync(W("dir/sub/b.md"), "B");
    nodeFs.writeFileSync(W("keep.md"), "K");
    const hooks = mountHooks();
    await open(W("keep.md"));
    await open(W("dir/sub/b.md"));
    await open(W("dir/a.md"));
    type("x");

    await act(async () => {
      nodeFs.rmSync(W("dir"), { recursive: true });
      useWorkspace.getState().onFileDeleted(W("dir"));
    });

    expect(useWorkspace.getState().openTabs.map((t) => t.path)).toEqual([W("keep.md")]);
    expect(loadDeletedSnapshots().map((s) => s.path)).toContain(W("dir/a.md"));
    await tick(AUTOSAVE + POLL);
    expect(nodeFs.existsSync(W("dir"))).toBe(false);
    hooks.unmount();
  });
});

describe("issue #363：图片资源写入", () => {
  it("文档所在目录已被删除：粘贴图片失败，不重建目录", async () => {
    nodeFs.mkdirSync(W("dir"));
    nodeFs.writeFileSync(W("dir/a.md"), "A");
    nodeFs.rmSync(W("dir"), { recursive: true });

    await expect(
      saveImageAsset(W("dir/a.md"), new Uint8Array([137, 80, 78, 71]), "x.png"),
    ).rejects.toThrow();
    expect(nodeFs.existsSync(W("dir"))).toBe(false);
  });

  it("文档目录存在、assets/ 尚未创建：照常创建 assets/ 并写入", async () => {
    nodeFs.mkdirSync(W("dir"));
    nodeFs.writeFileSync(W("dir/a.md"), "A");

    await expect(
      saveImageAsset(W("dir/a.md"), new Uint8Array([137, 80, 78, 71]), "x.png"),
    ).resolves.toBe("assets/x.png");
    expect(nodeFs.existsSync(W("dir/assets/x.png"))).toBe(true);
  });
});

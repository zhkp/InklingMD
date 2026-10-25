// 保存链路并发与冲突状态清理批次测试
// - issue #148：保存互斥按 tab 生效——某个 tab 的另存为对话框挂起期间，
//   其他 tab 的手动保存不被全局 saving 闸吞掉；顶层镜像跟随活跃 tab 派生
// - issue #164：冲突经 reloadFile 解决后，tab 与状态栏镜像的 conflictPending 统一清除

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { readTextFileMock, writeTextFileMock, fileMtimeMock, saveMock, askMock, isTauriMock } =
  vi.hoisted(() => ({
    readTextFileMock: vi.fn(),
    writeTextFileMock: vi.fn(),
    fileMtimeMock: vi.fn(),
    saveMock: vi.fn(),
    askMock: vi.fn(),
    isTauriMock: vi.fn(() => true),
  }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: saveMock,
  ask: askMock,
}));

vi.mock("../../src/lib/fs", () => ({
  readTextFile: readTextFileMock,
  writeTextFile: writeTextFileMock,
  fileMtime: fileMtimeMock,
  // #362：reloadFile 走成对读取；switchTab 会做磁盘核验（本文件只断言 saving 镜像，
  // stat 固定值让核验不引入额外冲突）
  readDocument: async (path: string) => ({
    content: await readTextFileMock(path),
    stat: { mtimeUs: 1_700_000_000_000_000, size: 1 },
  }),
  fileStat: async () => ({ mtimeUs: 1_700_000_000_000_000, size: 1 }),
  // #362：保存走 save_document（写盘回执）。委派给 writeTextFile mock，
  // 让既有「按 mustExist 断言写入参数」的用例保持同一观察面
  saveDocument: async (path: string, content: string) => {
    await writeTextFileMock(path, content, { mustExist: true });
    return {
      kind: "written",
      stat: { mtimeUs: 1_700_000_000_000_000, size: 1 },
      foreignWrite: false,
    };
  },
}));

import { useWorkspace } from "../../src/store/workspace";

function tab(path: string, content: string, diskContent: string, extra?: Partial<OpenTab>): OpenTab {
  return {
    path,
    content,
    cursorPos: null,
    scrollTop: null,
    dirty: true,
    isUntitled: false,
    diskContent,
    lastSavedAt: null,
    ...extra,
  };
}

/** 等待微任务队列清空，让 saveCurrent 推进到下一个 await 点 */
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("saveCurrent 按 tab 互斥（issue #148）", () => {
  beforeEach(() => {
    readTextFileMock.mockReset();
    writeTextFileMock.mockReset();
    fileMtimeMock.mockReset();
    saveMock.mockReset();
    askMock.mockReset();
    isTauriMock.mockReset();
    isTauriMock.mockReturnValue(true);
    writeTextFileMock.mockResolvedValue(undefined);
    readTextFileMock.mockResolvedValue("磁盘基线");
    fileMtimeMock.mockResolvedValue(1000);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("另存为对话框挂起期间，其他 tab 的手动保存不被吞掉", async () => {
    // tab A（未命名草稿）的另存为对话框一直挂起（真实场景：用户停在对话框不关闭）
    let resolveSaveDialog!: (picked: string | null) => void;
    saveMock.mockImplementation(
      () => new Promise<string | null>((resolve) => (resolveSaveDialog = resolve)),
    );

    useWorkspace.setState({
      openTabs: [
        tab("untitled-1", "草稿内容", "", { isUntitled: true }),
        tab("/docs/b.md", "B 编辑", "磁盘基线"),
      ],
      activeTabPath: "untitled-1",
      currentFile: "untitled-1",
      currentContent: "草稿内容",
      dirty: true,
      saving: false,
      saveError: null,
    } as never);

    const pendingSave = useWorkspace.getState().saveCurrent({ interactive: true });
    await flushMicrotasks();

    // 对话框挂起中：A 在保存，顶层镜像为 true（旧行为下 B 的保存会被吞掉）
    const hanging = useWorkspace.getState();
    expect(hanging.saving).toBe(true);
    expect(hanging.openTabs.find((t) => t.path === "untitled-1")?.saving).toBe(true);

    // 用户切到 tab B 并按 Ctrl+S
    useWorkspace.getState().switchTab("/docs/b.md");
    // 切换后镜像跟随 B：不再显示"保存中"
    expect(useWorkspace.getState().saving).toBe(false);

    await useWorkspace.getState().saveCurrent();

    // B 的保存真实落盘，而不是被全局 saving 闸静默吞掉
    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/b.md", "B 编辑", { mustExist: true });

    // A 的对话框此刻返回：保存完成，但不得抢占 B 的活跃状态或污染镜像
    resolveSaveDialog("E:/docs/a.md");
    await pendingSave;

    const s = useWorkspace.getState();
    const migrated = s.openTabs.find((t) => t.path === "E:/docs/a.md");
    expect(migrated).toBeDefined();
    expect(migrated?.isUntitled).toBe(false);
    expect(migrated?.saving).toBe(false);
    // 活跃 tab 仍是 B，镜像反映 B 刚保存成功的干净状态
    expect(s.activeTabPath).toBe("/docs/b.md");
    expect(s.saving).toBe(false);
    expect(s.dirty).toBe(false);
    expect(s.currentFile).toBe("/docs/b.md");
  });

  it("同一 tab 的重复保存仍被互斥拦截（防重入语义保留）", async () => {
    useWorkspace.setState({
      openTabs: [tab("/docs/b.md", "B 编辑", "磁盘基线", { saving: true })],
      activeTabPath: "/docs/b.md",
      currentFile: "/docs/b.md",
      currentContent: "B 编辑",
      dirty: true,
      saving: true,
      saveError: null,
    } as never);

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).not.toHaveBeenCalled();
  });

  it("切换到保存中的 tab 时镜像为 true，切回空闲 tab 恢复 false", () => {
    useWorkspace.setState({
      openTabs: [
        tab("/docs/a.md", "A 内容", "磁盘基线", { saving: true, dirty: true }),
        tab("/docs/b.md", "B 内容", "磁盘基线"),
      ],
      activeTabPath: "/docs/b.md",
      currentFile: "/docs/b.md",
      saving: false,
      dirty: false,
    } as never);

    useWorkspace.getState().switchTab("/docs/a.md");
    expect(useWorkspace.getState().saving).toBe(true);

    useWorkspace.getState().switchTab("/docs/b.md");
    expect(useWorkspace.getState().saving).toBe(false);
  });
});

describe("reloadFile 清除 conflictPending（issue #164）", () => {
  beforeEach(() => {
    readTextFileMock.mockReset();
    writeTextFileMock.mockReset();
    fileMtimeMock.mockReset();
    isTauriMock.mockReset();
    isTauriMock.mockReturnValue(true);
    readTextFileMock.mockResolvedValue("磁盘最新内容");
    fileMtimeMock.mockResolvedValue(2000);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("活跃 tab 冲突经重载解决后，tab 与状态栏镜像的 conflictPending 均被清除", async () => {
    useWorkspace.setState({
      openTabs: [tab("/docs/a.md", "本地编辑", "磁盘基线", { conflictPending: true })],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: "本地编辑",
      dirty: true,
      conflictPending: true,
      saveError: null,
    } as never);

    await useWorkspace.getState().reloadFile("/docs/a.md");

    const s = useWorkspace.getState();
    // 旧缺陷：重载后 dirty=false 但 conflictPending 残留，
    // 状态栏持续误报"外部冲突"且指示器点击因 !dirty 无效
    expect(s.conflictPending).toBe(false);
    expect(s.openTabs[0].conflictPending).toBe(false);
    expect(s.dirty).toBe(false);
    expect(s.currentContent).toBe("磁盘最新内容");
    expect(s.openTabs[0].diskContent).toBe("磁盘最新内容");
  });

  it("非活跃 tab 重载只清该 tab 的 conflictPending，不影响其他 tab", async () => {
    useWorkspace.setState({
      openTabs: [
        tab("/docs/a.md", "本地编辑", "磁盘基线", { conflictPending: true }),
        tab("/docs/b.md", "B 内容", "磁盘基线", { conflictPending: true }),
      ],
      activeTabPath: "/docs/b.md",
      currentFile: "/docs/b.md",
      dirty: false,
      conflictPending: true,
    } as never);

    await useWorkspace.getState().reloadFile("/docs/a.md");

    const s = useWorkspace.getState();
    expect(s.openTabs.find((t) => t.path === "/docs/a.md")?.conflictPending).toBe(false);
    expect(s.openTabs.find((t) => t.path === "/docs/b.md")?.conflictPending).toBe(true);
    // 镜像跟随活跃 tab B（其冲突仍待处理）
    expect(s.conflictPending).toBe(true);
  });
});

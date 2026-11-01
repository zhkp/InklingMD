// #362：switchTab 核验重排（设计 §4.4）
//
// 旧实现的三个缺陷：
//   ① 判定冲突前无条件写 diskMtime → 把外部 stat 登记成基线（R3）
//   ② 先比 mtime 再决定是否读全文 → 5ms 容差内的外写被当成"没变"（W2）
//   ③ await 前捕获 tab、判定后用旧内容/旧基线 → 假冲突或漏判
//
// 新顺序：await 后重取 tab → stat 错误分类 → 基线判定 → 成对读盘 →
//         flush 后重取内容 → 先比内容（三路）再决定 adopt / reload / 冲突。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { isTauriMock, fileStatMock, readDocumentMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(() => true),
  fileStatMock: vi.fn(),
  readDocumentMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

vi.mock("../../src/lib/fs", () => ({
  fileStat: fileStatMock,
  readDocument: readDocumentMock,
  // 保存链路（saveCurrent）在本文件不被触发；保留导出避免任何间接调用拿到 undefined
  readTextFile: vi.fn(),
  writeTextFile: vi.fn(),
  fileMtime: vi.fn(),
}));

vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { useWorkspace } from "../../src/store/workspace";
import { useConflict } from "../../src/store/conflict";
import { flushAllMarkdownPublishers } from "../../src/components/Editor/markdown-publisher";
import type { DocumentSnapshot, FileStat } from "../../src/lib/fs";
import type { OpenTab } from "../../src/store/workspace";

const DOC = "/w/a.md";
const stat = (mtimeUs: number, size: number): FileStat => ({ mtimeUs, size });
const snap = (content: string, s: FileStat): DocumentSnapshot => ({ content, stat: s });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tab(over: Partial<OpenTab> = {}): OpenTab {
  return {
    path: DOC,
    content: "本地内容",
    dirty: false,
    lastSavedAt: null,
    diskContent: "本地内容",
    diskStat: stat(1_000, 8),
    diskMtime: 1,
    cursorPos: null,
    scrollTop: null,
    ...over,
  };
}

function reset(over: Partial<OpenTab> = {}, activePath = DOC) {
  useWorkspace.setState({
    openTabs: [tab(over)],
    activeTabPath: activePath,
    currentFile: activePath,
    currentContent: over.content ?? "本地内容",
    dirty: over.dirty ?? false,
    conflictPending: !!over.conflictPending,
    saveError: null,
  } as never);
}

const openConflictMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  isTauriMock.mockReturnValue(true);
  fileStatMock.mockReset();
  readDocumentMock.mockReset();
  vi.mocked(flushAllMarkdownPublishers).mockImplementation(() => {});
  useConflict.setState({ conflict: null, openConflict: openConflictMock });
});

describe("switchTab 磁盘核验（#362 §4.4）", () => {
  it("基线未变（stat 完全一致）时不做任何读取", async () => {
    reset();
    fileStatMock.mockResolvedValue(stat(1_000, 8));

    useWorkspace.getState().switchTab(DOC);
    await vi.waitFor(() => expect(fileStatMock).toHaveBeenCalledWith(DOC));

    expect(readDocumentMock).not.toHaveBeenCalled();
    expect(openConflictMock).not.toHaveBeenCalled();
  });

  it("仅 touch（stat 变了、内容等于旧基线）→ adopt 新基线，不弹冲突、不丢 dirty", async () => {
    reset({ content: "本地未保存编辑", dirty: true });
    const next = stat(2_000, 8);
    fileStatMock.mockResolvedValue(next);
    readDocumentMock.mockResolvedValue(snap("本地内容", next));

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => {
      const updated = useWorkspace.getState().openTabs[0];
      expect(updated.diskStat).toEqual(next);
    });
    const updated = useWorkspace.getState().openTabs[0];
    // 过渡期双写：diskMtime 必须由 diskStat 换算（与 diskStat 成对）
    expect(updated.diskMtime).toBe(2);
    expect(updated.dirty).toBe(true);
    expect(updated.content).toBe("本地未保存编辑");
    expect(openConflictMock).not.toHaveBeenCalled();
  });

  it("磁盘内容等于编辑器内容（same-as-write）→ adopt 并清 dirty，不写盘", async () => {
    reset({ content: "已写内容", diskContent: "旧基线", dirty: true });
    const next = stat(3_000, 12);
    fileStatMock.mockResolvedValue(next);
    readDocumentMock.mockResolvedValue(snap("已写内容", next));

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => {
      expect(useWorkspace.getState().openTabs[0].dirty).toBe(false);
    });
    const updated = useWorkspace.getState().openTabs[0];
    expect(updated.diskContent).toBe("已写内容");
    expect(updated.diskStat).toEqual(next);
    expect(updated.conflictPending).toBe(false);
    expect(openConflictMock).not.toHaveBeenCalled();
  });

  it("真冲突且 dirty → 置 conflictPending 并打开对话框，localContent 取 flush 后的最新内容", async () => {
    reset({ content: "本地内容", dirty: true });
    const next = stat(4_000, 16);
    fileStatMock.mockResolvedValue(next);
    readDocumentMock.mockResolvedValue(snap("外部内容（更长）", next));
    // 模拟编辑器在 flush 时把尾部输入发布进 store：对话框不得拿过期内容
    vi.mocked(flushAllMarkdownPublishers).mockImplementation(() => {
      const state = useWorkspace.getState();
      useWorkspace.setState({
        openTabs: state.openTabs.map((t) => ({ ...t, content: "本地内容 + 尾部输入" })),
        currentContent: "本地内容 + 尾部输入",
      });
    });

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => expect(openConflictMock).toHaveBeenCalledTimes(1));
    expect(openConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: DOC,
        localContent: "本地内容 + 尾部输入",
        diskContent: "外部内容（更长）",
      }),
    );
    expect(useWorkspace.getState().openTabs[0].conflictPending).toBe(true);
    expect(useWorkspace.getState().conflictPending).toBe(true);
  });

  it("真冲突但本地干净 → 直接 reloadFile 到磁盘内容（不打扰用户）", async () => {
    reset();
    const next = stat(5_000, 12);
    fileStatMock.mockResolvedValue(next);
    readDocumentMock.mockResolvedValue(snap("磁盘最新内容", next));

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => {
      expect(useWorkspace.getState().openTabs[0].content).toBe("磁盘最新内容");
    });
    const updated = useWorkspace.getState().openTabs[0];
    expect(updated.diskContent).toBe("磁盘最新内容");
    expect(updated.diskStat).toEqual(next);
    expect(updated.dirty).toBe(false);
    expect(openConflictMock).not.toHaveBeenCalled();
  });

  it("stat 超时/IO 期间基线被并发保存改写 → 用最新基线，不假冲突", async () => {
    reset({ content: "本地内容", dirty: true });
    const next = stat(6_000, 8);
    // await 期间另一条路径（并发 saveTab）已把基线与内容同步到磁盘
    fileStatMock.mockImplementation(async () => {
      useWorkspace.setState({
        openTabs: useWorkspace.getState().openTabs.map((t) => ({
          ...t,
          content: "本地内容",
          diskContent: "本地内容",
          diskStat: next,
          diskMtime: 6,
        })),
      });
      return next;
    });

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => expect(fileStatMock).toHaveBeenCalled());
    // 重取后的基线已是最新 → ③ 直接返回，不读盘、不判冲突
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readDocumentMock).not.toHaveBeenCalled();
    expect(openConflictMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().openTabs[0].dirty).toBe(true);
  });

  it("stat 返回 notFound → 删除态并清 stat 基线；不再读盘", async () => {
    reset();
    fileStatMock.mockRejectedValue({ code: "notFound", message: "文件不存在" });

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => {
      expect(useWorkspace.getState().openTabs[0].deletedOnDisk).toBe(true);
    });
    const updated = useWorkspace.getState().openTabs[0];
    expect(updated.diskStat).toBeUndefined();
    expect(updated.diskMtime).toBeUndefined();
    // 内容基线保留：文件重建时"仅 touch"仍可判定
    expect(updated.diskContent).toBe("本地内容");
    expect(readDocumentMock).not.toHaveBeenCalled();
  });

  it("stat 返回 permissionDenied → 只记 tab 错误，不标删除、不清基线", async () => {
    reset();
    fileStatMock.mockRejectedValue({ code: "permissionDenied", message: "拒绝访问" });

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => {
      expect(useWorkspace.getState().openTabs[0].saveError).toContain("拒绝访问");
    });
    const updated = useWorkspace.getState().openTabs[0];
    expect(updated.deletedOnDisk).toBeFalsy();
    expect(updated.diskStat).toEqual(stat(1_000, 8));
    expect(useWorkspace.getState().conflictPending).toBe(false);
  });

  it("stat 返回 notAFile（原路径被同名目录占位）→ 进删除态，与 watcher 同语义", async () => {
    reset();
    fileStatMock.mockRejectedValue({ code: "notAFile", message: "目标路径不是普通文件: /w/a.md" });

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => {
      expect(useWorkspace.getState().openTabs[0].deletedOnDisk).toBe(true);
    });
    const updated = useWorkspace.getState().openTabs[0];
    // 不是「文件仍在」：清掉 stat 基线，保留内容基线（文件被恢复时仍可判「仅 touch」）
    expect(updated.diskStat).toBeUndefined();
    expect(updated.diskContent).toBe("本地内容");
    expect(readDocumentMock).not.toHaveBeenCalled();
    expect(openConflictMock).not.toHaveBeenCalled();
  });

  it("删除态下 stat 相同仍需读盘：同 mtime+size 重建且内容不同 → 退出删除态并报冲突", async () => {
    reset({ deletedOnDisk: true, dirty: true, content: "本地未保存改动" });
    const same = stat(1_000, 8);
    fileStatMock.mockResolvedValue(same);
    readDocumentMock.mockResolvedValue(snap("重建后的不同内容", same));

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => expect(openConflictMock).toHaveBeenCalledTimes(1));
    const updated = useWorkspace.getState().openTabs[0];
    expect(updated.deletedOnDisk).toBe(false);
    expect(updated.conflictPending).toBe(true);
    // 本地编辑不被磁盘内容覆盖
    expect(updated.content).toBe("本地未保存改动");
  });

  it("删除态下同 stat 重建且内容等于编辑器内容 → adopt 并清删除态/脏标记", async () => {
    reset({ deletedOnDisk: true, dirty: true, content: "本地未保存改动" });
    const same = stat(1_000, 8);
    fileStatMock.mockResolvedValue(same);
    readDocumentMock.mockResolvedValue(snap("本地未保存改动", same));

    useWorkspace.getState().switchTab(DOC);

    await vi.waitFor(() => {
      expect(useWorkspace.getState().openTabs[0].dirty).toBe(false);
    });
    const updated = useWorkspace.getState().openTabs[0];
    expect(updated.deletedOnDisk).toBe(false);
    expect(updated.diskStat).toEqual(same);
    expect(openConflictMock).not.toHaveBeenCalled();
  });

  it("核验在途时切到别的 tab：不弹窗、不置 conflictPending；切回来仍会弹", async () => {
    const OTHER = "/w/b.md";
    useWorkspace.setState({
      openTabs: [
        tab({ content: "a 的本地改动", dirty: true }),
        {
          path: OTHER,
          content: "b 内容",
          dirty: false,
          lastSavedAt: null,
          diskContent: "b 内容",
          diskStat: stat(1_000, 8),
          diskMtime: 1,
          cursorPos: null,
          scrollTop: null,
        },
      ],
      activeTabPath: DOC,
      currentFile: DOC,
      currentContent: "a 的本地改动",
      dirty: true,
      conflictPending: false,
      saveError: null,
    } as never);

    // a：stat 变了 → 进入成对读盘并挂起；b：基线未变 → 直接返回
    const next = stat(2_000, 16);
    fileStatMock.mockImplementation(async (path: string) => (path === DOC ? next : stat(1_000, 8)));
    const pendingRead = deferred<DocumentSnapshot>();
    readDocumentMock.mockReturnValue(pendingRead.promise);

    useWorkspace.getState().switchTab(DOC);
    await vi.waitFor(() => expect(readDocumentMock).toHaveBeenCalledWith(DOC));

    // 读盘返回前用户切到 b
    useWorkspace.getState().switchTab(OTHER);
    expect(useWorkspace.getState().activeTabPath).toBe(OTHER);

    pendingRead.resolve(snap("外部内容", next));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 后台 tab 不得弹模态框、不得置 conflictPending（否则对话框作用在用户没看的文件上）
    expect(openConflictMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().openTabs[0].conflictPending).toBeFalsy();
    expect(useWorkspace.getState().conflictPending).toBe(false);
    expect(useWorkspace.getState().openTabs[0].content).toBe("a 的本地改动");

    // 切回 a：重新核验 → 这次是活跃 tab，正常弹冲突
    readDocumentMock.mockResolvedValue(snap("外部内容", next));
    useWorkspace.getState().switchTab(DOC);
    await vi.waitFor(() => expect(openConflictMock).toHaveBeenCalledTimes(1));
    expect(useWorkspace.getState().openTabs[0].conflictPending).toBe(true);
  });

  it("tab 在 await 期间被关闭 → 不产生任何副作用", async () => {
    reset();
    let resolveStat!: (value: FileStat) => void;
    fileStatMock.mockReturnValue(new Promise<FileStat>((resolve) => (resolveStat = resolve)));

    useWorkspace.getState().switchTab(DOC);
    useWorkspace.setState({ openTabs: [], activeTabPath: null, currentFile: null } as never);
    resolveStat(stat(9_000, 8));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readDocumentMock).not.toHaveBeenCalled();
    expect(openConflictMock).not.toHaveBeenCalled();
    expect(useWorkspace.getState().openTabs).toEqual([]);
  });
});

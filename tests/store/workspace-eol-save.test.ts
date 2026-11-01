// 换行保真保存链路单测（issue #368）
//
// 锁定 saveCurrent / ensureTab / reloadFile / setTabDiskContent 的换行元数据流转：
// - 读取时检测 EOL 存入 tab（detectEol），保存写盘前按原风格还原（applyEol）；
// - diskContent 基线记录写盘字节（含换行还原），后续冲突比对不失配；
// - 混合换行按主导风格归一并 console.warn 告警；
// - 合并保存（草稿另存到已打开文件）沿用目标文件的换行风格；
// - reloadFile / 冲突基线同步时换行元数据随磁盘内容重检。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { readTextFileMock, writeTextFileMock, fileMtimeMock, isTauriMock, saveDialogMock } =
  vi.hoisted(() => ({
    readTextFileMock: vi.fn(),
    writeTextFileMock: vi.fn(),
    fileMtimeMock: vi.fn(),
    isTauriMock: vi.fn(() => true),
    saveDialogMock: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: isTauriMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  save: saveDialogMock,
}));

vi.mock("../../src/lib/fs", () => ({
  readTextFile: readTextFileMock,
  writeTextFile: writeTextFileMock,
  fileMtime: fileMtimeMock,
}));

import { useWorkspace } from "../../src/store/workspace";

function diskTab(path: string, internal: string, eol: OpenTab["eol"]): OpenTab {
  return {
    path,
    content: internal,
    cursorPos: null,
    scrollTop: null,
    dirty: true,
    isUntitled: false,
    diskContent: undefined,
    diskMtime: 1_000,
    lastSavedAt: null,
    ...(eol !== undefined ? { eol } : {}),
  };
}

function setState(next: Partial<ReturnType<typeof useWorkspace.getState>>) {
  useWorkspace.setState(next as any);
}

describe("saveCurrent 换行保真（#368）", () => {
  beforeEach(() => {
    readTextFileMock.mockReset().mockResolvedValue("磁盘基线");
    writeTextFileMock.mockReset().mockResolvedValue(undefined);
    fileMtimeMock.mockReset().mockResolvedValue(1_000);
    isTauriMock.mockReset();
    isTauriMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("CRLF 文件：内部 LF 内容保存写盘时还原为 CRLF，基线记录写盘字节", async () => {
    const internal = "# 标题\n\n正文段落。\n";
    setState({
      openTabs: [diskTab("/docs/a.md", internal, "crlf")],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: internal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    const expected = "# 标题\r\n\r\n正文段落。\r\n";
    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", expected);
    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/docs/a.md");
    // 基线 = 实际写盘字节（CRLF），下一次保存的外部比对才不会误判冲突
    expect(tab?.diskContent).toBe(expected);
    // 内部表示保持 LF（编辑器统一表示不受影响）
    expect(tab?.content).toBe(internal);
    expect(tab?.dirty).toBe(false);
  });

  it("LF 文件：保存原样写出，不引入 CR", async () => {
    const internal = "# 标题\n\n正文段落。\n";
    setState({
      openTabs: [diskTab("/docs/a.md", internal, "lf")],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: internal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", internal);
  });

  it("无换行元数据（原文件无换行 / 新建转正）：原样写出，不凭空转换", async () => {
    const internal = "hello\nworld\n";
    setState({
      openTabs: [diskTab("/docs/a.md", internal, undefined)],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: internal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", "hello\nworld\n");
  });

  it("混合换行：按主导风格归一写盘并 console.warn 告警", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const internal = "# 标题\n\n正文段落。\n";
    const tab = { ...diskTab("/docs/a.md", internal, "crlf"), eolMixed: true };
    setState({
      openTabs: [tab],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: internal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith(
      "/docs/a.md",
      "# 标题\r\n\r\n正文段落。\r\n",
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("混合换行");
    expect(warnSpy.mock.calls[0][0]).toContain("/docs/a.md");
  });

  it("混合换行但主导风格为 lf：写 LF 并告警", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const internal = "# 标题\n\n正文段落。\n";
    const tab = { ...diskTab("/docs/a.md", internal, "lf"), eolMixed: true };
    setState({
      openTabs: [tab],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: internal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith("/docs/a.md", internal);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("混合换行保存后清除 eolMixed：连续保存只告警一次（磁盘已归一，不再重复提示）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const internal = "# 标题\n\n正文段落。\n";
    const tab = { ...diskTab("/docs/a.md", internal, "crlf"), eolMixed: true };
    setState({
      openTabs: [tab],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: internal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    // 第一次保存：告警 + eolMixed 清空
    await useWorkspace.getState().saveCurrent();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(
      useWorkspace.getState().openTabs.find((t) => t.path === "/docs/a.md")?.eolMixed,
    ).toBeUndefined();

    // 第二次保存（继续编辑后再存）：磁盘已统一 CRLF，不得再刷告警
    const edited = "# 标题\n\n正文段落（改）。\n";
    setState({
      openTabs: [
        {
          ...useWorkspace.getState().openTabs.find((t) => t.path === "/docs/a.md")!,
          content: edited,
          dirty: true,
        },
      ],
      currentContent: edited,
      dirty: true,
    });
    await useWorkspace.getState().saveCurrent();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(writeTextFileMock).toHaveBeenLastCalledWith("/docs/a.md", "# 标题\r\n\r\n正文段落（改）。\r\n");
  });

  it("合并保存（草稿另存到已打开的 CRLF 文件）：写盘沿用目标文件换行风格", async () => {
    saveDialogMock.mockReset().mockResolvedValue("/docs/target.md");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const draftInternal = "# 草稿内容\n\n新段落。\n";
    const targetInternal = "# 原目标内容\n";
    setState({
      openTabs: [
        {
          path: "untitled-1",
          content: draftInternal,
          cursorPos: null,
          scrollTop: null,
          dirty: true,
          isUntitled: true,
          lastSavedAt: null,
        },
        {
          path: "/docs/target.md",
          content: targetInternal,
          cursorPos: null,
          scrollTop: null,
          dirty: false,
          isUntitled: false,
          diskContent: "# 原目标内容\r\n",
          diskMtime: 1_000,
          lastSavedAt: null,
          eol: "crlf" as const,
          eolMixed: true,
        },
      ],
      activeTabPath: "untitled-1",
      currentFile: "untitled-1",
      currentContent: draftInternal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    expect(writeTextFileMock).toHaveBeenCalledWith(
      "/docs/target.md",
      "# 草稿内容\r\n\r\n新段落。\r\n",
    );
    // 混合换行告警指向被归一化的目标文件，而不是草稿路径（评审 P1）
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("/docs/target.md");
    expect(warnSpy.mock.calls[0][0]).not.toContain("untitled-1");
    const state = useWorkspace.getState();
    const target = state.openTabs.find((t) => t.path === "/docs/target.md");
    expect(target?.diskContent).toBe("# 草稿内容\r\n\r\n新段落。\r\n");
    // 目标 tab 内容承接草稿的内部表示（LF），元数据保持目标的 crlf
    expect(target?.content).toBe(draftInternal);
    expect(target?.eol).toBe("crlf");
    // 写盘已归一，eolMixed 必须清空（否则后续每次保存重复告警）
    expect(target?.eolMixed).toBeUndefined();
    // 草稿已并入目标关闭
    expect(state.openTabs.some((t) => t.path === "untitled-1")).toBe(false);
  });

  it("合并路径窗口期目标有新编辑：保留 dirty 但 eolMixed 仍清空", async () => {
    saveDialogMock.mockReset().mockResolvedValue("/docs/target.md");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const draftInternal = "# 草稿内容\n";
    // 写盘窗口期给目标 tab 追加新编辑（内容相对入口快照变化）
    writeTextFileMock.mockImplementation(async () => {
      useWorkspace.setState((current) => ({
        openTabs: current.openTabs.map((t) =>
          t.path === "/docs/target.md" ? { ...t, content: "# 窗口期新编辑\n", dirty: true } : t,
        ),
      }));
    });
    setState({
      openTabs: [
        {
          path: "untitled-1",
          content: draftInternal,
          cursorPos: null,
          scrollTop: null,
          dirty: true,
          isUntitled: true,
          lastSavedAt: null,
        },
        {
          path: "/docs/target.md",
          content: "# 原目标内容\n",
          cursorPos: null,
          scrollTop: null,
          dirty: false,
          isUntitled: false,
          diskContent: "# 原目标内容\r\n",
          diskMtime: 1_000,
          lastSavedAt: null,
          eol: "crlf" as const,
          eolMixed: true,
        },
      ],
      activeTabPath: "untitled-1",
      currentFile: "untitled-1",
      currentContent: draftInternal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const target = useWorkspace
      .getState()
      .openTabs.find((t) => t.path === "/docs/target.md");
    // 窗口期新编辑保留（dirty 不清），但 eolMixed 描述的是已归一化的磁盘，必须清
    expect(target?.dirty).toBe(true);
    expect(target?.content).toBe("# 窗口期新编辑\n");
    expect(target?.eolMixed).toBeUndefined();
    expect(target?.eol).toBe("crlf");
  });

  it("合并路径窗口期目标被关闭（草稿承接）：eolMixed 清空、eol 跟随目标", async () => {
    saveDialogMock.mockReset().mockResolvedValue("/docs/target.md");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const draftInternal = "# 草稿内容\n";
    // 写盘窗口期关闭目标 tab → 走「草稿承接已保存路径」分支
    writeTextFileMock.mockImplementation(async () => {
      useWorkspace.getState().closeTab("/docs/target.md");
    });
    setState({
      openTabs: [
        {
          path: "untitled-1",
          content: draftInternal,
          cursorPos: null,
          scrollTop: null,
          dirty: true,
          isUntitled: true,
          lastSavedAt: null,
        },
        {
          path: "/docs/target.md",
          content: "# 原目标内容\n",
          cursorPos: null,
          scrollTop: null,
          dirty: false,
          isUntitled: false,
          diskContent: "# 原目标内容\r\n",
          diskMtime: 1_000,
          lastSavedAt: null,
          eol: "crlf" as const,
          eolMixed: true,
        },
      ],
      activeTabPath: "untitled-1",
      currentFile: "untitled-1",
      currentContent: draftInternal,
      dirty: true,
      saving: false,
      saveError: null,
    });

    await useWorkspace.getState().saveCurrent();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const carried = useWorkspace.getState().openTabs.find((t) => t.path === "/docs/target.md");
    expect(carried?.isUntitled).toBe(false);
    expect(carried?.eol).toBe("crlf");
    // 注意：草稿 tab 本身不携带 eolMixed，本场景下该字段天然为 undefined；
    // 此断言锚定的是「禁止从 mergeTarget 拷贝 eolMixed」这一具体回退形态
    // （写成 eolMixed: mergeTarget.eolMixed 会得到 true 而变红）。
    expect(carried?.eolMixed).toBeUndefined();
    expect(carried?.diskContent).toBe("# 草稿内容\r\n");
  });

  it("打开文件时按磁盘内容检测换行风格并存入 tab", async () => {
    readTextFileMock.mockResolvedValue("# 磁盘内容\r\n\r\nCRLF 正文。\r\n");
    setState({
      openTabs: [],
      activeTabPath: null,
      currentFile: null,
      currentContent: "",
      dirty: false,
    });

    await useWorkspace.getState().openFile("/docs/disk-crlf.md");

    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/docs/disk-crlf.md");
    expect(tab?.eol).toBe("crlf");
    expect(tab?.eolMixed).toBeUndefined();
    // 内容保持磁盘原样（含 CRLF），编辑器往返后才归一为 LF
    expect(tab?.content).toBe("# 磁盘内容\r\n\r\nCRLF 正文。\r\n");
  });

  it("打开混合换行文件：记录主导风格与 mixed 标记", async () => {
    readTextFileMock.mockResolvedValue("a\r\nb\nc\r\n");
    setState({ openTabs: [], activeTabPath: null, currentFile: null, currentContent: "", dirty: false });

    await useWorkspace.getState().openFile("/docs/mixed.md");

    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/docs/mixed.md");
    expect(tab?.eol).toBe("crlf");
    expect(tab?.eolMixed).toBe(true);
  });

  it("reloadFile 重载后换行风格随磁盘内容重检（crlf → lf）", async () => {
    const crlfTab = {
      ...diskTab("/docs/a.md", "# 旧内容\n", "crlf"),
      dirty: false,
    };
    setState({
      openTabs: [crlfTab],
      activeTabPath: "/docs/a.md",
      currentFile: "/docs/a.md",
      currentContent: "# 旧内容\n",
      dirty: false,
    });
    readTextFileMock.mockResolvedValue("# 新内容\n\n外部改成 LF 了。\n");

    await useWorkspace.getState().reloadFile("/docs/a.md");

    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/docs/a.md");
    expect(tab?.eol).toBe("lf");
    expect(tab?.eolMixed).toBeUndefined();
  });

  it("冲突「继续编辑」同步基线（setTabDiskContent）时换行风格重检", async () => {
    const crlfTab = {
      ...diskTab("/docs/a.md", "# 本地内容\n", "crlf"),
      dirty: true,
    };
    setState({ openTabs: [crlfTab], activeTabPath: "/docs/a.md" });

    useWorkspace.getState().setTabDiskContent("/docs/a.md", "# 外部 LF 版本\n");

    const tab = useWorkspace.getState().openTabs.find((t) => t.path === "/docs/a.md");
    expect(tab?.eol).toBe("lf");
    expect(tab?.diskContent).toBe("# 外部 LF 版本\n");
  });
});

// #365 / #378 崩溃恢复：检测 → 恢复 / 丢弃 → TTL 清理
//
// 这一层的失败模式都是「拿错东西覆盖用户已改好的文件」，所以恢复语义类断言都落在
// 文件系统状态与恢复出来的 tab 属性上（dirty / 无磁盘基线），不看调用次数；
// 唯一例外是 #409 的默认 IO 接线用例：它必须断言「真实命令被谁以什么参数调用」，
// 因为那条链路要证的正是 listDirFiles → 判龄 → deletePath 的接线本身。

import { beforeEach, describe, expect, it, vi } from "vitest";

// #404：应用数据根走 `app_data_root` 命令（便携模式下不再是 Roaming AppData）；
// 便携迁移报告由 `take_portable_migration` 一次性取走（默认没有迁移）
const portable = vi.hoisted(() => ({ migration: null as null | Record<string, unknown> }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string) => {
    if (cmd === "app_data_root") return "/appdata";
    if (cmd === "take_portable_migration") return portable.migration;
    return null;
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
  flushMarkdownPublishersForPath: vi.fn(),
}));

// `applyRecovery` 对「有路径的草稿」会读一次当前磁盘基线，避免保存时静默覆盖
const {
  readDocumentMock,
  saveDocumentMock,
  readTextFileMock,
  readRecoveryFileMock,
  listDirFilesMock,
  deletePathMock,
} = vi.hoisted(() => ({
  readDocumentMock: vi.fn(),
  readTextFileMock: vi.fn(async (_path: string) => "基线"),
  readRecoveryFileMock: vi.fn(async (_path: string) => "基线"),
  listDirFilesMock: vi.fn(async (_dirPath: string) => [] as Array<{
    name: string;
    isDir: boolean;
    size: number;
    mtimeUs: number;
  }>),
  deletePathMock: vi.fn(async (_path: string) => undefined),
  saveDocumentMock: vi.fn(async (_p: string, content: string) => ({
    kind: "written" as const,
    stat: { mtimeUs: 9_000, size: content.length },
    foreignWrite: false,
  })),
}));
vi.mock("../../src/lib/fs", () => ({
  readDocument: readDocumentMock,
  saveDocument: saveDocumentMock,
  readTextFile: readTextFileMock,
  readRecoveryFile: readRecoveryFileMock,
  listDirFiles: listDirFilesMock,
  deletePath: deletePathMock,
  fileMtime: vi.fn(async () => 5),
  fileStat: vi.fn(async () => ({ mtimeUs: 5_000, size: 4 })),
  writeTextFile: vi.fn(async () => undefined),
  writeRecoveryFile: vi.fn(async () => undefined),
}));
const { messageMock } = vi.hoisted(() => ({ messageMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ message: messageMock, ask: vi.fn(), save: vi.fn() }));

import {
  __setRecoveryIo,
  DRAFT_TTL_MS,
  applyRecovery,
  beginSession,
  cleanupExpiredDrafts,
  discardDrafts,
  findRecoverableDrafts,
  listDrafts,
  markDraftsHandled,
  readSessionMarker,
} from "../../src/lib/session-recovery";
import { currentSessionId } from "../../src/lib/draft-journal";
import {
  __resetCursorCheckpoint,
  __setCursorIo,
  flushCursorCheckpoint,
  scheduleCursorCheckpoint,
} from "../../src/lib/cursor-checkpoint";
import { useWorkspace } from "../../src/store/workspace";

const SESSION = "/appdata/recovery/main/session.json";
const DRAFTS = "/appdata/recovery/main/drafts";

const files = new Map<string, string>();
/** 文件 mtime（微秒）：模拟旧归档缺 archivedAt 时用磁盘时间判龄 */
const fileMtimeUs = new Map<string, number>();
let failDelete = false;
/** 只让指定前缀的删除失败：用于「草稿删不掉、归档仍可删」的场景 */
let failDeleteOnlyPrefix: string | null = null;

function draftFile(path: string): string {
  const key = Buffer.from(path, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${DRAFTS}/${key}.json`;
}

function seedDraft(
  tabPath: string,
  opts: {
    content?: string;
    updatedAt?: number;
    pinned?: boolean;
    isUntitled?: boolean;
    sessionId?: string;
  } = {},
): string {
  const file = draftFile(tabPath);
  files.set(
    file,
    JSON.stringify({
      version: 1,
      draftId: file,
      sessionId: opts.sessionId ?? "s1",
      tabPath,
      isUntitled: !!opts.isUntitled,
      title: tabPath.split("/").pop(),
      content: opts.content ?? "未保存内容",
      pinned: !!opts.pinned,
      updatedAt: opts.updatedAt ?? Date.now(),
    }),
  );
  return file;
}

beforeEach(() => {
  files.clear();
  fileMtimeUs.clear();
  failDelete = false;
  failDeleteOnlyPrefix = null;
  portable.migration = null;
  readDocumentMock
    .mockReset()
    .mockResolvedValue({ content: "磁盘内容", stat: { mtimeUs: 5_000, size: 4 } });
  readTextFileMock.mockReset().mockResolvedValue("磁盘内容");
  readRecoveryFileMock.mockReset().mockResolvedValue("磁盘内容");
  listDirFilesMock.mockReset().mockResolvedValue([]);
  deletePathMock.mockReset().mockResolvedValue(undefined);
  saveDocumentMock.mockClear();
  __setRecoveryIo({
    appDataDir: async () => "/appdata",
    readTextFile: async (path) => {
      const v = files.get(path);
      if (v === undefined) throw new Error("not found");
      return v;
    },
    writeTextFile: async (path, content) => {
      files.set(path, content);
    },
    listDir: async (path) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
      }
      return [...names].map((name) => ({
        name,
        isDir: false,
        mtimeUs: fileMtimeUs.get(`${prefix}${name}`),
      }));
    },
    deletePath: async (path) => {
      const targeted = failDeleteOnlyPrefix !== null && path.startsWith(failDeleteOnlyPrefix);
      if (failDelete || targeted) throw new Error("EIO: 删除失败");
      files.delete(path);
    },
  });
  useWorkspace.setState({ openTabs: [], activeTabPath: null, dirty: false } as never);
});

describe("#365 崩溃检测", () => {
  it("上次正常退出（cleanExit:true）→ 不提示、不返回草稿", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: true }));
    seedDraft("/w/a.md");

    expect(await findRecoverableDrafts()).toEqual([]);
  });

  it("上次非正常退出 → 返回草稿（含正文与 title），按 updatedAt 倒序", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/old.md", { content: "旧", updatedAt: 1_000 });
    seedDraft("/w/new.md", { content: "新", updatedAt: 2_000 });

    const drafts = await findRecoverableDrafts();

    expect(drafts.map((d) => d.tabPath)).toEqual(["/w/new.md", "/w/old.md"]);
    expect(drafts[0].content).toBe("新");
    expect(drafts[0].title).toBe("new.md");
  });

  it("标记文件不存在 / 损坏 → 不提示（不猜测）", async () => {
    seedDraft("/w/a.md");
    expect(await readSessionMarker()).toBeNull();
    expect(await findRecoverableDrafts()).toEqual([]);

    files.set(SESSION, "{ 坏 json");
    expect(await readSessionMarker()).toBeNull();
  });

  it("真实启动顺序：上次正常退出 + 残留草稿 → 不提示（beginSession 不得覆盖判断依据）", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: true }));
    seedDraft("/w/leftover.md", { updatedAt: 1_000 });

    // 真实顺序：beginSession() 会把标记改写成 false，所以调用方必须用它返回的旧标记
    const previous = await beginSession();
    expect(previous?.cleanExit).toBe(true);
    expect(await findRecoverableDrafts(previous)).toEqual([]);
    // 反证：若不传旧标记（读到的已是 false），就会误报
    expect((await findRecoverableDrafts()).length).toBe(1);
  });

  it("beginSession 先落 cleanExit:false（进程被杀下次才有提示）", async () => {
    await beginSession(1_234);

    const marker = JSON.parse(files.get(SESSION)!);
    expect(marker.cleanExit).toBe(false);
    expect(marker.windowLabel).toBe("main");
  });
});

describe("#365 恢复与丢弃", () => {
  it("applyRecovery 恢复成 dirty tab，并带上当前磁盘基线（否则保存会静默覆盖）", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    // 显式 updatedAt：缺省用 Date.now() 时两条可能同毫秒，跨毫秒会让顺序翻转（曾偶发红）
    seedDraft("/w/a.md", { content: "崩溃前的内容", updatedAt: 2_000 });
    seedDraft("untitled-1", { content: "草稿正文", isUntitled: true, updatedAt: 1_000 });

    const drafts = await listDrafts();
    const restored = await applyRecovery(drafts);

    expect(restored.restored).toBe(2);
    expect(restored.restoredPaths).toEqual(["/w/a.md", "untitled-1"]);
    const state = useWorkspace.getState();
    expect(state.openTabs.map((t) => t.path)).toEqual(["/w/a.md", "untitled-1"]);
    expect(state.openTabs[0].content).toBe("崩溃前的内容");
    expect(state.openTabs[0].dirty).toBe(true);
    // 有路径的 tab 必须带当前磁盘基线：空白线会让 saveTab 的一致性预检永远判「没冲突」
    expect(state.openTabs[0].diskContent).toBe("磁盘内容");
    expect(state.openTabs[0].diskStat).toEqual({ mtimeUs: 5_000, size: 4 });
    expect(state.openTabs[0].diskMtime).toBe(5);
    // 无标题草稿没有磁盘基线
    expect(state.openTabs[1].isUntitled).toBe(true);
    expect(state.openTabs[1].diskStat).toBeUndefined();
    expect(state.activeTabPath).toBe("/w/a.md");
  });

  it("已打开的干净 tab：草稿内容合并进来（不新建重复 tab）", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    const draftFile = seedDraft("/w/a.md", { content: "草稿" });
    useWorkspace.setState({
      openTabs: [{ path: "/w/a.md", content: "上次磁盘内容", dirty: false }],
      activeTabPath: "/w/a.md",
    } as never);

    const restored = await applyRecovery(await listDrafts());

    expect(restored.restored).toBe(0);
    expect(restored.restoredPaths).toEqual(["/w/a.md"]);
    const state = useWorkspace.getState();
    expect(state.openTabs).toHaveLength(1);
    expect(state.openTabs[0].content).toBe("草稿");
    expect(state.openTabs[0].dirty).toBe(true);
    // 合并后 content 只在编辑器里（未保存），草稿文件必须留着
    expect(files.has(draftFile)).toBe(true);
  });

  it("合并进已打开的干净 tab 时也恢复光标；本次会话已有光标则不覆盖", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/open.md", { content: "草稿", updatedAt: 1_000 });
    __setCursorIo({
      appDataDir: async () => "/appdata",
      readRecoveryFile: async () =>
        JSON.stringify({
          version: 1,
          tabs: { "/w/open.md": { pos: 9, scrollTop: 7, updatedAt: 1 } },
        }),
      writeTextFile: async () => undefined,
    });
    useWorkspace.setState({
      openTabs: [
        { path: "/w/open.md", content: "磁盘", dirty: false, cursorPos: null, scrollTop: null },
      ],
      activeTabPath: "/w/open.md",
    } as never);

    await applyRecovery(await listDrafts());
    const merged = useWorkspace.getState().openTabs[0];
    expect(merged.content).toBe("草稿");
    expect(merged.cursorPos).toBe(9);
    expect(merged.scrollTop).toBe(7);

    // 第二次：本次会话已设过视口位置，不能被上次会话的 checkpoint 覆盖
    useWorkspace.setState({
      openTabs: [
        { path: "/w/open.md", content: "磁盘", dirty: false, cursorPos: 42, scrollTop: 11 },
      ],
    } as never);
    await applyRecovery(await listDrafts());
    expect(useWorkspace.getState().openTabs[0].cursorPos).toBe(42);

    __setCursorIo(null);
    __resetCursorCheckpoint();
  });

  it("同一批里同时有合并与新建：合并结果不能被随后的 setState 回滚", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/open.md", { content: "合并进来的内容", updatedAt: 3_000 });
    seedDraft("/w/new.md", { content: "新 tab 内容", updatedAt: 2_000 });
    useWorkspace.setState({
      openTabs: [{ path: "/w/open.md", content: "上次磁盘内容", dirty: false }],
      activeTabPath: "/w/open.md",
    } as never);

    await applyRecovery(await listDrafts());

    const tabs = useWorkspace.getState().openTabs;
    expect(tabs).toHaveLength(2);
    const openTab = tabs.find((t) => t.path === "/w/open.md")!;
    expect(openTab.content).toBe("合并进来的内容");
    expect(openTab.dirty).toBe(true);
    expect(tabs.some((t) => t.path === "/w/new.md")).toBe(true);
  });

  it("已打开的 tab 有本地修改：不覆盖用户内容，草稿保留", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    const draftFile = seedDraft("/w/a.md", { content: "草稿" });
    useWorkspace.setState({
      openTabs: [{ path: "/w/a.md", content: "当前编辑中", dirty: true }],
      activeTabPath: "/w/a.md",
    } as never);

    const restored = await applyRecovery(await listDrafts());

    expect(restored.restored).toBe(0);
    expect(useWorkspace.getState().openTabs[0].content).toBe("当前编辑中");
    expect(files.has(draftFile)).toBe(true);
  });

  it("文件已被删除的草稿：恢复后没有磁盘基线（保存会被 mustExist 拒，不会复活）", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/gone.md", { updatedAt: 1_000 });
    readDocumentMock.mockRejectedValueOnce(new Error("not found"));

    await applyRecovery(await listDrafts());

    const restored = useWorkspace.getState().openTabs[0];
    expect(restored.path).toBe("/w/gone.md");
    expect(restored.diskStat).toBeUndefined();
    expect(restored.diskContent).toBeUndefined();
  });

  it("discardDrafts 真删文件", async () => {
    const file = seedDraft("/w/a.md");
    const drafts = await listDrafts();

    const deleted = await discardDrafts(drafts);

    expect(deleted).toBe(1);
    expect(files.has(file)).toBe(false);
  });
});

describe("#365 恢复出的 tab 必须保留磁盘换行风格", () => {
  it("CRLF 文件恢复后保存：写盘内容仍含 \\r\\n（否则整份文件被改成 LF）", async () => {
    const crlf = "第一行\r\n第二行\r\n";
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/a.md", { content: "第一行\r\n第二行\r\n崩溃新增", updatedAt: Date.now() });
    readDocumentMock.mockResolvedValue({ content: crlf, stat: { mtimeUs: 5_000, size: crlf.length } });
    // 写前比对读到的磁盘内容必须与基线一致，否则会走冲突询问而不是直接写
    readTextFileMock.mockResolvedValue(crlf);

    await applyRecovery(await listDrafts());

    const tab = useWorkspace.getState().openTabs[0];
    expect(tab.eol).toBe("crlf");
    expect(tab.finalNewline).toBe(true);

    await useWorkspace.getState().saveTab("/w/a.md", { interactive: true });

    const written = saveDocumentMock.mock.calls.at(-1)?.[1] as string;
    expect(written).toContain("\r\n");
    expect(written.includes("\n") && !written.includes("\r\n")).toBe(false);
  });
});

describe("#365 恢复出来的内容不能被自动保存立刻写盘", () => {
  it("恢复后 3s 内不排自动保存；用户编辑一次之后才回到调度", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/a.md", { content: "崩溃前的内容", updatedAt: Date.now() });
    await applyRecovery(await listDrafts());

    // 只看「调度器有没有排这次保存」：真的走 saveTab 会牵扯写前预检与冲突弹窗，
    // 那是 save-receipt 用例的职责，这里只需证明 recovered 被跳过
    const saveTabMock = vi.fn(async () => undefined);
    useWorkspace.setState({ saveTab: saveTabMock as never });

    vi.useFakeTimers();
    try {
      const { renderHook } = await import("@testing-library/react");
      const { useAutoSave } = await import("../../src/lib/useAutoSave");
      renderHook(() => useAutoSave());

      await vi.advanceTimersByTimeAsync(3_000);
      // 基线是「恢复时刻的磁盘内容」：自动写盘会静默覆盖停机期间的外部修改
      expect(saveTabMock).not.toHaveBeenCalled();

      // 用户真的动手了：标记失效，2s 后正常自动保存
      useWorkspace.getState().setContent("恢复了并继续编辑");
      await vi.advanceTimersByTimeAsync(2_100);
      expect(saveTabMock).toHaveBeenCalledTimes(1);
      expect(useWorkspace.getState().openTabs[0].recovered).toBe(false);
    } finally {
      // 断言失败也必须还原，否则假定时器会污染后续用例（上一版就是这样连累 4 条）
      vi.useRealTimers();
    }
  });
});

describe("#378 崩溃重启链路（注入 IO 的端到端模拟）", () => {
  it("上次异常退出 → 重启 → 命名/未命名/后台 dirty 草稿都恢复，光标随 checkpoint 回来，草稿不删", async () => {
    // 光标 checkpoint 与草稿正文分文件存；这里用同一份内存文件系统模拟真实重启后的磁盘
    __setCursorIo({
      appDataDir: async () => "/appdata",
      readRecoveryFile: async (path) => files.get(path) ?? "",
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
    });
    // 走**真实的写入侧**：节流登记 → 立即 flush，而不是手工播种 JSON
    scheduleCursorCheckpoint("/w/named.md", 12, 80, 1);
    scheduleCursorCheckpoint("untitled-1", 3, 0, 1);
    expect(await flushCursorCheckpoint()).toBe(true);
    files.set(
      SESSION,
      JSON.stringify({ version: 1, sessionId: "s-crashed", startedAt: 1_000, cleanExit: false }),
    );
    const named = seedDraft("/w/named.md", {
      content: "命名文档正文",
      updatedAt: 1_100,
      sessionId: "s-crashed",
    });
    const untitled = seedDraft("untitled-1", {
      content: "未命名草稿正文",
      updatedAt: 1_200,
      sessionId: "s-crashed",
      isUntitled: true,
    });
    const background = seedDraft("/w/background.md", {
      content: "后台 tab 的改动",
      updatedAt: 1_300,
      sessionId: "s-crashed",
    });

    // 重启：先读旧标记再写新标记，随后用旧标记筛选草稿并恢复
    const previous = await beginSession(2_000);
    const recoverable = await findRecoverableDrafts(previous);
    expect(recoverable).toHaveLength(3);

    const result = await applyRecovery(recoverable);
    expect(result.restored).toBe(3);

    const tabs = useWorkspace.getState().openTabs;
    expect(tabs.map((t) => t.path).sort()).toEqual(
      ["/w/named.md", "/w/background.md", "untitled-1"].sort(),
    );
    const namedTab = tabs.find((t) => t.path === "/w/named.md")!;
    expect(namedTab.content).toBe("命名文档正文");
    expect(namedTab.cursorPos).toBe(12);
    expect(namedTab.scrollTop).toBe(80);
    expect(namedTab.recovered).toBe(true);
    expect(tabs.find((t) => t.path === "untitled-1")!.isUntitled).toBe(true);
    expect(tabs.find((t) => t.path === "untitled-1")!.cursorPos).toBe(3);
    expect(tabs.find((t) => t.path === "/w/background.md")!.content).toBe("后台 tab 的改动");

    // 恢复不删草稿：内容此刻只落在编辑器里（下一次编辑前不会有新副本）
    expect(files.has(named)).toBe(true);
    expect(files.has(untitled)).toBe(true);
    expect(files.has(background)).toBe(true);

    // 全局 IO / pending / timer 不能泄漏给本文件后续用例
    __setCursorIo(null);
    __resetCursorCheckpoint();
  });
});

describe("#365 会话归档与「已处理」的会话维度", () => {
  function seedCrashed(startedAt: number, data: Record<string, unknown>): void {
    files.set(
      `/appdata/recovery/main/crashed-${startedAt}.json`,
      JSON.stringify({
        version: 1,
        sessionId: "s-old",
        windowLabel: "main",
        startedAt,
        archivedAt: startedAt + 1,
        cleanExit: false,
        draftPaths: [],
        handledDraftIds: [],
        fullyHandled: false,
        ...data,
      }),
    );
  }

  it("上次非正常退出：归档 crashed-<startedAt>.json，draftPaths 只收该会话的草稿", async () => {
    files.set(
      SESSION,
      JSON.stringify({ version: 1, sessionId: "s-old", startedAt: 1_111, cleanExit: false }),
    );
    seedDraft("/w/a.md", { updatedAt: 1_000, sessionId: "s-old" });
    seedDraft("/w/b.md", { updatedAt: 1_000, sessionId: "s-other" });

    await beginSession(2_222);

    const archived = JSON.parse(files.get("/appdata/recovery/main/crashed-1111.json")!);
    expect(archived.sessionId).toBe("s-old");
    expect(archived.draftPaths).toEqual(["/w/a.md"]);
    expect(archived.fullyHandled).toBe(false);
  });

  it("同一次运行（sessionId 相同）不会自我归档：StrictMode 双跑不产生假归档", async () => {
    // 第一次：没有旧标记
    expect(await beginSession(1_000)).toBeNull();

    // 第二次读到的是自己刚写的标记（sessionId 相同）→ 不归档、不误报
    const previous = await beginSession(1_050);
    expect(previous?.sessionId).toBe(currentSessionId());
    expect(previous?.cleanExit).toBe(false);

    const archives = [...files.keys()].filter((k) => k.includes("crashed-"));
    expect(archives).toEqual([]);
  });

  it("markDraftsHandled 只写匹配 sessionId 的归档，并按 draftPaths 判定 fullyHandled", async () => {
    seedCrashed(10, { sessionId: "s-old", draftPaths: ["/w/a.md", "/w/b.md"] });
    seedCrashed(20, { sessionId: "s-other", draftPaths: ["/w/a.md"] });
    const otherBefore = files.get("/appdata/recovery/main/crashed-20.json")!;

    await markDraftsHandled([{ sessionId: "s-old", tabPath: "/w/a.md" }]);

    const mine = JSON.parse(files.get("/appdata/recovery/main/crashed-10.json")!);
    expect(mine.handledDraftIds).toEqual(["/w/a.md"]);
    expect(mine.fullyHandled).toBe(false); // /w/b.md 还没处理
    // 别的会话不受影响
    expect(files.get("/appdata/recovery/main/crashed-20.json")).toBe(otherBefore);
  });

  it("TTL：已处理的删、未处理的留、本次会话的留、pinned 留、孤儿留", async () => {
    const now = 10 * DRAFT_TTL_MS;
    const old = now - DRAFT_TTL_MS - 1;
    const handledFile = seedDraft("/w/handled.md", { updatedAt: old, sessionId: "s-old" });
    const unhandledFile = seedDraft("/w/unhandled.md", { updatedAt: old, sessionId: "s-old" });
    const currentFile = seedDraft("/w/current.md", {
      updatedAt: old,
      sessionId: currentSessionId(),
    });
    const orphanFile = seedDraft("/w/orphan.md", { updatedAt: old, sessionId: "s-vanished" });
    const pinnedFile = seedDraft("/w/pinned.md", {
      updatedAt: old,
      sessionId: "s-old",
      pinned: true,
    });
    seedCrashed(1_000, {
      sessionId: "s-old",
      draftPaths: ["/w/handled.md", "/w/unhandled.md", "/w/pinned.md"],
      // pinned 这条也标了 handled：能留下来只能是因为 pinned 豁免
      handledDraftIds: ["/w/handled.md", "/w/pinned.md"],
    });

    const removed = await cleanupExpiredDrafts(now);

    expect(removed).toBe(1);
    expect(files.has(handledFile)).toBe(false);
    // 未处理的崩溃副本永不自动清；无归档的（归档写失败/旧残留）同样只留不删
    expect(files.has(unhandledFile)).toBe(true);
    expect(files.has(orphanFile)).toBe(true);
    // 本次会话的草稿永不自动清
    expect(files.has(currentFile)).toBe(true);
    expect(files.has(pinnedFile)).toBe(true);
  });

  it("跨会话：旧归档里处理过的同路径，不能授权删除新会话的草稿", async () => {
    const old = 10 * DRAFT_TTL_MS - DRAFT_TTL_MS - 1;
    // 旧归档说处理过 /w/a.md
    seedCrashed(1_000, {
      sessionId: "s-old",
      draftPaths: ["/w/a.md"],
      handledDraftIds: ["/w/a.md"],
    });
    // 磁盘上这份 /w/a.md 属于另一个**已归档但未处理**的会话
    seedCrashed(2_000, { sessionId: "s-new", draftPaths: ["/w/a.md"], handledDraftIds: [] });
    const fresh = seedDraft("/w/a.md", { updatedAt: old, sessionId: "s-new" });

    const removed = await cleanupExpiredDrafts(10 * DRAFT_TTL_MS);

    expect(removed).toBe(0);
    expect(files.has(fresh)).toBe(true);
  });
});

describe("#365 启动入口（useStartupRecovery）", () => {
  it("选择「恢复」：tab 恢复出来，但草稿**不删**（恢复本身不消费副本）", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    // 用当前时间：否则收尾的 TTL 清理会把它当过期草稿删掉，测不到「恢复不删」
    const draftFile = seedDraft("/w/a.md", { content: "崩溃前", updatedAt: Date.now() });
    messageMock.mockReset().mockResolvedValue("恢复");

    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useStartupRecovery } = await import("../../src/lib/useStartupRecovery");
    renderHook(() => useStartupRecovery());

    await waitFor(() => expect(useWorkspace.getState().openTabs.length).toBe(1));
    expect(useWorkspace.getState().openTabs[0].content).toBe("崩溃前");
    // 恢复出来的 tab 在下一次编辑前不会产生新草稿；此时崩溃就等于没有副本，
    // 所以草稿必须留到「保存成功」或 TTL 清理
    expect(files.has(draftFile)).toBe(true);
  });

  it("恢复一份超过 TTL 的草稿后，收尾的 TTL 清理不能删它", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    // 8 天前写的草稿：正常会被 TTL 清掉，但用户刚恢复它，内容此刻只在编辑器里
    const old = seedDraft("/w/old.md", {
      content: "八天前的内容",
      updatedAt: Date.now() - DRAFT_TTL_MS - 1_000,
    });
    messageMock.mockReset().mockResolvedValue("恢复");

    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useStartupRecovery } = await import("../../src/lib/useStartupRecovery");
    renderHook(() => useStartupRecovery());

    await waitFor(() => expect(useWorkspace.getState().openTabs.length).toBe(1));
    expect(files.has(old)).toBe(true);
  });

  it("平台回传 Yes / No 也要能走恢复 / 丢弃（自定义按钮的既有约定）", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    const draftFile = seedDraft("/w/a.md", { updatedAt: Date.now() });
    messageMock.mockReset().mockResolvedValue("Yes");

    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useStartupRecovery } = await import("../../src/lib/useStartupRecovery");
    renderHook(() => useStartupRecovery());

    await waitFor(() => expect(useWorkspace.getState().openTabs.length).toBe(1));
    expect(files.has(draftFile)).toBe(true);
  });

  it("选择「丢弃」：草稿真被删掉", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    const draftFile = seedDraft("/w/a.md", { updatedAt: 5_000 });
    messageMock.mockReset().mockResolvedValue("丢弃");

    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useStartupRecovery } = await import("../../src/lib/useStartupRecovery");
    renderHook(() => useStartupRecovery());

    await waitFor(() => expect(files.has(draftFile)).toBe(false));
    expect(useWorkspace.getState().openTabs).toHaveLength(0);
  });

  it("#404 便携迁移结果必须可见：弹窗列出复制/跳过/失败，而非静默搬走", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: true }));
    portable.migration = {
      from: "C:/Users/x/AppData/Roaming/com.inklingmd.editor",
      to: "D:/Portable/InklingMD/data",
      copied: ["themes"],
      failed: ["recovery: 复制失败 磁盘已满"],
      skipped: ["themes/link.css: 符号链接，未迁移"],
      warnings: [],
    };
    messageMock.mockReset().mockResolvedValue(undefined);

    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useStartupRecovery } = await import("../../src/lib/useStartupRecovery");
    renderHook(() => useStartupRecovery());

    await waitFor(() => expect(messageMock).toHaveBeenCalled());
    const call = messageMock.mock.calls.find(
      (c) => (c[1] as { title?: string } | undefined)?.title === "便携模式数据迁移",
    );
    expect(call, "迁移必须弹出「便携模式数据迁移」提示").toBeTruthy();
    const text = String(call?.[0]);
    expect(text).toContain("D:/Portable/InklingMD/data");
    expect(text).toContain("themes");
    // 失败项用 error 语气呈现：用户要知道哪些数据没搬过来
    expect((call?.[1] as { kind?: string }).kind).toBe("error");
    expect(text).toContain("磁盘已满");
  });

  it("#404 会话标记必须先于迁移弹窗落盘（弹窗挂着时崩溃仍能提示恢复）", async () => {
    // 迁移弹窗是模态的，会挂住后续 await：若 beginSession 在它后面，
    // 用户不点弹窗就崩溃，本次会话没有 cleanExit:false，下次启动不会提示恢复
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: true }));
    portable.migration = {
      from: "C:/Roaming/com.inklingmd.editor",
      to: "D:/Portable/InklingMD/data",
      copied: ["themes"],
      failed: [],
      skipped: [],
      warnings: [],
    };
    let cleanExitFalseAtDialogTime: boolean | null = null;
    messageMock.mockReset().mockImplementation(async () => {
      const marker = files.get(SESSION);
      cleanExitFalseAtDialogTime =
        marker !== undefined && JSON.parse(marker).cleanExit === false;
      return undefined;
    });

    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useStartupRecovery } = await import("../../src/lib/useStartupRecovery");
    renderHook(() => useStartupRecovery());

    await waitFor(() => expect(messageMock).toHaveBeenCalled());
    expect(cleanExitFalseAtDialogTime).toBe(true);
  });
});

describe("#365 TTL 清理", () => {
  it("已处理 + 超 7 天才清；近期与 pinned 一律保留", async () => {
    const now = 10 * DRAFT_TTL_MS;
    const old = now - DRAFT_TTL_MS - 1;
    const handledFile = seedDraft("/w/handled.md", { updatedAt: old, sessionId: "s0" });
    const recentFile = seedDraft("/w/recent.md", { updatedAt: now - 1_000, sessionId: "s0" });
    const pinnedFile = seedDraft("/w/pinned.md", {
      updatedAt: old,
      sessionId: "s0",
      pinned: true,
    });
    files.set(
      "/appdata/recovery/main/crashed-1.json",
      JSON.stringify({
        version: 1,
        sessionId: "s0",
        windowLabel: "main",
        startedAt: 1,
        archivedAt: 2,
        cleanExit: false,
        draftPaths: ["/w/handled.md", "/w/pinned.md"],
        handledDraftIds: ["/w/handled.md", "/w/pinned.md"],
        fullyHandled: false,
      }),
    );

    const removed = await cleanupExpiredDrafts(now);

    expect(removed).toBe(1);
    expect(files.has(handledFile)).toBe(false);
    expect(files.has(recentFile)).toBe(true);
    // 同样标了 handled 且超期，能留下只因 pinned
    expect(files.has(pinnedFile)).toBe(true);
  });
});

describe("#409 旧 crashed 归档回收", () => {
  const NOW = 10 * DRAFT_TTL_MS;
  const OLD = NOW - DRAFT_TTL_MS - 1;

  function crashed(name: string, data: Record<string, unknown> = {}): string {
    const file = `/appdata/recovery/main/${name}`;
    files.set(
      file,
      JSON.stringify({
        version: 1,
        sessionId: "s-archived",
        windowLabel: "main",
        startedAt: OLD,
        archivedAt: OLD,
        cleanExit: false,
        draftPaths: [],
        handledDraftIds: [],
        fullyHandled: true,
        // 手工播种默认「枚举可信」：回收要求归档自证枚举完整 + 残留检查通过，
        // 与 draftPaths 是否为空无关
        draftsEnumerated: true,
        ...data,
      }),
    );
    return file;
  }

  it("fullyHandled 且超 7 天的归档被回收，返回值只统计草稿删除数", async () => {
    const archive = crashed("crashed-old.json", {
      sessionId: "s-handled",
      draftPaths: ["/w/a.md"],
      handledDraftIds: ["/w/a.md"],
    });
    const draft = seedDraft("/w/a.md", { updatedAt: OLD, sessionId: "s-handled" });

    expect(await cleanupExpiredDrafts(NOW)).toBe(1);
    expect(files.has(draft)).toBe(false);
    expect(files.has(archive)).toBe(false);
  });

  it("写入侧：beginSession 归档空草稿会话时写出 draftsEnumerated=true + fullyHandled=true，超期后归档真被回收", async () => {
    files.set(
      SESSION,
      JSON.stringify({ version: 1, sessionId: "s-empty", startedAt: 1_111, cleanExit: false }),
    );
    const archivedAt = 5_000;

    await beginSession(archivedAt);

    const archive = "/appdata/recovery/main/crashed-1111.json";
    const archived = JSON.parse(files.get(archive)!);
    // 回收的必要条件：它必须由归档链路自己写出来（该位为 false 则回收彻底失效），
    // 而不是用例手工播种的字段
    expect(archived.draftsEnumerated).toBe(true);
    expect(archived.fullyHandled).toBe(true);

    expect(await cleanupExpiredDrafts(archivedAt + DRAFT_TTL_MS + 1)).toBe(0);
    expect(files.has(archive)).toBe(false);
  });

  it("写入侧到回收全链路：beginSession 归档 1 份草稿 → 丢弃并记账 → 超期清理删草稿与归档", async () => {
    files.set(
      SESSION,
      JSON.stringify({ version: 1, sessionId: "s-one", startedAt: 1_111, cleanExit: false }),
    );
    const draftPath = "/w/a.md";
    const draftPathFile = seedDraft(draftPath, { updatedAt: 4_000, sessionId: "s-one" });
    const archivedAt = 5_000;

    await beginSession(archivedAt);

    const archive = "/appdata/recovery/main/crashed-1111.json";
    let archived = JSON.parse(files.get(archive)!);
    expect(archived.draftsEnumerated).toBe(true);
    expect(archived.draftPaths).toEqual([draftPath]);
    expect(archived.fullyHandled).toBe(false);

    // 与设置面板「丢弃」一致：先 discardDrafts 删文件，再 markDraftsHandled 按会话记账
    const drafts = await listDrafts();
    expect(drafts.map((d) => d.tabPath)).toEqual([draftPath]);
    expect(await discardDrafts(drafts)).toBe(1);
    // 归因明确：文件是「丢弃」删的，后面的清理只负责回收账本
    expect(files.has(draftPathFile)).toBe(false);
    await markDraftsHandled([{ sessionId: "s-one", tabPath: draftPath }]);

    archived = JSON.parse(files.get(archive)!);
    expect(archived.fullyHandled).toBe(true);

    expect(await cleanupExpiredDrafts(archivedAt + DRAFT_TTL_MS + 1)).toBe(0);
    expect(files.has(draftPathFile)).toBe(false);
    expect(files.has(archive)).toBe(false);
  });

  it("fullyHandled=false 的归档即使超期也保留（已处理账本不能丢）", async () => {
    const archive = crashed("crashed-pending.json", { fullyHandled: false });

    await cleanupExpiredDrafts(NOW);

    expect(files.has(archive)).toBe(true);
  });

  it("归档未满 7 天不回收", async () => {
    const archive = crashed("crashed-recent.json", {
      archivedAt: NOW - DRAFT_TTL_MS + 1_000,
    });

    await cleanupExpiredDrafts(NOW);

    expect(files.has(archive)).toBe(true);
  });

  it("archivedAt 缺失时用文件 mtime 判龄（元数据透传的真实消费者）", async () => {
    const archive = crashed("crashed-legacy.json", { archivedAt: 0 });
    fileMtimeUs.set(archive, OLD * 1000); // 微秒 → 毫秒

    await cleanupExpiredDrafts(NOW);

    expect(files.has(archive)).toBe(false);
  });

  it("archivedAt 与 mtime 都缺失时保留，不把时间戳 0 误判成 7 天前", async () => {
    const archive = crashed("crashed-unknown.json", { archivedAt: 0 });

    await cleanupExpiredDrafts(NOW);

    expect(files.has(archive)).toBe(true);
  });

  function expectWarnMessage(warn: ReturnType<typeof vi.spyOn>, substring: string): void {
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes(substring)),
      `预期 console.warn 首参数包含 "${substring}"，实际记录：${JSON.stringify(warn.mock.calls)}`,
    ).toBe(true);
  }

  it("删除失败不抛错、归档保留到下次，且不静默吞错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = crashed("crashed-io.json");
    failDelete = true;

    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      expect(files.has(archive)).toBe(true);
      expectWarnMessage(warn, "旧归档删除失败");
    } finally {
      warn.mockRestore();
    }
  });

  it("草稿清理与归档回收互不干扰：未处理的草稿与对应归档都保留", async () => {
    const archive = crashed("crashed-unhandled.json", {
      sessionId: "s-pending",
      draftPaths: ["/w/b.md"],
      handledDraftIds: [],
      fullyHandled: false,
    });
    const draft = seedDraft("/w/b.md", { updatedAt: OLD, sessionId: "s-pending" });

    expect(await cleanupExpiredDrafts(NOW)).toBe(0);
    expect(files.has(draft)).toBe(true);
    expect(files.has(archive)).toBe(true);
  });

  it("该会话的草稿删除失败时，归档保留到下次清理", async () => {
    const archive = crashed("crashed-keep.json", {
      sessionId: "s-failed",
      draftPaths: ["/w/a.md"],
      handledDraftIds: ["/w/a.md"],
    });
    const draft = seedDraft("/w/a.md", { updatedAt: OLD, sessionId: "s-failed" });
    failDeleteOnlyPrefix = `${DRAFTS}/`;

    expect(await cleanupExpiredDrafts(NOW)).toBe(0); // 删失败：removed 不计
    expect(files.has(draft)).toBe(true);
    // 账本必须留着：删了这份草稿就再没有会话归属，永远不会被清理
    expect(files.has(archive)).toBe(true);
  });

  it("本次刚恢复（exclude）的草稿仍在磁盘时，归档不被回收", async () => {
    const archive = crashed("crashed-excluded.json", {
      sessionId: "s-restored",
      draftPaths: ["/w/a.md"],
      handledDraftIds: ["/w/a.md"],
    });
    const draft = seedDraft("/w/a.md", { updatedAt: OLD, sessionId: "s-restored" });

    expect(
      await cleanupExpiredDrafts(NOW, undefined, { exclude: new Set(["/w/a.md"]) }),
    ).toBe(0);
    expect(files.has(draft)).toBe(true);
    expect(files.has(archive)).toBe(true);
  });

  it("pinned 草稿仍在磁盘时，归档不被回收", async () => {
    const archive = crashed("crashed-pinned.json", {
      sessionId: "s-pinned",
      draftPaths: ["/w/a.md"],
      handledDraftIds: ["/w/a.md"],
    });
    const draft = seedDraft("/w/a.md", {
      updatedAt: OLD,
      sessionId: "s-pinned",
      pinned: true,
    });

    expect(await cleanupExpiredDrafts(NOW)).toBe(0);
    expect(files.has(draft)).toBe(true);
    expect(files.has(archive)).toBe(true);
  });

  it("草稿目录列不出来时跳过归档回收，不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = crashed("crashed-unlistable.json");
    __setRecoveryIo({
      appDataDir: async () => "/appdata",
      readTextFile: async (path) => {
        const v = files.get(path);
        if (v === undefined) throw new Error("not found");
        return v;
      },
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      listDir: async (path) => {
        if (path.endsWith("/drafts")) throw new Error("EIO: 目录不可读");
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
        }
        return [...names].map((name) => ({ name, isDir: false }));
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    });

    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      expect(files.has(archive)).toBe(true);
      // 必须命中归档回收自身的跳过告警，而非 cleanupExpiredDrafts 开头 listDrafts() 的前置告警
      expectWarnMessage(warn, "跳过旧归档回收");
    } finally {
      warn.mockRestore();
    }
  });

  it("恢复区目录列不出来时不抛错、不回收任何归档，并留下「读取恢复区目录失败」告警", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = crashed("crashed-recovery-unreadable.json");
    __setRecoveryIo({
      appDataDir: async () => "/appdata",
      readTextFile: async (path) => {
        const v = files.get(path);
        if (v === undefined) throw new Error("not found");
        return v;
      },
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      listDir: async (path) => {
        // 只让恢复区目录本身不可读：草稿目录照常可列，才能确证是 crashedFiles() 的失败分支
        if (path === "/appdata/recovery/main") throw new Error("EIO: 恢复区不可读");
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
        }
        return [...names].map((name) => ({ name, isDir: false }));
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    });

    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      // 本次看不到任何账本 → 一条归档都不许删，否则对应草稿会永久失去归属
      expect(files.has(archive)).toBe(true);
      expectWarnMessage(warn, "读取恢复区目录失败");
    } finally {
      warn.mockRestore();
    }
  });

  it("归档时草稿目录列不出来 → 不宣称已处理完，超期也不回收账本", async () => {
    files.set(
      SESSION,
      JSON.stringify({ version: 1, sessionId: "s-old", startedAt: 1_111, cleanExit: false }),
    );
    const draft = seedDraft("/w/a.md", { updatedAt: OLD, sessionId: "s-old" });
    __setRecoveryIo({
      appDataDir: async () => "/appdata",
      readTextFile: async (path) => {
        const v = files.get(path);
        if (v === undefined) throw new Error("not found");
        return v;
      },
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      listDir: async (path) => {
        if (path.endsWith("/drafts")) throw new Error("EIO: 目录不可读");
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
        }
        return [...names].map((name) => ({ name, isDir: false }));
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await beginSession(2_222);

      const archive = "/appdata/recovery/main/crashed-1111.json";
      const archived = JSON.parse(files.get(archive)!);
      expect(archived.draftsEnumerated).toBe(false);
      expect(archived.fullyHandled).toBe(false);
      // 归档侧不能静默：这份账本会永久不可回收，需要诊断线索
      expectWarnMessage(warn, "读取草稿目录失败");

      warn.mockClear();
      await cleanupExpiredDrafts(NOW);
      // 那次枚举失败，谁也不知道还有没有草稿：账本与草稿都必须留着；
      // 此处 archived.fullyHandled 为 false 未进归档回收分支，告警来自 cleanupExpiredDrafts 开头的 listDrafts()
      expect(files.has(archive)).toBe(true);
      expect(files.has(draft)).toBe(true);
      expectWarnMessage(warn, "读取草稿目录失败");
    } finally {
      warn.mockRestore();
    }
  });

  it("旧归档缺 draftsEnumerated 且 draftPaths 为空时保守保留", async () => {
    const archive = crashed("crashed-legacy-empty.json", {
      draftPaths: [],
      draftsEnumerated: undefined,
    });

    await cleanupExpiredDrafts(NOW);

    expect(files.has(archive)).toBe(true);
  });

  it("旧归档缺 draftsEnumerated 时，即使 draftPaths 非空且已处理、列出的草稿已删也不回收", async () => {
    const archive = crashed("crashed-legacy-handled.json", {
      sessionId: "s-old",
      draftPaths: ["/w/a.md"],
      handledDraftIds: ["/w/a.md"],
      draftsEnumerated: undefined,
    });
    const handled = seedDraft("/w/a.md", { updatedAt: OLD, sessionId: "s-old" });
    // 旧版 listDrafts() 读不出来就静默跳过：这条不在 draftPaths 里，但确实属于同一会话
    const missed = seedDraft("/w/b.md", { updatedAt: OLD, sessionId: "s-old" });

    // 列出的那条照常清掉（它确实被用户处理过）
    expect(await cleanupExpiredDrafts(NOW)).toBe(1);
    expect(files.has(handled)).toBe(false);
    // 但账本必须留着：删了它就没人知道 /w/b.md 属于哪个会话，会永久留在 !crash 分支
    expect(files.has(missed)).toBe(true);
    expect(files.has(archive)).toBe(true);
  });

  it("归档里的 draftPaths 无法映射为文件名时不抛错、也不回收", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = crashed("crashed-bad-path.json", {
      draftPaths: ["\ud800"],
      handledDraftIds: ["\ud800"],
    });

    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      expect(files.has(archive)).toBe(true);
      expectWarnMessage(warn, "无法映射为文件名");
    } finally {
      warn.mockRestore();
    }
  });

  it("归档声明枚举失败且 draftPaths 为空时，即使 fullyHandled 也不回收", async () => {
    const archive = crashed("crashed-enum-failed.json", {
      sessionId: "s-enum",
      draftPaths: [],
      draftsEnumerated: false,
      fullyHandled: true,
    });
    const draft = seedDraft("/w/x.md", { updatedAt: OLD, sessionId: "s-enum" });

    await cleanupExpiredDrafts(NOW);

    // 空 draftPaths 无法证明「该会话没有草稿」：账本留着，草稿也留着
    expect(files.has(archive)).toBe(true);
    expect(files.has(draft)).toBe(true);
  });

  it("归档时有草稿读不出来 → 不宣称已处理完，账本不回收", async () => {
    files.set(
      SESSION,
      JSON.stringify({ version: 1, sessionId: "s-old", startedAt: 1_111, cleanExit: false }),
    );
    const draft = seedDraft("/w/a.md", { updatedAt: OLD, sessionId: "s-old" });
    files.set(draft, "{ 坏 JSON");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await beginSession(2_222);
      const archive = "/appdata/recovery/main/crashed-1111.json";
      const archived = JSON.parse(files.get(archive)!);
      expect(archived.draftsEnumerated).toBe(false);
      expect(archived.fullyHandled).toBe(false);
      expectWarnMessage(warn, "草稿读取/解析失败");

      warn.mockClear();
      await cleanupExpiredDrafts(NOW);
      expect(files.has(archive)).toBe(true);
      expect(files.has(draft)).toBe(true);
      // 归档 fullyHandled 为 false 未进回收分支；告警来自 cleanupExpiredDrafts 开头重读损坏草稿
      expectWarnMessage(warn, "草稿读取/解析失败");
    } finally {
      warn.mockRestore();
    }
  });

  it("部分枚举失败（1 份可读 / 1 份读失败）→ 处理完可读份后 fullyHandled 仍为 false 且超期不回收账本", async () => {
    files.set(
      SESSION,
      JSON.stringify({
        version: 1,
        sessionId: "s-partial",
        startedAt: OLD - 10,
        cleanExit: false,
      }),
    );
    const aDraftFile = seedDraft("/w/a.md", {
      content: "可读草稿",
      updatedAt: OLD,
      sessionId: "s-partial",
    });
    const bDraftFile = seedDraft("/w/b.md", {
      content: "暂时锁住的草稿",
      updatedAt: OLD,
      sessionId: "s-partial",
    });

    // 仅在首次读取 b.md 草稿时模拟瞬时文件锁失败，之后恢复可读
    let lockBOnce = true;
    __setRecoveryIo({
      appDataDir: async () => "/appdata",
      readTextFile: async (path) => {
        if (lockBOnce && path === bDraftFile) {
          lockBOnce = false;
          throw new Error("EBUSY: 瞬时文件锁");
        }
        const v = files.get(path);
        if (v === undefined) throw new Error("not found");
        return v;
      },
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      listDir: async (path) => {
        const prefix = path.endsWith("/") ? path : `${path}/`;
        const names = new Set<string>();
        for (const key of files.keys()) {
          if (key.startsWith(prefix)) names.add(key.slice(prefix.length));
        }
        return [...names].map((name) => ({
          name,
          isDir: false,
          mtimeUs: fileMtimeUs.get(`${prefix}${name}`),
        }));
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await beginSession(OLD);
      const archive = `/appdata/recovery/main/crashed-${OLD - 10}.json`;
      const archivedAfterBegin = JSON.parse(files.get(archive)!);
      expect(archivedAfterBegin.draftPaths).toEqual(["/w/a.md"]);
      expect(archivedAfterBegin.draftsEnumerated).toBe(false);
      expect(archivedAfterBegin.fullyHandled).toBe(false);
      expectWarnMessage(warn, "草稿读取/解析失败");

      // 用户随后只丢弃并标记处理完归档已知的那份 /w/a.md
      const aDraft = (await listDrafts()).find((d) => d.tabPath === "/w/a.md")!;
      expect(aDraft).toBeTruthy();
      await discardDrafts([aDraft]);
      await markDraftsHandled([aDraft]);

      const archivedAfterHandled = JSON.parse(files.get(archive)!);
      expect(archivedAfterHandled.handledDraftIds).toEqual(["/w/a.md"]);
      // 归档时漏掉过 b.md：绝不能把 fullyHandled 改成 true
      expect(archivedAfterHandled.fullyHandled).toBe(false);

      // 超 7 天后清理：a.md 已删，b.md 仍在磁盘，归档账本必须保留
      await cleanupExpiredDrafts(NOW);
      expect(files.has(aDraftFile)).toBe(false);
      expect(files.has(bDraftFile)).toBe(true);
      expect(files.has(archive)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("draftPaths 非空但 draftsEnumerated=false 的归档，即使 fullyHandled=true 且草稿已不在磁盘也不回收", async () => {
    const archive = crashed("crashed-partial-enum.json", {
      sessionId: "s-partial-flag",
      draftPaths: ["/w/a.md"],
      handledDraftIds: ["/w/a.md"],
      draftsEnumerated: false,
      fullyHandled: true,
    });

    await cleanupExpiredDrafts(NOW);

    expect(files.has(archive)).toBe(true);
  });

  it("缺 sessionId 的旧草稿仍可恢复与丢弃，但归档写出 draftsEnumerated=false 且超期不误删草稿与账本", async () => {
    const prevMarker = { version: 1, sessionId: "s-old", startedAt: OLD - 10, cleanExit: false };
    files.set(SESSION, JSON.stringify(prevMarker));
    const draftMissing = draftFile("/w/legacy-no-session.md");
    files.set(
      draftMissing,
      JSON.stringify({
        version: 1,
        draftId: "legacy-x",
        tabPath: "/w/legacy-no-session.md",
        content: "旧版未保存正文",
        updatedAt: OLD,
      }),
    );
    const draftEmpty = draftFile("/w/legacy-empty-session.md");
    files.set(
      draftEmpty,
      JSON.stringify({
        version: 1,
        draftId: "legacy-y",
        sessionId: "",
        tabPath: "/w/legacy-empty-session.md",
        content: "空会话旧正文",
        updatedAt: OLD - 1,
      }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // (a) listDrafts 与 findRecoverableDrafts 仍可返回正文供恢复或手动丢弃
      const listed = await listDrafts();
      expect(listed).toHaveLength(2);
      expect(listed[0]).toMatchObject({
        tabPath: "/w/legacy-no-session.md",
        content: "旧版未保存正文",
        sessionId: "",
      });
      expect(listed[1]).toMatchObject({
        tabPath: "/w/legacy-empty-session.md",
        content: "空会话旧正文",
        sessionId: "",
      });
      const recoverable = await findRecoverableDrafts(prevMarker);
      expect(recoverable).toHaveLength(2);
      expect(recoverable.map((d) => d.content)).toEqual(["旧版未保存正文", "空会话旧正文"]);
      expectWarnMessage(warn, "缺少 sessionId");

      // 「仍可恢复」要落到真实恢复链路，而不只是能列出来
      const restored = await applyRecovery(recoverable);
      expect(restored.restored).toBe(2);
      expect(useWorkspace.getState().openTabs.map((t) => t.content)).toEqual([
        "旧版未保存正文",
        "空会话旧正文",
      ]);
      // 恢复不消费副本
      expect(files.has(draftMissing)).toBe(true);
      expect(files.has(draftEmpty)).toBe(true);
      useWorkspace.setState({ openTabs: [], activeTabPath: null, dirty: false } as never);

      // (b) beginSession 写出的归档 draftsEnumerated=false, fullyHandled=false 且带告警
      warn.mockClear();
      await beginSession(OLD);
      const archive = `/appdata/recovery/main/crashed-${OLD - 10}.json`;
      const archived = JSON.parse(files.get(archive)!);
      expect(archived.draftsEnumerated).toBe(false);
      expect(archived.fullyHandled).toBe(false);
      expectWarnMessage(warn, "缺少 sessionId");

      // (c) 超 7 天后 cleanupExpiredDrafts 既不误删旧草稿也不回收归档
      warn.mockClear();
      await cleanupExpiredDrafts(NOW);
      expect(files.has(draftMissing)).toBe(true);
      expect(files.has(draftEmpty)).toBe(true);
      expect(files.has(archive)).toBe(true);
      expectWarnMessage(warn, "缺少 sessionId");

      // 用户通过面板/恢复弹窗手动丢弃时仍可真实删掉该旧草稿
      await expect(discardDrafts(listed)).resolves.toBe(2);
      expect(files.has(draftMissing)).toBe(false);
      expect(files.has(draftEmpty)).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("仅缺 content 或 tabPath 的损坏草稿才会被跳过、告警并标 draftsEnumerated=false", async () => {
    files.set(
      SESSION,
      JSON.stringify({ version: 1, sessionId: "s-old", startedAt: OLD - 10, cleanExit: false }),
    );
    files.set(
      draftFile("/w/missing-content.md"),
      JSON.stringify({
        version: 1,
        draftId: "broken-1",
        sessionId: "s-old",
        tabPath: "/w/missing-content.md",
        updatedAt: OLD,
      }),
    );
    files.set(
      draftFile("/w/missing-tabpath.md"),
      JSON.stringify({
        version: 1,
        draftId: "broken-2",
        sessionId: "s-old",
        content: "有正文但没有路径",
        updatedAt: OLD,
      }),
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await listDrafts()).toEqual([]);
      // 两条都要各自告警：缺 content 与缺 tabPath 是同一分支的两种输入
      expect(
        warn.mock.calls.filter((args) => String(args[0]).includes("缺少正文或路径")),
      ).toHaveLength(2);

      warn.mockClear();
      await beginSession(OLD);
      const archive = `/appdata/recovery/main/crashed-${OLD - 10}.json`;
      const archived = JSON.parse(files.get(archive)!);
      expect(archived.draftsEnumerated).toBe(false);
      expect(archived.fullyHandled).toBe(false);
      expectWarnMessage(warn, "缺少正文或路径");
    } finally {
      warn.mockRestore();
    }
  });

  it("面板丢弃缺 sessionId 的草稿：discardDrafts + markDraftsHandled 组合真的删文件且不写坏账本", async () => {
    // 与 SettingsPanel 的 onDiscard 一致：先 discardDrafts 再 markDraftsHandled
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archive = crashed("crashed-other-session.json", {
      sessionId: "s-other",
      draftPaths: ["/w/keep.md"],
      handledDraftIds: [],
      fullyHandled: false,
      draftsEnumerated: true,
    });
    const archiveBefore = files.get(archive)!;
    const legacy = draftFile("/w/legacy-panel.md");
    files.set(
      legacy,
      JSON.stringify({
        version: 1,
        draftId: "legacy-panel",
        tabPath: "/w/legacy-panel.md",
        content: "面板里丢弃的旧草稿",
        updatedAt: OLD,
      }),
    );

    const selected = await listDrafts();
    expect(selected).toHaveLength(1);
    expect(selected[0].sessionId).toBe("");

    try {
      await expect(discardDrafts(selected)).resolves.toBe(1);
      await expect(markDraftsHandled(selected)).resolves.toBeUndefined();

      // 文件真的删掉了；空 sessionId 无从归属，不能把别人的归档写坏
      expect(files.has(legacy)).toBe(false);
      expect(files.get(archive)).toBe(archiveBefore);
      expect(await listDrafts()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("坏归档不会静默：损坏 JSON 与缺 sessionId 的归档各留一条告警且不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const corrupt = "/appdata/recovery/main/crashed-corrupt.json";
    const noSession = "/appdata/recovery/main/crashed-no-session.json";
    files.set(corrupt, "{ 半截 JSON");
    files.set(noSession, JSON.stringify({ version: 1, draftPaths: [], fullyHandled: true }));

    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      expectWarnMessage(warn, "归档读取/解析失败");
      expectWarnMessage(warn, "归档缺少 sessionId");
      // 读不懂的归档一律保留，不能因为解析失败就当成「没有账本」删掉
      expect(files.has(corrupt)).toBe(true);
      expect(files.has(noSession)).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("归档 draftPaths 非数组（配合 fullyHandled=true, draftsEnumerated=true）时不抛错、告警且不回收", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archiveNull = crashed("crashed-non-array-null.json", {
      draftPaths: null as unknown as string[],
      fullyHandled: true,
      draftsEnumerated: true,
    });
    const archiveObj = crashed("crashed-non-array-obj.json", {
      draftPaths: { bad: 1 } as unknown as string[],
      fullyHandled: true,
      draftsEnumerated: true,
    });

    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      expect(files.has(archiveNull)).toBe(true);
      expect(files.has(archiveObj)).toBe(true);
      expectWarnMessage(warn, "draftPaths 非数组");
      expect(
        warn.mock.calls.filter((args) => String(args[0]).includes("draftPaths 非数组")),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("归档 draftPaths 含非字符串元素（[null] / [123]）时不抛错、告警且不回收", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const archiveNull = crashed("crashed-elem-null.json", {
      draftPaths: [null] as unknown as string[],
      handledDraftIds: [],
      fullyHandled: true,
      draftsEnumerated: true,
    });
    const archiveNum = crashed("crashed-elem-num.json", {
      draftPaths: [123] as unknown as string[],
      handledDraftIds: [],
      fullyHandled: true,
      draftsEnumerated: true,
    });

    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      expect(files.has(archiveNull)).toBe(true);
      expect(files.has(archiveNum)).toBe(true);
      expectWarnMessage(warn, "无法映射为文件名");
      expect(
        warn.mock.calls.filter((args) => String(args[0]).includes("无法映射为文件名")),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("默认 IO（defaultIo.listDir）必须把 listDirFiles 的 mtimeUs 透传给旧归档判龄删除", async () => {
    const archive = "/appdata/recovery/main/crashed-default-io.json";
    const archiveBody = JSON.stringify({
      version: 1,
      sessionId: "s-default-io",
      windowLabel: "main",
      startedAt: OLD,
      archivedAt: 0,
      cleanExit: false,
      draftPaths: [],
      handledDraftIds: [],
      fullyHandled: true,
      draftsEnumerated: true,
    });
    listDirFilesMock.mockImplementation(async (dir: string) => {
      if (dir === "/appdata/recovery/main") {
        return [
          {
            name: "crashed-default-io.json",
            isDir: false,
            size: archiveBody.length,
            mtimeUs: OLD * 1000,
          },
        ];
      }
      return [];
    });
    readRecoveryFileMock.mockImplementation(async (path: string) => {
      if (path === archive) return archiveBody;
      throw new Error("not found");
    });

    __setRecoveryIo(null);
    try {
      await expect(cleanupExpiredDrafts(NOW)).resolves.toBe(0);
      expect(deletePathMock).toHaveBeenCalledTimes(1);
      expect(deletePathMock).toHaveBeenCalledWith(archive);
      // 恢复区读取必须走专用通道：草稿正文 10MB + 信封会超过文档通道的 10MB 护栏
      expect(readRecoveryFileMock).toHaveBeenCalled();
      expect(readTextFileMock).not.toHaveBeenCalled();
    } finally {
      __setRecoveryIo(null);
    }
  });
});

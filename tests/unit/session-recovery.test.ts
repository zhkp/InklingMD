// #365 / #378 崩溃恢复：检测 → 恢复 / 丢弃 → TTL 清理
//
// 这一层的失败模式都是「拿错东西覆盖用户已改好的文件」，所以断言都落在
// 文件系统状态与恢复出来的 tab 属性上（dirty / 无磁盘基线），不看调用次数。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "/appdata" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

// `applyRecovery` 对「有路径的草稿」会读一次当前磁盘基线，避免保存时静默覆盖
const { readDocumentMock, saveDocumentMock, readTextFileMock } = vi.hoisted(() => ({
  readDocumentMock: vi.fn(),
  readTextFileMock: vi.fn(async () => "基线"),
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
  readDocumentMock
    .mockReset()
    .mockResolvedValue({ content: "磁盘内容", stat: { mtimeUs: 5_000, size: 4 } });
  readTextFileMock.mockReset().mockResolvedValue("磁盘内容");
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
      return [...names].map((name) => ({ name, isDir: false }));
    },
    deletePath: async (path) => {
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
      readTextFile: async () =>
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
      readTextFile: async (path) => files.get(path) ?? "",
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

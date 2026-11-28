// #365 草稿日志：写 / 清 / 退出 flush / 单条配额门禁 + 提示
//
// 这一层的失败模式都是「静默丢内容」，所以断言必须落在**写出去的文件内容**、
// **失败/超限时的健康度与写盘结果**上，而不是只看调用次数。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const files = new Map<string, string>();
const writes: Array<{ path: string; options?: { durability?: string; createParents?: boolean } }> = [];
let failWrite = false;
let failRemove = false;

// #404：应用数据根由 `app_data_root` 命令解析（便携模式可能不是 Roaming），
// 这里按真实命令名应答；继续 mock `@tauri-apps/api/path` 会掩盖这条链路
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: async (cmd: string) => (cmd === "app_data_root" ? "/appdata" : null),
}));

vi.mock("../../src/lib/fs", () => ({
  writeTextFile: vi.fn(async (path: string, content: string, options?: { durability?: string }) => {
    if (failWrite) throw new Error("disk full");
    files.set(path, content);
    writes.push({ path, options });
  }),
  // 会话标记现在走恢复区通道（`write_recovery_file`）：同一个内存文件表，便于断言
  writeRecoveryFile: vi.fn(async (path: string, content: string, durability?: string) => {
    if (failWrite) throw new Error("disk full");
    files.set(path, content);
    writes.push({ path, options: { durability } });
  }),
}));

import { writeTextFile } from "../../src/lib/fs";
import {
  __resetSession,
  __setDraftMaxBytes,
  __setDraftTotalBytes,
  __setJournalIo,
  __setNoticeSink,
  clearDraft,
  scheduleDraft,
  writeDraftNow,
  DRAFT_DEBOUNCE_MS,
  DRAFT_MAX_BYTES,
  draftFileKey,
  lastDraftWriteOutcome,
} from "../../src/lib/draft-journal";
import {
  __resetJournalHealth,
  countDraftlessTabs,
  flushAllDrafts,
  journalHealth,
  markCleanExit,
  markUncleanExit,
} from "../../src/lib/exit-session";
import { __setRecoveryIo } from "../../src/lib/session-recovery";
import { useWorkspace } from "../../src/store/workspace";
import {
  __resetCursorCheckpoint,
  __setCursorIo,
  scheduleCursorCheckpoint,
} from "../../src/lib/cursor-checkpoint";

function tab(path: string, extra: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    content: "# 未保存内容",
    dirty: true,
    isUntitled: false,
    lastSavedAt: null,
    diskContent: "",
    diskStat: { mtimeUs: 1_000, size: 0 },
    cursorPos: null,
    scrollTop: null,
    ...extra,
  };
}

const DRAFT_DIR = "/appdata/recovery/main/drafts";

beforeEach(() => {
  files.clear();
  writes.length = 0;
  failWrite = false;
  failRemove = false;
  vi.mocked(writeTextFile).mockClear();
  __resetSession("main");
  __resetJournalHealth();
  __setJournalIo({
    writeTextFile: async (path, content, options) => {
      if (failWrite) throw new Error("disk full");
      files.set(path, content);
      writes.push({ path, options });
    },
    appDataDir: async () => "/appdata",
    removeFile: async (path) => {
      if (failRemove) throw new Error("EBUSY: 副本被占用");
      files.delete(path);
    },
  });
  useWorkspace.setState({ openTabs: [], activeTabPath: null } as never);
});

afterEach(() => {
  __setJournalIo(null);
  __setRecoveryIo(null);
  __setCursorIo(null);
  __resetCursorCheckpoint();
  vi.useRealTimers();
});

describe("#378 光标 flush 失败不参与内容副本判定", () => {
  it("光标 checkpoint 写失败、草稿成功 → 仍视为有恢复副本", async () => {
    __setCursorIo({
      appDataDir: async () => "/appdata",
      readRecoveryFile: async () => "",
      writeTextFile: async () => {
        throw new Error("EIO: cursor.json 写失败");
      },
    });
    scheduleCursorCheckpoint("/w/a.md", 4, 40, 1);
    useWorkspace.setState({ openTabs: [tab("/w/a.md")], activeTabPath: "/w/a.md" } as never);

    await flushAllDrafts({ durability: "sync" });

    // 断言落在真实副作用上：草稿正文确实落在恢复区，退出确认不该说「永久丢失」
    const draft = `${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`;
    expect(JSON.parse(files.get(draft)!).content).toBe("# 未保存内容");
    expect(journalHealth).toBe("healthy");
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);

    __setCursorIo(null);
    __resetCursorCheckpoint();
  });
});

describe("#365 草稿日志", () => {
  it("writeDraftNow 写出可解析的 DraftFile（含正文、tabPath、sessionId）", async () => {
    const ok = await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "正文 v1" });
    expect(ok).toBe(true);

    const file = `${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`;
    const draft = JSON.parse(files.get(file)!);
    expect(draft).toMatchObject({
      version: 1,
      tabPath: "/w/a.md",
      content: "正文 v1",
      isUntitled: false,
      pinned: false,
    });
    expect(draft.sessionId).toBeTruthy();
    // 总量 LRU 的排序键：每次落盘都要刷新写入时间
    expect(draft.updatedAt).toBeGreaterThan(0);
    // 平时不付 fsync：退出时才 Sync
    expect(writes.at(-1)?.options?.durability).toBe("none");
    expect(writes.at(-1)?.options?.createParents).toBe(true);
  });

  it("路径无法编码时只返回 false，不让 flushAllDrafts 整体 reject", async () => {
    await expect(
      writeDraftNow({ path: "\ud800", isUntitled: false, content: "x" }),
    ).resolves.toBe(false);
    expect(files.size).toBe(0);

    // 聚合点也必须只是「有一条没写成」，不能让退出 flush 整体 reject
    useWorkspace.setState({ openTabs: [tab("\ud800")] } as never);
    await expect(flushAllDrafts({ durability: "sync" })).resolves.toBeUndefined();
    expect(journalHealth).toBe("degraded");
    expect(countDraftlessTabs(["\ud800"])).toBe(1);
  });

  it("scheduleDraft 按 1.2s 防抖：连续输入只写最后一次", async () => {
    vi.useFakeTimers();
    scheduleDraft({ path: "/w/a.md", isUntitled: false, content: "v1" });
    vi.advanceTimersByTime(600);
    scheduleDraft({ path: "/w/a.md", isUntitled: false, content: "v2" });
    vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1);
    expect(files.size).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    // 定时器回调里有 await，给它一个 microtask 轮次
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(files.get(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)!).content).toBe("v2");
  });

  it("clearDraft 删掉已经写出的草稿", async () => {
    await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "x" });
    const file = `${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`;
    expect(files.has(file)).toBe(true);

    await clearDraft("/w/a.md");

    expect(files.has(file)).toBe(false);
  });

  it("flushAllDrafts：只写 dirty tab，用 Sync，并把结果记进健康度", async () => {
    useWorkspace.setState({
      openTabs: [tab("/w/a.md"), tab("/w/b.md", { dirty: false, content: "已保存" })],
    } as never);

    await flushAllDrafts({ durability: "sync" });

    const aKey = draftFileKey("/w/a.md");
    const bKey = draftFileKey("/w/b.md");
    expect(files.has(`${DRAFT_DIR}/${aKey}.json`)).toBe(true);
    expect(files.has(`${DRAFT_DIR}/${bKey}.json`)).toBe(false);
    expect(writes.at(-1)?.options?.durability).toBe("sync");
    expect(journalHealth).toBe("healthy");
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);
  });

  it("flushAllDrafts 写失败 → health 降级，不再承诺「有恢复副本」", async () => {
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    failWrite = true;

    await flushAllDrafts({ durability: "sync" });

    expect(journalHealth).toBe("degraded");
    expect(countDraftlessTabs(["/w/a.md"])).toBe(1);
  });

  it("草稿写失败降级后，下一次全部写成功即恢复 healthy", async () => {
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    failWrite = true;
    await flushAllDrafts({ durability: "sync" });
    expect(journalHealth).toBe("degraded");
    expect(countDraftlessTabs(["/w/a.md"])).toBe(1);

    failWrite = false;
    await flushAllDrafts({ durability: "sync" });
    expect(journalHealth).toBe("healthy");
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);
    const draft = `${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`;
    expect(JSON.parse(files.get(draft)!).content).toBe("# 未保存内容");
  });

  it("markCleanExit 先清干净 tab 的草稿，再写 cleanExit:true", async () => {
    useWorkspace.setState({
      openTabs: [tab("/w/a.md", { dirty: false }), tab("/w/b.md", { dirty: true })],
    } as never);
    await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "已保存" });
    await writeDraftNow({ path: "/w/b.md", isUntitled: false, content: "未保存" });

    const ok = await markCleanExit();

    expect(ok).toBe(true);
    // 已保存的 tab 草稿删掉；仍 dirty 的保留（下一次退出流程还要用）
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)).toBe(false);
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/b.md")}.json`)).toBe(true);
    const session = JSON.parse(files.get("/appdata/recovery/main/session.json")!);
    expect(session.cleanExit).toBe(true);
  });

  it("markUncleanExit 只写 cleanExit:false，草稿保留", async () => {
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "未保存" });

    const ok = await markUncleanExit();

    expect(ok).toBe(true);
    const session = JSON.parse(files.get("/appdata/recovery/main/session.json")!);
    expect(session.cleanExit).toBe(false);
    expect(session.windowLabel).toBe("main");
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)).toBe(true);
  });
});

describe("#409 配额：单条 10MB 上限 + 总量 32MB 淘汰", () => {
  let notices: string[] = [];

  beforeEach(() => {
    notices = [];
    __setNoticeSink((text) => notices.push(text));
  });

  afterEach(() => {
    __setNoticeSink(null);
    __setDraftMaxBytes(null);
    __setDraftTotalBytes(null);
  });

  it("上限按 UTF-8 字节计：字符数没超但字节数超了也要拒绝", async () => {
    __setDraftMaxBytes(1_024);
    // 400 个汉字 = 400 字符（< 1024），但 UTF-8 是 1200 字节
    const ok = await writeDraftNow({
      path: "/w/a.md",
      isUntitled: false,
      content: "汉".repeat(400),
    });

    expect(ok).toBe(false);
    expect(lastDraftWriteOutcome.get("/w/a.md")).toBe("oversize");
    expect(files.size).toBe(0);
    expect(notices).toHaveLength(1);
  });

  it("上限把 JSON 信封算进去：正文没超、加上路径与时间戳后超了也要拒绝", async () => {
    __setDraftMaxBytes(1_024);
    // 正文 950 字节 < 1024，但 DraftFile 的信封字段会把它推过上限
    const ok = await writeDraftNow({
      path: "/w/envelope.md",
      isUntitled: false,
      content: "a".repeat(950),
    });

    expect(ok).toBe(false);
    expect(lastDraftWriteOutcome.get("/w/envelope.md")).toBe("oversize");
    expect(files.size).toBe(0);
  });

  it("未超限时照常写盘，结果为 ok", async () => {
    __setDraftMaxBytes(1_024);
    expect(
      await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "短正文" }),
    ).toBe(true);
    expect(lastDraftWriteOutcome.get("/w/a.md")).toBe("ok");
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)).toBe(true);
  });

  it("超过真实 10MB 上限的文档被跳过，且同一条只提示一次", async () => {
    const content = "a".repeat(DRAFT_MAX_BYTES + 1);

    expect(await writeDraftNow({ path: "/w/big.md", isUntitled: false, content })).toBe(false);
    expect(lastDraftWriteOutcome.get("/w/big.md")).toBe("oversize");
    expect(files.size).toBe(0);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("10 MB");

    // 1.2s 防抖下每次输入都会重试：不能每次都弹提示
    expect(await writeDraftNow({ path: "/w/big.md", isUntitled: false, content })).toBe(false);
    expect(lastDraftWriteOutcome.get("/w/big.md")).toBe("oversize");
    expect(notices).toHaveLength(1);
  });

  it("缩小回上限内写成功后，再次超限要重新提示（否则用户以为副本还在更新）", async () => {
    __setDraftMaxBytes(1_024);
    const big = "汉".repeat(400);

    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: big })).toBe(false);
    expect(notices).toHaveLength(1);

    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "短" })).toBe(true);
    expect(lastDraftWriteOutcome.get("/w/a.md")).toBe("ok");

    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: big })).toBe(false);
    expect(notices).toHaveLength(2);
  });

  it("超限但盘上仍有旧副本：退出确认不能声称「没有恢复副本」", async () => {
    __setDraftMaxBytes(1_024);
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    await flushAllDrafts({ durability: "sync" });
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);

    // 同一 tab 内容涨到超限：本次不写盘，但上一份副本是刻意保留的
    useWorkspace.setState({
      openTabs: [tab("/w/a.md", { content: "汉".repeat(400) })],
    } as never);
    await flushAllDrafts({ durability: "sync" });

    expect(lastDraftWriteOutcome.get("/w/a.md")).toBe("oversize");
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)).toBe(true);
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);
  });

  it("混合场景：超限且无副本的 tab 必须算作缺失（不能因为别的 tab 有副本就放行退出）", async () => {
    __setDraftMaxBytes(1_024);
    useWorkspace.setState({
      openTabs: [tab("/w/big.md", { content: "汉".repeat(400) }), tab("/w/a.md")],
    } as never);

    await flushAllDrafts({ durability: "sync" });

    // health 仍是 healthy（超限不是写盘故障），但逐条判定必须认出 /w/big.md 没有副本
    expect(journalHealth).toBe("healthy");
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/big.md")}.json`)).toBe(false);
    expect(countDraftlessTabs(["/w/big.md", "/w/a.md"])).toBe(1);
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);
  });

  it("清掉副本后不再声称「有恢复副本」（历史成功记录不能放行退出）", async () => {
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    await flushAllDrafts({ durability: "sync" });
    expect(journalHealth).toBe("healthy");
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);

    // 保存 / 关闭 tab 会走 clearDraft：文件删了，成功记录也必须一起清
    await clearDraft("/w/a.md");
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)).toBe(false);
    expect(countDraftlessTabs(["/w/a.md"])).toBe(1);
  });

  it("删副本失败时保留提示历史（盘上还有旧副本，不能假装「没有副本」）", async () => {
    __setDraftMaxBytes(1_024);
    const big = "汉".repeat(400);

    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "短" })).toBe(true);
    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: big })).toBe(false);
    expect(notices).toHaveLength(1);

    failRemove = true;
    await clearDraft("/w/a.md");

    // 副本删不掉就还在盘上：仍然算「有副本」，提示也不重新武装
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)).toBe(true);
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);
    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: big })).toBe(false);
    expect(notices).toHaveLength(1);
  });

  it("关掉重开同一路径后再次超限要重新提示（clearDraft 也要清提示历史）", async () => {
    __setDraftMaxBytes(1_024);
    const big = "汉".repeat(400);

    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: big })).toBe(false);
    expect(notices).toHaveLength(1);

    // 关闭 tab：超限路径从未写成功，journaled 里没有它，清理不能因此被跳过
    await clearDraft("/w/a.md");

    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: big })).toBe(false);
    expect(notices).toHaveLength(2);
  });

  it("文档变大超限时不删掉之前写下的副本（偏旧也好过完全没有）", async () => {
    __setDraftMaxBytes(1_024);
    const file = `${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`;
    expect(await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "短" })).toBe(true);

    expect(
      await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "汉".repeat(400) }),
    ).toBe(false);

    expect(files.has(file)).toBe(true);
    expect(JSON.parse(files.get(file)!).content).toBe("短");
  });

  it("单条超限不算写盘故障：health 不降级，但该 tab 逐条判定仍算「没有副本」", async () => {
    __setDraftMaxBytes(1_024);
    useWorkspace.setState({
      openTabs: [tab("/w/big.md", { content: "汉".repeat(400) }), tab("/w/a.md")],
    } as never);

    await flushAllDrafts({ durability: "sync" });

    expect(journalHealth).toBe("healthy");
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/a.md")}.json`)).toBe(true);
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/big.md")}.json`)).toBe(false);
    expect(countDraftlessTabs(["/w/big.md"])).toBe(1);
    expect(countDraftlessTabs(["/w/a.md"])).toBe(0);
  });

  it("退出 flush 会顺带执行总量淘汰：删掉已处理的旧副本，本会话新副本保留", async () => {
    // 配额走 session-recovery 的 io：这里让它读同一份内存文件表
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
        return [...files.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({
            name: k.slice(prefix.length),
            isDir: false,
            size: new TextEncoder().encode(files.get(k) ?? "").length,
          }));
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    });

    // 旧会话：用户已处理过 /w/old.md，副本还留在盘上
    const oldKey = draftFileKey("/w/old.md");
    files.set(
      `${DRAFT_DIR}/${oldKey}.json`,
      JSON.stringify({
        version: 1,
        draftId: oldKey,
        sessionId: "s-old",
        tabPath: "/w/old.md",
        isUntitled: false,
        title: "old.md",
        content: "o".repeat(600),
        pinned: false,
        updatedAt: 1_000,
      }),
    );
    files.set(
      "/appdata/recovery/main/crashed-1000.json",
      JSON.stringify({
        version: 1,
        sessionId: "s-old",
        windowLabel: "main",
        startedAt: 1_000,
        archivedAt: 1_000,
        cleanExit: false,
        draftPaths: ["/w/old.md"],
        handledDraftIds: ["/w/old.md"],
        fullyHandled: true,
        draftsEnumerated: true,
      }),
    );
    __setDraftTotalBytes(1); // 强制超限

    useWorkspace.setState({ openTabs: [tab("/w/new.md")] } as never);
    await flushAllDrafts({ durability: "sync" });

    // 旧副本被淘汰；本次会话的新副本必须留着
    expect(files.has(`${DRAFT_DIR}/${oldKey}.json`)).toBe(false);
    expect(files.has(`${DRAFT_DIR}/${draftFileKey("/w/new.md")}.json`)).toBe(true);
  });

  it("没有 dirty tab 时退出/失焦也要校准总量（Ctrl+S 后直接关窗不能跳过配额）", async () => {
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
        return [...files.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({
            name: k.slice(prefix.length),
            isDir: false,
            size: new TextEncoder().encode(files.get(k) ?? "").length,
          }));
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    });

    const oldKey = draftFileKey("/w/old.md");
    files.set(
      `${DRAFT_DIR}/${oldKey}.json`,
      JSON.stringify({
        version: 1,
        draftId: oldKey,
        sessionId: "s-old",
        tabPath: "/w/old.md",
        isUntitled: false,
        title: "old.md",
        content: "o".repeat(600),
        pinned: false,
        updatedAt: 1_000,
      }),
    );
    files.set(
      "/appdata/recovery/main/crashed-1000.json",
      JSON.stringify({
        version: 1,
        sessionId: "s-old",
        windowLabel: "main",
        startedAt: 1_000,
        archivedAt: 1_000,
        cleanExit: false,
        draftPaths: ["/w/old.md"],
        handledDraftIds: ["/w/old.md"],
        fullyHandled: true,
        draftsEnumerated: true,
      }),
    );
    __setDraftTotalBytes(1);

    // 没有 dirty tab：旧实现会在这里 early return，配额整轮不跑
    useWorkspace.setState({ openTabs: [] } as never);
    await flushAllDrafts({ durability: "sync" });

    expect(files.has(`${DRAFT_DIR}/${oldKey}.json`)).toBe(false);
  });

  it("全部草稿都超限：health 仍 healthy，但确实没有可恢复副本（退出提示仍准确）", async () => {
    __setDraftMaxBytes(1_024);
    useWorkspace.setState({
      openTabs: [tab("/w/big.md", { content: "汉".repeat(400) })],
    } as never);

    await flushAllDrafts({ durability: "sync" });

    expect(journalHealth).toBe("healthy");
    expect(countDraftlessTabs(["/w/big.md"])).toBe(1);
  });
});

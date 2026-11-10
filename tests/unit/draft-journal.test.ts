// #365 草稿日志：写 / 清 / 退出 flush 三件事
//
// 这一层的失败模式都是「静默丢内容」，所以断言必须落在**写出去的文件内容**与
// **失败时的健康度**上，而不是只看调用次数。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const files = new Map<string, string>();
const writes: Array<{ path: string; options?: { durability?: string; createParents?: boolean } }> = [];
let failWrite = false;

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "/appdata" }));

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
  __setJournalIo,
  clearDraft,
  scheduleDraft,
  writeDraftNow,
  DRAFT_DEBOUNCE_MS,
  draftFileKey,
} from "../../src/lib/draft-journal";
import {
  __resetJournalHealth,
  flushAllDrafts,
  hasRecoverableDraft,
  journalHealth,
  markCleanExit,
  markUncleanExit,
} from "../../src/lib/exit-session";
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
  vi.mocked(writeTextFile).mockClear();
  __resetSession("main");
  __resetJournalHealth();
  __setJournalIo({
    writeTextFile: async (path, content, options) => {
      if (failWrite) throw new Error("disk full");
      files.set(path, content);
      writes.push({ path, options });
    },
    readTextFile: async (path) => files.get(path) ?? "",
    appDataDir: async () => "/appdata",
    removeFile: async (path) => {
      files.delete(path);
    },
  });
  useWorkspace.setState({ openTabs: [], activeTabPath: null } as never);
});

afterEach(() => {
  __setJournalIo(null);
  __setCursorIo(null);
  __resetCursorCheckpoint();
  vi.useRealTimers();
});

describe("#378 光标 flush 失败不参与内容副本判定", () => {
  it("光标 checkpoint 写失败、草稿成功 → 仍视为有恢复副本", async () => {
    __setCursorIo({
      appDataDir: async () => "/appdata",
      readTextFile: async () => "",
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
    expect(hasRecoverableDraft()).toBe(true);

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
    // 平时不付 fsync：退出时才 Sync
    expect(writes.at(-1)?.options?.durability).toBe("none");
    expect(writes.at(-1)?.options?.createParents).toBe(true);
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
    expect(hasRecoverableDraft()).toBe(true);
  });

  it("flushAllDrafts 写失败 → health 降级，不再承诺「有恢复副本」", async () => {
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    failWrite = true;

    await flushAllDrafts({ durability: "sync" });

    expect(journalHealth).toBe("degraded");
    expect(hasRecoverableDraft()).toBe(false);
  });

  it("草稿写失败降级后，下一次全部写成功即恢复 healthy", async () => {
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    failWrite = true;
    await flushAllDrafts({ durability: "sync" });
    expect(journalHealth).toBe("degraded");
    expect(hasRecoverableDraft()).toBe(false);

    failWrite = false;
    await flushAllDrafts({ durability: "sync" });
    expect(journalHealth).toBe("healthy");
    expect(hasRecoverableDraft()).toBe(true);
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

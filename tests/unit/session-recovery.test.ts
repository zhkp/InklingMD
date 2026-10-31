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

import {
  __setRecoveryIo,
  DRAFT_TTL_MS,
  applyRecovery,
  beginSession,
  cleanupExpiredDrafts,
  discardDrafts,
  findRecoverableDrafts,
  listDrafts,
  readSessionMarker,
} from "../../src/lib/session-recovery";
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
  opts: { content?: string; updatedAt?: number; pinned?: boolean; isUntitled?: boolean } = {},
): string {
  const file = draftFile(tabPath);
  files.set(
    file,
    JSON.stringify({
      version: 1,
      draftId: file,
      sessionId: "s1",
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

  it("beginSession 先落 cleanExit:false（进程被杀下次才有提示）", async () => {
    await beginSession(1_234);

    const marker = JSON.parse(files.get(SESSION)!);
    expect(marker.cleanExit).toBe(false);
    expect(marker.windowLabel).toBe("main");
  });
});

describe("#365 恢复与丢弃", () => {
  it("applyRecovery 恢复成 dirty tab，且不登记磁盘基线（避免静默覆盖）", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/a.md", { content: "崩溃前的内容" });
    seedDraft("untitled-1", { content: "草稿正文", isUntitled: true });

    const drafts = await listDrafts();
    const restored = applyRecovery(drafts);

    expect(restored).toBe(2);
    const state = useWorkspace.getState();
    expect(state.openTabs.map((t) => t.path)).toEqual(["/w/a.md", "untitled-1"]);
    expect(state.openTabs[0].content).toBe("崩溃前的内容");
    expect(state.openTabs[0].dirty).toBe(true);
    expect(state.openTabs[0].diskStat).toBeUndefined();
    expect(state.openTabs[1].isUntitled).toBe(true);
    expect(state.activeTabPath).toBe("/w/a.md");
  });

  it("已经打开的 path 不会被恢复动作覆盖", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/a.md", { content: "草稿" });
    useWorkspace.setState({
      openTabs: [{ path: "/w/a.md", content: "当前编辑中", dirty: false }],
      activeTabPath: "/w/a.md",
    } as never);

    const restored = applyRecovery(await listDrafts());

    expect(restored).toBe(0);
    expect(useWorkspace.getState().openTabs[0].content).toBe("当前编辑中");
  });

  it("discardDrafts 真删文件", async () => {
    const file = seedDraft("/w/a.md");
    const drafts = await listDrafts();

    const deleted = await discardDrafts(drafts);

    expect(deleted).toBe(1);
    expect(files.has(file)).toBe(false);
  });
});

describe("#365 TTL 清理", () => {
  it("只清超过 7 天且非 pinned 的，近期与 pinned 一律保留", async () => {
    const now = 10 * DRAFT_TTL_MS;
    const oldFile = seedDraft("/w/old.md", { updatedAt: now - DRAFT_TTL_MS - 1 });
    const recentFile = seedDraft("/w/recent.md", { updatedAt: now - 1_000 });
    const pinnedFile = seedDraft("/w/pinned.md", {
      updatedAt: now - DRAFT_TTL_MS - 1,
      pinned: true,
    });

    const removed = await cleanupExpiredDrafts(now);

    expect(removed).toBe(1);
    expect(files.has(oldFile)).toBe(false);
    expect(files.has(recentFile)).toBe(true);
    expect(files.has(pinnedFile)).toBe(true);
  });
});

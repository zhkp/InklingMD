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
const { readDocumentMock } = vi.hoisted(() => ({ readDocumentMock: vi.fn() }));
vi.mock("../../src/lib/fs", () => ({ readDocument: readDocumentMock }));
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
  readDocumentMock
    .mockReset()
    .mockResolvedValue({ content: "磁盘内容", stat: { mtimeUs: 5_000, size: 4 } });
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

    expect(restored).toBe(2);
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

  it("已经打开的 path 不会被恢复动作覆盖", async () => {
    files.set(SESSION, JSON.stringify({ version: 1, cleanExit: false }));
    seedDraft("/w/a.md", { content: "草稿" });
    useWorkspace.setState({
      openTabs: [{ path: "/w/a.md", content: "当前编辑中", dirty: false }],
      activeTabPath: "/w/a.md",
    } as never);

    const restored = await applyRecovery(await listDrafts());

    expect(restored).toBe(0);
    expect(useWorkspace.getState().openTabs[0].content).toBe("当前编辑中");
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

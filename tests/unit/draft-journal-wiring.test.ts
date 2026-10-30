// #365 复审要求的「能证伪」断言（默认 IO / 窗口隔离 / 无标题 / 重载清草稿）
//
// 这些点此前的用例全都绕过了：注入内存 IO 就测不到真实命令名；只调 flushAllDrafts
// 就测不到退出链路；windowLabel 里写死 "main" 也没人断言过。

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenTab } from "../../src/store/workspace";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: invokeMock,
}));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "/appdata" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "inkling-test" }),
}));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));
vi.mock("../../src/lib/fs", () => ({
  writeTextFile: vi.fn(async () => undefined),
  readTextFile: vi.fn(async () => "基线"),
  readDocument: vi.fn(async () => ({ content: "磁盘内容", stat: { mtimeUs: 5_000, size: 4 } })),
  fileStat: vi.fn(async () => ({ mtimeUs: 5_000, size: 4 })),
  fileMtime: vi.fn(async () => 5),
  deletePath: vi.fn(),
}));

import {
  __resetSession,
  __setJournalIo,
  clearDraft,
  draftFileKey,
  ensureWindowLabel,
  writeDraftNow,
} from "../../src/lib/draft-journal";
import { flushAllDrafts, __resetJournalHealth } from "../../src/lib/exit-session";
import { useWorkspace } from "../../src/store/workspace";

function tab(path: string, extra: Partial<OpenTab> = {}): OpenTab {
  return {
    path,
    content: "# 正文",
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

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  __resetJournalHealth();
  __setJournalIo(null); // 用默认 IO：这才是生产走的那条
  __resetSession();
  useWorkspace.setState({ openTabs: [], activeTabPath: null } as never);
});

describe("#365 默认 IO 的命令名", () => {
  it("写草稿用 write_text_file，删草稿用 delete_path（写错命令名会静默失败）", async () => {
    const written = await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "x" });
    expect(written).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "write_text_file",
      expect.objectContaining({ filePath: expect.stringContaining("/drafts/") }),
    );

    await clearDraft("/w/a.md");

    expect(invokeMock).toHaveBeenCalledWith(
      "delete_path",
      expect.objectContaining({ path: expect.stringContaining("/drafts/") }),
    );
  });

  it("删除失败时不清记账：下一次 clearDraft 仍会重试", async () => {
    await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "x" });
    invokeMock.mockRejectedValueOnce(new Error("locked"));

    await clearDraft("/w/a.md"); // 第一次：失败
    invokeMock.mockResolvedValue(undefined);
    await clearDraft("/w/a.md"); // 第二次：必须真的再发一次 delete_path

    const deleteCalls = invokeMock.mock.calls.filter((c) => c[0] === "delete_path");
    expect(deleteCalls).toHaveLength(2);
  });
});

describe("#365 多窗口隔离", () => {
  it("窗口 label 来自 getCurrentWindow()，草稿落在 recovery/<label>/ 下", async () => {
    await ensureWindowLabel();
    const ok = await writeDraftNow({ path: "/w/a.md", isUntitled: false, content: "x" });
    expect(ok).toBe(true);

    const writeCall = invokeMock.mock.calls.find((c) => c[0] === "write_text_file");
    expect(String(writeCall?.[1]?.filePath)).toContain("/recovery/inkling-test/drafts/");
  });

  it("两个不同 label 写各自的 session 目录，互不覆盖", async () => {
    const files = new Map<string, string>();
    __setJournalIo({
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      readTextFile: async (path) => files.get(path) ?? "",
      appDataDir: async () => "/appdata",
      removeFile: async (path) => {
        files.delete(path);
      },
    });

    __resetSession("inkling-a");
    useWorkspace.setState({ openTabs: [tab("/w/a.md")] } as never);
    await flushAllDrafts({ durability: "sync" });

    __resetSession("inkling-b");
    useWorkspace.setState({ openTabs: [tab("/w/b.md")] } as never);
    await flushAllDrafts({ durability: "sync" });

    const paths = [...files.keys()];
    expect(paths.some((p) => p.includes("/recovery/inkling-a/drafts/"))).toBe(true);
    expect(paths.some((p) => p.includes("/recovery/inkling-b/drafts/"))).toBe(true);
  });
});

describe("#365 草稿元信息与清理时机", () => {
  it("无标题草稿写出 isUntitled:true（写死 false 会让 5b 当成有路径的文档恢复）", async () => {
    const files = new Map<string, string>();
    __setJournalIo({
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      readTextFile: async (path) => files.get(path) ?? "",
      appDataDir: async () => "/appdata",
      removeFile: async (path) => {
        files.delete(path);
      },
    });
    __resetSession("main");

    useWorkspace.setState({
      openTabs: [tab("untitled-1", { isUntitled: true, content: "草稿正文" })],
      activeTabPath: "untitled-1",
    } as never);
    // 走真实的 setContent（生产入口），不是直接调 scheduleDraft
    useWorkspace.getState().setContent("草稿正文 2");

    await flushAllDrafts({ durability: "sync" });

    const key = draftFileKey("untitled-1");
    const draft = JSON.parse(files.get(`/appdata/recovery/main/drafts/${key}.json`)!);
    expect(draft.isUntitled).toBe(true);
    expect(draft.content).toBe("草稿正文 2");
  });

  it("reloadFile（用户选择丢弃本地修改）后草稿被删除，不会给出「可恢复」的假提示", async () => {
    const files = new Map<string, string>();
    __setJournalIo({
      writeTextFile: async (path, content) => {
        files.set(path, content);
      },
      readTextFile: async (path) => files.get(path) ?? "",
      appDataDir: async () => "/appdata",
      removeFile: async (path) => {
        files.delete(path);
      },
    });
    __resetSession("main");

    const DOC = "/w/a.md";
    useWorkspace.setState({
      openTabs: [tab(DOC)], // dirty
      activeTabPath: DOC,
      currentFile: DOC,
      currentContent: "# 正文",
    } as never);
    await flushAllDrafts({ durability: "sync" });
    const draftFile = `/appdata/recovery/main/drafts/${draftFileKey(DOC)}.json`;
    expect(files.has(draftFile)).toBe(true);

    await useWorkspace.getState().reloadFile(DOC);

    expect(files.has(draftFile)).toBe(false);
    expect(useWorkspace.getState().openTabs[0].dirty).toBe(false);
  });
});

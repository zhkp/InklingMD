// 光标 checkpoint（#378）：节流、合并、失焦 flush、失败可重试、读回

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: async () => "/appdata" }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

import {
  CURSOR_THROTTLE_MS,
  __resetCursorCheckpoint,
  __setCursorIo,
  flushCursorCheckpoint,
  readCursorCheckpoint,
  scheduleCursorCheckpoint,
} from "../../src/lib/cursor-checkpoint";

const files = new Map<string, string>();
let failWrite = false;

beforeEach(() => {
  files.clear();
  failWrite = false;
  __resetCursorCheckpoint();
  __setCursorIo({
    appDataDir: async () => "/appdata",
    readTextFile: async (path) => files.get(path) ?? "",
    writeTextFile: async (path, content) => {
      if (failWrite) throw new Error("disk full");
      files.set(path, content);
    },
  });
  vi.useFakeTimers();
});

afterEach(() => {
  __resetCursorCheckpoint();
  vi.useRealTimers();
});

describe("#378 光标 checkpoint", () => {
  it("5s 窗口内多次变化只写一次盘，且保留最后一次值", async () => {
    scheduleCursorCheckpoint("/w/a.md", 1, 10, 1_000);
    scheduleCursorCheckpoint("/w/a.md", 2, 20, 1_500);
    scheduleCursorCheckpoint("/w/b.md", 3, 30, 2_000);

    await vi.advanceTimersByTimeAsync(CURSOR_THROTTLE_MS - 1);
    expect(files.size).toBe(0); // 窗口未到不该落盘

    await vi.advanceTimersByTimeAsync(1);
    expect(files.size).toBe(1); // 三个变化合并成一次写

    const stored = JSON.parse(files.get("/appdata/recovery/main/cursor.json")!);
    expect(stored.tabs["/w/a.md"]).toMatchObject({ pos: 2, scrollTop: 20, updatedAt: 1_500 });
    expect(stored.tabs["/w/b.md"]).toMatchObject({ pos: 3, scrollTop: 30 });
  });

  it("flush 立即落盘（失焦/退出路径），读回与写入一致", async () => {
    scheduleCursorCheckpoint("/w/a.md", 7, 70, 3_000);

    expect(await flushCursorCheckpoint()).toBe(true);
    expect(files.size).toBe(1);

    const snapshot = await readCursorCheckpoint("/w/a.md");
    expect(snapshot).toMatchObject({ pos: 7, scrollTop: 70, updatedAt: 3_000 });
    expect(await readCursorCheckpoint("/w/missing.md")).toBeNull();
  });

  it("写失败时状态回队列，下一次 flush 仍会重试", async () => {
    scheduleCursorCheckpoint("/w/a.md", 9, 90, 4_000);
    failWrite = true;
    expect(await flushCursorCheckpoint()).toBe(false);
    expect(files.size).toBe(0);

    failWrite = false;
    expect(await flushCursorCheckpoint()).toBe(true);
    expect(await readCursorCheckpoint("/w/a.md")).toMatchObject({ pos: 9, scrollTop: 90 });
  });

  it("读取失败时拒绝按空表覆盖已有 checkpoint（瞬时 IO 错误不能抹掉别的 tab）", async () => {
    const path = "/appdata/recovery/main/cursor.json";
    files.set(
      path,
      JSON.stringify({ version: 1, tabs: { "/w/keep.md": { pos: 1, scrollTop: 1, updatedAt: 1 } } }),
    );
    __setCursorIo({
      appDataDir: async () => "/appdata",
      readTextFile: async () => {
        throw new Error("EIO: 瞬时读失败");
      },
      writeTextFile: async (p, c) => {
        files.set(p, c);
      },
    });
    scheduleCursorCheckpoint("/w/new.md", 5, 50, 5_000);

    expect(await flushCursorCheckpoint()).toBe(false);
    const stored = JSON.parse(files.get(path)!);
    expect(stored.tabs["/w/keep.md"]).toMatchObject({ pos: 1 });
  });

  it("已有 checkpoint 的其它 tab 不被覆盖（合并而非整表替换）", async () => {
    files.set(
      "/appdata/recovery/main/cursor.json",
      JSON.stringify({ version: 1, tabs: { "/w/keep.md": { pos: 1, scrollTop: 1, updatedAt: 1 } } }),
    );
    scheduleCursorCheckpoint("/w/new.md", 5, 50, 5_000);
    await flushCursorCheckpoint();

    expect(await readCursorCheckpoint("/w/keep.md")).toMatchObject({ pos: 1 });
    expect(await readCursorCheckpoint("/w/new.md")).toMatchObject({ pos: 5 });
  });

  it("cursor.json 内容损坏时按空表重建，后续 flush 都能写出可解析的新表", async () => {
    const path = "/appdata/recovery/main/cursor.json";
    files.set(path, "{ 坏 JSON：外部改写截断");

    scheduleCursorCheckpoint("/w/fresh.md", 12, 120, 6_000);
    expect(await flushCursorCheckpoint()).toBe(true);

    const stored = JSON.parse(files.get(path)!);
    expect(stored.version).toBe(1);
    expect(stored.tabs["/w/fresh.md"]).toMatchObject({ pos: 12, scrollTop: 120, updatedAt: 6_000 });
    expect(await readCursorCheckpoint("/w/fresh.md")).toMatchObject({ pos: 12 });

    // 不是一次侥幸：坏文件被覆盖后，第二次 flush 仍能正常合并
    scheduleCursorCheckpoint("/w/again.md", 13, 130, 7_000);
    expect(await flushCursorCheckpoint()).toBe(true);
    expect(await readCursorCheckpoint("/w/fresh.md")).toMatchObject({ pos: 12 });
    expect(await readCursorCheckpoint("/w/again.md")).toMatchObject({ pos: 13 });
  });
});

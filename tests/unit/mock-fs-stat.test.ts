// #362 mock 保真（设计 §11.6）
//
// 浏览器 mock 的 stat 必须是"真实磁盘身份"的替身：写/建/改名/删都要同步，
// 否则 E2E 里"文件没变"恒真、"删除态"不可达，成对读取与基线比对全部退化成
// 伪断言。本文件断言的是 mock 与 Rust 侧的同一张契约表。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

import {
  createFile,
  deletePath,
  fileMtime,
  fileStat,
  readDocument,
  renamePath,
  writeTextFile,
} from "../../src/lib/fs";
import { MOCK_FILE_CONTENT, MOCK_FILE_STAT, mockUtf8Length } from "../../src/lib/mockFs";

const DOC = "/mock-test/doc.md";
const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

beforeEach(() => {
  delete MOCK_FILE_CONTENT[DOC];
  delete MOCK_FILE_CONTENT["/mock-test/renamed.md"];
  delete MOCK_FILE_CONTENT["/mock-test/new.md"];
  delete MOCK_FILE_STAT[DOC];
  delete MOCK_FILE_STAT["/mock-test/renamed.md"];
  delete MOCK_FILE_STAT["/mock-test/new.md"];
});

describe("mock 磁盘身份表", () => {
  it("fixture 文件开箱即有 stat，且与 UTF-8 字节数一致", async () => {
    const path = "/mock-workspace/intro.md";
    const stat = await fileStat(path);
    expect(stat.size).toBe(mockUtf8Length(MOCK_FILE_CONTENT[path]));
    expect(stat.size).toBe(utf8(MOCK_FILE_CONTENT[path]));
    expect(stat.mtimeUs).toBeGreaterThan(0);
    expect(await fileMtime(path)).toBe(stat.mtimeUs / 1000);
  });

  it("readDocument 的内容与 stat 成对（同一次 mock 读取）", async () => {
    await writeTextFile(DOC, "# 标题\n正文");
    const before = await fileStat(DOC);

    const snap = await readDocument(DOC);

    expect(snap.content).toBe("# 标题\n正文");
    expect(snap.stat).toEqual(before);
  });

  it("写入后 mtime 前进、size 变为新内容字节数（fileMtime 不再返回 Date.now）", async () => {
    await writeTextFile(DOC, "a");
    const first = await fileStat(DOC);
    await writeTextFile(DOC, "abcd");
    const second = await fileStat(DOC);

    expect(second.size).toBe(4);
    expect(second.mtimeUs).toBeGreaterThan(first.mtimeUs);
    expect(await fileMtime(DOC)).toBe(second.mtimeUs / 1000);
  });

  it("新建文件的 stat 为 0 字节；删除后 fileStat / readDocument 报 notFound", async () => {
    await createFile(DOC);
    expect(await fileStat(DOC)).toMatchObject({ size: 0 });

    await deletePath(DOC);
    await expect(fileStat(DOC)).rejects.toMatchObject({ code: "notFound" });
    await expect(readDocument(DOC)).rejects.toMatchObject({ code: "notFound" });
  });

  it("改名后 stat 跟随内容迁到新路径，旧路径不再有身份", async () => {
    await writeTextFile(DOC, "迁移内容");
    const before = await fileStat(DOC);

    await renamePath(DOC, "/mock-test/renamed.md");

    expect(await fileStat("/mock-test/renamed.md")).toEqual(before);
    await expect(fileStat(DOC)).rejects.toMatchObject({ code: "notFound" });
    expect((await readDocument("/mock-test/renamed.md")).content).toBe("迁移内容");
  });

  it("目录删除按前缀清掉子文件的 stat（目录与单文件同语义）", async () => {
    await createFile("/mock-test/dir/a.md");
    await createFile("/mock-test/dir/b.md");

    await deletePath("/mock-test/dir");

    await expect(fileStat("/mock-test/dir/a.md")).rejects.toMatchObject({ code: "notFound" });
    await expect(fileStat("/mock-test/dir/b.md")).rejects.toMatchObject({ code: "notFound" });
    delete MOCK_FILE_STAT["/mock-test/dir"];
  });
});

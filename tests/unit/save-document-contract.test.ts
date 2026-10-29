// #362 `fs.saveDocument` 契约（浏览器 mock 分支）
//
// 评审 #394 第二轮第 5 条：判别联合与「目标缺失 / 身份不符 / 无身份」三分支此前零用例，
// 而 mock 分支正是 E2E 里唯一会走到的实现——它和 Rust 语义一旦漂移，
// 「删除后保存」「覆盖确认」在 E2E 里就会变成伪断言。

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));

import { saveDocument } from "../../src/lib/fs";
import { MOCK_FILE_CONTENT, MOCK_FILE_STAT } from "../../src/lib/mockFs";

const FILE = "/mock-workspace/save-contract.md";
const BASE = { mtimeUs: 1_000_000, size: 3 };

beforeEach(() => {
  delete MOCK_FILE_CONTENT[FILE];
  delete MOCK_FILE_STAT[FILE];
});

describe("fs.saveDocument（mock 分支）", () => {
  it("expected 命中：写入并返回新身份的回执", async () => {
    MOCK_FILE_CONTENT[FILE] = "old";
    MOCK_FILE_STAT[FILE] = { ...BASE };

    const outcome = await saveDocument(FILE, "new!", { expected: BASE });

    expect(outcome.kind).toBe("written");
    if (outcome.kind !== "written") return;
    expect(MOCK_FILE_CONTENT[FILE]).toBe("new!");
    // 回执必须是**写后**的身份（不是写前），否则基线又指向别人的内容
    expect(outcome.stat).toEqual(MOCK_FILE_STAT[FILE]);
    expect(outcome.stat.mtimeUs).toBeGreaterThan(BASE.mtimeUs);
    expect(outcome.stat.size).toBe(4);
    expect(outcome.foreignWrite).toBe(false);
  });

  it("expected 不匹配（外部已改）：返回 conflict 且不覆盖磁盘", async () => {
    MOCK_FILE_CONTENT[FILE] = "external";
    MOCK_FILE_STAT[FILE] = { mtimeUs: 2_000_000, size: 8 };

    const outcome = await saveDocument(FILE, "mine", { expected: BASE });

    expect(outcome.kind).toBe("conflict");
    if (outcome.kind !== "conflict") return;
    expect(outcome.disk).toEqual({ mtimeUs: 2_000_000, size: 8 });
    expect(MOCK_FILE_CONTENT[FILE]).toBe("external");
  });

  it("目标缺失 + 给了 expected：notFound，且绝不复活文件", async () => {
    const outcome = await saveDocument(FILE, "mine", { expected: BASE });

    expect(outcome.kind).toBe("notFound");
    expect(MOCK_FILE_CONTENT[FILE]).toBeUndefined();
    expect(MOCK_FILE_STAT[FILE]).toBeUndefined();
  });

  it("目标缺失 + 无 expected：创建并成功（草稿另存为 / 重新创建）", async () => {
    const outcome = await saveDocument(FILE, "first");

    expect(outcome.kind).toBe("written");
    expect(MOCK_FILE_CONTENT[FILE]).toBe("first");
  });

  it("目标存在 + 无 expected（CreateExclusive 语义）：conflict，不静默覆盖", async () => {
    MOCK_FILE_CONTENT[FILE] = "someone else";
    MOCK_FILE_STAT[FILE] = { mtimeUs: 3_000_000, size: 12 };

    const outcome = await saveDocument(FILE, "mine");

    expect(outcome.kind).toBe("conflict");
    expect(MOCK_FILE_CONTENT[FILE]).toBe("someone else");
  });

  it("另存为到已存在的文件（无 expected + overwriteExisting）：覆盖写入", async () => {
    // 原生保存对话框已经问过「是否替换」，用户点是之后必须能覆盖；
    // 不带 overwriteExisting 会走 CreateExclusive → 一律 conflict，等于该功能不可用
    MOCK_FILE_CONTENT[FILE] = "旧内容";
    MOCK_FILE_STAT[FILE] = { mtimeUs: 5_000_000, size: 9 };

    const outcome = await saveDocument(FILE, "新内容", { overwriteExisting: true });

    expect(outcome.kind).toBe("written");
    expect(MOCK_FILE_CONTENT[FILE]).toBe("新内容");
  });

  it("确认覆盖（expected + overwriteExisting）：即便身份不符也写入", async () => {
    MOCK_FILE_CONTENT[FILE] = "external";
    MOCK_FILE_STAT[FILE] = { mtimeUs: 4_000_000, size: 8 };

    const outcome = await saveDocument(FILE, "mine", {
      expected: BASE,
      overwriteExisting: true,
    });

    expect(outcome.kind).toBe("written");
    expect(MOCK_FILE_CONTENT[FILE]).toBe("mine");
  });
});

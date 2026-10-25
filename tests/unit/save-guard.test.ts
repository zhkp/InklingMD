// #362 M2：基线判定与三路 reconcile 的纯函数契约
//
// 这两条判定是写前冲突、写后回执、watcher、switchTab 的共同底座：
// 判定错一次，用户要么被无内容的误报打断，要么在"仅 touch"时丢掉本地编辑。

import { describe, expect, it } from "vitest";
import { evaluateBaseline, reconcileDiskContent } from "../../src/lib/save-guard";
import type { FileStat } from "../../src/lib/fs";

const stat = (mtimeUs: number, size: number): FileStat => ({ mtimeUs, size });

describe("evaluateBaseline", () => {
  it("没有基线时是 unknown（不是 unchanged，也不许当成 changed 直接判冲突）", () => {
    expect(evaluateBaseline(undefined, stat(1_000, 10))).toBe("unknown");
  });

  it("mtime 与 size 都相同才是 unchanged", () => {
    expect(evaluateBaseline(stat(1_000, 10), stat(1_000, 10))).toBe("unchanged");
  });

  it("mtime 差 1µs 就判 changed（不再有 5ms 容差）", () => {
    expect(evaluateBaseline(stat(1_000, 10), stat(1_001, 10))).toBe("changed");
  });

  it("同 mtime 但 size 变化也判 changed", () => {
    expect(evaluateBaseline(stat(1_000, 10), stat(1_000, 11))).toBe("changed");
  });
});

describe("reconcileDiskContent 三路", () => {
  it("磁盘内容等于要写的内容 → same-as-write（即使旧基线完全不同）", () => {
    expect(reconcileDiskContent("最新", "最新", "旧基线")).toEqual({ kind: "same-as-write" });
  });

  it("磁盘内容等于旧基线（仅时间戳变化）→ touch-only，不是冲突", () => {
    expect(reconcileDiskContent("旧基线", "本地编辑", "旧基线")).toEqual({ kind: "touch-only" });
  });

  it("磁盘内容是第三方内容 → conflict", () => {
    expect(reconcileDiskContent("外部内容", "本地编辑", "旧基线")).toEqual({ kind: "conflict" });
  });

  it("基线内容未知时不同内容一律 conflict（无证据不得静默覆盖）", () => {
    expect(reconcileDiskContent("磁盘内容", "本地编辑", undefined)).toEqual({ kind: "conflict" });
  });

  it("同样内容被重写：内容等于要写的内容时优先判 same-as-write", () => {
    expect(reconcileDiskContent("相同", "相同", "相同")).toEqual({ kind: "same-as-write" });
  });
});

// #225 §4.4（G9）快照存储契约的单测：key 契约 / 一致性校验 / 体积预算 / 回收 / 适用性 / 状态位。
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_PREFIX,
  SNAPSHOT_STATE_KEY,
  THEMES_INDEX_KEY,
  THEME_KEY,
  byteLength,
  gcSnapshots,
  listSnapshotKeys,
  parseSnapshotKey,
  readSnapshot,
  readSnapshotState,
  readStoredThemeId,
  readThemesIndex,
  recordSnapshotState,
  removeSnapshotsFor,
  snapshotKey,
  writeSnapshot,
  writeStoredThemeId,
  writeThemesIndex,
} from "../../src/theme/snapshot";

const USER = "user:vue";
const HASH_A = "aaaaaaaa";
const HASH_B = "bbbbbbbb";

beforeEach(() => {
  localStorage.clear();
});

describe("#225 G9：快照 key 契约与解析", () => {
  it("key 形态 = inkling-theme-snapshot:<themeId>:<hash>，且 themeId 自带 `:` 也能解析", () => {
    const key = snapshotKey(USER, HASH_A);
    expect(key).toBe(`${SNAPSHOT_PREFIX}${USER}:${HASH_A}`);
    // themeId 形如 `user:vue` → 必须以**最后**一个 `:` 切分，hash 才是 aaaaaaaa
    expect(parseSnapshotKey(key)).toEqual({ themeId: USER, hash: HASH_A });
  });

  it("当前主题 key 复用 inkling-theme（值升级为 themeId）（C2/P2-1）", () => {
    expect(THEME_KEY).toBe("inkling-theme");
    writeStoredThemeId("builtin:dark");
    expect(readStoredThemeId()).toBe("builtin:dark");
  });

  it("快照 key 不以清单 key 混淆（两份 key 独立）", () => {
    writeThemesIndex([{ id: USER, name: "Vue", mode: "light", hash: HASH_A }]);
    expect(readThemesIndex()).toEqual([{ id: USER, name: "Vue", mode: "light", hash: HASH_A }]);
    expect(listSnapshotKeys()).toEqual([]);
    expect(THEMES_INDEX_KEY).not.toBe(SNAPSHOT_PREFIX);
  });
});

describe("#225 G9：一致性校验（themeId + hash，防串味）", () => {
  it("写入后按 (themeId, hash) 命中", () => {
    const r = writeSnapshot(USER, HASH_A, "#write h1{color:red}");
    expect(r.ok).toBe(true);
    const snap = readSnapshot(USER, HASH_A);
    expect(snap?.css).toBe("#write h1{color:red}");
    expect(snap?.v).toBe(1);
  });

  it("请求的 hash 无对应 key → 返回 undefined（不串味到别的 hash）", () => {
    writeSnapshot(USER, HASH_A, "A-css");
    expect(readSnapshot(USER, HASH_B)).toBeUndefined();
    // 另一份快照不受影响（key 由 hash 决定，读取不是「模糊查找」）
    expect(readSnapshot(USER, HASH_A)?.css).toBe("A-css");
  });

  it("key 与 payload 的 hash 不一致（串味/被改写）→ 弃用并清理该 key", () => {
    // 伪造：key 用 HASH_A，payload 里写 HASH_B
    localStorage.setItem(
      snapshotKey(USER, HASH_A),
      JSON.stringify({ v: 1, themeId: USER, hash: HASH_B, css: "B-css", at: 1 }),
    );
    expect(readSnapshot(USER, HASH_A)).toBeUndefined();
    expect(localStorage.getItem(snapshotKey(USER, HASH_A))).toBeNull();
  });

  it("payload 的 themeId 不一致（跨主题串味）→ 弃用并清理", () => {
    localStorage.setItem(
      snapshotKey(USER, HASH_A),
      JSON.stringify({ v: 1, themeId: "user:other", hash: HASH_A, css: "x", at: 1 }),
    );
    expect(readSnapshot(USER, HASH_A)).toBeUndefined();
    expect(localStorage.getItem(snapshotKey(USER, HASH_A))).toBeNull();
  });

  it("损坏 JSON → 弃用并清理", () => {
    localStorage.setItem(snapshotKey(USER, HASH_A), "{not json");
    expect(readSnapshot(USER, HASH_A)).toBeUndefined();
    expect(listSnapshotKeys()).toEqual([]);
  });

  it("版本不符（v ≠ 1）→ 弃用", () => {
    localStorage.setItem(
      snapshotKey(USER, HASH_A),
      JSON.stringify({ v: 99, themeId: USER, hash: HASH_A, css: "x", at: 1 }),
    );
    expect(readSnapshot(USER, HASH_A)).toBeUndefined();
  });
});

describe("#225 G9：体积预算与回落（不得静默）", () => {
  it("超 256 KB → 不写快照，状态位记 oversize", () => {
    const big = "a".repeat(MAX_SNAPSHOT_BYTES + 1);
    const r = writeSnapshot(USER, HASH_A, big);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("oversize");
    expect(readSnapshot(USER, HASH_A)).toBeUndefined();
    expect(readSnapshotState()?.last).toBe("oversize");
    expect(byteLength(big)).toBeGreaterThan(MAX_SNAPSHOT_BYTES);
  });

  it("边界内（正好 256 KB）可写", () => {
    const exact = "a".repeat(MAX_SNAPSHOT_BYTES);
    expect(writeSnapshot(USER, HASH_A, exact).ok).toBe(true);
  });

  it("内置主题（builtin:*）不适用快照（P2-4），状态位记 inapplicable", () => {
    const r = writeSnapshot("builtin:dark", HASH_A, "x");
    expect(r.status).toBe("inapplicable");
    expect(listSnapshotKeys()).toEqual([]);
    expect(readSnapshotState()?.last).toBe("inapplicable");
  });

  it("状态位 key 独立且可读（G9「不得静默」的载体）", () => {
    expect(SNAPSHOT_STATE_KEY).toBe("inkling-theme-snapshot-state");
    recordSnapshotState({ last: "quota", themeId: USER, detail: "QuotaExceededError" });
    const st = readSnapshotState();
    expect(st?.last).toBe("quota");
    expect(st?.detail).toContain("Quota");
    expect(typeof st?.at).toBe("number");
  });
});

describe("#225 G9：回收策略（P2-2）", () => {
  it("同一 themeId 只保留最新一份快照（写入前删旧 hash）", () => {
    writeSnapshot(USER, HASH_A, "old");
    writeSnapshot(USER, HASH_B, "new");
    const keys = listSnapshotKeys();
    expect(keys).toEqual([snapshotKey(USER, HASH_B)]);
    expect(readSnapshot(USER, HASH_B)?.css).toBe("new");
  });

  it("removeSnapshotsFor 支持保留指定 hash（历史多份也能一次清干净）", () => {
    // 直接铺两份历史快照（绕过写入时的单份回收），验证「保留指定 hash」这一条
    for (const [h, css] of [
      [HASH_A, "a"],
      [HASH_B, "b"],
    ] as const) {
      localStorage.setItem(
        snapshotKey(USER, h),
        JSON.stringify({ v: 1, themeId: USER, hash: h, css, at: 1 }),
      );
    }
    expect(listSnapshotKeys()).toHaveLength(2);
    expect(removeSnapshotsFor(USER, HASH_A)).toBe(1);
    expect(listSnapshotKeys()).toEqual([snapshotKey(USER, HASH_A)]);
  });

  it("启动 GC 清掉清单里已不存在的 themeId，并保留在册的", () => {
    writeSnapshot(USER, HASH_A, "a");
    writeSnapshot("user:removed", HASH_A, "b");
    const removed = gcSnapshots([USER, "builtin:light", "builtin:dark"]);
    expect(removed).toBe(1);
    expect(listSnapshotKeys()).toEqual([snapshotKey(USER, HASH_A)]);
    expect(readSnapshotState()?.last).toBe("gc");
  });

  it("GC 不动清单内的快照（幂等/不误删）", () => {
    writeSnapshot(USER, HASH_A, "a");
    expect(gcSnapshots([USER])).toBe(0);
    expect(readSnapshot(USER, HASH_A)?.css).toBe("a");
  });
});

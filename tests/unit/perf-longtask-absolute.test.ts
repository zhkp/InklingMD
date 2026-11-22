// 「单次 Long Task ≤ 50ms」绝对判定（Epic #387 的统一验收项）
//
// 背景：`absoluteRows()` 原先只对 `scroll` 场景产出绝对行（帧间隔 p95 / 掉帧率），
// 输入类场景（`input-source-*`）的长任务永远进不了绝对判定——Epic 写的
// 「主线程 Long Task 不超过 50ms」在报告里根本没有对应的行。
//
// 这里用子进程真实调用 report.mjs，锁定三件事：
// 1. 全场景（含 input-source）都会产出 `longTaskMaxMs(绝对)` 行；
// 2. 判据是「每轮单次最长」而不是均值——`longTaskMs/longTaskCount` 推不出来；
// 3. 三轮都超才 FAIL（沿用 #294 的确认语义），单轮超只 WARN。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "input-source-M-longtask";

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

const roots: string[] = [];
let perf: PerfReportWorkspace;

beforeEach(() => {
  perf = createPerfReportWorkspace("perf-longtask-");
  roots.push(perf.root);
});

afterEach(() => {
  perf.assertRepoBaselineUntouched();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** 输入类场景的一轮采样：长任务最大值可控，均值固定（防止用均值蒙混过关） */
function rawFor(longTaskMaxMs: number, opts: { includeMax?: boolean } = {}) {
  const includeMax = opts.includeMax !== false;
  const scalars: Record<string, number | null> = {
    ttiMs: 100,
    inputSyncMs: 1,
    inputPaintMs: 20,
    longTaskCount: 2,
    // 均值恒为 20ms（总和 40 / 2 次），与 longTaskMaxMs 解耦
    longTaskMs: 40,
    cls: 0,
  };
  if (includeMax) scalars.longTaskMaxMs = longTaskMaxMs;
  return {
    id: ID,
    scenario: "input-source",
    tier: "M",
    kind: "rich",
    env: "local",
    profile: "quick",
    rounds: 2,
    warmups: 1,
    mode: "uncapped",
    absoluteEligible: true,
    fixture: { version: 2, hash: "longtaskabs01", lines: 5000, source: "generated:rich" },
    samples: { inputPaintMs: [18, 20, 22] },
    scalars,
  };
}

function writeRaw(dir: "raw" | "raw-retest" | "raw-retest2", max: number, opts = {}): void {
  const target =
    dir === "raw" ? perf.rawDir : dir === "raw-retest" ? perf.retestDir : perf.retest2Dir;
  writeFileSync(
    join(target, `${ID}.json`),
    JSON.stringify(rawFor(max, opts), null, 2),
    "utf8",
  );
}

function runReport(phase: "check" | "final"): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [REPORT, `--phase=${phase}`], {
      env: perf.env(),
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("longTaskMaxMs 绝对判定", () => {
  it("输入类场景也产出绝对行，且判据是「单次最长」而非均值", () => {
    // 均值 20ms（40ms / 2 次，不超）、单次最长 80ms（超）——只有取 max 才判得出来
    writeRaw("raw", 80);
    const check = runReport("check");
    // check 阶段只打摘要，但场景进疑似清单就说明「绝对行」参与了 actionableOver
    expect(check.stdout).toContain("疑似超阈值");
    expect(check.stdout).toContain(ID);
    expect(check.status).toBe(0);

    // 三轮齐备后报告表格里才有逐行明细
    writeRaw("raw-retest", 80);
    writeRaw("raw-retest2", 80);
    const final = runReport("final");
    expect(final.stdout).toContain("longTaskMaxMs(绝对)");
    expect(final.stdout).toMatch(/longTaskMaxMs\(绝对\).*≤50/);
  });

  it("三轮都超 → FAIL + exit 1（绝对目标未达标）", () => {
    writeRaw("raw", 80);
    writeRaw("raw-retest", 75);
    writeRaw("raw-retest2", 90);
    const final = runReport("final");
    expect(final.stdout).toContain("longTaskMaxMs(绝对)");
    expect(final.stdout).toMatch(/FAIL/);
    expect(final.status).toBe(1);
  });

  it("单轮超、复测回落 → WARN，exit 0（不当成回归）", () => {
    writeRaw("raw", 80);
    writeRaw("raw-retest", 30);
    const final = runReport("final");
    expect(final.stdout).toContain("longTaskMaxMs(绝对)");
    expect(final.status).toBe(0);
  });

  it("全部在阈值内 → PASS，不误报", () => {
    writeRaw("raw", 40);
    writeRaw("raw-retest", 35);
    writeRaw("raw-retest2", 30);
    const final = runReport("final");
    expect(final.stdout).toContain("longTaskMaxMs(绝对)");
    expect(final.status).toBe(0);
  });

  it("老 raw 没有 longTaskMaxMs：不产出该行（向后兼容，不误判）", () => {
    writeRaw("raw", 0, { includeMax: false });
    const check = runReport("check");
    expect(check.stdout).not.toContain("longTaskMaxMs(绝对)");
  });

  it("所有采长任务的场景都必须上报 longTaskMaxMs（#424 评审）", () => {
    // 这条锁的是「新增场景忘了采」的回归：只写 longTaskCount/longTaskMs 的场景
    // 在 absolute=true 时**不会**产出 50ms 判定行，等于该场景没有验收口径。
    const dir = "tests/perf/scenarios";
    const files = readdirSync(dir).filter((f) => f.endsWith(".spec.ts"));
    const collectors = files.filter((f) =>
      readFileSync(join(dir, f), "utf8").includes(
        "longTaskMs.push(observers.longTaskMs)",
      ),
    );
    // 至少覆盖 input-source / input / open / save / scroll / search / tab-switch
    expect(collectors.length).toBeGreaterThanOrEqual(7);
    for (const f of collectors) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, `${f} 采了 longTaskMs 却没采 longTaskMaxMs`).toContain(
        "longTaskMax.push(observers.longTaskMaxMs)",
      );
      expect(src, `${f} 没把 longTaskMaxMs 写进 scalars`).toContain(
        "longTaskMaxMs: maxOf(longTaskMax),",
      );
    }
  });
});

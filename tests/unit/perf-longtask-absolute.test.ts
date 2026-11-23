// 「单次 Long Task ≤ 50ms」绝对判定（Epic #387 的统一验收项）
//
// 背景：`absoluteRows()` 原先只对 `scroll` 场景产出绝对行（帧间隔 p95 / 掉帧率），
// 输入类场景（`input-source-*`）的长任务永远进不了绝对判定——Epic 写的
// 「主线程 Long Task 不超过 50ms」在报告里根本没有对应的行。
//
// 这里用子进程真实调用 report.mjs（完整跑通 check → confirm → final 三阶段），锁定：
// 1. 全场景（含 input-source）都会产出 `longTaskMaxMs(绝对)` 行，且判据是「每轮单次最长」而非均值；
// 2. 三轮都超 → FAIL（按长任务文案分流）+ exit 1；R2 或 R3 回落 → WARN + exit 0；
// 3. 边界值 `0ms` / `50ms` 为 PASS，`50.01ms` 触发复测与三轮 FAIL；老 raw 缺该字段不产出该行；
// 4. `PERF_LONG_TASK_LIMIT_MS` 空串/非法值安全回退 50ms；R2/R3 缺指标时安全降级不抛 TypeError；
// 5. `tests/perf/scenarios/*.spec.ts` 全集与 `profiles.json` 对账并采集 `longTaskMaxMs`，且锁定 `readObservers()`。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { readObservers } from "../perf/metrics.js";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "input-source-M-longtask";
const SCROLL_ID = "scroll-M-rich";
/** 多子进程串行用例的局部超时，防止 Windows CI 并发下撞 5s 默认线（与 #411 一致，不改全局配置） */
const SUBPROCESS_TIMEOUT_MS = 30_000;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface LatestJson {
  unconfirmed: string[];
  results: Array<{
    id: string;
    confirmExpected: boolean;
    confirmTrusted: boolean;
    confirmMissingReason: string | null;
    unconfirmed: boolean;
    metrics: Array<{
      metric: string;
      base: string | number;
      cur: number;
      retest?: number | null;
      retest2?: number | null;
      over: boolean;
      verdict: string;
      note?: string;
    }>;
  }>;
}

interface RawOptions {
  includeMax?: boolean;
  id?: string;
  scenario?: string;
  frameBudgetMs?: number;
  jankRatePct?: number;
  frameMs?: number[];
}

const roots: string[] = [];
let perf: PerfReportWorkspace;

beforeEach(() => {
  perf = createPerfReportWorkspace("perf-longtask-");
  roots.push(perf.root);
});

afterEach(() => {
  perf.assertRepoBaselineUntouched();
  delete (window as unknown as { __perf?: unknown }).__perf;
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/** 构造一轮采样：长任务最大值可控，均值固定（防止用均值蒙混过关） */
function rawFor(longTaskMaxMs: number, opts: RawOptions = {}) {
  const includeMax = opts.includeMax !== false;
  const scenario = opts.scenario ?? "input-source";
  const id = opts.id ?? (scenario === "scroll" ? SCROLL_ID : ID);
  const scalars: Record<string, number | null> =
    scenario === "scroll"
      ? {
          frameBudgetMs: opts.frameBudgetMs ?? 16.7,
          jankFactor: 1.5,
          step: 240,
          jankCount: 2,
          jankRatePct: opts.jankRatePct ?? 2,
          longFrameCount: 0,
          longTaskCount: 2,
          longTaskMs: 40,
          cls: 0,
          heapDeltaMB: 0,
        }
      : {
          ttiMs: 100,
          inputSyncMs: 1,
          inputPaintMs: 20,
          longTaskCount: 2,
          // 均值恒为 20ms（总和 40 / 2 次），与 longTaskMaxMs 解耦
          longTaskMs: 40,
          cls: 0,
        };
  if (includeMax) scalars.longTaskMaxMs = longTaskMaxMs;
  const samples =
    scenario === "scroll"
      ? { frameMs: opts.frameMs ?? Array.from({ length: 120 }, () => 16.5) }
      : { inputPaintMs: [18, 20, 22] };

  return {
    id,
    scenario,
    tier: "M",
    kind: "rich",
    env: "local",
    profile: "quick",
    rounds: 2,
    warmups: 1,
    mode: "uncapped",
    absoluteEligible: true,
    fixture: { version: 2, hash: "longtaskabs01", lines: 5000, source: "generated:rich" },
    samples,
    scalars,
  };
}

function writeRaw(
  dir: "raw" | "raw-retest" | "raw-retest2",
  max: number,
  opts: RawOptions = {},
): void {
  const target =
    dir === "raw" ? perf.rawDir : dir === "raw-retest" ? perf.retestDir : perf.retest2Dir;
  const id = opts.id ?? (opts.scenario === "scroll" ? SCROLL_ID : ID);
  writeFileSync(join(target, `${id}.json`), JSON.stringify(rawFor(max, opts), null, 2), "utf8");
}

function writeScrollBaseline(): void {
  const dir = join(perf.baselineDir, "local", "quick", "uncapped", "r2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SCROLL_ID}.json`),
    JSON.stringify(
      {
        schemaVersion: 2,
        env: "local",
        profile: "quick",
        mode: "uncapped",
        rounds: 2,
        scenario: "scroll",
        tier: "M",
        kind: "rich",
        fixture: { version: 2, hash: "longtaskabs01", lines: 5000, source: "generated:rich" },
        metrics: {
          frameMs: {
            median: 16.5,
            p95: 16.5,
            max: 16.5,
            n: 120,
            history: [16.5, 16.5, 16.5],
            historyP95: [16.5, 16.5, 16.5],
          },
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function runReport(
  phase: "check" | "confirm" | "final",
  opts: { extraEnv?: NodeJS.ProcessEnv; requireComparison?: boolean } = {},
): RunResult {
  const env = perf.env({
    ...(opts.requireComparison ? { PERF_REQUIRE_COMPARISON: "1" } : {}),
    ...opts.extraEnv,
  });
  const res = spawnSync(process.execPath, [REPORT, `--phase=${phase}`], {
    env,
    encoding: "utf8",
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function readReportMd(): string {
  const file = join(perf.outDir, "report.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function readLatestJson(): LatestJson {
  return JSON.parse(readFileSync(join(perf.outDir, "latest.json"), "utf8")) as LatestJson;
}

function readJsonList(name: "retest.json" | "retest2.json"): string[] {
  const file = join(perf.outDir, name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [];
}

function findTableRow(metric: string, id = ID): string {
  return (
    readReportMd()
      .split("\n")
      .find((l) => l.startsWith(`| ${id} | ${metric} |`)) ?? ""
  );
}

describe("longTaskMaxMs 绝对判定", () => {
  it("输入类场景也产出绝对行，且判据是「单次最长」而非均值（完整三阶段流转）", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    // 均值 20ms（40ms / 2 次，不超）、单次最长 80ms（超）——只有取 max 才判得出来
    writeRaw("raw", 80);
    const check = runReport("check");
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("疑似超阈值");
    expect(check.stdout).toContain(ID);
    expect(readJsonList("retest.json")).toEqual([ID]);

    writeRaw("raw-retest", 80);
    const confirm = runReport("confirm");
    expect(confirm.status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([ID]);

    writeRaw("raw-retest2", 80);
    const final = runReport("final");
    expect(final.status).toBe(1);
    const row = findTableRow("longTaskMaxMs(绝对)");
    expect(row).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 80 | 80 | 80 | — | — | FAIL（复测仍超单次长任务阈值 50ms + 末轮仍超） |`,
    );
    expect(readReportMd()).toContain("单次长任务 ≤ 50ms");
    expect(final.stderr).toContain("单次长任务是否超 50ms");
    expect(final.stderr).not.toContain("相对回归确认");
    expect(readLatestJson().unconfirmed).toEqual([]);
  });

  it("三轮都超 → 完整 check → confirm → final 判 FAIL + exit 1（锁定文案分流）", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 80);
    const check = runReport("check");
    expect(check.status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([ID]);

    writeRaw("raw-retest", 75);
    const confirm = runReport("confirm");
    expect(confirm.status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([ID]);

    writeRaw("raw-retest2", 90);
    const final = runReport("final");
    expect(final.status).toBe(1);
    const report = readReportMd();
    expect(report).toContain("单次长任务 ≤ 50ms");
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 80 | 75 | 90 | — | — | FAIL（复测仍超单次长任务阈值 50ms + 末轮仍超） |`,
    );
    expect(final.stderr).toContain("单次长任务是否超 50ms");
    expect(final.stderr).not.toContain("相对回归确认");
    expect(readLatestJson().unconfirmed).toEqual([]);
  });

  it("单轮超、复测回落 → 表格行落 WARN（复测回落（抖动）），不进确认轮，exit 0", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 80);
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([ID]);

    writeRaw("raw-retest", 30);
    expect(runReport("confirm").status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([]);

    const final = runReport("final");
    expect(final.status).toBe(0);
    expect(final.stderr).not.toContain("绝对目标未达标");
    expect(readReportMd()).not.toContain("| FAIL");
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 80 | 30 | — | — | — | WARN（复测回落（抖动）） |`,
    );
    expect(readLatestJson().unconfirmed).toEqual([]);
  });

  it("R1∧R2 双超、确认轮（R3）回落 → 表格行落 WARN（末轮回落（抖动）），exit 0", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 80);
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([ID]);

    writeRaw("raw-retest", 75);
    expect(runReport("confirm").status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([ID]);

    writeRaw("raw-retest2", 50);
    const final = runReport("final");
    expect(final.status).toBe(0);
    expect(final.stderr).not.toContain("绝对目标未达标");
    expect(readReportMd()).not.toContain("| FAIL");
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 80 | 75 | 50 | — | — | WARN（末轮回落（抖动）） |`,
    );
    expect(readLatestJson().unconfirmed).toEqual([]);
  });

  it("全部在阈值内（40 / 35 / 30）→ 表格行严格为 PASS 且无 WARN/FAIL", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 40);
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([]);

    writeRaw("raw-retest", 35);
    writeRaw("raw-retest2", 30);
    const final = runReport("final");
    expect(final.status).toBe(0);
    expect(final.stderr).toBe("");
    const row = findTableRow("longTaskMaxMs(绝对)");
    expect(row).toBe(`| ${ID} | longTaskMaxMs(绝对) | ≤50 | 40 | — | — | — | — | PASS |`);
    expect(readReportMd()).not.toContain("| WARN");
    expect(readReportMd()).not.toContain("| FAIL");
  });

  it("0ms 零长任务是合法值 → 正常产出 PASS 行（不被真值判断吞掉）", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 0);
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([]);

    const final = runReport("final");
    expect(final.status).toBe(0);
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 0 | — | — | — | — | PASS |`,
    );
    const latest = readLatestJson();
    expect(latest.results[0].metrics).toEqual([
      expect.objectContaining({
        metric: "longTaskMaxMs(绝对)",
        cur: 0,
        over: false,
        verdict: "PASS",
      }),
    ]);
  });

  it("阈值边界：50ms 精确达标 PASS（不进复测）", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 50);
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([]);

    const final = runReport("final");
    expect(final.status).toBe(0);
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 50 | — | — | — | — | PASS |`,
    );
  });

  it("阈值边界：50.01ms 触发复测，三轮均 50.01ms 判 FAIL + exit 1", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 50.01);
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([ID]);

    writeRaw("raw-retest", 50.01);
    expect(runReport("confirm").status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([ID]);

    writeRaw("raw-retest2", 50.01);
    const final = runReport("final");
    expect(final.status).toBe(1);
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 50.01 | 50.01 | 50.01 | — | — | FAIL（复测仍超单次长任务阈值 50ms + 末轮仍超） |`,
    );
    expect(readLatestJson().unconfirmed).toEqual([]);
  });

  it("老 raw 没有 longTaskMaxMs：check 不进复测，且 final 的 report.md 与 latest.json 均不产出该行", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 0, { includeMax: false });
    const check = runReport("check");
    expect(check.status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([]);

    const final = runReport("final");
    expect(final.status).toBe(0);
    expect(readReportMd()).not.toContain("longTaskMaxMs(绝对)");
    const latest = readLatestJson();
    expect(latest.results[0].metrics.some((m) => m.metric === "longTaskMaxMs(绝对)")).toBe(false);
  });
});

describe("PERF_LONG_TASK_LIMIT_MS 环境变量校验（#424 评审）", () => {
  it("合法覆盖值（100ms）：80ms 达标 PASS", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 80);
    expect(runReport("check", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: "100" } }).status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([]);

    const passFinal = runReport("final", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: "100" } });
    expect(passFinal.status).toBe(0);
    expect(passFinal.stderr).toBe("");
    expect(readReportMd()).toContain("单次长任务 ≤ 100ms");
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤100 | 80 | — | — | — | — | PASS |`,
    );
  });

  it("合法覆盖值（100ms）：120ms 三轮超标 FAIL + exit 1", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 120);
    expect(runReport("check", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: "100" } }).status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([ID]);
    writeRaw("raw-retest", 120);
    expect(runReport("confirm", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: "100" } }).status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([ID]);
    writeRaw("raw-retest2", 120);
    const failFinal = runReport("final", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: "100" } });
    expect(failFinal.status).toBe(1);
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤100 | 120 | 120 | 120 | — | — | FAIL（复测仍超单次长任务阈值 100ms + 末轮仍超） |`,
    );
    expect(failFinal.stderr).toContain("单次长任务是否超 100ms");
  });

  for (const [label, empty] of [
    ["空串", ""],
    ["空白", "   "],
  ] as const) {
    it(`${label}（${JSON.stringify(empty)}）视为未设置，回退默认值 50ms（10ms 样本 PASS）`, { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
      writeRaw("raw", 10);
      const check = runReport("check", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: empty } });
      expect(check.status).toBe(0);
      expect(readJsonList("retest.json")).toEqual([]);

      const final = runReport("final", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: empty } });
      expect(final.status).toBe(0);
      expect(final.stderr).toBe("");
      expect(readReportMd()).toContain("单次长任务 ≤ 50ms");
      expect(readReportMd()).not.toContain("≤0");
      expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
        `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 10 | — | — | — | — | PASS |`,
      );
    });
  }

  for (const invalid of ["50ms", "-1", "0", "Infinity"] as const) {
    it(`非法值 ${JSON.stringify(invalid)} 回退默认值 50ms 并告警，绝不静默产出 ≤NaN / ≤-1 / ≤0`, { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
      writeRaw("raw", 80);
      writeRaw("raw-retest", 80);
      writeRaw("raw-retest2", 80);
      expect(runReport("check", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: invalid } }).status).toBe(0);
      expect(readJsonList("retest.json")).toEqual([ID]);
      expect(runReport("confirm", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: invalid } }).status).toBe(0);
      expect(readJsonList("retest2.json")).toEqual([ID]);

      const final = runReport("final", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: invalid } });
      expect(final.status).toBe(1);
      const report = readReportMd();
      expect(report).toContain("单次长任务 ≤ 50ms");
      expect(report).not.toContain("≤NaN");
      expect(report).not.toContain("≤-1");
      expect(report).not.toContain("≤0");
      expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
        `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 80 | 80 | 80 | — | — | FAIL（复测仍超单次长任务阈值 50ms + 末轮仍超） |`,
      );
      expect(final.stderr).toContain("忽略非法的 PERF_LONG_TASK_LIMIT_MS");
    });
  }

  it("非正数 \"-1\" 时 0ms 样本仍安全回退 50ms 判 PASS", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 0);
    const zeroFinal = runReport("final", { extraEnv: { PERF_LONG_TASK_LIMIT_MS: "-1" } });
    expect(zeroFinal.status).toBe(0);
    expect(zeroFinal.stderr).toContain("忽略非法的 PERF_LONG_TASK_LIMIT_MS");
    expect(findTableRow("longTaskMaxMs(绝对)")).toBe(
      `| ${ID} | longTaskMaxMs(绝对) | ≤50 | 0 | — | — | — | — | PASS |`,
    );
  });
});

describe("R2 / R3 存在其他指标行但缺少 longTaskMaxMs 时的降级判定（#424 评审）", () => {
  it("R2 存在其他指标行但缺 longTaskMaxMs → 不抛 TypeError，落 WARN（复测缺该指标）", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeRaw("raw", 80, { scenario: "scroll" });
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([SCROLL_ID]);

    // R2 有 frameMs / jankRatePct（PASS），但缺少 longTaskMaxMs
    writeRaw("raw-retest", 0, { scenario: "scroll", includeMax: false });
    expect(runReport("confirm").status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([]);

    const final = runReport("final");
    expect(final.status).toBe(0);
    expect(final.stderr).not.toContain("TypeError");
    expect(findTableRow("longTaskMaxMs(绝对)", SCROLL_ID)).toBe(
      `| ${SCROLL_ID} | longTaskMaxMs(绝对) | ≤50 | 80 | — | — | — | — | WARN（复测缺该指标） |`,
    );
    expect(findTableRow("frameMs.p95(绝对)", SCROLL_ID)).toContain("| PASS |");
    expect(readLatestJson().unconfirmed).toEqual([]);
  });

  it("R1∧R2 超 50ms、R3 存在其他指标行但缺 longTaskMaxMs → 落 WARN（未确认：确认轮缺该指标）+ UNCONFIRMED，tag 模式 exit 2", { timeout: SUBPROCESS_TIMEOUT_MS }, () => {
    writeScrollBaseline();
    writeRaw("raw", 80, { scenario: "scroll" });
    expect(runReport("check").status).toBe(0);
    expect(readJsonList("retest.json")).toEqual([SCROLL_ID]);

    writeRaw("raw-retest", 75, { scenario: "scroll" });
    expect(runReport("confirm").status).toBe(0);
    expect(readJsonList("retest2.json")).toEqual([SCROLL_ID]);

    // R3 含 frameMs / jankRatePct（rows3.length > 0），但缺少 longTaskMaxMs
    writeRaw("raw-retest2", 0, { scenario: "scroll", includeMax: false });

    const finalPr = runReport("final");
    expect(finalPr.status).toBe(0);
    expect(finalPr.stderr).not.toContain("TypeError");
    expect(findTableRow("longTaskMaxMs(绝对)", SCROLL_ID)).toBe(
      `| ${SCROLL_ID} | longTaskMaxMs(绝对) | ≤50 | 80 | 75 | — | — | — | WARN（未确认：确认轮缺该指标） |`,
    );
    expect(findTableRow("frameMs.p95(绝对)", SCROLL_ID)).toContain("| PASS |");
    const report = readReportMd();
    expect(report).not.toContain("| FAIL");
    expect(report).not.toContain("无 UNCONFIRMED");
    expect(report).toContain(`确认轮未给出可信结论：1/1 个候选场景（${SCROLL_ID}:确认轮缺该指标）`);
    expect(report).toContain(`未确认：1 个场景（${SCROLL_ID}）`);

    const latest = readLatestJson();
    expect(latest.unconfirmed).toEqual([SCROLL_ID]);
    expect(latest.results[0]).toMatchObject({
      id: SCROLL_ID,
      confirmExpected: true,
      confirmTrusted: false,
      confirmMissingReason: "确认轮缺该指标",
      unconfirmed: true,
    });

    // tag 模式（PERF_REQUIRE_COMPARISON=1）：已匹配基线（覆盖 1/1），必须由 UNCONFIRMED 触发 exit 2
    const finalTag = runReport("final", { requireComparison: true });
    expect(finalTag.status).toBe(2);
    expect(finalTag.stderr).toContain(`有 1 个场景未确认：${SCROLL_ID}`);
  });
});

function collectAstNodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node): void => {
    if (predicate(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

describe("场景采集器与 readObservers() 单元测试（#424 评审）", () => {
  it("tests/perf/scenarios/*.spec.ts 全集与 profiles.json 对账，且每个场景均通过真实 AST 采集 longTaskMaxMs", () => {
    const profiles = JSON.parse(readFileSync("tests/perf/profiles.json", "utf8")) as {
      scenarios: string[];
    };
    const dir = "tests/perf/scenarios";
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".spec.ts"))
      .sort();
    const specNames = files.map((f) => f.replace(/\.spec\.ts$/, "")).sort();
    expect(specNames).toEqual([...profiles.scenarios].sort());
    expect(files.length).toBeGreaterThanOrEqual(7);

    for (const f of files) {
      const filePath = join(dir, f);
      const src = readFileSync(filePath, "utf8");
      const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

      const calls = collectAstNodes(sf, ts.isCallExpression);
      const readObserverCalls = calls.filter(
        (c) => c.expression.getText(sf) === "page.evaluate" && c.arguments[0]?.getText(sf) === "readObservers",
      );
      expect(readObserverCalls.length, `${f} 缺少真实的 page.evaluate(readObservers) 调用`).toBeGreaterThanOrEqual(1);

      const pushCalls = calls.filter((c) => c.expression.getText(sf) === "longTaskMax.push");
      expect(pushCalls.length, `${f} 缺少 longTaskMax.push(...) 调用`).toBeGreaterThanOrEqual(1);

      const formulaCalls = calls.filter(
        (c) => c.expression.getText(sf) === "page.evaluate" && c.arguments[0]?.getText(sf) === "waitFormulaSettled",
      );
      if (f === "open.spec.ts" || formulaCalls.length > 0) {
        // open 场景在 TTI 之后等待 waitFormulaSettled，必须在 waitFormulaSettled 之后再读一次 readObservers 并取前后最大值
        expect(formulaCalls.length, `${f} 缺少 waitFormulaSettled 调用`).toBeGreaterThanOrEqual(1);
        const formulaEnd = formulaCalls[0].getEnd();
        const varDecls = collectAstNodes(sf, ts.isVariableDeclaration);
        const postFormulaDecl = varDecls.find(
          (v) =>
            v.getStart(sf) > formulaEnd &&
            v.initializer !== undefined &&
            collectAstNodes(v.initializer, ts.isCallExpression).some(
              (c) => c.expression.getText(sf) === "page.evaluate" && c.arguments[0]?.getText(sf) === "readObservers",
            ),
        );
        expect(postFormulaDecl, `${f} 必须在 waitFormulaSettled 之后读取 readObservers`).toBeDefined();
        const postVarName = postFormulaDecl!.name.getText(sf);

        const maxPush = pushCalls.some((p) => {
          const arg = p.arguments[0];
          if (!arg || !ts.isCallExpression(arg) || arg.expression.getText(sf) !== "Math.max") return false;
          const argTexts = new Set(arg.arguments.map((a) => a.getText(sf)));
          return argTexts.has("observers.longTaskMaxMs") && argTexts.has(`${postVarName}.longTaskMaxMs`);
        });
        expect(
          maxPush,
          `${f} 必须用 Math.max(observers.longTaskMaxMs, ${postVarName}.longTaskMaxMs) 纳入公式尾部渲染长任务`,
        ).toBe(true);
      } else {
        const directPush = pushCalls.some((p) => p.arguments[0]?.getText(sf) === "observers.longTaskMaxMs");
        expect(directPush, `${f} 缺少 longTaskMax.push(observers.longTaskMaxMs)`).toBe(true);
      }

      const writeRawCalls = calls.filter((c) => c.expression.getText(sf) === "writeRawFile");
      expect(writeRawCalls.length, `${f} 缺少 writeRawFile 调用`).toBe(1);
      const rawArg = writeRawCalls[0].arguments[0];
      expect(rawArg && ts.isObjectLiteralExpression(rawArg), `${f} writeRawFile 参数须为对象字面量`).toBe(true);
      const scalarsProp = (rawArg as ts.ObjectLiteralExpression).properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          p.name.text === "scalars",
      );
      expect(
        scalarsProp && ts.isObjectLiteralExpression(scalarsProp.initializer),
        `${f} writeRawFile 缺少 scalars 对象`,
      ).toBe(true);
      const longTaskMaxProp = (scalarsProp!.initializer as ts.ObjectLiteralExpression).properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          p.name.text === "longTaskMaxMs",
      );
      expect(
        longTaskMaxProp?.initializer.getText(sf),
        `${f} scalars.longTaskMaxMs 必须由 maxOf(longTaskMax) 聚合`,
      ).toBe("maxOf(longTaskMax)");

      const maxOfDecl = collectAstNodes(sf, ts.isFunctionDeclaration).find(
        (fn) => fn.name?.getText(sf) === "maxOf",
      );
      expect(maxOfDecl, `${f} 缺少 maxOf 函数声明`).toBeDefined();
      const hasGt = collectAstNodes(maxOfDecl!, ts.isBinaryExpression).some(
        (b) => b.operatorToken.kind === ts.SyntaxKind.GreaterThanToken,
      );
      expect(hasGt, `${f} 的 maxOf 未使用 > 比较取最大值`).toBe(true);
    }
  });

  it("readObservers()：多条长任务取最大值并保留 2 位小数；空数组与未安装观察器返回 0", () => {
    // 1. 未安装观察器（window.__perf === undefined）
    delete (window as unknown as { __perf?: unknown }).__perf;
    expect(readObservers()).toMatchObject({
      longTaskCount: 0,
      longTaskMs: 0,
      longTaskMaxMs: 0,
      cls: 0,
      heapStartMB: null,
    });

    // 2. 已安装但空数组
    const w = window as unknown as {
      __perf?: { longTasks: number[]; cls: number; heapStartMB: number | null };
    };
    w.__perf = { longTasks: [], cls: 0, heapStartMB: null };
    expect(readObservers()).toMatchObject({
      longTaskCount: 0,
      longTaskMs: 0,
      longTaskMaxMs: 0,
      cls: 0,
    });

    // 3. 多条长任务：取最大值而非均值，且四舍五入保留 2 位小数
    w.__perf = { longTasks: [12.344, 80.566, 25.1], cls: 0.01234, heapStartMB: 10 };
    expect(readObservers()).toMatchObject({
      longTaskCount: 3,
      longTaskMs: 118.01,
      longTaskMaxMs: 80.57,
      cls: 0.0123,
      heapStartMB: 10,
    });

    // 4. 边界值 50ms 精确保留
    w.__perf = { longTasks: [50], cls: 0, heapStartMB: null };
    expect(readObservers()).toMatchObject({
      longTaskCount: 1,
      longTaskMs: 50,
      longTaskMaxMs: 50,
    });
  });
});

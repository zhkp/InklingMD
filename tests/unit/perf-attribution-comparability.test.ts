// 归因表的可比性门禁（#379 评审 P1）
//
// 背景：主判定只在 `baselineComparability().ok` 时才和基线比，归因表却无条件拿同一份
// baseline 算变化率。fixture 变了（或换了环境/模式）之后，归因行会显示「statsMs 7.8 → 7.8，
// 0.0%」这种伪对照——读者会以为成本没变，实际两份数据根本不可比。
//
// 这里用子进程真跑 report.mjs，锁三件事：
// ① 不可比：归因行标注原因，不显示旧参考值与变化率；
// ② 可比但基线还没有该指标（本 PR 5 份 CI 基线的现状）：显示 `—`，既不写 0 也不标不可比；
// ③ 可比且基线有参考值：照旧给出参考值与变化率（证明不是一刀切关掉归因对照）。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "input-source-S-rich";
const NOW_FIXTURE = { version: 2, hash: "nowhash0001", lines: 1000, source: "generated:rich" };
const OLD_FIXTURE = { version: 2, hash: "oldhash0002", lines: 1000, source: "generated:rich" };

let perf: PerfReportWorkspace;

function writeRaw(): void {
  const raw = {
    id: ID,
    scenario: "input-source",
    tier: "S",
    kind: "rich",
    env: "local",
    profile: "quick",
    rounds: 2,
    warmups: 1,
    mode: "headless",
    fixture: NOW_FIXTURE,
    samples: {
      inputPaintMs: Array.from({ length: 60 }, (_, i) => 20 + (i % 5) * 0.2),
      inputSyncMs: Array.from({ length: 60 }, (_, i) => 1 + (i % 3) * 0.1),
    },
    scalars: {
      // 归因指标（进基线、不参与判定）
      statsMs: 9,
      statsCount: 1,
      outlinePublishCount: 0,
      // 判定用标量（用于确认主表确实进入了可比/不可比分支）
      longTaskCount: 0,
      longTaskMs: 0,
      cls: 0,
      heapDeltaMB: 0,
      probeMs: 10,
    },
  };
  writeFileSync(join(perf.rawDir, `${ID}.json`), JSON.stringify(raw, null, 2), "utf8");
}

/** 写基线；`metrics` 缺哪个指标就等于「该指标还没播种进基线」 */
function writeBaseline(
  fixture: typeof NOW_FIXTURE,
  metrics: Record<string, unknown>,
): void {
  const dir = join(perf.baselineDir, "local", "quick", "headless", "r2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${ID}.json`),
    JSON.stringify(
      {
        schemaVersion: 2,
        env: "local",
        profile: "quick",
        mode: "headless",
        rounds: 2,
        scenario: "input-source",
        tier: "S",
        kind: "rich",
        fixture,
        metrics,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

const FULL_METRICS = {
  inputPaintMs: { median: 20.4, p95: 21.4, max: 22, n: 120 },
  statsMs: { median: 7.8, p95: null, max: null, n: null, scalar: true },
  statsCount: { median: 1, p95: null, max: null, n: null, scalar: true },
  outlinePublishCount: { median: 0, p95: null, max: null, n: null, scalar: true },
};

/** 只播种了不带 outlinePublishCount 的旧基线（本 PR 5 份 CI 基线的真实状态） */
const METRICS_WITHOUT_PUBLISH = {
  inputPaintMs: FULL_METRICS.inputPaintMs,
  statsMs: FULL_METRICS.statsMs,
  statsCount: FULL_METRICS.statsCount,
};

function runReport(): void {
  execFileSync(process.execPath, [REPORT, "--phase=final"], {
    env: perf.env(),
    encoding: "utf8",
  });
}

/** 报告里含指定归因指标的那一行（归因表每行形如 `| id | statsMs | ... |`） */
function attributionLine(metric: string): string {
  const report = readFileSync(join(perf.outDir, "report.md"), "utf8");
  const line = report
    .split("\n")
    .find((l) => l.startsWith(`| ${ID} | ${metric} |`));
  expect(line, `报告缺少 ${metric} 的归因行`).toBeTruthy();
  return line as string;
}

/** latest.json 里该场景的归因行（第三个消费出口，同样不能带不可比的参考值） */
function latestAttributionRow(metric: string): { base: number | null; cur: number } {
  const latest = JSON.parse(readFileSync(join(perf.outDir, "latest.json"), "utf8"));
  const result = (latest.results ?? []).find((r: { id: string }) => r.id === ID);
  const row = (result?.attribution ?? []).find(
    (a: { metric: string }) => a.metric === metric,
  );
  expect(row, `latest.json 缺少 ${metric} 的归因行`).toBeTruthy();
  return row;
}

beforeEach(() => {
  perf = createPerfReportWorkspace("perf-attr-cmp-");
  writeRaw();
});

afterEach(() => {
  perf.assertRepoBaselineUntouched();
  perf.cleanup();
});

describe("归因表的可比性门禁（#379 评审 P1）", () => {
  it("fixture 变了：归因行标注不可比，不显示旧参考值与变化率", () => {
    writeBaseline(OLD_FIXTURE, FULL_METRICS);
    runReport();

    const line = attributionLine("statsMs");
    expect(line).toContain("不可比：FIXTURE_CHANGED");
    // 旧 baseline 的 7.8 不得出现在归因行里（它是另一份 fixture 的参考值）
    expect(line).not.toContain("7.8");
    // 也不得出现任何变化率
    expect(line).not.toMatch(/%/);
    // latest.json 是机器可读出口，同样不能带不可比的参考值
    expect(latestAttributionRow("statsMs").base).toBeNull();
  });

  it("只计次归因指标同样受门禁约束", () => {
    writeBaseline(OLD_FIXTURE, FULL_METRICS);
    runReport();

    const line = attributionLine("outlinePublishCount");
    expect(line).toContain("不可比：FIXTURE_CHANGED");
    expect(line).not.toMatch(/%/);
  });

  it("可比但基线未播种该指标：显示 —，既不写 0 也不标不可比", () => {
    // 本 PR 提交的 5 份 CI 基线就是这种状态：outlinePublishCount 尚未进基线。
    // 读者必须能分清「未播种」与「不可比」与「0 次」。
    writeBaseline(NOW_FIXTURE, METRICS_WITHOUT_PUBLISH);
    runReport();

    const line = attributionLine("outlinePublishCount");
    expect(line).not.toContain("不可比");
    expect(line).toContain("| — |"); // 本次值 0 之外的基线与变化列都是 —
    expect(latestAttributionRow("outlinePublishCount").base).toBeNull();
  });

  it("可比且基线有参考值：照旧给出参考值与变化率（不是一刀切关掉归因对照）", () => {
    writeBaseline(NOW_FIXTURE, FULL_METRICS);
    runReport();

    const line = attributionLine("statsMs");
    expect(line).toContain("7.8");
    expect(line).toMatch(/%/);
    expect(line).not.toContain("不可比");
    expect(latestAttributionRow("statsMs").base).toBe(7.8);
  });
});

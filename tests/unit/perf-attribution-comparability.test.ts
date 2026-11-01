// 归因表的可比性门禁（#379 评审 P1）
//
// 背景：主判定只在 `baselineComparability().ok` 时才和基线比，归因表却无条件拿同一份
// baseline 算变化率。fixture 变了（或换了环境/模式）之后，归因行会显示「statsMs 7.8 → 7.8，
// 0.0%」这种伪对照——读者会以为成本没变，实际两份数据根本不可比。
//
// 这里用子进程真跑 report.mjs：不可比时归因行必须显式标注原因、不显示旧参考值与变化率；
// 可比时照旧给出参考值与变化率（证明不是一刀切关掉）。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "input-source-S-rich";
const NOW_FIXTURE = { version: 2, hash: "nowhash0001", lines: 1000, source: "generated:rich" };
const OLD_FIXTURE = { version: 2, hash: "oldhash0002", lines: 1000, source: "generated:rich" };

const roots: string[] = [];
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
      // 判定用标量（用于确认主表确实进入了不可比分支）
      longTaskCount: 0,
      longTaskMs: 0,
      cls: 0,
      heapDeltaMB: 0,
      probeMs: 10,
    },
  };
  writeFileSync(join(perf.rawDir, `${ID}.json`), JSON.stringify(raw, null, 2), "utf8");
}

function writeBaseline(fixture: typeof NOW_FIXTURE): void {
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
        metrics: {
          inputPaintMs: { median: 20.4, p95: 21.4, max: 22, n: 120 },
          statsMs: { median: 7.8, p95: null, max: null, n: null, scalar: true },
          statsCount: { median: 1, p95: null, max: null, n: null, scalar: true },
          outlinePublishCount: { median: 0, p95: null, max: null, n: null, scalar: true },
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

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

beforeEach(() => {
  perf = createPerfReportWorkspace("perf-attr-cmp-");
  roots.push(perf.root);
  writeRaw();
});

afterEach(() => {
  perf.assertRepoBaselineUntouched();
  perf.cleanup();
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("归因表的可比性门禁（#379 评审 P1）", () => {
  it("fixture 变了：归因行标注不可比，不显示旧参考值与变化率", () => {
    writeBaseline(OLD_FIXTURE);
    runReport();

    const line = attributionLine("statsMs");
    expect(line).toContain("不可比：FIXTURE_CHANGED");
    // 旧 baseline 的 7.8 不得出现在归因行里（它是另一份 fixture 的参考值）
    expect(line).not.toContain("7.8");
    // 也不得出现任何变化率
    expect(line).not.toMatch(/%/);
  });

  it("只计次归因指标同样受门禁约束", () => {
    writeBaseline(OLD_FIXTURE);
    runReport();

    const line = attributionLine("outlinePublishCount");
    expect(line).toContain("不可比：FIXTURE_CHANGED");
    expect(line).not.toMatch(/%/);
  });

  it("可比时照旧给出参考值与变化率（不是一刀切关掉归因对照）", () => {
    writeBaseline(NOW_FIXTURE);
    runReport();

    const line = attributionLine("statsMs");
    expect(line).toContain("7.8");
    expect(line).toMatch(/%/);
    expect(line).not.toContain("不可比");
  });
});

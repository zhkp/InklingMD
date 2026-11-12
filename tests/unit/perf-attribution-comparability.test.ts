// 归因表的可比性门禁（#379 评审 P1）
//
// 背景：主判定只在 `baselineComparability().ok` 时才和基线比，归因表却无条件拿同一份
// baseline 算变化率。fixture 变了（或换了环境/模式）之后，归因行会显示「statsMs 7.8 → 7.8，
// 0.0%」这种伪对照——读者会以为成本没变，实际两份数据根本不可比。
//
// 这里用子进程真跑 report.mjs，锁四件事（归因表的三种状态必须互相可区分）：
// ① 不可比：标注 `不可比：<原因>`，不显示旧参考值与变化率；
// ② 可比但基线还没有该指标（新增指标刚上线时就是这种状态，例如 open-* 基线上
//    至今没有 katexRenderMs）：参考值列必须显示 `—`，既不写 0 也不标不可比；
// ③ 可比且基线参考为 0：参考值列显示 `0`（与 ② 的 `—` 区分），变化率仍为 `—`（除零）；
// ④ 可比且有非零参考值：照旧给出参考值与变化率（证明不是一刀切关掉归因对照）。

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "input-source-S-rich";
const NOW_FIXTURE = { version: 2, hash: "nowhash0001", lines: 1000, source: "generated:rich" };
const OLD_FIXTURE = { version: 2, hash: "oldhash0002", lines: 1000, source: "generated:rich" };

let perf: PerfReportWorkspace;

function writeRaw(
  attributionCoverage?: {
    rounds: number;
    completeRounds: number;
    partial: boolean;
    metrics: Record<string, { observed: number; expected: number }>;
  },
  formulaCoverage?: {
    expectedNodes: number;
    measuredRounds: number;
    expectedRounds: number;
    unmeasured: boolean;
  },
): void {
  const raw: Record<string, unknown> = {
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
  if (attributionCoverage) raw.attributionCoverage = attributionCoverage;
  if (formulaCoverage) raw.formulaCoverage = formulaCoverage;
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

/** 只播种了不带 outlinePublishCount 的基线（「新指标尚未进基线」的真实形态） */
const METRICS_WITHOUT_PUBLISH = {
  inputPaintMs: FULL_METRICS.inputPaintMs,
  statsMs: FULL_METRICS.statsMs,
  statsCount: FULL_METRICS.statsCount,
};

/** 把归因表的一行拆成单元格（`| a | b | c |` → ["a","b","c"]） */
function cells(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
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

  it("可比但基线未播种该指标：参考值列显示 —，既不写 0 也不标不可比", () => {
    // 读者必须能分清「未播种」「不可比」「0 次」三种状态——它们都会让
    // 变化率变成 `—`，只看变化列无法区分，所以断言精确的单元格。
    writeBaseline(NOW_FIXTURE, METRICS_WITHOUT_PUBLISH);
    runReport();

    const row = cells(attributionLine("outlinePublishCount"));
    expect(row[1]).toBe("outlinePublishCount");
    expect(row[2]).toBe("—"); // 参考值：未播种
    expect(row[3]).toBe("0"); // 本次值：0 次
    expect(row[4]).toBe("—"); // 变化率：无参考值
    expect(latestAttributionRow("outlinePublishCount").base).toBeNull();
  });

  it("可比且基线参考为 0：参考值列显示 0，与「未播种」的 — 区分开", () => {
    // 只计次桶播种后参考值就是 0；若实现把 0 也渲染成 —，
    // 读者会以为「发布次数」根本没进基线。
    writeBaseline(NOW_FIXTURE, FULL_METRICS);
    runReport();

    const row = cells(attributionLine("outlinePublishCount"));
    expect(row[2]).toBe("0");
    expect(row[3]).toBe("0");
    expect(row[4]).toBe("—"); // 除零仍是 —（与主表口径一致）
    expect(latestAttributionRow("outlinePublishCount").base).toBe(0);
  });

  it("可比且有非零参考值：照旧给出参考值与变化率（不是一刀切关掉归因对照）", () => {
    writeBaseline(NOW_FIXTURE, FULL_METRICS);
    runReport();

    const row = cells(attributionLine("statsMs"));
    expect(row[2]).toBe("7.8");
    expect(row[4]).toMatch(/%/);
    expect(attributionLine("statsMs")).not.toContain("不可比");
    expect(latestAttributionRow("statsMs").base).toBe(7.8);
  });

  it("部分缺采：归因表标 PARTIAL、latest.json 带 coverage、基线带 partial（#379 评审 R4）", () => {
    // 2 轮里只有 1 轮采到 stats：均值本身看不出覆盖不足，必须三个出口都显式标注
    writeBaseline(NOW_FIXTURE, FULL_METRICS);
    writeRaw({
      rounds: 2,
      completeRounds: 2,
      partial: false,
      metrics: {
        statsMs: { observed: 1, expected: 2 },
        statsCount: { observed: 1, expected: 2 },
        outlinePublishCount: { observed: 2, expected: 2 },
      },
    });
    execFileSync(process.execPath, [REPORT, "--phase=final", "--update-baseline=1"], {
      env: perf.env(),
      encoding: "utf8",
    });

    const row = cells(attributionLine("statsMs"));
    expect(row[5]).toBe("PARTIAL 1/2");
    expect(cells(attributionLine("outlinePublishCount"))[5]).toBe("2/2");

    const latest = JSON.parse(
      readFileSync(join(perf.outDir, "latest.json"), "utf8"),
    );
    const result = (latest.results ?? []).find(
      (r: { id: string }) => r.id === ID,
    );
    const statsRow = (result?.attribution ?? []).find(
      (a: { metric: string }) => a.metric === "statsMs",
    );
    expect(statsRow.coverage).toEqual({ observed: 1, expected: 2 });

    const baseline = JSON.parse(
      readFileSync(
        join(
          perf.baselineDir,
          "local",
          "quick",
          "headless",
          "r2",
          `${ID}.json`,
        ),
        "utf8",
      ),
    );
    expect(baseline.metrics.statsMs).toMatchObject({
      observedRounds: 1,
      expectedRounds: 2,
      partial: true,
    });
  });

  it("公式节点未挂载：report.md 标 UNMEASURED 且 latest.json 带覆盖状态（#379 评审 R4）", () => {
    writeBaseline(NOW_FIXTURE, FULL_METRICS);
    writeRaw(undefined, {
      expectedNodes: 42,
      measuredRounds: 0,
      expectedRounds: 2,
      unmeasured: true,
    });
    runReport();

    const report = readFileSync(join(perf.outDir, "report.md"), "utf8");
    expect(report).toContain("### 公式测量未覆盖（UNMEASURED）");
    expect(report).toContain("预期 42 个公式节点");
    expect(report).toContain("0/2 轮拿到完整样本");

    const latest = JSON.parse(
      readFileSync(join(perf.outDir, "latest.json"), "utf8"),
    );
    const result = (latest.results ?? []).find(
      (r: { id: string }) => r.id === ID,
    );
    expect(result.formulaCoverage).toEqual({
      expectedNodes: 42,
      measuredRounds: 0,
      expectedRounds: 2,
      unmeasured: true,
    });
  });

  it("open 场景判红不落 raw 时：合成 UNMEASURED 行也标公式未覆盖，基线带覆盖状态", () => {
    // 真实链路（验收 F2）：公式节点没挂载 → measured 轮断言失败 → 本场景不写
    // raw → playwright 报告里该 spec 为 timedOut → report 合成 UNMEASURED 行。
    // 这一行必须带公式未覆盖标注，且播种出的基线本身也要带覆盖状态。
    writeBaseline(NOW_FIXTURE, FULL_METRICS);
    writeRaw(undefined, {
      expectedNodes: 76,
      measuredRounds: 2,
      expectedRounds: 2,
      unmeasured: false,
    });
    mkdirSync(perf.outDir, { recursive: true });
    writeFileSync(
      join(perf.outDir, "pw-report.json"),
      JSON.stringify({
        suites: [
          {
            specs: [
              {
                title: ID,
                tests: [{ results: [{ status: "passed" }] }],
              },
              {
                title: "open-M-rich",
                tests: [{ results: [{ status: "timedOut" }] }],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    // 有 UNMEASURED 场景时 report 按设计 exit 2（结论不完整 ≠ 没回归），
    // 这里只验证产物，因此用 spawnSync 接收退出码而不是让 execFileSync 抛错。
    const run = spawnSync(
      process.execPath,
      [REPORT, "--phase=final", "--update-baseline=1"],
      { env: perf.env(), encoding: "utf8" },
    );
    expect(run.status, `report stderr=${run.stderr}`).toBe(2);

    const report = readFileSync(join(perf.outDir, "report.md"), "utf8");
    expect(report).toContain("### 公式测量未覆盖（UNMEASURED）");
    expect(report).toContain("open-M-rich：场景未测量");

    const latest = JSON.parse(
      readFileSync(join(perf.outDir, "latest.json"), "utf8"),
    );
    const synthetic = (latest.results ?? []).find(
      (r: { id: string }) => r.id === "open-M-rich",
    );
    expect(synthetic?.baselineState).toContain("UNMEASURED");
    expect(synthetic?.formulaCoverage?.unmeasured).toBe(true);

    const baseline = JSON.parse(
      readFileSync(
        join(perf.baselineDir, "local", "quick", "headless", "r2", `${ID}.json`),
        "utf8",
      ),
    );
    expect(baseline.formulaCoverage).toEqual({
      expectedNodes: 76,
      measuredRounds: 2,
      expectedRounds: 2,
      unmeasured: false,
    });
  });
});

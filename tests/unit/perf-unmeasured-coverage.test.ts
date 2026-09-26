// 「部分场景未测量」降级判定的端到端测试（issue #247）
//
// 背景：单场景超时（如 L 档输入撞 180s 线）会让 playwright 整轮退出非 0。旧行为把整轮按
// infra 故障作废——`FAIL：0` 与"什么都没比"在退出码层面无法区分。方向 2 要的是：
// 已测场景照常判定、未测量场景单列于报告（UNMEASURED），并让整轮 exit 2。
//
// 这里复用 perf-report-env 的隔离基建，用子进程真实调用 report.mjs，覆盖三个用例：
//   (a) 有 pw-report 且其中一个场景 timedOut 无 raw → exit 2 + 覆盖 2/3 + UNMEASURED 行；
//   (b) 没有 pw-report → 回退现行为（exit 0，不合成任何未测量场景）；
//   (c) --update-baseline 变体：已测场景照常更新基线，未测量场景的基线文件不得被创建。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";

const roots: string[] = [];
let perf: PerfReportWorkspace;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function writeRaw(id: string): void {
  const raw = {
    id,
    scenario: "scroll",
    tier: "C",
    kind: "rich",
    env: "local",
    profile: "quick",
    rounds: 2,
    warmups: 1,
    mode: "headless",
    absoluteEligible: false,
    fixture: { version: 2, hash: "unmeasured001", lines: 1000, source: "generated:rich" },
    samples: { frameMs: Array.from({ length: 120 }, (_, i) => 16.7 + (i % 3) * 0.1) },
    scalars: {
      frameBudgetMs: 16.7,
      jankFactor: 1.5,
      step: 240,
      jankCount: 0,
      jankRatePct: 0,
      longFrameCount: 0,
      longTaskCount: 0,
      longTaskMs: 0,
      cls: 0,
      heapDeltaMB: 0,
    },
  };
  writeFileSync(join(perf.rawDir, `${id}.json`), JSON.stringify(raw, null, 2), "utf8");
}

/** 写一份 playwright json 报告到 OUT_DIR（report.mjs 默认读 `<OUT_DIR>/pw-report.json`） */
function writePwReport(specs: Array<{ title: string; status: string }>): void {
  const report = {
    suites: [
      {
        title: "root",
        specs: specs.map((s) => ({
          title: s.title,
          tests: [{ results: [{ status: s.status }] }],
        })),
      },
    ],
  };
  writeFileSync(join(perf.outDir, "pw-report.json"), JSON.stringify(report, null, 2), "utf8");
}

function runReport({ updateBaseline = false } = {}): RunResult {
  const args = [REPORT, "--phase=final"];
  if (updateBaseline) args.push("--update-baseline=1");
  // perf.env() 会剥掉继承来的所有 PERF_*（含 PERF_REQUIRE_COMPARISON / PERF_PW_REPORT），
  // 于是本用例断言的是"未测量 → exit 2"这条**独立于覆盖守卫**的路径
  const env = perf.env();
  try {
    const stdout = execFileSync(process.execPath, args, { env, encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function report(): string {
  return readFileSync(join(perf.outDir, "report.md"), "utf8");
}

const MEASURED_A = "scroll-C-aaa";
const MEASURED_B = "scroll-C-bbb";
const MISSING = "tab-switch-M-rich";

beforeEach(() => {
  perf = createPerfReportWorkspace("perf-unmeas-");
  roots.push(perf.root);
  writeRaw(MEASURED_A);
  writeRaw(MEASURED_B);
});

afterEach(() => {
  perf.assertRepoBaselineUntouched();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("部分场景未测量的降级判定（#247）", () => {
  it("(a) 一个场景 timedOut 无 raw → exit 2、覆盖分母含未测量场景、报告单列 UNMEASURED", () => {
    // 先播种两个已测场景的基线，让它们真的"参与相对判定"——否则覆盖率是 0/3，
    // 看不出「分母 M 含未测量场景」这件事（本用例的核心断言是 2/3）
    expect(runReport({ updateBaseline: true }).status).toBe(0);
    writePwReport([
      { title: MEASURED_A, status: "passed" },
      { title: MEASURED_B, status: "passed" },
      { title: MISSING, status: "timedOut" },
    ]);

    const result = runReport();

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("[perf] 判定覆盖：2/3");
    expect(result.stdout).toContain(MISSING); // 未测量清单指名道姓
    expect(result.stderr).toContain("未测量");
    expect(report()).toContain("未参与相对判定：UNMEASURED(timedOut)");
  });

  it("(b) 没有 pw-report → 回退现行为（exit 0，不合成任何未测量场景）", () => {
    const result = runReport();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[perf] 判定覆盖：0/2");
    expect(report()).not.toContain("UNMEASURED");
  });

  it("(c) --update-baseline 变体：已测场景照常更新基线，未测量场景的基线文件不被创建", () => {
    writePwReport([
      { title: MEASURED_A, status: "passed" },
      { title: MEASURED_B, status: "passed" },
      { title: MISSING, status: "timedOut" },
    ]);

    const result = runReport({ updateBaseline: true });

    expect(result.status).toBe(2); // 播种遇未测量 → exit 2 提示需补一次完整播种
    const dir = join(perf.baselineDir, "local", "quick", "headless", "r2");
    expect(existsSync(join(dir, `${MEASURED_A}.json`))).toBe(true);
    expect(existsSync(join(dir, `${MEASURED_B}.json`))).toBe(true);
    expect(existsSync(join(dir, `${MISSING}.json`))).toBe(false); // 无 raw → 不得凭空建基线
  });
});
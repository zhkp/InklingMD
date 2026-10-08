// 编排层的回归测试（issue #294）
//
// ## 为什么必须有这层测试
//
// #294 首版评审的 P0 正是**编排层**缺陷：工作流的 `retest` job 漏了 `PERF_SPLIT_RETEST=1`
// → `planConfirmPhases` 永远收到 `splitRetest=false` → 确认轮从不移交 → 第三轮跑在
// **与 R2 同一台 runner** 上。tag 运行因此以「同 runner 三轮」的假 FAIL 收尾，
// 而 retest2 job 又因上游非零被 skip —— **根治手段在 tag 路径上被整体旁路**。
//
// 既有两层测试都锁不住它：
// - `perf-retest-plan.test.ts` 只断言「`splitRetest:true` 时会 handoff」——它是对的，
//   坏的是**没人断言工作流真的会传这个变量**；
// - `perf-retest2-verdict.test.ts` 只驱动 `report.mjs`，完全不碰 `benchmark.mjs` 的分支。
//
// 所以这里分两层补缺口：
//
// **① 工作流契约（读 YAML）**——直接断言 `benchmark.yml` 每个 job 的 env。
//   这是 P0 的精确守卫：有人再删掉那一行，本文件当场红。**不依赖子进程，任何环境都能跑。**
//
// **② 端到端（桩 Playwright 驱动 benchmark.mjs）**——真跑三个 job，锁「谁移交、谁清什么、
//   产物里有什么」。判据刻意选**产物形状**（有没有 report.md）而不是内部变量——
//   编排出错时最先坏掉的正是产物形状（Job Summary 分支、播种取回目标都依赖它）。
//
// ## ② 在受限环境里会整组 skip
//
// ② 需要 vitest → node benchmark.mjs → node playwright **两层嵌套 spawn**。
// 本机沙箱内单层 spawn 可用、两层报 `EBUSY`（症状：status=-1 且无任何输出）。
// 故 ② 用 `skipIf` 并附明确原因；① 无此依赖，永远执行。
// CI（正常 spawn）里 ② **必然全跑**——它是入库的守卫，不是一次性验证脚本。

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = process.cwd();
const ID = "search-M-rich";
const HASH = "orch294";
const PERF_FILES = [
  "benchmark.mjs",
  "report.mjs",
  "judgment.js",
  "comparability.js",
  "pw-coverage.js",
  "retest-plan.js",
  "cli-env.js",
];
const WORKFLOW = ".github/workflows/benchmark.yml";

// ═══════════════════════════════════════════════════════════════════════
// ① 工作流契约：每个 job 必须传对 env（P0 的精确守卫，无子进程依赖）
// ═══════════════════════════════════════════════════════════════════════

interface WorkflowStep {
  name?: string;
  uses?: string;
  env?: Record<string, string>;
}
interface WorkflowJob {
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
}

/**
 * 极简 YAML 解析：只取 `jobs.<name>.steps[].env`。
 *
 * 为什么不用 yaml 库：本仓 vitest 环境没装 js-yaml/yaml，而为了一个契约断言新增依赖
 * 不划算（CI 与本地都不该为此装包）。工作流的 env 块结构固定（`KEY: value`），这个解析器够用。
 *
 * ⚠️ 两个必须处理的细节，否则解析器会**静默返回空**、让断言假通过：
 * 1. **CRLF**：本仓 `core.autocrlf=true`，工作区里的文件是 CRLF。不剥 `\r` 的话
 *    `raw === "jobs:"` 永远不成立，整棵树是空的（第一版就踩了这个）。
 * 2. **块内注释**：`retest` job 的 env 里有 9 行注释（说明 `PERF_SPLIT_RETEST` 为何不可省），
 *    不跳过就会把它们当成「缩进回退」，后面的键全丢。
 *
 * 解析失败必须**显式暴露**：找不到目标 job / 步骤时 `envOfBenchmarkStep` 断言失败。
 */
function parseWorkflowJobs(text: string): Record<string, WorkflowJob> {
  const jobs: Record<string, WorkflowJob> = {};
  const lines = text.split(/\r?\n/);
  let inJobs = false;
  let currentJob: WorkflowJob | null = null;
  let currentStep: WorkflowStep | null = null;
  let inStepEnv = false;
  let inJobOutputs = false;
  let jobDepth = 0;

  for (const raw of lines) {
    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    // 顶层键（无缩进）→ 离开 jobs 块
    if (/^[a-zA-Z]/.test(raw)) {
      inJobs = false;
      currentJob = null;
      continue;
    }
    const jobMatch = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(raw);
    if (jobMatch) {
      currentJob = { steps: [] };
      jobs[jobMatch[1]] = currentJob;
      currentStep = null;
      jobDepth = 2;
      continue;
    }
    if (!currentJob) continue;
    // job 的其余顶层字段（needs / if / outputs）——深度 4（`needs:` / `if:` 在 4 空格）
    if (jobDepth === 2 && /^ {4}(needs|if):\s*(.+)$/.test(raw)) {
      const kv = /^ {4}(needs|if):\s*(.+)$/.exec(raw)!;
      const value = kv[2].trim();
      if (kv[1] === "needs") currentJob.needs = value;
      else currentJob.if = value;
      continue;
    }
    if (jobDepth === 2 && /^ {4}outputs:\s*$/.test(raw)) {
      inJobOutputs = true;
      continue;
    }
    if (inJobOutputs) {
      const outKv = /^ {6}([a-zA-Z_][a-zA-Z0-9_]*):\s*(.+)$/.exec(raw);
      if (outKv) {
        currentJob.outputs ??= {};
        currentJob.outputs[outKv[1]] = outKv[2].trim();
        continue;
      }
      if (/^ {4}\S/.test(raw)) inJobOutputs = false; // 回到 job 顶层
    }
    if (/^ {6}- /.test(raw)) inJobOutputs = false;
    const stepMatch = /^ {6}- (name|uses):\s*(.*)$/.exec(raw);
    if (stepMatch) {
      currentStep = stepMatch[1] === "name" ? { name: stepMatch[2] } : { uses: stepMatch[2] };
      currentJob.steps!.push(currentStep);
      inStepEnv = false;
      continue;
    }
    if (!currentStep) continue;
    if (/^ {8}env:\s*$/.test(raw)) {
      currentStep.env = {};
      inStepEnv = true;
      continue;
    }
    if (inStepEnv) {
      if (/^\s*#/.test(raw)) continue;
      const kv = /^ {10}([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(raw);
      if (kv) {
        currentStep.env![kv[1]] = kv[2].replace(/^["']|["']$/g, "");
        continue;
      }
      // 缩进回退到 env 块之外（`run:` / 下一个 step / 下一个 job）
      const indent = raw.length - raw.trimStart().length;
      if (raw.trim() !== "" && indent <= 8) inStepEnv = false;
    }
  }
  return jobs;
}

let jobs: Record<string, WorkflowJob>;

/** 读工作流原文并**剥掉 CR**（本仓 core.autocrlf=true，工作区是 CRLF） */
function workflowText(): string {
  return readFileSync(join(REPO, WORKFLOW), "utf8").replace(/\r/g, "");
}

beforeAll(() => {
  jobs = parseWorkflowJobs(workflowText());
});

/** 取某个 job 里带 PERF_* env 的那一步（跑 benchmark 的那一步） */
function envOfBenchmarkStep(jobName: string): Record<string, string> {
  const job = jobs[jobName];
  expect(job, `工作流缺少 job：${jobName}（解析器失效或 YAML 结构变了）`).toBeDefined();
  const withEnv = (job!.steps ?? []).filter(
    (s) => s.env && Object.keys(s.env).some((k) => k.startsWith("PERF_")),
  );
  expect(withEnv.length, `${jobName} 没有任何带 PERF_* 的步骤`).toBeGreaterThan(0);
  return withEnv[withEnv.length - 1].env!;
}

describe("工作流契约：三个 job 的编排变量（#294 P0 的守卫）", () => {
  it("job 名与依赖链正确：benchmark → retest → retest2", () => {
    expect(Object.keys(jobs)).toEqual(["benchmark", "retest", "retest2"]);
    expect(jobs.retest.needs).toBe("benchmark");
    expect(jobs.retest2.needs).toBe("retest");
  });

  it("⚠️ retest job 必须传 PERF_SPLIT_RETEST=1（删掉这一行就是 #294 的 P0）", () => {
    // P0 的精确守卫。少了它 → splitRetest 恒 false → 确认轮永不移交 →
    // 第三轮跑在与 R2 同一台 runner 上 → tag 运行以「同 runner 三轮」的假 FAIL 收尾，
    // 而 retest2 job 因上游非零被 skip（needs.retest 的 if 不带 always()）。
    const env = envOfBenchmarkStep("retest");
    expect(env.PERF_RETEST_ONLY).toBe("1");
    expect(env.PERF_SPLIT_RETEST, "retest job 缺 PERF_SPLIT_RETEST=1 → 确认轮不会移交（P0）").toBe("1");
    // 反向断言：#234 的 PERF_RETEST_ONLY 不等于 split（两者语义不同，别拿前者顶替）
    expect(env.PERF_RETEST2_ONLY).toBeUndefined();
  });

  it("benchmark job 传 PERF_SPLIT_RETEST=1（有嫌疑才移交复测）", () => {
    expect(envOfBenchmarkStep("benchmark").PERF_SPLIT_RETEST).toBe("1");
  });

  it("retest2 job 传 PERF_RETEST2_ONLY=1，且**刻意不传** PERF_SPLIT_RETEST", () => {
    const env = envOfBenchmarkStep("retest2");
    expect(env.PERF_RETEST2_ONLY).toBe("1");
    expect(env.PERF_RETEST_ONLY).toBeUndefined();
    // retest2 是最后一个 job：在 planRetestPhases / planConfirmPhases 之前就 exit 了，
    // splitRetest 不参与任何决策。所以工作流**不传**它——「顺手补上」既无作用，
    // 又会让本断言变红。文档（CONTRIBUTING 与 isSplitPipeline 的注释）已与此处对齐。
    expect(env.PERF_SPLIT_RETEST, "retest2 不该设 PERF_SPLIT_RETEST（无移交决策要用它）").toBeUndefined();
  });

  it("retest2 仅在 retest job 给出候选时才起（if 读 suspects2，且 retest 导出了它）", () => {
    expect(jobs.retest2.if).toContain("suspects2");
    expect(Object.keys(jobs.retest.outputs ?? {})).toContain("suspects2");
  });

  it("retest job 必须导出 profile 给 retest2（档位不一致会测到另一套场景）", () => {
    expect(Object.keys(jobs.retest.outputs ?? {})).toContain("profile");
  });

  it("force_suspects2 作为 dispatch 输入存在，且复测 job 透传它", () => {
    const text = workflowText();
    expect(text).toContain("force_suspects2:");
    expect(envOfBenchmarkStep("retest").PERF_FORCE_SUSPECTS2).toBeTruthy();
  });

  it("三个 job 的 continue-on-error 一致：PR 不阻断、tag 必须显式失败", () => {
    const text = workflowText();
    const count = (text.match(/continue-on-error: \$\{\{ github\.ref_type != 'tag' \}\}/g) ?? []).length;
    expect(count).toBe(3);
  });

  it("不加 job 级 concurrency（workflow 级 queue: max 已串行，加了语义打架）", () => {
    // #294 D8
    const text = workflowText();
    expect(text.split("\n").filter((l) => /^ {2,}concurrency:/.test(l))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ② 端到端：桩 Playwright 驱动 benchmark.mjs 跑真实三段路径
// ═══════════════════════════════════════════════════════════════════════

/** 桩 CLI：按 `PW_STUB_PHASE` / `PW_STUB_VALUES*` 往对应 raw 目录写一份采样 */
const STUB_CLI = [
  'const fs = require("node:fs"), path = require("node:path");',
  'const idx = process.env.PW_STUB_PHASE || "1";',
  'const vals = process.env["PW_STUB_VALUES" + (idx === "1" ? "" : idx)] || "477:41";',
  'const outDir = process.env.PERF_RAW_DIR || ".perf-output/raw";',
  'const parts = vals.split(":");',
  'const id = "search-M-rich";',
  'fs.mkdirSync(outDir, { recursive: true });',
  'fs.writeFileSync(path.join(outDir, id + ".json"), JSON.stringify({',
  '  id, scenario: "search", tier: "M", kind: "rich", env: "local", profile: "quick",',
  '  rounds: 2, warmups: 1, mode: "headless", absoluteEligible: false,',
  `  fixture: { version: 2, hash: "${HASH}", lines: 5000, source: "generated:rich" },`,
  '  samples: { searchMs: [...Array(28).fill(Number(parts[0])), ...Array(2).fill(Number(parts[0]))] },',
  '  scalars: { frameBudgetMs: 16.7, probeMs: Number(parts[1] || 41) }',
  '}, null, 2));',
  'const pw = process.env.PERF_PW_REPORT;',
  'if (pw) { fs.mkdirSync(path.dirname(pw), { recursive: true }); fs.writeFileSync(pw, JSON.stringify({ suites: [] })); }',
  'process.exit(0);',
].join("\n");

function scaffold(root: string): string {
  mkdirSync(join(root, "tests", "perf"), { recursive: true });
  for (const file of PERF_FILES) cpSync(join(REPO, "tests", "perf", file), join(root, "tests", "perf", file));
  const stubPath = join(root, "pw-cli-stub.cjs");
  writeFileSync(stubPath, STUB_CLI, "utf8");
  const cli = join(root, "node_modules", "@playwright", "test");
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, "cli.js"), `require(${JSON.stringify(stubPath)});\n`, "utf8");
  return root;
}

/** 基线：searchMs 参考 477 / p95 500，probeMs 历史上限 44（越界门槛 44 × 1.1 = 48.4） */
function seedBaseline(root: string): void {
  const dir = join(root, ".perf-baseline", "local", "quick", "headless", "r2");
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
        scenario: "search",
        tier: "M",
        kind: "rich",
        fixture: { version: 2, hash: HASH, lines: 5000, source: "generated:rich" },
        metrics: {
          searchMs: {
            median: 477,
            p95: 500,
            max: 900,
            n: 30,
            history: [470, 480, 475, 490, 465, 485, 472, 478],
            historyP95: [495, 505, 500, 510, 490, 508, 498, 502],
          },
          probeMs: { median: 41.22, p95: null, max: null, n: null, scalar: true, history: [31, 41, 36, 44, 39, 43, 34, 42] },
        },
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runBenchmark(cwd: string, env: Record<string, string> = {}): RunResult {
  const allowed = [
    "PERF_PROFILE",
    "PERF_SPLIT_RETEST",
    "PERF_RETEST_ONLY",
    "PERF_RETEST2_ONLY",
    "PERF_FORCE_SUSPECTS",
    "PERF_FORCE_SUSPECTS2",
    "PERF_REQUIRE_COMPARISON",
  ];
  const full: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(full)) {
    if (key.startsWith("PERF_") && !allowed.includes(key)) delete full[key];
  }
  for (const [key, value] of Object.entries(env)) full[key] = value;
  try {
    const stdout = execFileSync(process.execPath, ["tests/perf/benchmark.mjs"], {
      env: full,
      cwd,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const roots: string[] = [];
let sandbox: string;
/** 本机能否两层嵌套 spawn（沙箱内不行：单层可用，两层 EBUSY） */
let canNest = true;
let nestReason = "";

/**
 * 探测必须发生在**模块加载期**（而不是 `beforeAll`）：`it.skipIf` 在收集阶段求值，
 * 那时 `beforeAll` 还没跑，用例会在环境根本不支持 spawn 时照样执行并整片变红。
 */
function probeNestedSpawn(): { sandbox: string; canNest: boolean; reason: string } {
  const dir = mkdtempSync(join(tmpdir(), "perf-orch-probe-"));
  scaffold(dir);
  seedBaseline(dir);
  const result = runBenchmark(dir, { PERF_PROFILE: "quick" });
  // status=-1 且无 stdout = spawn 根本没起来（EBUSY），不是脚本跑出问题
  if (result.status === -1 && result.stdout === "") {
    return { sandbox: dir, canNest: false, reason: "两层嵌套 spawn 不可用（EBUSY）" };
  }
  return { sandbox: dir, canNest: true, reason: "" };
}

const probe = probeNestedSpawn();
sandbox = probe.sandbox;
canNest = probe.canNest;
nestReason = probe.reason;
roots.push(sandbox);

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const out = (root: string, ...parts: string[]) => join(root, ".perf-output", ...parts);
const has = (root: string, ...parts: string[]) => existsSync(out(root, ...parts));
const readOut = (root: string, name: string) => readFileSync(out(root, name), "utf8");

/** 模拟 artifact 下载：把上游 job 的 `.perf-output/` 与 `.perf-baseline/` 拷进下一个 job */
function simulateDownload(from: string, to: string): string {
  scaffold(to);
  for (const dir of [".perf-output", ".perf-baseline"]) {
    if (existsSync(join(from, dir))) cpSync(join(from, dir), join(to, dir), { recursive: true });
  }
  return to;
}

/** 跑完「测量 + 复测」两个 job，返回可交给确认轮 job 的目录（已含双超候选） */
function twoJobsWithCandidate(tag: string): string {
  const job1 = scaffold(join(sandbox, `${tag}-1`));
  seedBaseline(job1);
  runBenchmark(job1, {
    PERF_PROFILE: "quick",
    PERF_SPLIT_RETEST: "1",
    PW_STUB_PHASE: "1",
    PW_STUB_VALUES: "549.5:41",
  });
  const job2 = simulateDownload(job1, join(sandbox, `${tag}-2`));
  runBenchmark(job2, {
    PERF_PROFILE: "quick",
    PERF_RETEST_ONLY: "1",
    PERF_SPLIT_RETEST: "1",
    PW_STUB_PHASE: "2",
    PW_STUB_VALUES2: "584.1:41",
  });
  return simulateDownload(job2, join(sandbox, `${tag}-3`));
}

/**
 * 端到端编排用例每条都会 spawn 2–3 个 benchmark 子进程：本机实测 2.1–4.9s，
 * 而 vitest 对 `tests/unit/**` 用**默认 5s** 线——Windows CI runner 上曾整批越过
 * （PR #314 第四轮 CI：两条用例报 `Test timed out in 5000ms`，同文件相邻用例实测 4854ms，贴着线）。
 * 这里只放宽「执行时间」，断言与语义一字未改。
 */
const E2E_ORCH_TIMEOUT_MS = 60_000;

describe(`端到端编排：测量 → 复测 → 确认轮${canNest ? "" : `（跳过：${nestReason}）`}`, () => {
  it.skipIf(!canNest)("复测 job 有确认候选时必须移交：不产 report.md、不在本 job 跑确认轮", () => {
    const job1 = scaffold(join(sandbox, "e2e-a1"));
    seedBaseline(job1);
    const first = runBenchmark(job1, {
      PERF_PROFILE: "quick",
      PERF_SPLIT_RETEST: "1",
      PW_STUB_PHASE: "1",
      PW_STUB_VALUES: "549.5:41",
    });

    expect(first.status).toBe(0);
    // 测量 job 移交：只产清单与首轮采样，不出 final
    expect(has(job1, "retest.json")).toBe(true);
    expect(has(job1, "report.md")).toBe(false);
    expect(readOut(job1, "retest.json")).toContain(ID);

    // ── 复测 job：双超 → 有确认候选 → 必须移交 ──
    const job2 = simulateDownload(job1, join(sandbox, "e2e-a2"));
    const second = runBenchmark(job2, {
      PERF_PROFILE: "quick",
      PERF_RETEST_ONLY: "1",
      PERF_SPLIT_RETEST: "1",
      PW_STUB_PHASE: "2",
      PW_STUB_VALUES2: "584.1:41",
    });

    expect(second.status).toBe(0);
    expect(readOut(job2, "retest2.json")).toContain(ID);
    // **P0 守卫**：移交就不能出 final —— 否则确认轮与 R2 同 runner，tag 上是假 FAIL
    expect(has(job2, "report.md"), "复测 job 在有确认候选时出了 final → 确认轮没移交（P0）").toBe(false);
    // 也不能在本 job 跑确认轮
    expect(existsSync(join(job2, ".perf-output", "raw-retest2", `${ID}.json`))).toBe(false);
    // 不得打印「本地为单进程」——它是 splitRetest=false 的直接指纹（评审据此定位 P0）
    expect(second.stdout).not.toContain("本地为单进程");
    // 上游产物必须原样保留（清错目录会让 final 静默退化成两轮）
    expect(existsSync(join(job2, ".perf-output", "raw", `${ID}.json`))).toBe(true);
    expect(existsSync(join(job2, ".perf-output", "raw-retest", `${ID}.json`))).toBe(true);
  }, E2E_ORCH_TIMEOUT_MS);

  it.skipIf(!canNest)("复测无确认候选时就地出 final（retest2 不应出现，常规路径零额外开销）", () => {
    const job1 = scaffold(join(sandbox, "e2e-b1"));
    seedBaseline(job1);
    runBenchmark(job1, {
      PERF_PROFILE: "quick",
      PERF_SPLIT_RETEST: "1",
      PW_STUB_PHASE: "1",
      PW_STUB_VALUES: "549.5:41",
    });

    const job2 = simulateDownload(job1, join(sandbox, "e2e-b2"));
    // 复测回落 → 无双超；标定也在范围内 → 无候选
    const second = runBenchmark(job2, {
      PERF_PROFILE: "quick",
      PERF_RETEST_ONLY: "1",
      PERF_SPLIT_RETEST: "1",
      PW_STUB_PHASE: "2",
      PW_STUB_VALUES2: "427.5:41",
    });

    expect(second.status).toBe(0);
    expect(JSON.parse(readOut(job2, "retest2.json"))).toEqual([]);
    expect(has(job2, "report.md")).toBe(true);
    expect(existsSync(join(job2, ".perf-output", "raw-retest2", `${ID}.json`))).toBe(false);
    expect(readOut(job2, "report.md")).toContain("WARN（复测回落（抖动））");
  }, E2E_ORCH_TIMEOUT_MS);

  it.skipIf(!canNest)("PERF_FORCE_SUSPECTS2 能确定性制造候选并触发移交（CI 演练路径）", () => {
    const job1 = scaffold(join(sandbox, "e2e-c1"));
    seedBaseline(job1);
    runBenchmark(job1, {
      PERF_PROFILE: "quick",
      PERF_SPLIT_RETEST: "1",
      PERF_FORCE_SUSPECTS: ID,
      PW_STUB_PHASE: "1",
      PW_STUB_VALUES: "477:41",
    });

    const job2 = simulateDownload(job1, join(sandbox, "e2e-c2"));
    const second = runBenchmark(job2, {
      PERF_PROFILE: "quick",
      PERF_RETEST_ONLY: "1",
      PERF_SPLIT_RETEST: "1",
      PERF_FORCE_SUSPECTS: ID,
      PERF_FORCE_SUSPECTS2: ID,
      PW_STUB_PHASE: "2",
      PW_STUB_VALUES2: "480:41",
    });

    expect(second.status).toBe(0);
    // 钩子必须把生效清单写回文件，否则工作流的 suspects2 输出为空、第三个 job 不触发
    expect(JSON.parse(readOut(job2, "retest2.json"))).toEqual([ID]);
    expect(has(job2, "report.md")).toBe(false);
  }, E2E_ORCH_TIMEOUT_MS);

  it.skipIf(!canNest)("确认轮回落 → 不判 FAIL（3 例假 FAIL 形态），exit 0，三轮都披露", () => {
    const job3 = twoJobsWithCandidate("e2e-d");
    const result = runBenchmark(job3, {
      PERF_PROFILE: "quick",
      PERF_RETEST2_ONLY: "1",
      PW_STUB_PHASE: "3",
      PW_STUB_VALUES3: "427.5:41",
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(job3, ".perf-output", "raw-retest2", `${ID}.json`))).toBe(true);
    const report = readOut(job3, "report.md");
    expect(report).toContain("WARN（末轮回落（抖动））");
    expect(report).not.toContain("| FAIL");
    expect(report).toContain("首轮 ✓　复测 ✓　确认 ✓");
  }, E2E_ORCH_TIMEOUT_MS);

  it.skipIf(!canNest)("三轮都超 → 确认 FAIL + exit 1（真回归护栏不被降级）", () => {
    const job3 = twoJobsWithCandidate("e2e-e");
    const result = runBenchmark(job3, {
      PERF_PROFILE: "quick",
      PERF_RETEST2_ONLY: "1",
      PW_STUB_PHASE: "3",
      PW_STUB_VALUES3: "601.3:41",
    });

    expect(result.status).toBe(1);
    expect(readOut(job3, "report.md")).toContain("FAIL（复测仍超阈值 + 末轮仍超）");
    expect(result.stderr).toContain("相对回归确认（3 轮均超阈值）");
  }, E2E_ORCH_TIMEOUT_MS);

  it.skipIf(!canNest)("目录清空矩阵：确认轮 job 只清 raw-retest2，上游两轮与候选清单原样保留", () => {
    // 「清错目录会让 final 静默退化成两轮」——用哨兵把四类上游产物逐一钉住。
    const job3 = twoJobsWithCandidate("e2e-f");
    // 哨兵：被清则下方断言红
    writeFileSync(join(job3, ".perf-output", "raw", "SENTINEL.json"), "{}", "utf8");
    writeFileSync(join(job3, ".perf-output", "raw-retest", "SENTINEL.json"), "{}", "utf8");
    // 确认轮那一轮**应该**被清（它是本 job 的产物目录）
    mkdirSync(join(job3, ".perf-output", "raw-retest2"), { recursive: true });
    writeFileSync(join(job3, ".perf-output", "raw-retest2", "STALE.json"), "{}", "utf8");

    runBenchmark(job3, {
      PERF_PROFILE: "quick",
      PERF_RETEST2_ONLY: "1",
      PW_STUB_PHASE: "3",
      PW_STUB_VALUES3: "427.5:41",
    });

    expect(existsSync(join(job3, ".perf-output", "raw", "SENTINEL.json")), "上游 R1 被清").toBe(true);
    expect(existsSync(join(job3, ".perf-output", "raw-retest", "SENTINEL.json")), "上游 R2 被清").toBe(true);
    expect(existsSync(join(job3, ".perf-output", "raw-retest2", "STALE.json")), "本轮该清的没清").toBe(false);
    // 候选清单也不能被清（它是「谁该被确认」的唯一依据）
    expect(JSON.parse(readOut(job3, "retest2.json"))).toEqual([ID]);
  }, E2E_ORCH_TIMEOUT_MS);

  it.skipIf(!canNest)("测量轮清掉上一轮的 retest2.json（#294 评审 P2-a）", () => {
    // 本 PR 新增了「无 suspects → 跳过 confirm」分支，retest2.json 不再每轮覆写。
    // 不清它，本地第 2 轮会读到第 1 轮的候选：多跑一轮确认、rounds.confirm 记成 true、
    // 报告写「确认 ✓」——全是假的。
    const root = scaffold(join(sandbox, "e2e-g"));
    seedBaseline(root);
    mkdirSync(out(root), { recursive: true });
    writeFileSync(out(root, "retest2.json"), JSON.stringify(["stale-S-rich"]), "utf8");

    const result = runBenchmark(root, {
      PERF_PROFILE: "quick",
      PERF_SPLIT_RETEST: "1",
      PW_STUB_PHASE: "1",
      PW_STUB_VALUES: "477:41",
    });

    expect(result.status).toBe(0);
    expect(has(root, "retest2.json"), "陈旧的确认轮候选没被清 → 本轮会误跑确认轮").toBe(false);
  }, E2E_ORCH_TIMEOUT_MS);

  it.skipIf(!canNest)("确认轮 job 保留上游 retest2.json（它是上游给的输入，不是本 job 的产物）", () => {
    // 与「测量轮清掉上一轮的 retest2.json」互为反证：确认轮 job 清掉它，final 就读不到候选清单。
    // ⚠️ 用例名要说准是**确认轮 job**：它跑 `PERF_RETEST2_ONLY=1`，
    // 读者若按「复测 job」去 benchmark.mjs 里找这个行为会找不到（复测 job 写、确认轮 job 读）。
    const job3 = twoJobsWithCandidate("e2e-h");
    runBenchmark(job3, {
      PERF_PROFILE: "quick",
      PERF_RETEST2_ONLY: "1",
      PW_STUB_PHASE: "3",
      PW_STUB_VALUES3: "427.5:41",
    });
    expect(JSON.parse(readOut(job3, "retest2.json"))).toEqual([ID]);
  }, E2E_ORCH_TIMEOUT_MS);
});
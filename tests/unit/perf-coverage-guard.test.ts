// 判定覆盖守卫的端到端测试
//
// 背景：基线缺失时所有场景都是 NEW，报告仍会打印「FAIL：0」——那看起来像"没有回归"，
// 实际是"什么都没比"。发版验证（tag 运行）尤其不能被这种假绿灯掩盖，
// 因此引入 PERF_REQUIRE_COMPARISON=1：覆盖不足时退出码 2（infra 故障），并显式说明
// 「本次结论不构成性能验证」。
//
// 这里用子进程真实调用 report.mjs，覆盖四种组合（有/无基线 × 有/无守卫）。

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIMARY_METRICS } from "../perf/judgment.js";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "scroll-C-coverage";

const roots: string[] = [];
let perf: PerfReportWorkspace;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function writeRaw(
  id = ID,
  frameMs = Array.from({ length: 120 }, (_, i) => 16.7 + (i % 3) * 0.1),
  extraScalars: Record<string, number> = {},
): void {
  const raw = {
    id,
    scenario: "scroll",
    tier: "S",
    kind: "rich",
    env: "local",
    profile: "quick",
    rounds: 2,
    warmups: 1,
    mode: "headless",
    absoluteEligible: false,
    fixture: { version: 2, hash: "coverage0001", lines: 1000, source: "generated:rich" },
    samples: { frameMs },
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
      ...extraScalars,
    },
  };
  writeFileSync(join(perf.rawDir, `${id}.json`), JSON.stringify(raw, null, 2), "utf8");
}

/** 写一份复测轮 raw（raw-retest 目录）：结构与首轮一致，供"两轮对账"类用例使用 */
function writeRetest(
  id = ID,
  frameMs = Array.from({ length: 120 }, (_, i) => 16.7 + (i % 3) * 0.1),
  extraScalars: Record<string, number> = {},
): void {
  const raw = {
    id,
    scenario: "scroll",
    tier: "S",
    kind: "rich",
    env: "local",
    profile: "quick",
    rounds: 2,
    warmups: 1,
    mode: "headless",
    absoluteEligible: false,
    fixture: { version: 2, hash: "coverage0001", lines: 1000, source: "generated:rich" },
    samples: { frameMs },
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
      ...extraScalars,
    },
  };
  writeFileSync(join(perf.retestDir, `${id}.json`), JSON.stringify(raw, null, 2), "utf8");
}

/** 明文超阈值的采样（对基线 16.8ms 约 +79%），用来造"复现的回归" */
const REGRESSED_FRAME_MS = Array.from({ length: 120 }, (_, i) => 30 + (i % 3) * 0.1);

/** 写一份与当前采样元数据匹配的基线（可指定 metrics，默认空对象模拟"无可用指标"） */
function writeBaseline(metrics: Record<string, unknown> = {}): void {
  mkdirSync(join(perf.baselineDir, "local", "quick", "headless", "r2"), { recursive: true });
  writeFileSync(
    join(perf.baselineDir, "local", "quick", "headless", "r2", `${ID}.json`),
    JSON.stringify(
      {
        schemaVersion: 2,
        env: "local",
        profile: "quick",
        mode: "headless",
        rounds: 2,
        scenario: "scroll",
        tier: "S",
        kind: "rich",
        fixture: { version: 2, hash: "coverage0001", lines: 1000, source: "generated:rich" },
        metrics,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

/** 跑 report.mjs；requireComparison 模拟 tag 运行的 PERF_REQUIRE_COMPARISON=1 */
function runReport(
  phase: "check" | "final",
  { requireComparison = false, updateBaseline = false, absolute = false } = {},
): RunResult {
  const args = [REPORT, `--phase=${phase}`];
  if (updateBaseline) args.push("--update-baseline=1");
  // 继承来的 PERF_*（含 PERF_ABSOLUTE / PERF_REQUIRE_COMPARISON）已由 perf.env() 统一剥离，
  // 这里只需显式给出本用例想要的开关——"守卫关闭"分支因此是真的关闭
  const env = perf.env({
    ...(requireComparison ? { PERF_REQUIRE_COMPARISON: "1" } : {}),
    ...(absolute ? { PERF_ABSOLUTE: "1" } : {}),
  });

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

beforeEach(() => {
  perf = createPerfReportWorkspace("perf-cov-");
  roots.push(perf.root);
  writeRaw();
});

afterEach(() => {
  perf.assertRepoBaselineUntouched();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("判定覆盖守卫（PERF_REQUIRE_COMPARISON）", () => {
  it("无基线 + 守卫开启 → exit 2，且明确说明「不构成性能验证」", () => {
    const result = runReport("final", { requireComparison: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("判定覆盖不足");
    expect(result.stderr).toContain("不构成性能验证");
    // 报告本身也要说清覆盖面，而不是只留一个 FAIL：0
    expect(report()).toContain("判定覆盖：0/1 个场景参与相对判定");
    expect(result.stdout).toContain("[perf] 判定覆盖：0/1");
  });

  it("无基线 + 守卫关闭（PR 运行/首次建立基线）→ exit 0，行为不变", () => {
    const result = runReport("final");

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("判定覆盖不足");
    expect(report()).toContain("判定覆盖：0/1 个场景参与相对判定");
  });

  it("check 阶段不受守卫影响：否则首个 --update-baseline 运行会被中途判为 infra 故障", () => {
    const check = runReport("check", { requireComparison: true, updateBaseline: true });

    expect(check.status).toBe(0);
    // 基线确实被写入（说明 check 未被守卫打断，后续阶段可继续）
    expect(runReport("final", { requireComparison: true }).status).toBe(0);
  });

  it("有可比基线 + 守卫开启 → exit 0，覆盖 1/1", () => {
    expect(runReport("final", { updateBaseline: true }).status).toBe(0);
    writeRaw(); // 同配置再跑一次，这次应命中基线

    const result = runReport("final", { requireComparison: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[perf] 判定覆盖：1/1 个场景参与相对判定");
    expect(report()).toContain("判定覆盖：1/1 个场景参与相对判定");
  });

  it("分辨率披露：3σ 占参考值 ≥30% 时报告显式提醒——PASS 不等于「没问题」", () => {
    // 手工构造一份"高噪声"基线：同一配置的历史值散布极大（16.8 / 16.9 / 40）
    // → 3σ 远超参考值 30%，此时该指标的相对判定只剩"抓大事故"的能力
    writeBaseline({
      frameMs: {
        median: 17,
        p95: 17.5,
        max: 18,
        n: 120,
        history: [16.8, 16.9, 40],
        historyP95: [17, 17.5, 41],
      },
    });

    const result = runReport("final");
    const table = report();

    expect(result.status).toBe(0);
    expect(table).toContain("3σ（占参考）");
    expect(table).toMatch(/\| \d+(\.\d+)?（\d+%） \|/); // 3σ 列带占比
    expect(table).toContain("分辨率提醒");
    expect(table).toMatch(/分辨率提醒：\d+ 行的 3σ ≥ 参考值的 30%/);
    expect(table).toContain(`${ID}:frameMs`);
  });

  it("元数据可比但基线里没有可用指标 → 记为 EMPTY_BASELINE，不得算作已比较", () => {
    // 复现场景：基线文件 metrics 为空（部分生成），或指标 schema 变更导致逐个指标被跳过。
    // 此时 baselineComparability 返回 OK、compareRun 静默跳过所有指标——表格是空的，
    // 若只按 baselineState 计数就会得到"覆盖 1/1"，重新制造假绿灯。
    writeBaseline({});

    const result = runReport("final", { requireComparison: true });

    expect(result.status).toBe(2); // 覆盖不足 → 不构成性能验证
    expect(result.stdout).toContain("[perf] 判定覆盖：0/1 个场景参与相对判定");
    expect(result.stderr).toContain("判定覆盖不足");
    expect(report()).toContain("未参与相对判定：EMPTY_BASELINE");
  });

  it("绝对行不算相对覆盖：PERF_ABSOLUTE=1 + 空指标基线 → 仍判 EMPTY_BASELINE → exit 2", () => {
    // 边界：`metrics` 里混含不依赖基线的绝对行（帧预算 p95 / 掉帧率）。
    // 若用 `metrics.length > 0` 判"已比较"，绝对行会让覆盖虚报为 OK，
    // EMPTY_BASELINE 不触发——同一族假绿灯的最后一角。
    writeBaseline({}); // 元数据可比、无可用指标
    writeRaw();

    const result = runReport("final", { requireComparison: true, absolute: true });

    expect(report()).toContain("(绝对)"); // 确认本次真的产出了绝对行
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("[perf] 判定覆盖：0/1 个场景参与相对判定");
    expect(report()).toContain("未参与相对判定：EMPTY_BASELINE");
  });

  it("覆盖不足优先于 exit 1：同时存在回归复现时，仍以 exit 2 报出「结论不完整」并列出 FAIL", () => {
    // A 场景：可比基线 + 复测复现的回归（raw 与 raw-retest 均为同一份超阈值采样）
    const A = "scroll-C-coverA";
    const B = "scroll-C-coverB";
    writeRaw(A);
    expect(runReport("final", { updateBaseline: true }).status).toBe(0); // 先建立 A 的基线
    const regressed = Array.from({ length: 120 }, (_, i) => 30 + (i % 3) * 0.1); // 相对 +79%
    writeRaw(A, regressed);
    writeFileSync(join(perf.retestDir, `${A}.json`), readFileSync(join(perf.rawDir, `${A}.json`), "utf8"));
    // B 场景：完全没有基线 → 覆盖 1/2
    writeRaw(B);

    const result = runReport("final", { requireComparison: true });

    expect(result.status).toBe(2); // 覆盖不足优先（否则 CI 只看到"回归"，看不出验证不完整）
    expect(result.stderr).toContain("判定覆盖不足");
    expect(result.stderr).toContain("注意：本次同时存在 FAIL");
    expect(result.stderr).toContain(A);
  });

  it("整机漂移披露：多数相对行同时变差时提示「疑似整机变慢」（只披露、不改判定）", () => {
    // 复现 PR 上那次假 FAIL 的成因：共享 runner 被拖慢时互不相关的指标一起变差
    // （实测 50/57 行、中位 Δ +18.7%，而纯噪声应接近 50%）。
    writeBaseline({
      frameMs: {
        median: 8,
        p95: 8.4,
        max: 9,
        n: 120,
        history: [8, 8, 8],
        historyP95: [8.4, 8.4, 8.4],
      },
    });
    writeRaw();

    const result = runReport("final");

    expect(result.status).toBe(0); // 只披露：整体变慢也可能是真回归，不能据此改判
    expect(report()).toMatch(/整机漂移迹象：\d+\/\d+ 行（100%）比基线差/);
  });

  it("安静运行不误报漂移：行值与基线一致时不出现漂移提示", () => {
    writeBaseline({
      frameMs: {
        median: 16.8,
        p95: 17.1,
        max: 17.2,
        n: 120,
        history: [16.8, 16.8, 16.8],
        historyP95: [17.1, 17.1, 17.1],
      },
    });
    writeRaw();

    expect(runReport("final").status).toBe(0);
    expect(report()).not.toContain("整机漂移迹象");
  });

  it("「判定分层」行的主指标名单与 PRIMARY_METRICS 一致（issue #238：曾写死成不存在的 inputMs）", () => {
    writeRaw();

    expect(runReport("final").status).toBe(0);
    // 断言的是**派生结果**：名单必须逐字等于 judgment 的白名单，防止文案再漂移
    expect(report()).toContain(`判定分层：主指标（${PRIMARY_METRICS.join(" / ")}）可单独判 FAIL`);
    expect(report()).not.toContain("inputMs）"); // 那个不存在的名字不许再出现
  });
});

// 会话标定归因（issue #236）：标定负载与编辑器代码无关，它变慢说明**机器**变慢。
// 断言的是归因结论（环境异常 / 环境正常）——这是 #236 的验收点，也是"连续 2 次"过滤
// 在共享 runner 上区分不开的那件事。
describe("会话标定归因（#236）", () => {
  const probeBaseline = {
    probeMs: { median: 100, p95: 105, max: 110, n: 3, history: [99, 100, 101] },
  };
  /** 基线里同时给出 frameMs（判定要用）与 probeMs（归因要用） */
  const frameAndProbeBaseline = {
    frameMs: {
      median: 16.8,
      p95: 17.1,
      max: 17.2,
      n: 120,
      history: [16.8, 16.8, 16.8],
      historyP95: [17.1, 17.1, 17.1],
    },
    ...probeBaseline,
  };

  it("首轮标定超范围且没有复测数据 → 判「首轮环境异常」并说明未触发复测（评审 R1）", () => {
    writeBaseline(probeBaseline);
    writeRaw(ID, undefined, { probeMs: 140 }); // 140 > 历史上限 101 的 110% → 超出历史范围

    const result = runReport("final");

    expect(result.status).toBe(0); // 只归因、不改判定（#236 明确的范围）
    expect(report()).toContain("会话标定");
    expect(report()).toContain("首轮环境异常");
    expect(report()).toContain("基线参考 100ms，历史范围 99–101ms，首轮 140ms");
    // 后半句必须锁住：没有复测轮时**不许**说"复测已回落"（评审 R1 实测抓到过这个无中生有）
    expect(report()).toContain("本次没有复测轮");
    expect(report()).not.toContain("复测已回落");
  });

  it("首轮超范围 + 复测正常 + 未复现 → 才写「复测已回落」（评审 R1 的另一半）", () => {
    writeBaseline(frameAndProbeBaseline);
    writeRaw(ID, undefined, { probeMs: 140 }); // 首轮：机器慢，应用指标未超阈值
    writeRetest(ID, undefined, { probeMs: 100 }); // 复测：机器正常

    expect(runReport("final").status).toBe(0);
    expect(report()).toContain("复测已回落");
    expect(report()).not.toContain("本次没有复测轮");
  });

  it("两轮对账①：复测那台机器慢 → 提示 FAIL 可能被复测环境放大（评审 P2-1 后果 b）", () => {
    // 只看首轮会写「环境正常」，恰好丢弃了唯一能识破这次假 FAIL 的证据（复测侧 probe）。
    writeBaseline(frameAndProbeBaseline);
    writeRaw(ID, REGRESSED_FRAME_MS, { probeMs: 100 }); // 首轮：机器正常，指标超阈值
    writeRetest(ID, REGRESSED_FRAME_MS, { probeMs: 140 }); // 复测：换到一台慢机器，仍超阈值

    runReport("final");

    expect(report()).toContain("复测环境异常");
    expect(report()).toContain("FAIL 未必成立");
    expect(report()).not.toContain("回归在「两台 runner 上复现」");
  });

  it("两轮对账②：首轮慢但复测（另一台 runner）仍复现 → 判「回归在两台 runner 上复现」（评审 P2-1 后果 a）", () => {
    // 旧实现只说首轮 → 会写「请换 runner 重跑确认」，而换 runner 恰恰已经做过了。
    writeBaseline(frameAndProbeBaseline);
    writeRaw(ID, REGRESSED_FRAME_MS, { probeMs: 140 }); // 首轮：机器慢 + 指标超阈值
    writeRetest(ID, REGRESSED_FRAME_MS, { probeMs: 100 }); // 复测：机器正常，仍超阈值 → 复现

    const result = runReport("final");

    expect(result.status).toBe(1); // FAIL 复现
    expect(report()).toContain("回归在「两台 runner 上复现」");
    expect(report()).not.toContain("请换 runner 重跑确认");
  });

  it("标定负载正常 → 判「环境正常」，恶变不归因于机器", () => {
    writeBaseline(probeBaseline);
    writeRaw(ID, undefined, { probeMs: 100 });

    expect(runReport("final").status).toBe(0);
    expect(report()).toContain("环境在历史范围内"); // 门槛=是否超出历史范围（3σ 对双峰不适用）
    expect(report()).not.toContain("会话环境异常");
  });

  it("基线还没播种标定指标时整行不出现（缺失就不判，不伪造 0）", () => {
    writeBaseline({}); // 老基线：没有 probeMs
    writeRaw(ID, undefined, { probeMs: 140 });

    expect(runReport("final").status).toBe(0);
    expect(report()).not.toContain("会话标定");
  });

  it("标定值必须写进基线，但不能作为判定行出现（进基线 ≠ 参与判定）", () => {
    // 实测踩过：标定指标被排除在 COMPARED_SCALARS 之外后，buildStats 写基线时也用同一白名单，
    // 于是播种产物里根本没有 probeMs——基线没历史、归因行永远不出现。
    // 两个集合必须分开：持久化取并集，判定只用白名单。
    writeRaw(ID, undefined, { probeMs: 36, probeLayoutMs: 9, probeCpuMs: 27 });

    expect(runReport("final", { updateBaseline: true }).status).toBe(0);

    const baseline = JSON.parse(
      readFileSync(join(perf.baselineDir, "local", "quick", "headless", "r2", `${ID}.json`), "utf8"),
    ) as { metrics: Record<string, { median?: number; history?: number[] }> };
    expect(baseline.metrics.probeMs?.median).toBe(36); // 持久化了
    expect(baseline.metrics.probeMs?.history).toEqual([36]); // 首次播种起头
    expect(baseline.metrics.probeLayoutMs?.median).toBe(9);
    expect(report()).not.toMatch(/\| probeMs \|/); // 但不出现在判定表格里
  });
});

// 范围内偏慢会话的假 FAIL 披露（#259）：标定在历史范围内 ≠ 排除环境。
// 实录：同一份代码（PR #253 只改 CI/文档）落在 runner 结构性双峰（30.95–50.85ms、参考 41.2ms）
// 的偏慢侧两轮（+7.7% / +20%）→ 旧文案「机器档位不足以解释它（须看代码或 IO 侧）」
// 把读者引向代码侧找不存在的回归。此处用该实录数字锁住两轮偏差的披露与结论订正。
describe("范围内偏慢会话的归因披露（#259）", () => {
  /** #259 实录基线：参考 41.2ms、历史范围 30.95–50.85ms（双峰） */
  const probe259Baseline = {
    frameMs: {
      median: 16.8,
      p95: 17.1,
      max: 17.2,
      n: 120,
      history: [16.8, 16.8, 16.8],
      historyP95: [17.1, 17.1, 17.1],
    },
    probeMs: { median: 41.2, p95: 41.2, max: 41.2, n: 3, history: [30.95, 50.85, 41.2] },
  };

  it("两轮都在范围内但均偏慢：两轮偏差都披露，且不再断言「机器档位不足以解释它」", () => {
    writeBaseline(probe259Baseline);
    writeRaw(ID, REGRESSED_FRAME_MS, { probeMs: 44.4 }); // 首轮 +7.8%（实录 44.4 / 参考 41.2）
    writeRetest(ID, REGRESSED_FRAME_MS, { probeMs: 49.6 }); // 复测 +20.4%，两轮均未超历史范围

    const result = runReport("final");

    expect(result.status).toBe(1); // 判定语义不变：仍判 FAIL（本 issue 只订正归因披露）
    expect(report()).toContain("环境在历史范围内");
    expect(report()).toContain("首轮比基线参考慢 7.8%");
    // 旧实现只报首轮，这条断言在旧文案下必红——复测那台更慢时漏掉的正是关键证据
    expect(report()).toContain("复测比基线参考慢 20.4%");
    expect(report()).toContain("不能据此排除环境");
    expect(report()).toContain("换 runner 重跑");
    expect(report()).not.toContain("机器档位不足以解释它");
  });

  it("首轮缺标定数据：不伪造首轮偏差，复测侧照常披露", () => {
    writeBaseline(probe259Baseline);
    writeRaw(ID, REGRESSED_FRAME_MS); // 老产物：没有 probeMs
    writeRetest(ID, REGRESSED_FRAME_MS, { probeMs: 49.6 });

    expect(runReport("final").status).toBe(1);
    expect(report()).toContain("首轮无标定数据");
    expect(report()).toContain("复测比基线参考慢 20.4%");
  });
});

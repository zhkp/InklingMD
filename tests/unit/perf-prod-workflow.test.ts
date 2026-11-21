// prod 基准工作流的静态契约（#420 / #421 评审）
//
// 与 `workflow-triggers.test.ts` 同风格：直接读 YAML 文本断言关键接线。
// 它不在 PR 上自动跑（只有 dispatch），坏了没人会发现，所以每条接线都要锁。
//
// 断言一律带缩进锚点：裸 `toContain("profile:")` 会被注释满足（#421 评审 6 实测）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 本仓 core.autocrlf=true：不归一化换行，下面的 `\n  job:\n` 锚点永远匹配不到，
// `jobBlock` 会「找不到 job」而不是断言失败（与 perf-orchestration 的解析器同款坑）。
const WORKFLOW = readFileSync(
  ".github/workflows/benchmark-prod.yml",
  "utf8",
).replace(/\r\n/g, "\n");

/** 取某个 job 块（从 `  <name>:` 到下一个 job 或文件尾），避免跨 job 误判 */
function jobBlock(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  expect(start, `找不到 job：${name}`).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("benchmark-prod 工作流契约", () => {
  it("只在手动触发，并提供 profile / scenario / update_baseline / absolute 入口", () => {
    expect(WORKFLOW).toMatch(/^on:\s*\n\s*workflow_dispatch:/m);
    expect(WORKFLOW).not.toMatch(/^\s{2}pull_request:/m);
    expect(WORKFLOW).toMatch(/^ {6}profile:$/m);
    expect(WORKFLOW).toMatch(/^ {6}scenario:$/m);
    expect(WORKFLOW).toMatch(/^ {6}update_baseline:$/m);
    expect(WORKFLOW).toMatch(/^ {6}absolute:$/m);
  });

  it("以生产构建口径运行，并把档位/场景/播种/绝对判定都接上", () => {
    expect(WORKFLOW).toMatch(/^\s+PERF_BUILD: prod$/m);
    // 档位经「决定档位」step 落到 job outputs（与 dev 通道同款），不是直接读 inputs
    expect(WORKFLOW).toMatch(
      /^\s+PERF_PROFILE: \$\{\{ steps\.profile\.outputs\.value \}\}$/m,
    );
    expect(WORKFLOW).toMatch(
      /^\s{6}profile: \$\{\{ steps\.profile\.outputs\.value \}\}$/m,
    );
    expect(WORKFLOW).toMatch(/^\s+PERF_SCENARIO: \$\{\{ inputs\.scenario \}\}$/m);
    expect(WORKFLOW).toMatch(
      /^\s+PERF_UPDATE_BASELINE: \$\{\{ inputs\.update_baseline/m,
    );
    // 绝对判定入口：CI 无显示设备，必须同时按 uncapped 跑（否则量的是 60Hz 地板）
    expect(WORKFLOW).toMatch(/^\s+PERF_ABSOLUTE: \$\{\{ inputs\.absolute/m);
    expect(WORKFLOW).toMatch(/^\s+PERF_UNCAPPED: \$\{\{ inputs\.absolute/m);
  });

  it("三段 job + 三个独立 runner，split 变量逐段正确（#421 评审 1）", () => {
    const bench = jobBlock("benchmark");
    const retest = jobBlock("retest");
    const retest2 = jobBlock("retest2");

    expect(bench).toContain("PERF_SPLIT_RETEST");
    expect(retest).toMatch(/^\s+PERF_RETEST_ONLY: "1"$/m);
    // 这一行不可省（#294 P0）：缺了确认轮会跑回与 R2 同一台 runner
    expect(retest).toMatch(/^\s+PERF_SPLIT_RETEST: "1"$/m);
    expect(retest2).toMatch(/^\s+PERF_RETEST2_ONLY: "1"$/m);

    // 链式依赖 + 只在有嫌疑/有确认候选时启动（常规路径不额外付 runner 成本）
    expect(retest).toMatch(/^\s{4}needs: benchmark$/m);
    expect(retest).toMatch(/suspects == 'true'/);
    expect(retest2).toMatch(/^\s{4}needs: retest$/m);
    expect(retest2).toMatch(/suspects2 == 'true'/);
  });

  it("常规跑必须比出结论；首播（播种）豁免（#421 评审 2）", () => {
    expect(WORKFLOW).toMatch(
      /^\s+PERF_REQUIRE_COMPARISON: \$\{\{ inputs\.update_baseline && '' \|\| '1' \}\}$/m,
    );
  });

  it("每个 job 都有 always 的 Job Summary，且写入 report.md（#421 评审 2）", () => {
    for (const name of ["benchmark", "retest", "retest2"]) {
      const block = jobBlock(name);
      expect(block, `${name} 缺少 Job Summary 步骤`).toContain("name: 写入 Job Summary");
      expect(block).toContain('if: ${{ !cancelled() }}');
      expect(block).toContain("GITHUB_STEP_SUMMARY");
    }
    // 首轮 summary 必须能暴露「未与任何基线比较」
    expect(jobBlock("benchmark")).toContain("判定覆盖：0/");
  });

  it("artifact 必须带上隐藏目录，且传不上去要报错", () => {
    // `.perf-output/` 与 `.perf-baseline/` 都是点目录；漏了 include-hidden-files
    // 就是「绿着但什么都没传」。
    expect(WORKFLOW).toMatch(/^\s+include-hidden-files: true$/m);
    expect(WORKFLOW).not.toMatch(/include-hidden-files:\s*false/);
    expect(WORKFLOW).toMatch(/^\s+if-no-files-found: error$/m);
  });

  it("播种必须显式打勾，默认不重写既有基线", () => {
    const block = WORKFLOW.slice(
      WORKFLOW.indexOf("update_baseline:"),
      WORKFLOW.indexOf("permissions:"),
    );
    expect(block).toMatch(/^\s+default: false$/m);
  });

  it("与 dev 通道共用测量队列；只读权限，不在 CI 里 push 基线", () => {
    expect(WORKFLOW).toMatch(/concurrency:\s*\n\s*group:\s*benchmark\b/);
    expect(WORKFLOW).toContain("cancel-in-progress: false");
    expect(WORKFLOW).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(WORKFLOW).not.toMatch(/git push/);
  });
});

// prod 基准工作流的静态契约（#420）
//
// 与 `workflow-triggers.test.ts` 同风格：直接读 YAML 文本断言关键接线，
// 防止「改了工作流但 prod 通道悄悄失效」——它不在 PR 上跑，坏了没人会发现。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(
  ".github/workflows/benchmark-prod.yml",
  "utf8",
);

describe("benchmark-prod 工作流契约", () => {
  it("只在手动触发，且提供 profile / scenario / update_baseline 三个入口", () => {
    expect(WORKFLOW).toMatch(/^on:\s*\n\s*workflow_dispatch:/m);
    expect(WORKFLOW).not.toMatch(/^\s{2}pull_request:/m);
    expect(WORKFLOW).toContain("profile:");
    expect(WORKFLOW).toContain("scenario:");
    expect(WORKFLOW).toContain("update_baseline:");
  });

  it("以生产构建口径运行（PERF_BUILD=prod），并允许播种", () => {
    expect(WORKFLOW).toContain("PERF_BUILD: prod");
    expect(WORKFLOW).toContain("PERF_PROFILE: ${{ inputs.profile }}");
    expect(WORKFLOW).toContain("PERF_SCENARIO: ${{ inputs.scenario }}");
    // 播种开关必须真的接到 benchmark 上，否则「首播基线」永远写不出来
    expect(WORKFLOW).toMatch(
      /PERF_UPDATE_BASELINE:\s*\$\{\{\s*inputs\.update_baseline/,
    );
  });

  it("与 dev 通道共用测量队列，避免并发抢 CPU 让长任务失真", () => {
    expect(WORKFLOW).toMatch(/concurrency:\s*\n\s*group:\s*benchmark\b/);
    expect(WORKFLOW).toContain("cancel-in-progress: false");
  });

  it("只读权限：播种产物走 artifact，不在 CI 里直接 push 基线", () => {
    expect(WORKFLOW).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(WORKFLOW).toContain("actions/upload-artifact");
    expect(WORKFLOW).not.toMatch(/git push/);
  });

  it("artifact 必须带上隐藏目录，且传不上去要报错（#421 评审 P1）", () => {
    // `.perf-output/` 与 `.perf-baseline/` 都是点目录；upload-artifact 默认跳过
    // 隐藏文件，漏了 include-hidden-files 就是「绿着但什么都没传」。
    // 断言 YAML 值本身，而不是注释里的字样（注释也写着 true，toContain 会假绿）
    expect(WORKFLOW).toMatch(/^\s+include-hidden-files: true$/m);
    expect(WORKFLOW).not.toMatch(/include-hidden-files:\s*false/);
    expect(WORKFLOW).toMatch(/^\s+if-no-files-found: error$/m);
    expect(WORKFLOW).toMatch(/path:\s*\|\s*\n\s*\.perf-output\/\s*\n\s*\.perf-baseline\//);
  });

  it("播种必须显式打勾，默认不重写既有基线（#421 评审 P2）", () => {
    // 默认 true 会让常规 dispatch 把本次结果写进基线，反复播种会把回归
    // 慢慢「正常化」进对照历史。
    const block = WORKFLOW.slice(
      WORKFLOW.indexOf("update_baseline:"),
      WORKFLOW.indexOf("permissions:"),
    );
    expect(block).toContain("default: false");
  });
});

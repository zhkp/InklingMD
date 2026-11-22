// prod 基准工作流的静态契约（#420 / #421 多轮评审）
//
// 与 `workflow-triggers.test.ts` 同风格：直接读 YAML 文本断言关键接线。
// 它不在 PR 上自动跑（只有 dispatch），坏了没人会发现，所以每条接线都要锁：
// - 断言带值 + 缩进锚点（裸 `toContain` 会被注释满足，也无法区分 "0" / "1"）；
// - 断言按 job 作用域取块（同一变量在不同 job 里语义不同）；
// - artifact 上传名与下游下载名做闭环断言。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 本仓 core.autocrlf=true：不归一化换行，下面的 `\n  job:\n` 锚点永远匹配不到，
// `jobBlock` 会「找不到 job」而不是断言失败（与 perf-orchestration 的解析器同款坑）。
const WORKFLOW = readFileSync(
  ".github/workflows/benchmark-prod.yml",
  "utf8",
).replace(/\r\n/g, "\n");

/**
 * 剔除尾部属于**下一个 job** 的注释行（#421 评审 R4-1）。
 *
 * 下一个 job 前面常带 2 空格的任务级注释（如「独立复测 job（#234）…」），
 * 若把它们留在上一个块里，「块内出现某字符串」就不等于「该 job 自己写了它」。
 */
function stripTrailingNextJobComments(block: string): string {
  const lines = block.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.trim() === "" || /^ {2}#/.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n");
}

/** 取某个 job 块（从 `  <name>:` 到下一个 job 或文件尾），避免跨 job 误判 */
function jobBlock(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  expect(start, `找不到 job：${name}`).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  return stripTrailingNextJobComments(block);
}

/**
 * GitHub Actions 的 `a && b || c` 求值语义：`&&`/`||` 返回**操作数本身**，
 * `''` 是 falsy。用它把 YAML 里的表达式跑一遍，才能抓到
 * `update_baseline && '' || '1'` 这种「恒为 '1'」的写法（#421 评审 1）。
 */
function evalGhTernary(cond: boolean, whenTrue: string, whenFalse: string): string {
  const and = (a: boolean, b: string): boolean | string => (a ? b : a);
  const or = (x: boolean | string, y: string): boolean | string => (x ? x : y);
  return String(or(and(cond, whenTrue), whenFalse));
}

describe("benchmark-prod 工作流契约", () => {
  it("只在手动触发，并提供 profile / scenario / update_baseline / absolute / 演练钩子", () => {
    expect(WORKFLOW).toMatch(/^on:\s*\n\s*workflow_dispatch:/m);
    expect(WORKFLOW).not.toMatch(/^\s{2}pull_request:/m);
    for (const input of [
      "profile",
      "scenario",
      "update_baseline",
      "absolute",
      // 三段路径的确定性演练钩子（prod 不随 PR 跑，没有它只能等真回归）
      "force_suspects",
      "force_suspects2",
    ]) {
      expect(WORKFLOW, `缺少输入：${input}`).toMatch(
        new RegExp(`^ {6}${input}:$`, "m"),
      );
    }
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
    // 绝对判定入口：CI 无显示设备，必须同时按 uncapped 跑（否则量的是 60Hz 地板）
    expect(WORKFLOW).toMatch(/^\s+PERF_ABSOLUTE: \$\{\{ inputs\.absolute/m);
    expect(WORKFLOW).toMatch(/^\s+PERF_UNCAPPED: \$\{\{ inputs\.absolute/m);
  });

  it("三段 job + 三个独立 runner，split 变量逐段正确（#421 评审 1）", () => {
    const bench = jobBlock("benchmark");
    const retest = jobBlock("retest");
    const retest2 = jobBlock("retest2");

    expect(bench).toMatch(/^\s+PERF_SPLIT_RETEST: "1"$/m);
    expect(retest).toMatch(/^\s+PERF_RETEST_ONLY: "1"$/m);
    // 这一行不可省（#294 P0）：缺了确认轮会跑回与 R2 同一台 runner
    expect(retest).toMatch(/^\s+PERF_SPLIT_RETEST: "1"$/m);
    expect(retest2).toMatch(/^\s+PERF_RETEST2_ONLY: "1"$/m);

    // 链式依赖 + 只在有嫌疑/有确认候选时启动（常规路径不额外付 runner 成本）
    expect(retest).toMatch(/^\s{4}needs: benchmark$/m);
    expect(retest).toMatch(/^\s{4}if: needs\.benchmark\.outputs\.suspects == 'true'$/m);
    expect(retest2).toMatch(/^\s{4}needs: retest$/m);
    expect(retest2).toMatch(/^\s{4}if: needs\.retest\.outputs\.suspects2 == 'true'$/m);

    // 演练钩子透传（benchmark 只传第一段；retest 两段都传，与 dev 一致）
    expect(bench).toMatch(/^\s+PERF_FORCE_SUSPECTS: \$\{\{ inputs\.force_suspects \}\}$/m);
    expect(retest).toMatch(
      /^\s+PERF_FORCE_SUSPECTS: \$\{\{ inputs\.force_suspects \}\}$/m,
    );
    expect(retest).toMatch(
      /^\s+PERF_FORCE_SUSPECTS2: \$\{\{ inputs\.force_suspects2 \}\}$/m,
    );
  });

  it("artifact 上传名与下游下载名闭环（#421 评审 2）", () => {
    const bench = jobBlock("benchmark");
    const retest = jobBlock("retest");
    const retest2 = jobBlock("retest2");

    expect(bench).toMatch(
      /^\s+name: perf-prod-\$\{\{ steps\.profile\.outputs\.value \}\}$/m,
    );
    expect(retest).toMatch(
      /^\s+name: perf-prod-\$\{\{ needs\.benchmark\.outputs\.profile \}\}$/m,
    );
    expect(retest).toMatch(
      /^\s+name: perf-prod-\$\{\{ needs\.benchmark\.outputs\.profile \}\}-retest$/m,
    );
    expect(retest2).toMatch(
      /^\s+name: perf-prod-\$\{\{ needs\.retest\.outputs\.profile \}\}-retest$/m,
    );
    expect(retest2).toMatch(
      /^\s+name: perf-prod-\$\{\{ needs\.retest\.outputs\.profile \}\}-retest2$/m,
    );
  });

  it("覆盖率门禁的表达式在 true/false 下必须给出不同值（#421 评审 1）", () => {
    const m = /PERF_REQUIRE_COMPARISON: \$\{\{ inputs\.update_baseline && '(\d)' \|\| '(\d)' \}\}/.exec(
      WORKFLOW,
    );
    expect(m, "找不到 PERF_REQUIRE_COMPARISON 表达式").toBeTruthy();
    const [, whenTrue, whenFalse] = m as RegExpExecArray;

    // 逐分支求值：播种（true）→ 关闭门禁 '0'；常规跑（false）→ 开启 '1'
    expect(evalGhTernary(true, whenTrue, whenFalse)).toBe("0");
    expect(evalGhTernary(false, whenTrue, whenFalse)).toBe("1");
    // 反过来写（`&& '' || '1'`）两分支同为 '1'，必须被这条挡住
    expect(evalGhTernary(true, "", "1")).toBe("1");
  });

  it("三个 job 都按播种开关下发覆盖率门禁与播种标记", () => {
    for (const name of ["benchmark", "retest", "retest2"]) {
      const block = jobBlock(name);
      expect(block, `${name} 缺少播种开关`).toMatch(
        /^\s+PERF_UPDATE_BASELINE: \$\{\{ inputs\.update_baseline && '1' \|\| '0' \}\}$/m,
      );
      expect(block, `${name} 缺少覆盖率门禁`).toMatch(
        /^\s+PERF_REQUIRE_COMPARISON: \$\{\{ inputs\.update_baseline && '0' \|\| '1' \}\}$/m,
      );
    }
  });

  it("每个 job 都有 always 的 Job Summary，且播种/常规文案分流（#421 评审 R4-1）", () => {
    for (const name of ["benchmark", "retest", "retest2"]) {
      const block = jobBlock(name);
      // 带缩进锚点 + 步骤边界：任一位置出现该字符串不再算数（注释/别的 job 都不行）
      expect(block, `${name} 缺少 Job Summary 步骤`).toMatch(
        /^ {6}- name: 写入 Job Summary$/m,
      );
      expect(block, `${name} 的 Summary 不是 always 运行`).toMatch(
        /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m,
      );
      expect(block, `${name} 的 Summary 没写 GITHUB_STEP_SUMMARY`).toMatch(
        /^ {12}\} >> "\$GITHUB_STEP_SUMMARY"$/m,
      );
    }
    const bench = jobBlock("benchmark");
    // 播种时不能提示「请先播种」——那是反事实
    expect(bench).toContain('if [ "${{ inputs.update_baseline }}" = "true" ]');
    expect(bench).toContain("本次是播种");
    expect(bench).toContain("本次未与任何基线比较");
  });

  it("jobBlock 不把下一个 job 的注释算进当前 job（#421 评审 R4-1）", () => {
    // 下一个 job 前的 2 空格注释若被吞进上一块，「块内出现」就不等于「自己写了」
    for (const name of ["benchmark", "retest"]) {
      const block = jobBlock(name);
      expect(block, `${name} 块吞进了下一个 job 的注释`).not.toMatch(
        /^ {2}# .*job/m,
      );
    }
  });

  it("artifact 必须带上隐藏目录，且传不上去要报错", () => {
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

  it("工作流注释指向真实文档（CONTRIBUTING 的 prod 章节）", () => {
    expect(WORKFLOW).toContain("CONTRIBUTING.md");
    const doc = readFileSync("CONTRIBUTING.md", "utf8");
    expect(doc).toContain("### prod 构建口径");
    expect(doc).toContain("prod-ci-<os>");
    expect(doc).toContain("perf-prod-<profile>");
  });

  it("文档覆盖三个会导致误判的前提（#421 评审 R4-2）", () => {
    const doc = readFileSync("CONTRIBUTING.md", "utf8");
    // 1) 首次前提：dispatch 只认默认分支上已存在的工作流，分支试跑要 --ref
    expect(doc).toContain("workflow not found on the default branch");
    expect(doc).toContain("--ref");
    // 2) 基线身份是 profile × mode 的笛卡尔积（含 full/uncapped 这一格）
    expect(doc).toContain("prod-ci-<os>/full/uncapped/r3/");
    expect(doc).toContain("笛卡尔积");
    // 3) 播种 exit 2 时已测场景的基线照常写入（与 dev 同一纪律）
    expect(doc).toContain("逐场景写入");
    expect(doc).toContain("已测场景的基线照常");
  });
});

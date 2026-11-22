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
function stripTrailingComments(block: string, commentIndent: number): string {
  const commentRe = new RegExp(`^ {${commentIndent}}#`);
  const lines = block.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.trim() === "" || commentRe.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n");
}

/** 取某个 dispatch input 块（从 `      <name>:` 到下一个 6 空格输入或 `permissions:`），避免跨 input 误判 */
function inputBlock(name: string): string {
  const inputsStart = WORKFLOW.indexOf("\n    inputs:\n");
  expect(inputsStart, "找不到 inputs 块").toBeGreaterThan(-1);
  const permsStart = WORKFLOW.indexOf("\npermissions:", inputsStart);
  expect(permsStart, "找不到 permissions 块").toBeGreaterThan(inputsStart);
  const inputsSection = WORKFLOW.slice(inputsStart, permsStart);
  const anchor = `\n      ${name}:\n`;
  const start = inputsSection.indexOf(anchor);
  expect(start, `找不到 input：${name}`).toBeGreaterThan(-1);
  const rest = inputsSection.slice(start + 1);
  const next = rest.slice(1).search(/\n {6}[a-zA-Z0-9_-]+:\n/);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  return stripTrailingComments(block, 6);
}

/** 取某个 job 块（从 `  <name>:` 到下一个 job 或文件尾），避免跨 job 误判 */
function jobBlock(name: string): string {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  expect(start, `找不到 job：${name}`).toBeGreaterThan(-1);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-zA-Z0-9_-]+:\n/);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  return stripTrailingComments(block, 2);
}

/** 取某个 job 内的单个 step 块（仅截到下一个 6 空格 `- name:` / `- uses:`），避免被同 job 其他步骤满足 */
function stepBlock(job: string, stepName: string): string {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`^ {6}- name: ${escaped}$`, "m");
  const m = headerRe.exec(job);
  expect(m, `找不到步骤：${stepName}`).toBeTruthy();
  const rest = job.slice(m!.index);
  const next = rest.slice(1).search(/\n {6}- (?:name|uses): /);
  const block = next === -1 ? rest : rest.slice(0, next + 1);
  return stripTrailingComments(block, 6);
}

/** 取 `写入 Job Summary` 步骤中的 `final` 分支（`if [ -f .perf-output/report.md ]`）与 `handoff` 分支（`elif [ -f .perf-output/retest*.json ]`） */
function summaryBranches(summary: string): { finalBranch: string; handoffBranch: string } {
  const finalStart = summary.indexOf("if [ -f .perf-output/report.md ]; then\n");
  expect(finalStart, "Summary 缺少 report.md final 分支").toBeGreaterThan(-1);
  const elifMatch = /\n {10}elif \[ -f \.perf-output\/retest2?\.json \]; then\n/.exec(
    summary.slice(finalStart),
  );
  const elseIdx = summary.indexOf("\n          else\n", finalStart);
  expect(elseIdx, "Summary 缺少 else 兜底分支").toBeGreaterThan(finalStart);
  if (elifMatch) {
    const elifAbs = finalStart + elifMatch.index;
    return {
      finalBranch: summary.slice(finalStart, elifAbs),
      handoffBranch: summary.slice(elifAbs, elseIdx),
    };
  }
  return {
    finalBranch: summary.slice(finalStart, elseIdx),
    handoffBranch: "",
  };
}

/** 从 `finalBranch` 内切片出 `case "$COVERAGE"` `0/` 块，并进一步切出 `update_baseline == "true"` 的 `then` 与 `else` 块 */
function zeroCoverageIfElse(finalBranch: string): {
  caseBlock: string;
  thenBlock: string;
  elseBlock: string;
} {
  const caseStart = finalBranch.indexOf('case "$COVERAGE" in\n');
  expect(caseStart, "finalBranch 缺少 case \"$COVERAGE\" 块").toBeGreaterThan(-1);
  const caseEnd = finalBranch.indexOf("\n              esac\n", caseStart);
  expect(caseEnd, "finalBranch 缺少 esac").toBeGreaterThan(caseStart);
  const caseBlock = finalBranch.slice(caseStart, caseEnd);

  const ifMarker = 'if [ "${{ inputs.update_baseline }}" = "true" ]; then\n';
  const ifStart = caseBlock.indexOf(ifMarker);
  expect(ifStart, "0/N 分支缺少 update_baseline 判断").toBeGreaterThan(-1);
  const elseMarker = "\n                  else\n";
  const elseStart = caseBlock.indexOf(elseMarker, ifStart);
  expect(elseStart, "0/N 分支缺少 else").toBeGreaterThan(ifStart);
  const fiMarker = "\n                  fi\n";
  const fiStart = caseBlock.indexOf(fiMarker, elseStart);
  expect(fiStart, "0/N 分支缺少 fi").toBeGreaterThan(elseStart);

  return {
    caseBlock,
    thenBlock: caseBlock.slice(ifStart + ifMarker.length, elseStart),
    elseBlock: caseBlock.slice(elseStart + elseMarker.length, fiStart),
  };
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

/** 求值 `inputs.absolute && !inputs.update_baseline && whenTrue || whenFalse` */
function evalGhAbsolute(
  absolute: boolean,
  updateBaseline: boolean,
  whenTrue: string,
  whenFalse: string,
): string {
  const cond1 = absolute && !updateBaseline;
  const and = (a: boolean, b: string): boolean | string => (a ? b : a);
  const or = (x: boolean | string, y: string): boolean | string => (x ? x : y);
  return String(or(and(cond1, whenTrue), whenFalse));
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

  it("以生产构建口径运行，并逐 job 把档位/场景/播种/绝对判定接上（#421 评审 R5-1）", () => {
    const bench = jobBlock("benchmark");
    const retest = jobBlock("retest");
    const retest2 = jobBlock("retest2");

    // 三个 job 都必须明确下发 PERF_BUILD: prod，缺任一会让复测/确认轮静默退回 dev server
    for (const [name, block] of [
      ["benchmark", bench],
      ["retest", retest],
      ["retest2", retest2],
    ] as const) {
      expect(block, `${name} 缺少 PERF_BUILD: prod`).toMatch(/^\s+PERF_BUILD: prod$/m);
    }

    // 档位经「决定档位」step 落到 job outputs，并经 retest.outputs.profile 链式传递到 retest2
    expect(bench).toMatch(/^\s+PERF_PROFILE: \$\{\{ steps\.profile\.outputs\.value \}\}$/m);
    expect(bench).toMatch(/^\s{6}profile: \$\{\{ steps\.profile\.outputs\.value \}\}$/m);
    expect(bench).toMatch(/^\s+PERF_SCENARIO: \$\{\{ inputs\.scenario \}\}$/m);
    expect(retest).toMatch(/^\s+PERF_PROFILE: \$\{\{ needs\.benchmark\.outputs\.profile \}\}$/m);
    expect(retest).toMatch(/^\s{6}profile: \$\{\{ needs\.benchmark\.outputs\.profile \}\}$/m);
    expect(retest2).toMatch(/^\s+PERF_PROFILE: \$\{\{ needs\.retest\.outputs\.profile \}\}$/m);

    // 绝对判定入口：CI 无显示设备，必须同时按 uncapped 跑；且播种期 PERF_ABSOLUTE='0' 跳过绝对失败判定
    for (const [name, block] of [
      ["benchmark", bench],
      ["retest", retest],
      ["retest2", retest2],
    ] as const) {
      const absMatch = /^\s+PERF_ABSOLUTE: \$\{\{ inputs\.absolute && !inputs\.update_baseline && '([^']*)' \|\| '([^']*)' \}\}$/m.exec(
        block,
      );
      expect(absMatch, `${name} 的 PERF_ABSOLUTE 表达式缺失或格式不对`).toBeTruthy();
      const [, absTrue, absFalse] = absMatch as RegExpExecArray;
      // 4 组 (absolute, update_baseline) 组合求值校验：
      // 仅 (true, false) 开启绝对失败判定 '1'；其余（含播种期 true, true）全为 '0'
      expect(evalGhAbsolute(false, false, absTrue, absFalse)).toBe("0");
      expect(evalGhAbsolute(false, true, absTrue, absFalse)).toBe("0");
      expect(evalGhAbsolute(true, false, absTrue, absFalse)).toBe("1");
      expect(evalGhAbsolute(true, true, absTrue, absFalse)).toBe("0");

      const uncappedMatch = /^\s+PERF_UNCAPPED: \$\{\{ inputs\.absolute && '([^']*)' \|\| '([^']*)' \}\}$/m.exec(
        block,
      );
      expect(uncappedMatch, `${name} 的 PERF_UNCAPPED 表达式缺失或格式不对`).toBeTruthy();
      const [, uncTrue, uncFalse] = uncappedMatch as RegExpExecArray;
      expect(evalGhTernary(true, uncTrue, uncFalse)).toBe("1");
      expect(evalGhTernary(false, uncTrue, uncFalse)).toBe("");
    }
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

  it("artifact 上传名与下游下载名闭环（限定在下载/上传 stepBlock 内，#421 评审 2/Lens B）", () => {
    const benchUpload = stepBlock(jobBlock("benchmark"), "Upload perf output");
    const retestDownload = stepBlock(jobBlock("retest"), "下载首轮产物");
    const retestUpload = stepBlock(jobBlock("retest"), "Upload perf output（复测轮）");
    const retest2Download = stepBlock(jobBlock("retest2"), "下载复测产物");
    const retest2Upload = stepBlock(jobBlock("retest2"), "Upload perf output（确认轮）");

    expect(benchUpload).toMatch(
      /^\s+name: perf-prod-\$\{\{ steps\.profile\.outputs\.value \}\}$/m,
    );
    expect(retestDownload).toMatch(
      /^\s+name: perf-prod-\$\{\{ needs\.benchmark\.outputs\.profile \}\}$/m,
    );
    expect(retestUpload).toMatch(
      /^\s+name: perf-prod-\$\{\{ needs\.benchmark\.outputs\.profile \}\}-retest$/m,
    );
    expect(retest2Download).toMatch(
      /^\s+name: perf-prod-\$\{\{ needs\.retest\.outputs\.profile \}\}-retest$/m,
    );
    expect(retest2Upload).toMatch(
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

  it("每个 job 都有 always 的 Job Summary，且 0/N 横幅与移交取产物提示逐 job 到位（#421 评审 R4-1/R5-3）", () => {
    for (const [name, uploadSuffix, profileExpr] of [
      ["benchmark", "", "steps\\.profile\\.outputs\\.value"],
      ["retest", "-retest", "needs\\.benchmark\\.outputs\\.profile"],
      ["retest2", "-retest2", "needs\\.retest\\.outputs\\.profile"],
    ] as const) {
      const block = jobBlock(name);
      const summary = stepBlock(block, "写入 Job Summary");
      // 限定在 stepBlock("写入 Job Summary") 内：避免同 job 其他步骤的 `if: ${{ !cancelled() }}` 造成假绿灯
      expect(summary, `${name} 缺少 Job Summary 步骤`).toMatch(
        /^ {6}- name: 写入 Job Summary$/m,
      );
      expect(summary, `${name} 的 Summary 不是 always 运行`).toMatch(
        /^ {8}if: \$\{\{ !cancelled\(\) \}\}$/m,
      );
      expect(summary, `${name} 的 Summary 没写 GITHUB_STEP_SUMMARY`).toMatch(
        /^ {12}\} >> "\$GITHUB_STEP_SUMMARY"$/m,
      );

      // 将 Summary 拆成 final 分支与 handoff 分支分别断言，防止 elif 里的旧产物/下游产物名互相遮蔽
      const { finalBranch } = summaryBranches(summary);
      expect(finalBranch, `${name} 缺少 COVERAGE 提取`).toMatch(
        /^\s+COVERAGE=\$\(grep -oE '判定覆盖：\[0-9\]\+\/\[0-9\]\+'/m,
      );
      expect(finalBranch, `${name} final 分支缺少 report.md 正文输出`).toMatch(
        /^\s+cat \.perf-output\/report\.md$/m,
      );
      // 0/N 分流内部再拆 case + then/else：避免底部提示遮蔽 0/N 横幅，避免 if/else 反转
      const { caseBlock, thenBlock, elseBlock } = zeroCoverageIfElse(finalBranch);
      expect(caseBlock, `${name} 缺少 0/N 分流 case`).toMatch(/^\s+"判定覆盖：0\/"\*\)$/m);
      expect(thenBlock, `${name} 0/N 播种 then 分支缺少播种提示`).toMatch(
        /^\s+echo "> 📦 \*\*本次是播种\*\*/m,
      );
      expect(thenBlock, `${name} 0/N 播种 then 分支不应打印未比较警告`).not.toContain(
        "本次未与任何基线比较",
      );
      // 精确校验本 job artifact 名（带反引号界定符）存在于 0/N 播种提示的 then 块中
      expect(thenBlock, `${name} 0/N 播种 then 分支缺少本 job 精确 artifact 名`).toMatch(
        new RegExp(`\\\\\`perf-prod-\\$\\{\\{ ${profileExpr} \\}\\}${uploadSuffix}\\\\\``),
      );
      expect(elseBlock, `${name} 0/N 常规 else 分支缺少未比较警告`).toMatch(
        /^\s+echo "> ⚠️ \*\*本次未与任何基线比较\*\*/m,
      );
      expect(elseBlock, `${name} 0/N 常规 else 分支不应打印播种提示`).not.toContain(
        "本次是播种",
      );

      // 整段 final 分支（含 0/N 横幅与底部产物行）均只能引导取本 job 产物，不得误导取其他后缀
      const afterBanner = finalBranch.slice(finalBranch.indexOf("cat .perf-output/report.md"));
      expect(afterBanner, `${name} final 底部缺少本 job 精确 artifact 名`).toMatch(
        new RegExp(`\\\\\`perf-prod-\\$\\{\\{ ${profileExpr} \\}\\}${uploadSuffix}\\\\\``),
      );
      if (uploadSuffix === "") {
        expect(finalBranch, `${name} final 分支不应引导取 -retest / -retest2`).not.toMatch(
          new RegExp(`perf-prod-\\$\\{\\{ ${profileExpr} \\}\\}-retest`),
        );
      } else if (uploadSuffix === "-retest") {
        // 只检查「请取 / 取回」引导（底部会声明「上游 perf-prod-... 里是旧基线」）
        expect(thenBlock, `${name} 0/N 播种不应引导取上游无后缀或下游 -retest2`).not.toMatch(
          new RegExp(`取回 \\\\\`perf-prod-\\$\\{\\{ ${profileExpr} \\}\\}(?:\\\\\`|-retest2)`),
        );
        expect(afterBanner, `${name} final 底部不应引导取无后缀或 -retest2`).not.toMatch(
          new RegExp(`请取 \\\\\`perf-prod-\\$\\{\\{ ${profileExpr} \\}\\}(?:\\\\\`|-retest2)`),
        );
      } else if (uploadSuffix === "-retest2") {
        expect(thenBlock, `${name} 0/N 播种不应引导取无后缀或 -retest`).not.toMatch(
          new RegExp(`取回 \\\\\`perf-prod-\\$\\{\\{ ${profileExpr} \\}\\}(?:\\\\\`|-retest\\\\\`)`),
        );
        expect(afterBanner, `${name} final 底部不应引导取无后缀或 -retest`).not.toMatch(
          new RegExp(`请取 \\\\\`perf-prod-\\$\\{\\{ ${profileExpr} \\}\\}(?:\\\\\`|-retest\\\\\`)`),
        );
      }
    }

    // 移交分支必须警示播种取下游产物，并带 retest*.json 读取 + Array.isArray 守卫 + 非注释 echo
    const { handoffBranch: benchHandoff } = summaryBranches(
      stepBlock(jobBlock("benchmark"), "写入 Job Summary"),
    );
    expect(benchHandoff).toMatch(
      /^\s+node -e "let l=null;.*readFileSync\('\.perf-output\/retest\.json'.*Array\.isArray\(l\)&&l\.length/m,
    );
    expect(benchHandoff).toMatch(/^\s+echo "> ⚠️ 若本次是\*\*播种\*\*.*$/m);
    expect(benchHandoff).toMatch(/^\s+echo ">.*取错＝本次播种静默丢失/m);
    expect(benchHandoff).toMatch(
      /请取回 \\`perf-prod-\$\{\{ steps\.profile\.outputs\.value \}\}-retest\\`/,
    );
    expect(benchHandoff).toMatch(
      /本 job 的 \\`perf-prod-\$\{\{ steps\.profile\.outputs\.value \}\}\\` 里仍是旧基线/,
    );

    const { handoffBranch: retestHandoff } = summaryBranches(
      stepBlock(jobBlock("retest"), "写入 Job Summary"),
    );
    expect(retestHandoff).toMatch(
      /^\s+node -e "let l=null;.*readFileSync\('\.perf-output\/retest2\.json'.*Array\.isArray\(l\)&&l\.length/m,
    );
    expect(retestHandoff).toMatch(/^\s+echo "> ⚠️ 若本次是\*\*播种\*\*.*$/m);
    expect(retestHandoff).toMatch(/^\s+echo ">.*取错＝本次播种静默丢失/m);
    expect(retestHandoff).toMatch(
      /请取回 \\`perf-prod-\$\{\{ needs\.benchmark\.outputs\.profile \}\}-retest2\\`/,
    );
    expect(retestHandoff).toMatch(
      /本 job 的 \\`perf-prod-\$\{\{ needs\.benchmark\.outputs\.profile \}\}-retest\\` 里仍是旧基线/,
    );
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

  it("三个 Upload perf output 步骤都必须带上隐藏目录，且传不上去要报错（#421 评审 R5-1）", () => {
    const stepNames = [
      ["benchmark", "Upload perf output"],
      ["retest", "Upload perf output（复测轮）"],
      ["retest2", "Upload perf output（确认轮）"],
    ] as const;
    for (const [jobName, stepName] of stepNames) {
      const upload = stepBlock(jobBlock(jobName), stepName);
      expect(upload, `${jobName} 上传缺少 include-hidden-files: true`).toMatch(
        /^\s+include-hidden-files: true$/m,
      );
      expect(upload, `${jobName} 上传不允许 include-hidden-files: false`).not.toMatch(
        /include-hidden-files:\s*false/,
      );
      expect(upload, `${jobName} 上传缺少 if-no-files-found: error`).toMatch(
        /^\s+if-no-files-found: error$/m,
      );
    }
  });

  it("播种必须显式打勾，默认不重写既有基线（限定在 update_baseline 输入块内，#421 评审 R5-1）", () => {
    const block = inputBlock("update_baseline");
    expect(block).toMatch(/^\s+default: false$/m);
    expect(block).not.toMatch(/^\s+default: true$/m);
  });

  it("与 dev 通道共用测量队列；只读权限，不在 CI 里 push 基线（#421 Lens B）", () => {
    const concStart = WORKFLOW.indexOf("\nconcurrency:\n");
    expect(concStart, "缺少顶层 concurrency 块").toBeGreaterThan(-1);
    const concEnd = WORKFLOW.indexOf("\njobs:", concStart);
    const concBlock = WORKFLOW.slice(concStart + 1, concEnd);
    expect(concBlock).toMatch(/^ {2}group: benchmark$/m);
    expect(concBlock).toMatch(/^ {2}cancel-in-progress: false$/m);
    expect(concBlock).not.toMatch(/^ {2}cancel-in-progress: true$/m);

    expect(WORKFLOW).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(WORKFLOW).not.toMatch(/git push/);
  });

  it("工作流注释指向真实文档（CONTRIBUTING 的 prod 章节）", () => {
    expect(WORKFLOW).toContain("CONTRIBUTING.md");
    const doc = readFileSync("CONTRIBUTING.md", "utf8");
    expect(doc).toContain("### prod 构建口径");
    expect(doc).toContain("prod-ci-<os>");
    expect(doc).toContain("perf-prod-<profile>");
  });

  it("文档覆盖两阶段触发前提、笛卡尔积基线与播种 exit 2/uncapped 纪律（#421 评审 R5-2）", () => {
    const doc = readFileSync("CONTRIBUTING.md", "utf8");
    // 1) 两阶段前提：未合入 main 时即使带 --ref 也返回 404；合入后可用 --ref 试跑分支
    expect(doc).toContain("workflow not found on the default branch");
    expect(doc).toContain("即使显式传 `--ref <branch>` 同样返回");
    expect(doc).toContain("合入 `main` 之后");
    expect(doc).toContain("--ref");
    // 2) 基线身份是 profile × mode 的笛卡尔积（含 full/uncapped 这一格）
    expect(doc).toContain("prod-ci-<os>/full/uncapped/r3/");
    expect(doc).toContain("笛卡尔积");
    // 3) 播种 exit 2 时已测场景的基线照常写入（与 dev 同一纪律）；uncapped 播种跳过绝对失败判定
    expect(doc).toContain("逐场景写入");
    expect(doc).toContain("已测场景的基线照常");
    expect(doc).toContain("PERF_ABSOLUTE=0");
  });
});

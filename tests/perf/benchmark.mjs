#!/usr/bin/env node
// Benchmark 入口：两阶段编排 + 三态退出码（issue #216）
//
//   phase 1  playwright 全量跑 → raw 落盘 .perf-output/raw/
//   phase 2  report --phase=check → 产出「疑似回归场景」清单 retest.json
//   phase 3  清单非空 → 只跑清单里的场景，raw 落盘 .perf-output/raw-retest/
//   phase 4  report --phase=final → 合并两轮判定，输出对比表与退出码
//
// 为什么"复测"必须由本脚本编排而不是 report.mjs 自己触发：
// report 运行时 Playwright 已经退出、浏览器已关闭，report 没有任何复测能力。
//
// 退出码三态（刻意区分，防"假绿灯"）：
//   0 = 跑完且无确认回归（含仅 WARN / 首次运行无 baseline / baseline 失效）
//   1 = 跑完且回归复现（连续 2 次超阈值）
//   2 = 没测到（playwright 启动失败、场景缺失等 infra 故障）

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT_DIR = resolve(".perf-output");
const CONFIG = "tests/perf/playwright.perf.config.ts";
const PW_CLI = resolve("node_modules/@playwright/test/cli.js");

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      out[key] = value ?? "1";
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** 参数同时支持 argv 与环境变量：绕开 npm/pnpm 在 `--` 透传上的差异 */
const profile = args.profile ?? process.env.PERF_PROFILE ?? "quick";
const repeat = args.repeat ?? process.env.PERF_REPEAT ?? "";
const scenario = args.scenario ?? process.env.PERF_SCENARIO ?? "";
const updateBaseline =
  (args["update-baseline"] ?? process.env.PERF_UPDATE_BASELINE ?? "") === "1";
const port = args.port ?? process.env.PERF_PORT ?? "1420";

function runCommand(cmdArgs, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, cmdArgs, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", () => resolvePromise(1));
  });
}

function gitValue(cmd) {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/** 采集运行元信息写进报告，保证结果可追溯（同环境纵向对比的前提） */
async function collectMeta() {
  let chromium = "unknown";
  try {
    const { chromium: browserType } = await import("@playwright/test");
    chromium = browserType.executablePath();
  } catch {
    /* 拿不到就记 unknown，不因此让整条管线失败 */
  }
  return {
    gitSha: gitValue("git rev-parse HEAD").slice(0, 12),
    branch: gitValue("git rev-parse --abbrev-ref HEAD"),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    chromium,
    ci: process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true",
  };
}

function readRetestList() {
  const file = resolve(OUT_DIR, "retest.json");
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

async function main() {
  if (!existsSync(PW_CLI)) {
    console.error(`[perf] 未找到 Playwright CLI：${PW_CLI}`);
    process.exit(2);
  }

  const meta = await collectMeta();
  console.log(
    `[perf] profile=${profile} port=${port} env=${meta.ci ? "ci" : "local"} sha=${meta.gitSha}`,
  );

  // 元信息落盘，由 report.mjs 并入 latest.json：
  // 没有 git sha / 浏览器版本的结果无法追溯，也就无法支撑"同环境纵向对比"
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

  const baseEnv = {
    PERF_PROFILE: profile,
    PERF_PORT: port,
    ...(repeat ? { PERF_REPEAT: String(repeat) } : {}),
  };

  // 两个 raw 目录每轮都清空：
  // - raw-retest：残留样本会让"连续 2 次"判定读到上一轮的数据
  // - raw：否则本次没跑到的场景（被 --scenario 过滤掉、或已从 profiles 移除）
  //   会拿上一轮的旧采样参与比较，报表里出现一堆 0.0% 的假 PASS
  rmSync(resolve(OUT_DIR, "raw-retest"), { recursive: true, force: true });
  rmSync(resolve(OUT_DIR, "raw"), { recursive: true, force: true });

  const pwArgs = [PW_CLI, "test", "-c", CONFIG];

  const code1 = await runCommand(pwArgs, baseEnv);
  if (code1 !== 0) {
    console.error(
      `[perf] 测量阶段失败（playwright exit=${code1}）。未产出完整采样，按 infra 故障处理。`,
    );
    process.exit(2);
  }

  const checkCode = await runCommand(["tests/perf/report.mjs", "--phase=check"]);
  if (checkCode !== 0) {
    console.error(`[perf] check 阶段异常（exit=${checkCode}）`);
    process.exit(2);
  }

  // 复测清单始终生效，包括显式 --scenario 过滤的运行。
  // 早先这里写的是「显式过滤时不复测」，理由是被过滤的子集不是"疑似回归清单"——
  // 但 check 阶段本来就只评估了被过滤的子集，跳过复测只会让过滤运行永远拿不到
  // raw2 → 落成 WARN「未复测」→ exit 0，即"跑单个场景时永远看不到 FAIL"。
  // 复测阶段的 PERF_SCENARIO 由下面的调用覆盖为清单内容，用户过滤不会串到复测里。
  const retest = readRetestList();
  if (retest.length > 0) {
    console.log(`[perf] 复测 ${retest.length} 个场景：${retest.join(", ")}`);
    const retestCode = await runCommand(pwArgs, {
      ...baseEnv,
      PERF_SCENARIO: retest.join(","),
      PERF_RAW_DIR: ".perf-output/raw-retest",
    });
    if (retestCode !== 0) {
      // 复测跑挂既不是"有回归"也不是"没回归"：按 infra 故障处理，不做无根据的判定
      console.error(`[perf] 复测阶段失败（exit=${retestCode}），无法完成"连续 2 次"判定`);
      process.exit(2);
    }
  }

  const finalArgs = ["tests/perf/report.mjs", "--phase=final"];
  if (updateBaseline) finalArgs.push("--update-baseline=1");
  const finalCode = await runCommand(finalArgs);
  process.exit(finalCode);
}

main();

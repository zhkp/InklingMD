// 场景共用骨架：运行参数解析、raw 采样落盘、环境识别（issue #216）
//
// 参数同时支持 argv 与环境变量，是为了绕开 npm/pnpm 在 `--` 透传上的差异，
// 也让 CI 只需要设 env（benchmark.mjs 负责把 argv 转成 env 传给 playwright）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildFixture, fixtureHash, FIXTURE_VERSION } from "./fixtures";

/**
 * 档位配置的唯一数据源是 profiles.json：
 * 用 readFileSync 而不是 import，是因为 Playwright 以 ESM 加载 spec 时，
 * JSON import 需要 import attribute（Node 22 严格要求），而 .mjs 侧的 report/benchmark
 * 脚本也要读同一份配置——文件读取是两边都成立的最小公约数。
 */
interface ProfilesConfig {
  tiers: Record<string, number>;
  profiles: Record<string, string[]>;
  scenarios: string[];
  plainScenarios: string[];
}

const profiles: ProfilesConfig = JSON.parse(
  readFileSync(resolve("tests/perf/profiles.json"), "utf8"),
);

export type FixtureKind = "rich" | "plain";

export interface RunContext {
  profile: string;
  /** 当前 profile 要跑的档位，如 ["S","M"] */
  tiers: string[];
  /** 正式轮次（不含 warm-up） */
  rounds: number;
  /** warm-up 轮次，结果丢弃 */
  warmups: number;
  /** 复测阶段只跑这些场景 id；null 表示全跑 */
  only: string[] | null;
  updateBaseline: boolean;
}

export function readRunContext(): RunContext {
  const profile = process.env.PERF_PROFILE ?? "quick";
  const tierMap = profiles.profiles as Record<string, string[]>;
  const tiers = tierMap[profile] ?? tierMap.quick;

  const repeat = Number(process.env.PERF_REPEAT ?? "");
  const rounds =
    Number.isFinite(repeat) && repeat > 0 ? repeat : profile === "full" ? 3 : 1;

  const onlyRaw = process.env.PERF_SCENARIO ?? "";
  const only = onlyRaw
    ? onlyRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  return {
    profile,
    tiers,
    rounds,
    warmups: 1,
    only,
    updateBaseline: process.env.PERF_UPDATE_BASELINE === "1",
  };
}

/** 只有 open / scroll 跑纯文本对照（区分"文档长度"与"结构复杂度"） */
export function kindsFor(scenario: string): FixtureKind[] {
  return (profiles.plainScenarios as string[]).includes(scenario)
    ? ["rich", "plain"]
    : ["rich"];
}

export function tierLines(tier: string): number {
  const tiers = profiles.tiers as Record<string, number>;
  const lines = tiers[tier];
  if (!lines) throw new Error(`未知档位: ${tier}`);
  return lines;
}

/** 生成指定档位/类型的 fixture 及其指纹 */
export function fixtureFor(tier: string, kind: FixtureKind): {
  lines: number;
  content: string;
  hash: string;
  version: number;
} {
  const lines = tierLines(tier);
  const content = buildFixture({ lines, kind });
  return { lines, content, hash: fixtureHash(content), version: FIXTURE_VERSION };
}

/**
 * 环境标识：baseline 只在相同 env 之间比较。
 * 本地（dev 构建、有窗口焦点）与 CI（无头、共享 runner）的数值不可比，
 * 混用会让 baseline 彻底失去意义。
 */
export function detectEnv(): string {
  const ci = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
  if (!ci) return "local";
  return process.platform === "win32" ? "ci-windows" : "ci-ubuntu";
}

export interface RawFile {
  id: string;
  scenario: string;
  tier: string;
  kind: FixtureKind;
  env: string;
  profile: string;
  rounds: number;
  warmups: number;
  fixture: { version: number; hash: string; lines: number };
  /** 主指标样本数组（report 负责算 median/p95/max） */
  samples: Record<string, number[]>;
  /** 标量指标（计数、占比等），直接比较 */
  scalars: Record<string, number | null>;
}

/**
 * 落盘单份 raw 采样；report.mjs 扫描 .perf-output/raw/ 汇总。
 *
 * 目录可通过 PERF_RAW_DIR 覆盖：复测轮（phase 3）必须写到独立目录，
 * 否则会用同名文件覆盖首轮采样，"连续两次复现"就失去了第一次的原始数据。
 */
export function writeRawFile(raw: RawFile): void {
  const dir = resolve(process.env.PERF_RAW_DIR ?? ".perf-output/raw");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `${raw.id}.json`),
    JSON.stringify(raw, null, 2),
    "utf8",
  );
}

/** 场景是否应执行（复测阶段只跑清单里的 id） */
export function shouldRun(id: string, ctx: RunContext): boolean {
  return !ctx.only || ctx.only.includes(id);
}

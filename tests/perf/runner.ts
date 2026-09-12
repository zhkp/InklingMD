// 场景共用骨架：运行参数解析、raw 采样落盘、环境识别（issue #216）
//
// 参数同时支持 argv 与环境变量，是为了绕开 npm/pnpm 在 `--` 透传上的差异，
// 也让 CI 只需要设 env（benchmark.mjs 负责把 argv 转成 env 传给 playwright）。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildFixture,
  countLines,
  fixtureHash,
  FIXTURE_VERSION,
} from "./fixtures";

/**
 * 档位配置的唯一数据源是 profiles.json：
 * 用 readFileSync 而不是 import，是因为 Playwright 以 ESM 加载 spec 时，
 * JSON import 需要 import attribute（Node 22 严格要求），而 .mjs 侧的 report/benchmark
 * 脚本也要读同一份配置——文件读取是两边都成立的最小公约数。
 */
interface ProfilesConfig {
  tiers: Record<string, number>;
  profiles: Record<string, string[]>;
  /** 各档位的采样轮数（不含 warmup）；标量指标每轮一个值，轮数即其样本数 */
  rounds: Record<string, number>;
  scenarios: string[];
  plainScenarios: string[];
}

const profiles: ProfilesConfig = JSON.parse(
  readFileSync(resolve("tests/perf/profiles.json"), "utf8"),
);

export type FixtureKind = "rich" | "plain" | "custom";

/** 自定义文档（PERF_DOC_FILE）使用的虚拟档位：不按行数分档，整份文件即一档 */
export const CUSTOM_TIER = "C";

/**
 * 用户自带的压测文档路径（评审 P1-2）。
 * 设置后所有场景只跑这一份文档，不再跑生成档位与纯文本对照——
 * 用户关心的是"我手上这份压测文件滚起来顺不顺"，而不是合成 fixture。
 */
function customDocPath(): string | null {
  const raw = process.env.PERF_DOC_FILE;
  return raw && raw.trim() ? raw.trim() : null;
}

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
  const tiers = customDocPath()
    ? [CUSTOM_TIER]
    : (tierMap[profile] ?? tierMap.quick);

  // 采样轮数（不含 warmup）：标量指标每轮一个值，轮数决定它有几个样本。
  // quick 档从 1 提升到 2 的原因：rounds=1 时每个标量只有一个样本、没有任何平均，
  // 共享 runner 的抖动会直接顶到阈值上（实测同一份代码 longTaskMs 就能涨 35%）。
  const repeat = Number(process.env.PERF_REPEAT ?? "");
  const roundsByProfile = profiles.rounds as Record<string, number>;
  const configured = roundsByProfile[profile];
  const rounds =
    Number.isFinite(repeat) && repeat > 0
      ? repeat
      : (configured ?? (profile === "full" ? 3 : 2));

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
  if (customDocPath()) return ["custom"];
  return (profiles.plainScenarios as string[]).includes(scenario)
    ? ["rich", "plain"]
    : ["rich"];
}

/**
 * 帧预算（ms）：判定"这一帧有没有掉"的基准。
 * 60Hz = 16.7，120Hz = 8.3。headless 下 vsync 锁 60Hz，帧间隔中位数恒为 ~16.7ms，
 * 因此高刷目标必须配合 PERF_HEADED=1（或 PERF_UNCAPPED=1）才有意义。
 */
export function frameBudgetMs(): number {
  const raw = Number(process.env.PERF_FRAME_BUDGET_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 16.7;
}

/** 测量运行模式：决定帧间隔到底反映"显示器刷新节拍"还是"单帧真实工作耗时" */
export type PerfMode = "uncapped" | "headed" | "headless";

export function detectMode(): PerfMode {
  if (process.env.PERF_UNCAPPED === "1") return "uncapped";
  if (process.env.PERF_HEADED === "1") return "headed";
  return "headless";
}

/**
 * 本次测量是否允许产出**绝对阈值判定**（帧预算目标是否达标）。
 *
 * 为什么不能默认开启（复审发现的问题）：headless 下 vsync 锁 60Hz，帧间隔反映的是
 * 显示器节拍而非单帧工作耗时——绝对结论衡量的是"这台机器此刻忙不忙"，不是代码质量。
 * 一旦默认开启，本地/CI 的**首次运行**（无 baseline、无代码变更）就会因为
 * jankRate 贴线而打印「回归确认」并以 exit 1 结束，与真实回归在退出码层面完全无法区分。
 *
 * 策略：
 * - PERF_ABSOLUTE=1 → 强制开启（含 headless，用于复现/调试）
 * - PERF_ABSOLUTE=0 → 强制关闭（含 headed）
 * - 未设置（或空串）→ 仅在 uncapped / headed 下默认开启
 *
 * 判定结果随 raw 一起落盘（见 writeRawFile），因此 report.mjs 独立复算时不会因
 * 环境变量丢失而静默翻转结论。
 */
export function absoluteEligible(): boolean {
  const flag = process.env.PERF_ABSOLUTE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  const mode = detectMode();
  return mode === "uncapped" || mode === "headed";
}

export function tierLines(tier: string): number {
  const tiers = profiles.tiers as Record<string, number>;
  const lines = tiers[tier];
  if (!lines) throw new Error(`未知档位: ${tier}`);
  return lines;
}

/** 生成指定档位/类型的 fixture 及其指纹 */
export function fixtureFor(
  tier: string,
  kind: FixtureKind,
): {
  lines: number;
  content: string;
  hash: string;
  version: number;
  source: string;
} {
  const docPath = customDocPath();
  if (kind === "custom" || tier === CUSTOM_TIER) {
    if (!docPath) throw new Error("custom 档位需要设置 PERF_DOC_FILE");
    // 读用户自带文档：行数与指纹都取自真实文件内容，
    // 于是"换了一份压测文档"会自然触发 baseline 失效（hash 不匹配）
    const content = readFileSync(resolve(docPath), "utf8");
    return {
      lines: countLines(content),
      content,
      hash: fixtureHash(content),
      version: FIXTURE_VERSION,
      source: docPath,
    };
  }
  const lines = tierLines(tier);
  const content = buildFixture({ lines, kind });
  return {
    lines,
    content,
    hash: fixtureHash(content),
    version: FIXTURE_VERSION,
    source: `generated:${kind}`,
  };
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
  /** 测量运行模式，由 writeRawFile 自动补齐 */
  mode?: PerfMode;
  /** 本次测量是否产出绝对阈值判定，由 writeRawFile 自动补齐 */
  absoluteEligible?: boolean;
  fixture: { version: number; hash: string; lines: number; source: string };
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
 *
 * mode 与 absoluteEligible 在此统一写入，调用方无需各自传递：
 * 判定所依赖的环境事实必须随样本落盘，否则 report 换个环境复算就会变结论。
 */
export function writeRawFile(raw: RawFile): void {
  const dir = resolve(process.env.PERF_RAW_DIR ?? ".perf-output/raw");
  mkdirSync(dir, { recursive: true });
  const payload: RawFile = {
    ...raw,
    mode: raw.mode ?? detectMode(),
    absoluteEligible: raw.absoluteEligible ?? absoluteEligible(),
  };
  writeFileSync(
    resolve(dir, `${payload.id}.json`),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
}

/**
 * 为 search 场景挑选一个"文档里确实存在"的关键词。
 *
 * 不能用硬编码关键词（如 "bench-"）：那只保证在生成 fixture 里命中，
 * 用户自带压测文档（PERF_DOC_FILE）里没有这个词时会搜索无结果 → 场景超时。
 * 实测踩过：md_editor_stress_test.md 里没有 "bench-"，search-C-custom 直接跑挂。
 */
export function pickSearchKeyword(content: string): string {
  if (content.includes("bench-")) return "bench-";

  // 跳过 YAML frontmatter：它只存在于源码里，编辑器渲染后不参与文本搜索。
  // 实测踩过：md_editor_stress_test.md 的 frontmatter 里有 "title:"，
  // 选中它会导致搜索永远 0 命中。
  let body = content;
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(body);
  if (frontmatter) body = body.slice(frontmatter[0].length);

  for (const line of body.split("\n")) {
    // 去掉 Markdown 前缀（标题/引用/列表/围栏/表格）与可能影响匹配的标记符号
    const text = line
      .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.|```|~~~|\|)+\s*/, "")
      .replace(/[|`*_~[\]()]/g, " ")
      .trim();
    if (text.length >= 6) return text.slice(0, 6);
  }
  // 兜底：整篇没有 >= 6 字符的文本行时，取前 4 个字符
  return body.slice(0, 4) || "a";
}

/** 场景是否应执行（复测阶段只跑清单里的 id） */
export function shouldRun(id: string, ctx: RunContext): boolean {
  return !ctx.only || ctx.only.includes(id);
}

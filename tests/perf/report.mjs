#!/usr/bin/env node
// 统计、baseline 比较与报告输出（issue #216）
//
// 两种运行模式：
//   --phase=check  比 baseline，把「超阈值场景 id」写进 .perf-output/retest.json（供复测）
//   --phase=final  合并首轮与复测轮，出最终判定与退出码
//
// 判定语义（issue 原文「劣化超阈值且连续 2 次复现才 fail」的可执行化）：
//   首轮超阈值 → 复测该场景一轮 → 复测仍超阈值 = FAIL（回归复现）；
//   复测回落 = WARN（抖动），不计 fail。
// 注意不是「把两个 run 的样本混在一起算中位数」——混样会让一次好的复测
// 把首轮的回归稀释掉，与"复现"语义相反。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const OUT_DIR = resolve(".perf-output");
const RAW_DIR = resolve(process.env.PERF_RAW_DIR ?? ".perf-output/raw");
const RETEST_DIR = resolve(".perf-output/raw-retest");
const BASE_DIR = resolve(".perf-baseline");

/** 默认劣化阈值（%）；可按指标覆盖 */
const DEFAULT_PCT = 15;

/** p95 天然比中位数抖，在基础阈值上放宽（评审 P1-3：p95 也要参与判定） */
const P95_EXTRA_PCT = 10;

/**
 * 绝对阈值（不依赖 baseline，首次运行也能判；评审 P1-1）：
 * 相对比较只能回答「有没有比上次差」，回答不了「120fps 目标达没达到」。
 * - 帧间隔 p95 不得超过 2 × 帧预算（60Hz → 33.4ms，120Hz → 16.6ms）
 * - 掉帧率不得超过该百分比
 *
 * 注意：绝对阈值带有**环境属性**——它衡量的是"这份文档在当前机器上能否跑满帧预算"。
 * 无 GPU 的共享 CI runner 上，大档位掉帧是真实结论（实测 M 档 jankRate 21.7%），
 * 但它说的是 runner 而不是用户机器。团队若觉得 CI 上噪声大于价值，可用 PERF_ABSOLUTE=0 关闭
 * （关闭后仍保留相对回归判定）。
 */
const ABSOLUTE_ENABLED = process.env.PERF_ABSOLUTE !== "0";
const JANK_RATE_LIMIT_PCT = Number(process.env.PERF_JANK_RATE_LIMIT ?? 10);
const P95_BUDGET_FACTOR = 2;

/**
 * 指标阈值覆盖：
 * - longTaskCount 基数常常是 0，纯百分比会无限放大，因此要求「+20% 且绝对值 +5」同时成立
 * - cls 基数极小（千分位），用绝对增量判定
 * - heapDeltaMB 波动天然大，放宽到 25%
 * - 掉帧相关指标基数通常是 0，用绝对增量门槛
 */
const METRIC_RULES = {
  longTaskCount: { pct: 20, absMin: 5 },
  longFrameCount: { pct: 20, absMin: 3 },
  jankCount: { pct: 50, absMin: 6 },
  jankRatePct: { pct: 50, absMin: 5 },
  cls: { abs: 0.02 },
  heapDeltaMB: { pct: 25 },
};

/** 只比较这些标量；matchCount / frameBudgetMs / step 之类不是性能指标，不参与判定 */
const COMPARED_SCALARS = [
  "longTaskCount",
  "longTaskMs",
  "longFrameCount",
  "jankCount",
  "jankRatePct",
  "cls",
  "heapDeltaMB",
];

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] ?? "1";
  }
  return out;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function p95(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
}

const round = (v) => Math.round(v * 100) / 100;

function statsFor(samples) {
  return {
    median: round(median(samples)),
    p95: round(p95(samples)),
    max: round(samples.length ? Math.max(...samples) : 0),
    n: samples.length,
  };
}

/** 把 raw 目录读成 id → raw 的映射 */
function readRun(dir) {
  const map = new Map();
  if (!existsSync(dir)) return map;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    map.set(raw.id, raw);
  }
  return map;
}

/** baseline 路径：本地基线隔离在 local/ 下，避免与 CI 基线互相污染 */
function baselinePath(env, profile, id) {
  const prefix = env === "local" ? "local/" : "";
  return resolve(BASE_DIR, `${prefix}${profile}/${id}.json`);
}

function readBaseline(env, profile, id) {
  const file = baselinePath(env, profile, id);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

/** baseline 是否可比较：env / profile / fixture 任一不匹配即失效 */
function baselineState(raw, baseline) {
  if (!baseline) return { ok: false, reason: "NEW" };
  if (baseline.env !== raw.env) {
    return { ok: false, reason: `ENV_MISMATCH(baseline=${baseline.env}, now=${raw.env})` };
  }
  if (baseline.profile !== raw.profile) {
    return {
      ok: false,
      reason: `PROFILE_MISMATCH(baseline=${baseline.profile}, now=${raw.profile})`,
    };
  }
  const bf = baseline.fixture;
  if (!bf || bf.version !== raw.fixture.version || bf.hash !== raw.fixture.hash) {
    return { ok: false, reason: "FIXTURE_CHANGED" };
  }
  return { ok: true, reason: "OK" };
}

/**
 * 取 baseline 里某指标的可比值。
 * 样本类指标存的是统计对象（用 median），标量类指标也走 buildStats 存成对象，
 * 直接当数字用会得到 [object Object] → NaN → 永远判 PASS。这里统一取 median。
 */
function baselineValue(baseline, metric) {
  const entry = baseline.metrics?.[metric];
  if (entry === undefined || entry === null) return undefined;
  return typeof entry === "number" ? entry : entry.median;
}

/** 取 baseline 里某样本指标的 p95 */
function baselineP95(baseline, metric) {
  const entry = baseline.metrics?.[metric];
  if (!entry || typeof entry === "number") return undefined;
  return entry.p95;
}

/** 取指标对应的阈值规则（`xxx.p95` 行在基础规则上放宽） */
function ruleFor(metric) {
  if (METRIC_RULES[metric]) return METRIC_RULES[metric];
  if (metric.endsWith(".p95")) {
    const base = METRIC_RULES[metric.slice(0, -4)] ?? { pct: DEFAULT_PCT };
    return { pct: (base.pct ?? DEFAULT_PCT) + P95_EXTRA_PCT };
  }
  return { pct: DEFAULT_PCT };
}

/** 单指标是否劣化超阈值 */
function isOver(metric, current, base) {
  const rule = ruleFor(metric);
  const delta = current - base;
  if (rule.abs !== undefined) return delta > rule.abs;
  if (base === 0) {
    // 基数为 0 时百分比无意义：退化为绝对增量门槛
    return delta > (rule.absMin ?? 0.5);
  }
  const pctOk = delta / base > rule.pct / 100;
  if (rule.absMin !== undefined) return pctOk && delta >= rule.absMin;
  return pctOk;
}

/**
 * 绝对阈值判定：不看 baseline，直接对照"帧预算"这一硬目标。
 * 没有它，「用户本机 120fps 流畅滚动」这个场景永远只能验证"没比上次差"。
 */
function absoluteRows(raw) {
  const rows = [];
  if (!ABSOLUTE_ENABLED) return rows;
  const budget = raw.scalars?.frameBudgetMs;
  if (raw.scenario !== "scroll" || typeof budget !== "number") return rows;

  const frameSamples = raw.samples?.frameMs ?? [];
  if (frameSamples.length > 0) {
    const stats = statsFor(frameSamples);
    const limit = round(budget * P95_BUDGET_FACTOR);
    rows.push({
      metric: "frameMs.p95(绝对)",
      base: `≤${limit}`,
      cur: stats.p95,
      p95: null,
      max: stats.max,
      n: stats.n,
      over: stats.p95 > limit,
      limit,
    });
  }

  const jankRate = raw.scalars?.jankRatePct;
  if (typeof jankRate === "number") {
    rows.push({
      metric: "jankRatePct(绝对)",
      base: `≤${JANK_RATE_LIMIT_PCT}`,
      cur: jankRate,
      p95: null,
      max: null,
      n: null,
      over: jankRate > JANK_RATE_LIMIT_PCT,
      limit: JANK_RATE_LIMIT_PCT,
    });
  }
  return rows;
}

/** 计算一次 run 相对 baseline 的所有指标判定 */
function compareRun(raw, baseline) {
  const rows = [];
  if (!baseline) return rows;

  for (const [metric, samples] of Object.entries(raw.samples ?? {})) {
    const cur = statsFor(samples);
    const base = baselineValue(baseline, metric);
    if (base === undefined || base === null) continue;
    rows.push({
      metric,
      base,
      cur: cur.median,
      p95: cur.p95,
      max: cur.max,
      n: cur.n,
      over: isOver(metric, cur.median, base),
    });

    // p95 单独成行参与判定（评审 P1-3）：
    // 「每 10 帧一次 40ms 尖刺」这种回归在 median 上完全看不出来，只有尾部指标能捕获
    const baseP95 = baselineP95(baseline, metric);
    if (baseP95 !== undefined && baseP95 !== null) {
      rows.push({
        metric: `${metric}.p95`,
        base: baseP95,
        cur: cur.p95,
        p95: null,
        max: cur.max,
        n: cur.n,
        over: isOver(`${metric}.p95`, cur.p95, baseP95),
      });
    }
  }

  for (const metric of COMPARED_SCALARS) {
    if (!(metric in (raw.scalars ?? {}))) continue;
    const base = baselineValue(baseline, metric);
    if (base === undefined || base === null) continue;
    const cur = raw.scalars[metric];
    rows.push({
      metric,
      base,
      cur,
      p95: null,
      max: null,
      n: null,
      over: isOver(metric, cur, base),
    });
  }
  return rows;
}

function buildStats(raw) {
  const metrics = {};
  for (const [metric, samples] of Object.entries(raw.samples ?? {})) {
    metrics[metric] = statsFor(samples);
  }
  for (const metric of COMPARED_SCALARS) {
    if (metric in (raw.scalars ?? {})) {
      const v = raw.scalars[metric];
      metrics[metric] = { median: v, p95: null, max: null, n: null, scalar: true };
    }
  }
  return metrics;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const phase = args.phase === "check" ? "check" : "final";

  const run1 = readRun(RAW_DIR);
  const run2 = phase === "final" ? readRun(RETEST_DIR) : new Map();
  if (run1.size === 0) {
    console.error("[perf] 未找到任何 raw 采样（.perf-output/raw/ 为空）");
    process.exit(2);
  }

  const results = [];
  const retest = [];

  for (const [id, raw] of run1) {
    const env = raw.env;
    const profile = raw.profile;
    const baseline = readBaseline(env, profile, id);
    const state = baselineState(raw, baseline);

    // 相对（对 baseline）+ 绝对（对帧预算硬目标）两路判定并行
    const rows1 = [
      ...(state.ok ? compareRun(raw, baseline) : []),
      ...absoluteRows(raw),
    ];
    const raw2 = run2.get(id);
    const rows2 = raw2
      ? [
          ...(state.ok ? compareRun(raw2, baseline) : []),
          ...absoluteRows(raw2),
        ]
      : [];

    const overMetrics = rows1.filter((r) => r.over).map((r) => r.metric);
    if (phase === "check" && overMetrics.length > 0) retest.push(id);

    // 最终判定：首轮超阈值 + 复测仍超阈值 = FAIL；首轮超但复测回落 = WARN
    const verdicts = [];
    for (const row of rows1) {
      const second = rows2.find((r) => r.metric === row.metric);
      if (!row.over) {
        verdicts.push({ ...row, verdict: "PASS" });
        continue;
      }
      if (!raw2) {
        // 没有复测数据（例如复测轮未覆盖）：只报 WARN，不把单次抖动当回归
        verdicts.push({ ...row, verdict: "WARN", note: "未复测" });
        continue;
      }
      verdicts.push({
        ...row,
        verdict: second && second.over ? "FAIL" : "WARN",
        retest: second ? second.cur : null,
        note: second && second.over ? "复测仍超阈值" : "复测回落（抖动）",
      });
    }

    // 更新 baseline：优先用该场景最新一轮的数据（有复测轮则用复测轮）
    if (args["update-baseline"] === "1" || args["update-baseline"] === "true") {
      const source = raw2 ?? raw;
      const file = baselinePath(env, profile, id);
      ensureDir(resolve(file, ".."));
      writeFileSync(
        file,
        JSON.stringify(
          {
            schemaVersion: 1,
            env,
            profile,
            scenario: source.scenario,
            tier: source.tier,
            kind: source.kind,
            rounds: source.rounds,
            fixture: source.fixture,
            metrics: buildStats(source),
            updatedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
    }

    results.push({
      id,
      scenario: raw.scenario,
      tier: raw.tier,
      kind: raw.kind,
      env,
      profile,
      baselineState: state.reason,
      metrics: verdicts,
      overMetrics,
    });
  }

  ensureDir(OUT_DIR);

  if (phase === "check") {
    writeFileSync(
      resolve(OUT_DIR, "retest.json"),
      JSON.stringify(retest, null, 2),
      "utf8",
    );
    console.log(
      retest.length > 0
        ? `[perf] check：${retest.length} 个场景疑似回归，需复测 → ${retest.join(", ")}`
        : "[perf] check：未发现超阈值场景，无需复测",
    );
    process.exit(0);
  }

  const failed = results.filter((r) => r.metrics.some((m) => m.verdict === "FAIL"));
  const warned = results.filter((r) => r.metrics.some((m) => m.verdict === "WARN"));

  let runMeta = null;
  const metaFile = resolve(OUT_DIR, "meta.json");
  if (existsSync(metaFile)) {
    try {
      runMeta = JSON.parse(readFileSync(metaFile, "utf8"));
    } catch {
      runMeta = null;
    }
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    phase: "final",
    run: runMeta,
    profile: [...run1.values()][0].profile,
    env: [...run1.values()][0].env,
    summary: {
      scenarios: results.length,
      failed: failed.length,
      warned: warned.length,
    },
    results,
  };
  writeFileSync(resolve(OUT_DIR, "latest.json"), JSON.stringify(payload, null, 2), "utf8");

  const lines = [];
  lines.push("# 性能 Benchmark 报告");
  lines.push("");
  lines.push(
    `> 运行时：Playwright chromium + vite dev server（未压缩、含 HMR）。**绝对值不代表生产构建**，仅用于同环境纵向对比。`,
  );
  lines.push("");
  lines.push(`- env：${payload.env}　profile：${payload.profile}　生成时间：${payload.generatedAt}`);
  if (runMeta) {
    lines.push(
      `- git：${runMeta.gitSha}@${runMeta.branch}　node：${runMeta.nodeVersion}　平台：${runMeta.platform}/${runMeta.arch}`,
    );
  }
  lines.push(`- 场景数：${results.length}　FAIL：${failed.length}　WARN：${warned.length}`);
  if (ABSOLUTE_ENABLED) {
    lines.push(
      `- 绝对阈值已启用：帧间隔 p95 ≤ ${P95_BUDGET_FACTOR}× 帧预算、掉帧率 ≤ ${JANK_RATE_LIMIT_PCT}%（带环境属性，无 GPU 的 CI 上大档位掉帧属真实结论；可用 PERF_ABSOLUTE=0 关闭）`,
    );
  } else {
    lines.push(
      "- 绝对阈值已关闭（PERF_ABSOLUTE=0）：本次只做相对回归判定。绝对结论请在本地用 PERF_HEADED=1 或 PERF_UNCAPPED=1 获取",
    );
  }
  lines.push("");
  lines.push("| 场景 | 指标 | baseline | 本次 | 复测 | 变化 | 判定 |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of results) {
    if (r.metrics.length === 0) {
      lines.push(`| ${r.id} | — | — | — | — | — | ${r.baselineState} |`);
      continue;
    }
    for (const m of r.metrics) {
      const delta =
        typeof m.base !== "number" || m.base === 0
          ? "—"
          : `${(((m.cur - m.base) / m.base) * 100).toFixed(1)}%`;
      lines.push(
        `| ${r.id} | ${m.metric} | ${m.base} | ${m.cur} | ${m.retest ?? "—"} | ${delta} | ${m.verdict}${
          m.note ? `（${m.note}）` : ""
        } |`,
      );
    }
  }
  lines.push("");
  writeFileSync(resolve(OUT_DIR, "report.md"), lines.join("\n"), "utf8");
  console.log(lines.join("\n"));

  if (failed.length > 0) {
    console.error(
      `\n[perf] 回归确认（连续 2 次超阈值）：${failed.map((f) => f.id).join(", ")}`,
    );
    process.exit(1);
  }
  if (warned.length > 0) {
    console.log(`\n[perf] 疑似回归但复测回落（抖动）：${warned.map((w) => w.id).join(", ")}`);
  }
  process.exit(0);
}

main();

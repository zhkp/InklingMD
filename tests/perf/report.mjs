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
import { baselineComparability } from "./comparability.js";
import {
  COMPARED_SCALARS,
  isOver,
  isPrimary,
  median,
  NOISE_MIN_POINTS,
  NOISE_SIGMA,
  noiseFor,
  referenceValue,
  requiresPrimaryCorroboration,
  suppressionReason,
} from "./judgment.js";

// 三个目录都可用环境变量覆盖。RAW_DIR 原本就支持（复测轮要写到独立目录，
// 否则同名文件会覆盖首轮采样）；OUT_DIR / RETEST_DIR 一并开放，是为了让端到端测试
// 能在临时目录里跑完整两阶段流转，不污染真实 .perf-output。
const OUT_DIR = resolve(process.env.PERF_OUT_DIR ?? ".perf-output");
const RAW_DIR = resolve(process.env.PERF_RAW_DIR ?? ".perf-output/raw");
const RETEST_DIR = resolve(process.env.PERF_RETEST_DIR ?? ".perf-output/raw-retest");
const BASE_DIR = resolve(".perf-baseline");

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
/**
 * 绝对判定的启用条件：**以测量时记录的 `absoluteEligible` 为准**。
 *
 * 为什么不直接读环境变量（复审发现的缺陷）：绝对结论只在 uncapped / headed 下有意义，
 * 若按"未设置即开启"处理，headless 的首次运行（无 baseline、无代码变更）也会因 jankRate 贴线
 * 而打印「回归确认」+ exit 1，与真实回归在退出码层面无法区分。
 *
 * 判定随 raw 落盘后，report 无论怎么被单独复算都不会静默翻转结论；
 * 同时保留双向强制覆盖，便于对既有 raw 复算或调试：
 * - PERF_ABSOLUTE=1 → 强制开启（含 headless）
 * - PERF_ABSOLUTE=0 → 强制关闭
 */
function absoluteEnabledFor(raw) {
  const flag = process.env.PERF_ABSOLUTE;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return raw.absoluteEligible === true;
}
const JANK_RATE_LIMIT_PCT = Number(process.env.PERF_JANK_RATE_LIMIT ?? 10);
const P95_BUDGET_FACTOR = 2;

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] ?? "1";
  }
  return out;
}

// median 来自 judgment.js（与判定层共用同一定义，避免多处实现漂移）

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

// 基线可比性策略在 ./comparability.js（env / profile / mode / rounds / fixture 五维），
// 抽成独立模块是为了让单测直接断言线上实现，而不是它的副本。

/**
 * 取 baseline 里某指标的可比值。
 * 样本类指标存的是统计对象（用 median），标量类指标也走 buildStats 存成对象，
 * 直接当数字用会得到 [object Object] → NaN → 永远判 PASS。这里统一取 median。
 */
/** 取 baseline 里某指标的参考值（历史足够时用历史中位数，见 judgment.referenceValue） */
function baselineValue(baseline, metric) {
  const entry = baseline.metrics?.[metric];
  if (entry === undefined || entry === null) return undefined;
  if (typeof entry === "number") return entry;
  return referenceValue(entry, "median");
}

/** 取 baseline 里某样本指标的 p95 参考值（同样支持滚动参考） */
function baselineP95(baseline, metric) {
  const entry = baseline.metrics?.[metric];
  if (!entry || typeof entry === "number") return undefined;
  return referenceValue(entry, "p95");
}

/**
 * 绝对阈值判定：不看 baseline，直接对照"帧预算"这一硬目标。
 * 没有它，「用户本机 120fps 流畅滚动」这个场景永远只能验证"没比上次差"。
 */
function absoluteRows(raw) {
  const rows = [];
  if (!absoluteEnabledFor(raw)) return rows;
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
      absolute: true,
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
      absolute: true,
    });
  }
  return rows;
}

/** 计算一次 run 相对 baseline 的所有指标判定 */
function compareRun(raw, baseline) {
  const rows = [];
  if (!baseline) return rows;

  /**
   * 噪声门槛（3σ）：由基线历史（同一环境、同一 fixture 的多次运行）估计。
   * 历史不足时返回 null → 判定退化为"百分比 + 绝对地板"。
   * 被噪声抑制的行不是 PASS（它确实动了），而是 WARN「变化在运行噪声内」。
   */
  const pushRow = (row, entry, statistic) => {
    const noise = noiseFor(entry, statistic);
    rows.push({
      ...row,
      noise,
      historyPoints: (statistic === "p95" ? entry?.historyP95 : entry?.history)?.length ?? 0,
      // 过了相对阈值但被绝对地板/噪声门槛挡下：不是 PASS，需要显式标注原因
      suppressed: suppressionReason(row.metric, row.cur, row.base, noise),
    });
  };

  for (const [metric, samples] of Object.entries(raw.samples ?? {})) {
    const cur = statsFor(samples);
    const entry = baseline.metrics?.[metric];
    const base = baselineValue(baseline, metric);
    if (base === undefined || base === null) continue;
    pushRow(
      {
        metric,
        base,
        cur: cur.median,
        p95: cur.p95,
        max: cur.max,
        n: cur.n,
        over: isOver(metric, cur.median, base, noiseFor(entry, "median")),
      },
      entry,
      "median",
    );

    // p95 单独成行参与判定（评审 P1-3）：
    // 「每 10 帧一次 40ms 尖刺」这种回归在 median 上完全看不出来，只有尾部指标能捕获
    const baseP95 = baselineP95(baseline, metric);
    if (baseP95 !== undefined && baseP95 !== null) {
      pushRow(
        {
          metric: `${metric}.p95`,
          base: baseP95,
          cur: cur.p95,
          p95: null,
          max: cur.max,
          n: cur.n,
          over: isOver(`${metric}.p95`, cur.p95, baseP95, noiseFor(entry, "p95")),
        },
        entry,
        "p95",
      );
    }
  }

  for (const metric of COMPARED_SCALARS) {
    if (!(metric in (raw.scalars ?? {}))) continue;
    const entry = baseline.metrics?.[metric];
    const base = baselineValue(baseline, metric);
    if (base === undefined || base === null) continue;
    const cur = raw.scalars[metric];
    pushRow(
      {
        metric,
        base,
        cur,
        p95: null,
        max: null,
        n: null,
        over: isOver(metric, cur, base, noiseFor(entry, "median")),
      },
      entry,
      "median",
    );
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

/**
 * 基线历史保留的最近运行数。噪声门槛（3σ）与滚动参考值都依赖它：
 * 点越多，σ 越接近真实的运行间漂移；但太旧的点会把"环境已经变了"混进来。
 */
const HISTORY_MAX = 8;

/** 追加一次运行的聚合值到历史序列（旧基线无 history 时用它的点值起头） */
function appendHistory(previousSeries, value, previousValue) {
  const base = Array.isArray(previousSeries)
    ? previousSeries
    : typeof previousValue === "number"
      ? [previousValue]
      : [];
  return [...base, value].slice(-HISTORY_MAX);
}

/**
 * 给每个指标补上 history / historyP95（逐次运行的聚合值）。
 *
 * 只有**同一份 fixture** 的历史才能合并——换了文档，历史就测的不是同一个对象。
 * fixture 变了则从本次重新起头（等价于重建基线）。
 */
function withHistory(stats, previous, source) {
  // schemaVersion < 2 的旧基线没有历史序列，从本次重新起头（也避免把同一个点重复计入）
  const comparable =
    previous?.schemaVersion === 2 &&
    previous.fixture &&
    previous.fixture.version === source.fixture.version &&
    previous.fixture.hash === source.fixture.hash;
  const out = {};
  for (const [metric, entry] of Object.entries(stats)) {
    const prevEntry = comparable ? previous.metrics?.[metric] : undefined;
    out[metric] = {
      ...entry,
      history: appendHistory(prevEntry?.history, entry.median, prevEntry?.median),
      ...(typeof entry.p95 === "number"
        ? {
            historyP95: appendHistory(
              prevEntry?.historyP95,
              entry.p95,
              prevEntry?.p95 ?? undefined,
            ),
          }
        : {}),
    };
  }
  return out;
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
    const state = baselineComparability(raw, baseline);

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

    // 只有"可行动"的超阈值才值得复测：主指标超阈值算，派生指标要有主指标佐证才算。
    // 否则会为一次纯粹的 runner 抖动多跑一轮（实测这类抖动在 CI 上很常见）。
    //
    // 绝对行必须无条件进入复测：它的指标名是 `frameMs.p95(绝对)` 这种带后缀的形式，
    // 不命中 PRIMARY_METRICS，若不豁免就会被"需佐证"规则滤掉 → raw2 缺失 →
    // final 阶段落成 WARN「未复测」→ 退出码 0，使「绝对目标未达标」成为死代码。
    const primaryOver = rows1.some((r) => r.over && isPrimary(r.metric));
    const actionableOver = rows1.filter(
      (r) =>
        r.over &&
        (r.absolute === true ||
          !requiresPrimaryCorroboration(r.metric) ||
          primaryOver),
    );
    const overMetrics = actionableOver.map((r) => r.metric);
    if (phase === "check" && overMetrics.length > 0) retest.push(id);

    // 最终判定：首轮超阈值 + 复测仍超阈值 = FAIL；首轮超但复测回落 = WARN
    // 绝对行与相对行的结论文案必须分开：前者是"帧预算目标未达标"，后者才是"相对基线回归"
    const verdicts = [];
    for (const row of rows1) {
      const second = rows2.find((r) => r.metric === row.metric);
      const isAbsolute = row.absolute === true;
      // 过了相对阈值但被绝对地板/噪声门槛挡下：确实动了，但幅度不可行动 → WARN 并说明原因
      if (row.suppressed) {
        verdicts.push({
          ...row,
          verdict: "WARN",
          note:
            row.suppressed === "floor"
              ? "变化低于该指标的绝对地板"
              : `变化在运行噪声内（${NOISE_SIGMA}σ=${round(row.noise)}）`,
        });
        continue;
      }
      if (!row.over) {
        verdicts.push({ ...row, verdict: "PASS" });
        continue;
      }
      // 派生指标（longTaskMs / jankRate 之类）在共享 runner 上的自然波动可达 35%，
      // 无主指标佐证时不判 FAIL，只提示：没有主指标佐证的"回归"不可行动。
      // 绝对行不受此限——它本来就只在定向测量（headed/uncapped）下产出。
      if (!isAbsolute && requiresPrimaryCorroboration(row.metric) && !primaryOver) {
        verdicts.push({
          ...row,
          verdict: "WARN",
          note: "派生指标无主指标佐证（疑似运行抖动）",
        });
        continue;
      }
      if (!raw2) {
        // 没有复测数据（例如复测轮未覆盖）：只报 WARN，不把单次抖动当回归
        verdicts.push({ ...row, verdict: "WARN", note: "未复测" });
        continue;
      }
      const reproduced = Boolean(second && second.over);
      verdicts.push({
        ...row,
        verdict: reproduced ? "FAIL" : "WARN",
        retest: second ? second.cur : null,
        note: reproduced
          ? isAbsolute
            ? "复测仍超帧预算"
            : "复测仍超阈值"
          : "复测回落（抖动）",
      });
    }

    // 更新 baseline：优先用该场景最新一轮的数据（有复测轮则用复测轮）
    if (args["update-baseline"] === "1" || args["update-baseline"] === "true") {
      const source = raw2 ?? raw;
      const file = baselinePath(env, profile, id);
      ensureDir(resolve(file, ".."));
      const previous = readBaseline(env, profile, id);
      writeFileSync(
        file,
        JSON.stringify(
          {
            schemaVersion: 2,
            env,
            profile,
            mode: source.mode ?? "headless",
            scenario: source.scenario,
            tier: source.tier,
            kind: source.kind,
            rounds: source.rounds,
            fixture: source.fixture,
            metrics: withHistory(buildStats(source), previous, source),
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
      mode: raw.mode ?? "unknown",
      absoluteEnabled: absoluteEnabledFor(raw),
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
        ? `[perf] check：${retest.length} 个场景疑似超阈值（相对/绝对合计），需复测 → ${retest.join(", ")}`
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
  // 噪声门槛：由基线历史（同一环境 + 同一 fixture 的多次运行）估计的 3σ。
  // 历史不足时判定退化为"百分比 + 绝对地板"，必须显式说明，避免读者高估分辨率。
  const historyPoints = results
    .flatMap((r) => r.metrics.map((m) => m.historyPoints ?? 0))
    .filter((n) => n > 0);
  const minHistory = historyPoints.length > 0 ? Math.min(...historyPoints) : 0;
  if (minHistory >= NOISE_MIN_POINTS) {
    lines.push(
      `- 噪声门槛：按基线历史（每指标 ${minHistory}+ 次运行）估计的 ${NOISE_SIGMA}σ 判定；` +
        `小于该幅度的变化无法与运行间抖动区分，标为 WARN（各行的 3σ 见表格）`,
    );
  } else {
    lines.push(
      `- 噪声门槛未启用：基线历史不足（最少 ${minHistory} 次运行，需 ≥${NOISE_MIN_POINTS}）→ ` +
        `回退到「百分比 + 绝对地板」。重建基线（--update-baseline）会逐次累积历史`,
    );
  }
  const absoluteCount = results.filter((r) => r.absoluteEnabled).length;
  if (absoluteCount > 0) {
    lines.push(
      `- 绝对阈值参与判定：${absoluteCount}/${results.length} 个场景（帧间隔 p95 ≤ ${P95_BUDGET_FACTOR}× 帧预算、掉帧率 ≤ ${JANK_RATE_LIMIT_PCT}%）`,
    );
  }
  lines.push(
    `- 判定分层：主指标（ttiMs / frameMs / switchMs / searchMs / saveMs / inputMs）可单独判 FAIL；` +
      `派生指标（longTaskMs / longTaskCount / jankRate 等）需同场景有主指标佐证，否则只提示 WARN`,
  );
  if (absoluteCount < results.length) {
    lines.push(
      `- 其余 ${results.length - absoluteCount} 个场景未参与绝对判定：本次为 headless 测量（vsync 锁 60Hz，帧间隔反映显示器节拍而非单帧工作耗时）。要拿绝对结论请用 PERF_HEADED=1 或 PERF_UNCAPPED=1，或用 PERF_ABSOLUTE=1 强制开启`,
    );
  }
  lines.push("");
  lines.push("| 场景 | 指标 | baseline | 本次 | 复测 | 变化 | 3σ | 判定 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    // 不可比时必须显式出现在表里：否则读者会把"没有相对行"误读成"相对判定通过"
    if (r.baselineState !== "OK") {
      lines.push(
        `| ${r.id} | 基线 | — | — | — | — | 未参与相对判定：${r.baselineState} |`,
      );
    }
    if (r.metrics.length === 0) continue;
    for (const m of r.metrics) {
      const delta =
        typeof m.base !== "number" || m.base === 0
          ? "—"
          : `${(((m.cur - m.base) / m.base) * 100).toFixed(1)}%`;
      lines.push(
        `| ${r.id} | ${m.metric} | ${m.base} | ${m.cur} | ${m.retest ?? "—"} | ${delta} | ${
          typeof m.noise === "number" ? round(m.noise) : "—"
        } | ${m.verdict}${m.note ? `（${m.note}）` : ""} |`,
      );
    }
  }
  lines.push("");
  writeFileSync(resolve(OUT_DIR, "report.md"), lines.join("\n"), "utf8");
  console.log(lines.join("\n"));

  const jitterRows = results.flatMap((r) =>
    r.metrics
      .filter((m) => m.verdict === "WARN" && (m.note ?? "").includes("无主指标佐证"))
      .map((m) => `${r.id}:${m.metric}`),
  );
  if (jitterRows.length > 0) {
    console.log(
      `[perf] 派生指标超阈值但无主指标佐证（按运行抖动处理，不判 FAIL）：${jitterRows.join(", ")}`,
    );
  }

  const noiseRows = results.flatMap((r) =>
    r.metrics
      .filter((m) => (m.note ?? "").includes("变化在运行噪声内"))
      .map((m) => `${r.id}:${m.metric}`),
  );
  if (noiseRows.length > 0) {
    console.log(
      `[perf] 变化在运行噪声内（${NOISE_SIGMA}σ 门槛，按抖动处理，不判 FAIL）：${noiseRows.join(", ")}`,
    );
  }

  const notCompared = results.filter((r) => r.baselineState !== "OK");
  if (notCompared.length > 0) {
    console.log(
      `[perf] 未做相对比较的 ${notCompared.length} 个场景：` +
        notCompared.map((r) => `${r.id}(${r.baselineState})`).join(", "),
    );
  }

  if (failed.length > 0) {
    // 两类 FAIL 的成因完全不同，必须分开表述，避免"代码回归"与"目标未达标"混为一谈
    const relativeFailed = failed.filter((f) =>
      f.metrics.some((m) => m.verdict === "FAIL" && m.absolute !== true),
    );
    const absoluteFailed = failed.filter(
      (f) =>
        !relativeFailed.includes(f) &&
        f.metrics.some((m) => m.verdict === "FAIL" && m.absolute === true),
    );
    if (relativeFailed.length > 0) {
      console.error(
        `\n[perf] 相对回归确认（连续 2 次超阈值）：${relativeFailed.map((f) => f.id).join(", ")}`,
      );
    }
    if (absoluteFailed.length > 0) {
      console.error(
        `[perf] 绝对目标未达标（非回归，反映当前环境能否跑满帧预算）：${absoluteFailed
          .map((f) => f.id)
          .join(", ")}`,
      );
    }
    process.exit(1);
  }
  if (warned.length > 0) {
    console.log(`\n[perf] 疑似超阈值但复测回落（抖动）：${warned.map((w) => w.id).join(", ")}`);
  }
  process.exit(0);
}

main();

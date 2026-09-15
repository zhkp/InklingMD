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
import { baselineComparability, MODE_FALLBACK, ROUNDS_FALLBACK } from "./comparability.js";
import {
  COMPARED_SCALARS,
  DRIFT_WARN_PCT,
  isOver,
  isPrimary,
  median,
  NOISE_MIN_POINTS,
  NOISE_SIGMA,
  noiseFor,
  referenceValue,
  requiresPrimaryCorroboration,
  RESOLUTION_WARN_PCT,
  SESSION_PROBE_METRICS,
  resolutionPct,
  suppressionReason,
} from "./judgment.js";

// 四个目录都可用环境变量覆盖。RAW_DIR 原本就支持（复测轮要写到独立目录，
// 否则同名文件会覆盖首轮采样）；OUT_DIR / RETEST_DIR / BASELINE_DIR 一并开放，
// 是为了让端到端测试能在临时目录里跑完整两阶段流转与基线累积，不污染真实产物。
const OUT_DIR = resolve(process.env.PERF_OUT_DIR ?? ".perf-output");
const RAW_DIR = resolve(process.env.PERF_RAW_DIR ?? ".perf-output/raw");
const RETEST_DIR = resolve(process.env.PERF_RETEST_DIR ?? ".perf-output/raw-retest");
const BASE_DIR = resolve(process.env.PERF_BASELINE_DIR ?? ".perf-baseline");

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
/**
 * 基线文件路径 = **测量配置** 的函数：`<BASE_DIR>/[local/]<profile>/<mode>/r<rounds>/<id>.json`
 *
 * 为什么把 mode / rounds 放进路径（而不是只靠 comparability 拦截）：
 * 它们是**测量配置**，不同配置的绝对值不可比。放在路径里，headless 日常回归与
 * uncapped 定向验证（120fps 路径）能各自维护基线、互不覆盖；否则
 * `PERF_UNCAPPED=1 ... --update-baseline` 会覆盖掉 headless 基线文件，
 * 之后 headless 运行全部 MODE_MISMATCH，直到重建——这正是复审发现的 P1 场景。
 * `PERF_REPEAT` 同理：不同轮数的采样精度不同，不应互相覆盖。
 *
 * 剩下的 fixture 是**被测对象**，不是配置：换了文档就该作废重建（同路径、历史重起），
 * 所以它不进路径，由 comparability 的指纹校验负责。
 */
function baselinePath(env, profile, id, mode, rounds) {
  const envPrefix = env === "local" ? "local/" : "";
  const modeSegment = mode ?? MODE_FALLBACK;
  const roundsSegment = `r${rounds ?? ROUNDS_FALLBACK}`;
  return resolve(BASE_DIR, `${envPrefix}${profile}/${modeSegment}/${roundsSegment}/${id}.json`);
}

function readBaseline(env, profile, id, mode, rounds) {
  const file = baselinePath(env, profile, id, mode, rounds);
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
      // 3σ 占参考值的比例 = 该指标在当前环境下的检出下限（见 judgment.resolutionPct）
      resolution: resolutionPct(entry, statistic),
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
  // 判定白名单 + 会话标定指标：标定值必须**持久化**（否则基线没有参考值与 3σ 门槛，
  // 「环境归因」永远判不出来），但它不参与判定——见 judgment.SESSION_PROBE_METRICS 的说明。
  for (const metric of [...COMPARED_SCALARS, ...SESSION_PROBE_METRICS]) {
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
  // 历史累积的可比性判定**必须与比较侧同一套规则**（baselineComparability 五维）。
  // 早期只查 fixture，于是「headless 日常回归建基线 → 切 uncapped 做定向验证并 update-baseline」
  // 会把两种模式的聚合值混进同一条 history（实测 [16.8,16.8,16.8] → [16.8,16.8,16.8,8.5]），
  // σ 被污染成 ≈4.4ms、3σ≈13ms，真实的 8.4→11ms 回归会被「变化在运行噪声内」吞掉。
  //
  // 现在 mode/rounds 已由**路径**隔离（见 baselinePath），两者不可能再混；
  // 这里仍跑全套五维，是因为 mode/rounds/env/profile 属于"路径不变量"——
  // 一旦不匹配，说明基线文件被手工搬动或路径方案变了，属于该拦下的异常，不是可忽略的差异。
  // 实际会命中重启的通常是 **fixture**（换文档 = 被测对象变了）与旧 schemaVersion。
  // schemaVersion < 2 的旧基线没有历史序列，也从本次重新起头（避免把同一个点重复计入）。
  const previousComparability = previous
    ? baselineComparability(source, previous)
    : { ok: false, reason: "NEW" };
  const comparable = previous?.schemaVersion === 2 && previousComparability.ok;
  if (previous && previous.schemaVersion === 2 && !previousComparability.ok) {
    console.log(
      `[perf] 基线历史重新起头（${source.id}）：${previousComparability.reason}` +
        `——与比较侧的不可比语义对齐，历史不与不同 env/profile/mode/rounds/fixture 的样本混用`,
    );
  }
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

/**
 * 场景的"判定覆盖状态"：真正参与相对判定 = 基线可比 **且真的产出了比较行**。
 *
 * 只查 `baselineState === "OK"` 会漏掉「元数据可比但没有可用指标」的基线：
 * 基线文件 `metrics: {}`（部分生成）、或指标 schema 变更导致逐个指标都被跳过时，
 * `baselineComparability` 照样返回 OK，而 `compareRun` 静默跳过所有指标——表格是空的，
 * 该场景却会被算成"已比较"，于是 tag 运行以 exit 0 收尾，重新制造本守卫要消灭的假绿灯。
 * 所以把这种基线单独标成 `EMPTY_BASELINE`，与 NEW / MISMATCH 同样计入"未覆盖"。
 */
function coverageState(result) {
  if (result.baselineState !== "OK") return result.baselineState;
  // 只统计**相对**行：绝对行（帧预算 p95 / 掉帧率）不依赖基线，它的存在不能说明"比较过了"。
  // 否则 PERF_ABSOLUTE=1 / headed / uncapped + 「元数据可比但没有可用指标」的基线时，
  // 绝对行会让覆盖虚报为 OK、EMPTY_BASELINE 不触发——同一族假绿灯的最后一角。
  return result.metrics.some((m) => m.absolute !== true) ? "OK" : "EMPTY_BASELINE";
}

/**
 * 会话标定对比（issue #236）：当前轮的标定值与基线参考值。
 *
 * 标定指标（probeMs / probeLayoutMs / probeCpuMs）刻意**不进 COMPARED_SCALARS 白名单**——
 * 「机器变慢」不是代码回归，它们不参与 FAIL/WARN 判定；这里只把两侧取出来供**环境归因**披露。
 * 任一缺失（基线还没播种到标定指标 / 老产物回放）时返回 null，不猜测。
 */
function sessionProbeOf(raw, baseline) {
  const cur = raw?.scalars?.probeMs;
  const entry = baseline?.metrics?.probeMs;
  const base = entry ? referenceValue(entry) : undefined;
  if (typeof cur !== "number" || typeof base !== "number" || base <= 0) return null;
  return {
    cur,
    base,
    deltaPct: ((cur - base) / base) * 100,
    noise: noiseFor(entry),
    historyPoints: entry?.history?.length ?? 0,
    // 历史序列：门槛判"是否超出历史范围"要用（3σ 对"机器档位双峰"这种分布不适用）
    history: Array.isArray(entry?.history) ? entry.history : [],
  };
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
    const baseline = readBaseline(env, profile, id, raw.mode, raw.rounds);
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
      const file = baselinePath(env, profile, id, source.mode, source.rounds);
      ensureDir(resolve(file, ".."));
      const previous = readBaseline(env, profile, id, source.mode, source.rounds);
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
      // 会话标定（#236）：不参与判定，只供「环境归因」披露使用
      sessionProbe: sessionProbeOf(raw, baseline),
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
  // 判定覆盖面必须显式报出来：基线缺失时所有场景都是 NEW，报告照样打印「FAIL：0」——
  // 那看起来像"没有回归"，实际是"什么都没比"。发版验证尤其不能出现这种假绿灯。
  const comparedRuns = results.filter((r) => coverageState(r) === "OK");
  lines.push(
    `- 判定覆盖：${comparedRuns.length}/${results.length} 个场景参与相对判定` +
      (comparedRuns.length < results.length
        ? "（其余无基线、不可比或基线里没有可用指标，其 FAIL/WARN 计数不代表已比较）"
        : ""),
  );
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
  // 分辨率提醒：3σ 达到参考值 RESOLUTION_WARN_PCT% 的行，其相对判定只剩"抓大事故"的能力。
  // 必须与 FAIL 计数并列报出来——"假 FAIL"会被人发现，"静默漏检"不会。
  const coarseRows = results.flatMap((r) =>
    r.metrics
      .filter((m) => typeof m.resolution === "number" && m.resolution >= RESOLUTION_WARN_PCT)
      .map((m) => `${r.id}:${m.metric}(${Math.round(m.resolution)}%)`),
  );
  if (coarseRows.length > 0) {
    const shown = coarseRows.slice(0, 8);
    lines.push(
      `- 分辨率提醒：${coarseRows.length} 行的 3σ ≥ 参考值的 ${RESOLUTION_WARN_PCT}%` +
        `（这些指标在当前环境只能检出更大的变化，行上的 PASS 不等于"没问题"）：${shown.join(", ")}` +
        (coarseRows.length > shown.length ? `，等共 ${coarseRows.length} 行` : ""),
    );
  }
  // 整机漂移迹象：共享 runner 被拖慢时，互不相关的指标会一起变差（实测 88% 行、中位 Δ +18.7%），
  // 而纯噪声下应接近 50%。**只披露、不改判定**——整体变慢也可能真是全链路回归，
  // 二者在共享 runner 上无法据此区分；把证据摆出来，避免读者把"机器慢"读成"代码坏"。
  const relativeRows = results.flatMap((r) =>
    r.metrics.filter(
      (m) => m.absolute !== true && typeof m.base === "number" && m.base > 0 && typeof m.cur === "number",
    ),
  );
  if (relativeRows.length > 0) {
    const worsened = relativeRows.filter((m) => m.cur > m.base).length;
    const driftPct = (worsened / relativeRows.length) * 100;
    if (driftPct >= DRIFT_WARN_PCT) {
      const deltas = relativeRows.map((m) => ((m.cur - m.base) / m.base) * 100);
      lines.push(
        `- ⚠️ 整机漂移迹象：${worsened}/${relativeRows.length} 行（${Math.round(driftPct)}%）比基线差，` +
          `中位变化 ${median(deltas).toFixed(1)}%——互不相关的指标同时变差通常意味着 runner 变慢而非代码回归，` +
          `FAIL 结论请结合这一点判断（二者在共享 runner 上无法仅凭本报告区分）`,
      );
    }
  }
  // 会话标定（#236）：把「机器慢」从「代码回归」里分开。
  // 注意门槛的选型：标定值的分布就是**机器档位的分布**（实测两档 ≈31ms / ≈50ms，同一次运行内
  // 16 个场景彼此只差 ~2ms），σ 自然很大 → 用 3σ 会几乎永不触发。所以改判「是否超出历史范围」：
  // 落在范围内 = 与历史档位一致（不看机器好坏，只看是否"见过"）；超出 10% 才算环境异常。
  const probes = results
    .filter((r) => r.sessionProbe)
    .map((r) => ({ id: r.id, ...r.sessionProbe }));
  if (probes.length > 0) {
    const probeCur = median(probes.map((p) => p.cur));
    const probeRef = median(probes.map((p) => p.base));
    const hist = probes.flatMap((p) => p.history ?? []);
    const lo = Math.round(Math.min(...hist) * 100) / 100;
    const hi = Math.round(Math.max(...hist) * 100) / 100;
    const deltaPct = ((probeCur - probeRef) / probeRef) * 100;
    const outOfRange = probeCur > hi * 1.1;
    lines.push(
      `- 会话标定（与代码无关的固定工作量，#236）：本次 ${probeCur}ms vs 基线参考 ${probeRef}ms` +
        `（${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%），基线历史范围 ${lo}–${hi}ms（${probes.length} 个场景）→ ` +
        (outOfRange
          ? `**⚠️ 判为「会话环境异常」**（超出历史范围 10% 以上）：应用指标的恶化**很可能来自 runner 变慢**` +
            `而非代码回归，请换 runner 重跑确认`
          : `环境在历史范围内（**档位归因**：本次比基线参考${deltaPct >= 0 ? "慢" : "快"} ` +
            `${Math.abs(deltaPct).toFixed(1)}%）——标定负载覆盖 **CPU 与布局/绘制**两条路径，` +
            `不含 IO/网络；应用指标若同时变差，机器档位不足以解释它（须看代码或 IO 侧）；` +
            `只有超出历史范围才判为环境异常`),
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
  lines.push("| 场景 | 指标 | baseline | 本次 | 复测 | 变化 | 3σ（占参考） | 判定 |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    // 不可比（或基线里没有可用指标）时必须显式出现在表里：
    // 否则读者会把"没有相对行"误读成"相对判定通过"
    const cov = coverageState(r);
    if (cov !== "OK") {
      lines.push(
        `| ${r.id} | 基线 | — | — | — | — | 未参与相对判定：${cov} |`,
      );
    }
    if (r.metrics.length === 0) continue;
    for (const m of r.metrics) {
      const delta =
        typeof m.base !== "number" || m.base === 0
          ? "—"
          : `${(((m.cur - m.base) / m.base) * 100).toFixed(1)}%`;
      const noiseCell =
        typeof m.noise !== "number"
          ? "—"
          : typeof m.resolution === "number"
            ? `${round(m.noise)}（${Math.round(m.resolution)}%）`
            : `${round(m.noise)}`;
      lines.push(
        `| ${r.id} | ${m.metric} | ${m.base} | ${m.cur} | ${m.retest ?? "—"} | ${delta} | ${noiseCell} | ${
          m.verdict
        }${m.note ? `（${m.note}）` : ""} |`,
      );
    }
  }
  lines.push("");
  writeFileSync(resolve(OUT_DIR, "report.md"), lines.join("\n"), "utf8");
  console.log(lines.join("\n"));

  // WARN 有五种成因（复测回落 / 未复测 / 无主指标佐证 / 运行噪声内 / 低于绝对地板），
  // 按成因分组输出。早期这里把所有 WARN 统一写成「疑似超阈值但复测回落（抖动）」，
  // 既与表格正文不符，也与上面按成因分列的行重复。
  const warnGroups = new Map();
  for (const r of results) {
    for (const m of r.metrics) {
      if (m.verdict !== "WARN") continue;
      const cause = m.note ?? "其他";
      if (!warnGroups.has(cause)) warnGroups.set(cause, []);
      warnGroups.get(cause).push(`${r.id}:${m.metric}`);
    }
  }
  if (warnGroups.size > 0) {
    console.log(
      `\n[perf] WARN 按成因归类（${warned.length} 个场景命中，均不判 FAIL）：`,
    );
    for (const [cause, items] of warnGroups) {
      console.log(`  · ${cause}：${items.join(", ")}`);
    }
  }
  const notCompared = results.filter((r) => coverageState(r) !== "OK");
  if (notCompared.length > 0) {
    console.log(
      `[perf] 未做相对比较的 ${notCompared.length} 个场景：` +
        notCompared.map((r) => `${r.id}(${r.baselineState})`).join(", "),
    );
  }

  // 先无条件打印覆盖行：无论后面走哪条退出路径，读者都能在控制台看到本次究竟比了几个场景
  console.log(
    `[perf] 判定覆盖：${comparedRuns.length}/${results.length} 个场景参与相对判定`,
  );

  const coverageIncomplete = comparedRuns.length < results.length;
  // PERF_REQUIRE_COMPARISON=1：要求本次必须完成比较（发版验证用）。
  // 没比上就退出码 2（infra 故障）——绝不允许"没比"伪装成"没回归"。
  //
  // 为什么必须放在 FAIL 判定**之前**：tag 运行若同时"有回归复现"且"覆盖不足"，
  // 先 exit 1 会让覆盖问题永远报不出来——CI 只看到"回归"，看不出这次验证本身不完整。
  // 覆盖不足时退出码 2 优先（结论不完整比单个结论更根本），但两条信息都打出来。
  //
  // 只在 final 阶段判定：check 阶段退出非 0 会被 benchmark.mjs 当成 infra 故障中止，
  // 那样连"建立首个基线"的 --update-baseline 运行都跑不完（它天生没有基线可比）。
  if (phase === "final" && process.env.PERF_REQUIRE_COMPARISON === "1" && coverageIncomplete) {
    if (failed.length > 0) {
      console.error(
        `[perf] 注意：本次同时存在 FAIL（${failed.map((f) => f.id).join(", ")}）——` +
          `报告表格里有逐行判定细节，但覆盖不足使整份结论不完整。`,
      );
    }
    console.error(
      `[perf] 判定覆盖不足：仅 ${comparedRuns.length}/${results.length} 个场景参与相对判定。\n` +
        `        本次结论**不构成性能验证**：基线缺失时「FAIL：0」只说明"没比"，不说明"没回归"。\n` +
        `        请先建立该档位的基线：workflow_dispatch(profile=<档位>, update_baseline=true) → 取回产物提交。`,
    );
    process.exit(2);
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

  process.exit(0);
}

main();

#!/usr/bin/env node
// 统计、baseline 比较与报告输出（issue #216）
//
// 三种运行模式：
//   --phase=check    比 baseline，把「超阈值场景 id」写进 .perf-output/retest.json（供复测）
//   --phase=confirm  合并首轮与复测，把「确认轮候选场景 id」写进 .perf-output/retest2.json
//   --phase=final    合并首轮/复测/确认轮，出最终判定与退出码
//
// 判定语义：issue #294 之前是「连续 2 次复现」（首轮 + 复测），**现已改为三轮**——
//   FAIL ⟺ 首轮 ∧ 复测 ∧ **确认轮**都超阈值（末轮仍超才确认）；
//   任一轮回落 = WARN（抖动），不计 fail。完整判定表见下方「为什么要第三轮」。
// 注意不是「把三个 run 的样本混在一起算中位数」——混样会让一次好的复测
// 把首轮的回归稀释掉，与"复现"语义相反。
//
// ## 为什么要第三轮（issue #294）
//
// 「连续 2 次」有个盲区：**两个会话可以同时被拖慢**。共享 runner 池内跨工作流的并发
// （自家 Build/test、打包、其他 Benchmark）会让同一测量窗口里的两台 VM 一起变慢，
// 于是 R1∧R2 双超成立、而结论是错的——2026-09-30 实证 3 例，换 runner 静默复跑全部证伪。
// 故 FAIL 必须由**第三个独立 runner** 上的会话（确认轮）确认；确认轮自身不可信时
// **不允许**产出 FAIL（落 UNCONFIRMED）。
//
// 三轮判定表（每场景每指标行）：
//   R1 未超 / 被抑制                 → PASS / WARN（沿用现有语义）
//   R1 超、无 R2                     → WARN（未复测）
//   R1 超、R2 未超                   → WARN（复测回落（抖动））—— 不进 R3
//   R1∧R2 超、R3 存在且超            → FAIL
//   R1∧R2 超、R3 存在但未超          → WARN（末轮回落（抖动））
//   R1∧R2 超、R3 缺失/不可信/缺该指标 → WARN（未确认：…）+ 场景进 UNCONFIRMED
//
// UNCONFIRMED = 「本来会确认 FAIL、但确认轮没能给出可信结论」的场景集合。它与
// UNMEASURED 同族但语义不同：PR 运行披露 + 逐行 WARN；tag 运行
// （PERF_REQUIRE_COMPARISON=1）exit 2 —— **结论不完整 ≠ 没回归**。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { baselineComparability, MODE_FALLBACK, ROUNDS_FALLBACK } from "./comparability.js";
import {
  ATTRIBUTION_METRICS,
  COMPARED_SCALARS,
  confirmVerdict,
  COUNT_FLOOR_FACTOR,
  DRIFT_WARN_PCT,
  effectiveAbsMin,
  historyFloor,
  isOver,
  isPrimary,
  isRaisedFloor,
  median,
  NOISE_MIN_POINTS,
  NOISE_SIGMA,
  noiseFor,
  PRIMARY_METRICS,
  referenceValue,
  requiresPrimaryCorroboration,
  RESOLUTION_WARN_PCT,
  ruleFor,
  SESSION_PROBE_METRICS,
  resolutionPct,
  suppressionReason,
} from "./judgment.js";
import { expectedScenarioIds, parseScenarioId, unmeasuredScenarios } from "./pw-coverage.js";

// 五个目录都可用环境变量覆盖。RAW_DIR 原本就支持（复测轮要写到独立目录，
// 否则同名文件会覆盖首轮采样）；OUT_DIR / RETEST_DIR / RETEST2_DIR / BASELINE_DIR 一并开放，
// 是为了让端到端测试能在临时目录里跑完整三阶段流转与基线累积，不污染真实产物。
// RETEST2_DIR 是确认轮采样（#294），与 RETEST_DIR 同理——同名文件会覆盖复测轮；
// 漏掉它，端到端测试里的确认轮就会写到真实 `.perf-output/` 上去。
const OUT_DIR = resolve(process.env.PERF_OUT_DIR ?? ".perf-output");
const RAW_DIR = resolve(process.env.PERF_RAW_DIR ?? ".perf-output/raw");
const RETEST_DIR = resolve(process.env.PERF_RETEST_DIR ?? ".perf-output/raw-retest");
const RETEST2_DIR = resolve(process.env.PERF_RETEST2_DIR ?? ".perf-output/raw-retest2");
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

/**
 * 读 playwright json 报告（方向 2，issue #247），用于核算「应测但未测量」的场景。
 *
 * 落点：优先 PERF_PW_REPORT（相对仓库根 cwd，与 config 的写入口径一致）；
 * 否则取 OUT_DIR 下的 pw-report.json（默认 `.perf-output/pw-report.json`，与 config 默认一致，
 * 同时在端到端测试里随 PERF_OUT_DIR 一起被重定向到临时目录）。
 * 缺失 / JSON 畸形 → 返回 `{ report: null, reason }`，调用方回退现行为并打印原因——
 * 读不到报告不能反过来改变判定（"没测到"与"测到没回归"必须区分）。
 */
function readPwReport() {
  const file = process.env.PERF_PW_REPORT
    ? resolve(process.cwd(), process.env.PERF_PW_REPORT)
    : resolve(OUT_DIR, "pw-report.json");
  if (!existsSync(file)) return { file, report: null, reason: "文件不存在" };
  try {
    return { file, report: JSON.parse(readFileSync(file, "utf8")), reason: null };
  } catch (error) {
    return { file, report: null, reason: `JSON 解析失败：${error.message}` };
  }
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

/**
 * 归因行（issue #379）：只披露、不判定。
 * base 缺失时保留 `—`（新指标尚未播种进基线），不能伪造成 0。
 */
function attributionRows(raw, baseline) {
  const rows = [];
  for (const metric of ATTRIBUTION_METRICS) {
    const cur = raw.scalars?.[metric];
    if (typeof cur !== "number") continue;
    const base = baseline ? baselineValue(baseline, metric) : undefined;
    rows.push({
      metric,
      base: typeof base === "number" ? base : null,
      cur,
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
   *
   * 生效地板（#270 方案 B）：= 登记常数 与「同代码历史散布推导的下限」取大者。
   * 小基数计数指标的百分比规则本就不可信，手写常数又常比该指标自身散布还小，这里统一收紧。
   */
  const pushRow = (row, entry, statistic) => {
    const noise = noiseFor(entry, statistic);
    const absMin = effectiveAbsMin(entry, row.metric, statistic);
    rows.push({
      ...row,
      noise,
      absMin,
      // 登记常数（未受历史散布影响的那一份）：报告据此判断本行地板是不是**真的**被抬高（#274）
      registeredAbsMin: ruleFor(row.metric).absMin,
      // 由「同代码历史散布」推导出的那部分地板（用于报告里显式披露哪几行被抬高了）
      floorDerived: historyFloor(entry, row.metric, statistic),
      // 3σ 占参考值的比例 = 该指标在当前环境下的检出下限（见 judgment.resolutionPct）
      resolution: resolutionPct(entry, statistic),
      historyPoints: (statistic === "p95" ? entry?.historyP95 : entry?.history)?.length ?? 0,
      // 过了相对阈值但被绝对地板/噪声门槛挡下：不是 PASS，需要显式标注原因
      suppressed: suppressionReason(row.metric, row.cur, row.base, noise, absMin),
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
        over: isOver(metric, cur.median, base, noiseFor(entry, "median"), effectiveAbsMin(entry, metric, "median")),
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
          over: isOver(
            `${metric}.p95`,
            cur.p95,
            baseP95,
            noiseFor(entry, "p95"),
            effectiveAbsMin(entry, `${metric}.p95`, "p95"),
          ),
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
        over: isOver(metric, cur, base, noiseFor(entry, "median"), effectiveAbsMin(entry, metric, "median")),
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
  // 判定白名单 + 会话标定指标 + 归因指标：后两者必须**持久化**（否则基线没有参考值，
  // 「环境归因 / 钱花在哪」永远看不出来），但都不参与判定——见 judgment 里的说明。
  for (const metric of [
    ...COMPARED_SCALARS,
    ...SESSION_PROBE_METRICS,
    ...ATTRIBUTION_METRICS,
  ]) {
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
 * 会话标定对比（issue #236）：**首轮 / 复测 / 确认轮三轮**的标定值 + 基线参考值/历史范围。
 *
 * 标定指标（probeMs / probeLayoutMs / probeCpuMs）刻意**不进 COMPARED_SCALARS 白名单**——
 * 「机器变慢」不是代码回归，它们不参与 FAIL/WARN 判定；这里只把两侧取出来供**环境归因**披露。
 *
 * 为什么每轮都要取：各轮跑在**不同的 runner** 上（#234 拆 job、#294 再拆一轮）。
 * 只看首轮会得出与事实上相反的结论——例如首轮慢（超范围）触发复测、复测在另一台机器上
 * 仍超阈值时，若只看首轮就会写「请换 runner 重跑确认」，而这一步其实已经做过了。
 * 反过来，复测那台机器慢会把复测值整体抬高造成假 FAIL，此时唯一能识破的证据恰是复测侧 probe。
 * 确认轮（#294）同理：它是**唯一**能确认 FAIL 的那一轮，它自己不可信时必须拒绝出 FAIL。
 *
 * 任一缺失（基线还没播种到标定指标 / 老产物回放 / 没有复测或确认轮）时返回 null 或对应字段缺省，不猜测。
 */
function sessionProbeOf(raw, raw2, raw3, baseline) {
  const entry = baseline?.metrics?.probeMs;
  const base = entry ? referenceValue(entry) : undefined;
  if (typeof base !== "number" || base <= 0) return null;
  const pick = (r) => (typeof r?.scalars?.probeMs === "number" ? r.scalars.probeMs : undefined);
  const first = pick(raw);
  const retest = pick(raw2);
  const confirm = pick(raw3);
  if (first === undefined && retest === undefined && confirm === undefined) return null;
  return {
    base,
    first,
    retest,
    confirm,
    // 历史序列：门槛判"是否超出历史范围"要用（3σ 对"机器档位双峰"这种分布不适用）
    history: Array.isArray(entry?.history) ? entry.history : [],
  };
}

/**
 * 标定「越界」判定：某轮会话是否超出基线历史范围（issue #294 的确认轮触发条件）。
 *
 * 门槛沿用报告既有的口径 `v > hi × 1.1`（超出历史上限 10% 才算环境异常，见报告会话标定段）。
 * 为什么不作 FAIL 抑制门禁：#294 实测表明越界**既非必要也非充分**——范围内照样出假 FAIL
 * （两例），高偏差的核验会话照样正常（两例）。所以它只用来：
 *   ① 复测轮越界 → 该场景并入确认轮候选（环境不可信，不许就地确认）；
 *   ② 确认轮越界 → 不确认 FAIL（落 UNCONFIRMED）。
 * **历史序列缺失时不判定**（缺失不判，不猜门槛）。
 */
function probeBeyond(value, history) {
  if (typeof value !== "number") return false;
  if (!Array.isArray(history) || history.length === 0) return false;
  const hi = Math.max(...history);
  if (!(hi > 0)) return false;
  return value > hi * 1.1;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // 三个相位：check（编排信号：谁要复测）/ confirm（编排信号：谁要确认轮）/ final（出结论）。
  // 只有 final 产出报告与退出码——check 与 confirm 同性质，都**不构成结论**。
  const phase = args.phase === "check" || args.phase === "confirm" ? args.phase : "final";

  const run1 = readRun(RAW_DIR);
  // 复测轮只在 confirm / final 读；确认轮只在 final 读（check 阶段它们都还没跑）
  const run2 = phase === "check" ? new Map() : readRun(RETEST_DIR);
  const run3 = phase === "final" ? readRun(RETEST2_DIR) : new Map();
  if (run1.size === 0) {
    console.error("[perf] 未找到任何 raw 采样（.perf-output/raw/ 为空）");
    process.exit(2);
  }

  const results = [];
  const retest = [];
  // 确认轮候选（#294）：R1∧R2 双超的场景 ∪ R2 标定越界的场景。
  // confirm 阶段由本进程算出；final 阶段从上游产物 retest2.json 读回（由 retest job 写）。
  const confirm = [];
  // 方向 2（#247）：本次「应测但未测量」的场景 id，final 阶段统一报出并让整轮 exit 2
  const unmeasuredIds = [];
  // UNCONFIRMED（#294）：本来会确认 FAIL、但确认轮缺失/不可信/缺指标的场景
  const unconfirmedIds = [];
  // 复测轮标定越界的场景（#294）：它们被强制并入确认轮候选
  const retestUntrusted = [];

  // final 阶段读回确认轮候选清单。它决定「哪些场景本该被确认」——
  // 没有它就无法区分「R3 没测到（未确认）」与「R3 本来就不该跑（回落/未超）」。
  // 缺失（老产物 / 本地未跑 confirm）按空清单处理，向后兼容（见 §7 边界矩阵）。
  let confirmCandidates = [];
  if (phase === "final") {
    const file = resolve(OUT_DIR, "retest2.json");
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) confirmCandidates = parsed;
      } catch {
        // 清单损坏按「无候选」处理：绝不因为读不到编排信号就改变判定结论
        console.log(`[perf] 确认轮候选清单无法解析（${file}），按「无候选」处理`);
      }
    }
  }

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
    // 确认轮（#294）：第三轮的行来源与复测轮完全同构，只是目录不同。
    // 缺失是**正常**情况（无候选时整轮不跑），由判定表按「未确认」处置，不猜测。
    const raw3 = run3.get(id);
    const rows3 = raw3
      ? [
          ...(state.ok ? compareRun(raw3, baseline) : []),
          ...absoluteRows(raw3),
        ]
      : [];

    // 只有"可行动"的超阈值才值得复测：主指标超阈值算，派生指标要有主指标佐证才算。
    // 否则会为一次纯粹的 runner 抖动多跑一轮（实测这类抖动在 CI 上很常见）。
    //
    // 绝对行必须无条件进入复测：它的指标名是 `frameMs.p95(绝对)` 这种带后缀的形式，
    // 不命中 PRIMARY_METRICS，若不豁免就会被"需佐证"规则滤掉 → raw2 缺失 →
    // final 阶段落成 WARN「未复测」→ 退出码 0，使「绝对目标未达标」成为死代码。
    //
    // ⚠️ 这一处用「首轮」是**正确**的：check 阶段还没有复测数据，而且它的语义只是
    // 「值不值得再跑一轮」，不参与结论。终判阶段的佐证必须换用 primaryReproduced（见下，#270）。
    const primaryOver = rows1.some((r) => r.over && isPrimary(r.metric));

    // 参与终判的轮次（#294）：复测轮与确认轮里**确实采到样**的那些。
    // 「缺失」与「未超」必须分开：把缺失当成"没超"会让佐证与聚合误判成回落/通过。
    const judgedRounds = [rows2, rows3].filter((rows) => rows.length > 0);

    // 终判阶段的佐证基准：**本场景存在同样被判 FAIL 的主指标**（#270，#294 扩到三轮）。
    //
    // 修复前这里复用了 primaryOver（只看首轮），而终判用的是「首轮 + 复测」两轮证据，
    // 两者证据基础不一致 → 一个「首轮超、复测回落」的主指标行（已被判 WARN、已宣告是抖动）
    // 仍然能给全场景的派生指标发豁免券，导致「零主指标 FAIL 的场景产出 FAIL、exit 1」。
    // 实测案例见 issue #270：`frameMs.p95` 复测差 0.05ms 未过阈值判 WARN，而
    // `longFrameCount` 因复测微升被判 FAIL。
    //
    // #294：确认轮参与时，佐证基准同步扩到三轮——主指标必须「每轮都超」才算复现，
    // 否则一个末轮已回落的主指标仍会给派生指标发豁免券，在三段路径上重演 #270。
    const primaryReproduced = rows1.some(
      (r) =>
        r.over &&
        isPrimary(r.metric) &&
        judgedRounds.every((rows) => Boolean(rows.find((s) => s.metric === r.metric)?.over)),
    );
    const actionableOver = rows1.filter(
      (r) =>
        r.over &&
        (r.absolute === true ||
          !requiresPrimaryCorroboration(r.metric) ||
          primaryOver),
    );
    const overMetrics = actionableOver.map((r) => r.metric);
    if (phase === "check" && overMetrics.length > 0) retest.push(id);

    // 会话标定（#236）与「标定越界」（#294）：复测轮那台机器慢 → 复测值被整体抬高，
    // 这正是双超假 FAIL 的成因之一，所以该场景**必须**再上一轮独立 runner（确认轮）。
    // 越界只作「进确认轮」的触发与披露，**不作 FAIL 抑制门禁**（实证既非必要也非充分）。
    const probe = sessionProbeOf(raw, raw2, raw3, baseline);
    const retestBeyond = probeBeyond(probe?.retest, probe?.history ?? []);
    const confirmBeyond = probeBeyond(probe?.confirm, probe?.history ?? []);
    if (retestBeyond) retestUntrusted.push(id);

    // 确认轮候选（#294），两条并列：
    //   ① R1 ∧ R2 双超阈值（口径与 check 一致：主指标用 actionableOver，派生指标需主指标佐证）
    //   ② R2 标定越界（环境不可信，不许就地确认）
    // R2 无标定数据时不触发 ②（缺失不判）。
    const doubleOver = actionableOver.some((r) =>
      Boolean(rows2.find((s) => s.metric === r.metric)?.over),
    );
    if (phase === "confirm") {
      if (doubleOver || retestBeyond) confirm.push(id);
    }

    // 确认轮是否给出了**可信结论**（#294）。这是场景级判定，与「该场景有没有双超」**无关**：
    // 编排把场景放进 retest2.json 就是在说「这个场景需要第三个 runner 给结论」，
    // 编排没兑现就是链路故障（#294 评审 P1：先前只把 unconfirmed 挂在双超分支上，
    // 于是「仅因 R2 标定越界进候选、但 R2 未超」的场景永远进不了 UNCONFIRMED，
    // 报告会打出与事实相反的「均已给出可信结论」）。
    //
    // 三种「不可信」：确认轮没测到这一场景 / 确认轮自身标定越界 / 该场景在确认轮里没有任何指标行。
    const confirmExpected = phase === "final" && confirmCandidates.includes(id);
    let confirmTrusted = true;
    let confirmMissingReason = null;
    if (confirmExpected) {
      if (!raw3) {
        confirmMissingReason = "确认轮未测量";
      } else if (confirmBeyond) {
        confirmMissingReason = "确认轮环境不可信";
      } else if (rows3.length === 0) {
        confirmMissingReason = "确认轮缺该指标";
      }
      confirmTrusted = confirmMissingReason === null;
    }
    // 只有「本来会确认 FAIL、但确认轮没能给出可信结论」才叫 UNCONFIRMED。
    // 非候选场景（压根不该进确认轮）不因此记 UNCONFIRMED——它们的 R2 回落结论是自洽的。
    //
    // ⚠️ 老产物（无 retest2.json）时 confirmExpected 恒为 false，但**双超场景仍然要记
    // UNCONFIRMED**：它同样是「本来会确认 FAIL、却拿不到第三轮证据」，§7 要求落 WARN +
    // 进 UNCONFIRMED 且绝不判 FAIL。若只按 confirmExpected 记账，老产物会退化成
    // 「未确认列表为空」+ 报告打「均已给出可信结论」——与事实相反。
    const legacyDoubleOver = doubleOver && !confirmExpected;
    if (doubleOver && (!confirmTrusted || legacyDoubleOver)) unconfirmedIds.push(id);

    // 最终判定（#294 三轮）：R1∧R2 双超只是**候选**，必须由确认轮确认才判 FAIL；
    // 确认轮自身不可信/缺失/缺该指标时一律不确认 FAIL（落 UNCONFIRMED）。
    // 绝对行与相对行的结论文案必须分开：前者是"帧预算目标未达标"，后者才是"相对基线回归"
    const verdicts = [];
    for (const row of rows1) {
      const second = rows2.find((r) => r.metric === row.metric);
      const third = rows3.find((r) => r.metric === row.metric);
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
      // 佐证基准是 primaryReproduced —— 必须与终判同证据基础（主指标自己也要每一轮都超），
      // 否则「首轮超、复测回落」的主指标（已判 WARN）会给出无效豁免券（#270 / #294）。
      // 绝对行不受此限——它本来就只在定向测量（headed/uncapped）下产出。
      if (!isAbsolute && requiresPrimaryCorroboration(row.metric) && !primaryReproduced) {
        verdicts.push({
          ...row,
          verdict: "WARN",
          // 复测值照常披露：结论虽是"无佐证"，但读者仍需要看到复测那一轮的数字
          retest: second ? second.cur : null,
          retest2: third ? third.cur : null,
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
      if (!reproduced) {
        // 复测回落 = 抖动，且**不进确认轮**（确认轮只跑 R1∧R2 双超的候选）
        verdicts.push({
          ...row,
          verdict: "WARN",
          retest: second.cur,
          retest2: third ? third.cur : null,
          note: "复测回落（抖动）",
        });
        continue;
      }

      // ↓↓↓ R1∧R2 双超：以下全部是 #294 的新增判定面 ↓↓↓
      // 双超不再等于 FAIL——两个会话可能**同时**被拖慢（共享 runner 池内跨工作流并发，
      // 2026-09-30 实证 3 例，换 runner 静默复跑全部证伪）。必须由第三个独立 runner 确认。
      const disclose = { ...row, retest: second.cur, retest2: third ? third.cur : null };
      if (confirmMissingReason) {
        // 确认轮没能给出可信结论（未测量 / 环境不可信 / 缺该指标）→ 不确认 FAIL。
        // note 直接复用场景级判定的原因，保证逐行文案与「未确认」披露说的是同一件事。
        verdicts.push({
          ...disclose,
          verdict: "WARN",
          note: `未确认：${confirmMissingReason}`,
        });
        continue;
      }
      // 老产物 / 手工拼装产物：没有 retest2.json 时双超无从确认——同样不得判 FAIL。
      // 这里不能靠 confirmMissingReason（它只在 confirmExpected 时才计算）。
      if (!raw3 && !confirmExpected) {
        verdicts.push({
          ...disclose,
          verdict: "WARN",
          note: "未确认：确认轮未测量",
        });
        continue;
      }
      // 三轮齐备且确认轮可信 → 交给纯函数聚合（judgment.confirmVerdict）。
      // 只有「每一轮都超」才确认 FAIL；末轮回落即降 WARN（抖动）。
      const verdict = confirmVerdict([row.over, second.over, third.over]);
      verdicts.push({
        ...disclose,
        verdict: verdict === "fail" ? "FAIL" : "WARN",
        note:
          verdict === "fail"
            ? isAbsolute
              ? "复测仍超帧预算 + 末轮仍超"
              : "复测仍超阈值 + 末轮仍超"
            : "末轮回落（抖动）",
      });
    }
    // 更新 baseline：优先用该场景最新一轮的数据（确认轮 > 复测轮 > 首轮，#294）
    if (args["update-baseline"] === "1" || args["update-baseline"] === "true") {
      const source = raw3 ?? raw2 ?? raw;
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
      // 归因指标（#379）：不参与判定，只披露统计 / 大纲 / 公式各花在哪
      attribution: attributionRows(raw, baseline),
      // 会话标定（#236）：不参与判定，只供「环境归因」披露使用（首轮 / 复测 / 确认轮三轮对账）
      sessionProbe: probe,
      // 该场景是否进入了确认轮（#294）：由 retest2.json 决定，不是「碰巧有第三轮数据」。
      // 二者的区别在披露上很关键——「本该确认却没测到」与「压根没进确认轮」是两种结论。
      confirmExpected,
      confirmMeasured: Boolean(raw3),
      // 确认轮是否给出了可信结论（#294）。false 时 confirmMissingReason 给出具体原因。
      confirmTrusted,
      confirmMissingReason,
      // UNCONFIRMED（#294）：本来会确认 FAIL（双超）、但确认轮没给出可信结论。
      // 非候选场景不记；老产物（无 retest2.json）下双超也算——它同样拿不到第三轮证据。
      unconfirmed: doubleOver && (!confirmTrusted || legacyDoubleOver),
    });
  }

  // 方向 2（issue #247）：把「应测但未测量」的场景合成进 results。
  // 合成对象走既有「未参与相对判定」机制（baselineState !== "OK"），于是自动进入覆盖分母、
  // notCompared 列表与报告表格（单列一行 UNMEASURED）；metrics 为空，故不会产出任何 FAIL/WARN 行。
  // 只在 final 合成：check 阶段未测量场景本就没有 raw，天然不进复测嫌疑清单。
  if (phase === "final") {
    const first = [...run1.values()][0];
    const pw = readPwReport();
    if (!pw.report) {
      console.log(
        `[perf] 未读取到 playwright 报告（${pw.file}）：${pw.reason}——` +
          `跳过「未测量场景」核算，按现行为出报告`,
      );
    } else {
      const expected = expectedScenarioIds(pw.report);
      // 差集基准是**首轮已经落盘的 raw id**：有 raw = 测到了，无论场景最终 PASS/WARN/FAIL
      const missing = unmeasuredScenarios(expected, [...run1.keys()]);
      for (const { id, status } of missing) {
        const parsed = parseScenarioId(id);
        results.push({
          id,
          scenario: parsed?.scenario ?? "unknown",
          tier: parsed?.tier ?? "unknown",
          kind: parsed?.kind ?? "unknown",
          env: first.env,
          profile: first.profile,
          mode: first.mode ?? "unknown",
          absoluteEnabled: false,
          baselineState: `UNMEASURED(${status})`,
          metrics: [],
          overMetrics: [],
          attribution: [],
          sessionProbe: null,
          // 合成对象没进任何轮次，#294 的新字段一律置空（它不参与判定，也不该被披露成候选）。
          // 字段集必须与正常场景**完全一致**——否则 latest.json 里同一份 schema
          // 会出现两种形状，下游按 confirmTrusted 读会拿到 undefined 而非 false。
          confirmExpected: false,
          confirmMeasured: false,
          confirmTrusted: true, // 没有候选即无可不信之处
          confirmMissingReason: null,
          unconfirmed: false,
        });
        unmeasuredIds.push(id);
      }
      if (unmeasuredIds.length > 0) {
        console.log(
          `[perf] 未测量场景 ${unmeasuredIds.length} 个（来自 playwright 报告 ${pw.file}）：` +
            unmeasuredIds.join(", "),
        );
      }
    }
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

  // confirm 相位（#294）：只产出「谁需要确认轮」这一编排信号，**不构成结论**，
  // 因此退出码恒为 0（与 check 同性质）。工作流据此决定是否起第三个 job。
  if (phase === "confirm") {
    writeFileSync(
      resolve(OUT_DIR, "retest2.json"),
      JSON.stringify(confirm, null, 2),
      "utf8",
    );
    console.log(
      confirm.length > 0
        ? `[perf] confirm：${confirm.length} 个场景需要确认轮（第三个 runner）→ ${confirm.join(", ")}` +
          (retestUntrusted.length > 0
            ? `（其中 ${retestUntrusted.length} 个因复测标定越界：${retestUntrusted.join(", ")}）`
            : "")
        : "[perf] confirm：无场景需要确认轮（无 R1∧R2 双超、无复测标定越界）",
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
    // 实际参与了本次判定的轮次（#294）。`confirm: false` 表示确认轮没跑或没采到样，
    // 读者据此判断「三轮都超」这类结论是否有三轮证据支撑。
    rounds: {
      measured: run1.size > 0,
      retest: run2.size > 0,
      confirm: run3.size > 0,
    },
    // UNCONFIRMED 场景（#294）：本来会确认 FAIL、但确认轮没能给出可信结论
    unconfirmed: unconfirmedIds,
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
  // 会话标定（#236）：把「机器慢」从「代码回归」里分开，**首轮 / 复测 / 确认轮三轮对账**。
  // 门槛选型：标定值的分布就是**机器档位的分布**（实测两档 ≈31ms / ≈50ms，同一次运行内
  // 16 个场景彼此只差 ~2ms），σ 自然很大 → 用 3σ 会几乎永不触发。所以判「是否超出历史范围」：
  // 落在范围内 = 与历史档位一致（只看是否"见过"）；超出上限 10% 才算环境异常。
  // 多轮对账的必要性见 sessionProbeOf 的注释：只看首轮会把"已在另一台机器复现的 FAIL"
  // 说成"请换 runner 重跑"，也会漏掉"复测机器慢导致的假 FAIL"；确认轮（#294）自己越界时
  // 更必须显式说明——那一轮是**唯一**能确认 FAIL 的证据源。
  // **「范围内」不等于排除环境（#259）**：代码零差异、各轮都落在双峰偏慢侧（+7.8% / +20.4%）
  // 仍复现 FAIL——所以范围内分支必须披露**每轮**偏差，并把最终裁决交给"换 runner 重跑"。
  const probes = results
    .filter((r) => r.sessionProbe)
    .map((r) => ({ id: r.id, ...r.sessionProbe }));
  const probeHist = probes.flatMap((p) => p.history ?? []);
  if (probes.length > 0 && probeHist.length > 0) {
    const lo = Math.round(Math.min(...probeHist) * 100) / 100;
    const hi = Math.round(Math.max(...probeHist) * 100) / 100;
    const pick = (key) => probes.map((p) => p[key]).filter((n) => typeof n === "number");
    const firstMed = pick("first").length > 0 ? median(pick("first")) : undefined;
    const retestMed = pick("retest").length > 0 ? median(pick("retest")) : undefined;
    const confirmMed = pick("confirm").length > 0 ? median(pick("confirm")) : undefined;
    const baseRef = median(probes.map((p) => p.base));
    // fmt 统一保留 ≤2 位小数：baseRef 是历史中位数，直接插值会把浮点噪声原样印进报告
    // （实测线上出现「基线参考 41.224999999999994ms」）
    const fmt = (v) => (typeof v === "number" ? `${Math.round(v * 100) / 100}ms` : "—");
    const beyond = (v) => typeof v === "number" && v > hi * 1.1;
    const firstBad = beyond(firstMed);
    const retestBad = beyond(retestMed);
    const confirmBad = beyond(confirmMed);
    const confirmed = failed.length > 0;

    let verdict;
    if (confirmBad) {
      // 确认轮（#294）自己越界 → 这一轮不足以确认 FAIL，结论已落 UNCONFIRMED。
      // 必须说清「为什么没有 FAIL」，否则读者会以为判定漏掉了。
      verdict =
        `**⚠️ 确认轮环境异常**（确认 ${fmt(confirmMed)} 超出历史范围）——` +
        `确认轮是唯一能确认 FAIL 的那一轮（#294），它自己不可信时不得产出 FAIL：` +
        `相关场景已落 **UNCONFIRMED**（逐行 WARN），请换 runner 重跑`;
    } else if (retestBad) {
      // 复测那台机器慢 → 复测值被整体抬高，可能把抖动顶成双超
      verdict =
        `**⚠️ 复测环境异常**（复测 ${fmt(retestMed)} 超出历史范围）——` +
        `复测值可能被机器档位放大，双超未必成立，该场景已被强制进入确认轮（#294）`;
    } else if (firstBad && confirmed) {
      // 首轮慢 + FAIL 已确认：**只有真的拿到复测侧标定**才能声称"多台 runner 上复现"
      // （复测轮没跑 / 老产物没有 probe 时不得替它下结论）
      verdict =
        typeof retestMed === "number"
          ? `**回归在「多个 runner 上复现」**（首轮 ${fmt(firstMed)} 超历史范围，复测 ${fmt(retestMed)} 已回到范围内` +
            `${typeof confirmMed === "number" ? `，确认 ${fmt(confirmMed)} 亦在范围内` : ""}）` +
            `——该 FAIL 不能归因于机器档位`
          : `首轮环境异常（${fmt(firstMed)} 超历史范围）且 FAIL 已确认，但**复测轮没有标定数据**` +
            `——无法判断复测环境，建议换 runner 重跑确认`;
    } else if (firstBad && !confirmed) {
      // 同样必须区分"有没有复测轮"：无嫌疑的运行**不会**触发复测（#234 的编排），
      // 这时说"复测已回落"是无中生有的归因（评审 R1 实测抓到）。
      verdict =
        typeof retestMed === "number"
          ? `首轮环境异常（${fmt(firstMed)} 超历史范围），复测已回落（${fmt(retestMed)}）` +
            `→ 支持「首轮机器慢」的解释`
          : `首轮环境异常（${fmt(firstMed)} 超历史范围），但**本次没有复测轮**（应用指标未超阈值、未触发复测）` +
            `——环境异常不影响本次结论`;
    } else {
      // 每轮都要给出相对基线参考的偏差（#259）：只报首轮会在实录里漏掉关键证据——
      // 同一份代码多轮都落在同档位偏慢侧（首轮 +7.8% / 复测 +20.4%）同样能顶出假 FAIL，
      // 旧文案「机器档位不足以解释它（须看代码或 IO 侧）」会把人引向代码侧找不存在的回归。
      const dev = (label, value) => {
        // 缺采集（老产物 / 没跑标定）时写「无标定数据」，**不伪造 0%**（曾把首轮印成"慢 0.0%"）
        if (typeof value !== "number") return `${label}无标定数据`;
        const pct = ((value - baseRef) / baseRef) * 100;
        return `${label}比基线参考${pct >= 0 ? "慢" : "快"} ${Math.abs(pct).toFixed(1)}%`;
      };
      verdict =
        `环境在历史范围内（**档位归因**：${dev("首轮", firstMed)}` +
        `${typeof retestMed === "number" ? ` / ${dev("复测", retestMed)}` : ""}` +
        `${typeof confirmMed === "number" ? ` / ${dev("确认", confirmMed)}` : ""}）——` +
        `标定负载覆盖 **CPU 与 DOM 构建/样式/布局**，不含 IO/网络；` +
        `**范围内只说明「档位与历史见过的一致」，不能据此排除环境**：同档位偏慢的多轮会话` +
        `同样能顶出假 FAIL（#259/#294）；FAIL 是否成立以**换 runner 重跑**为准——代码性回归不会因换 runner 消失`;
    }
    lines.push(
      `- 会话标定（与代码无关的固定工作量，#236）：基线参考 ${fmt(baseRef)}，历史范围 ${lo}–${hi}ms，` +
        `首轮 ${fmt(firstMed)}${typeof retestMed === "number" ? ` / 复测 ${fmt(retestMed)}` : ""}` +
        `${typeof confirmMed === "number" ? ` / 确认 ${fmt(confirmMed)}` : ""}` +
        `（${probes.length} 个场景）→ ${verdict}`,
    );
  }

  // ── 确认轮披露（#294）──────────────────────────────────────────────────
  // 必须显式报出「本该确认的场景」与「没能确认」的两组，否则读者无法区分
  // 「跑了两轮就下结论」与「跑了三轮才下结论」——这两者的证据强度完全不同。
  if (confirmCandidates.length > 0) {
    lines.push(
      `- 确认轮：${confirmCandidates.length} 个场景进入 retest-2（${confirmCandidates.join(", ")}）` +
        `——FAIL 须由第三个独立 runner 确认（#294：两轮可能被并发同时拖慢）`,
    );
  }
  if (retestUntrusted.length > 0) {
    const detail = results
      .filter((r) => retestUntrusted.includes(r.id) && r.sessionProbe)
      .map((r) => {
        const p = r.sessionProbe;
        const hiLocal = Math.round(Math.max(...p.history) * 100) / 100;
        return `${r.id}:probeMs ${Math.round(p.retest * 100) / 100}ms 超历史上限 ${hiLocal}ms`;
      });
    lines.push(
      `- ⚠️ 复测环境不可信：${detail.join("；")}——` +
        `已强制进入确认轮。**标定越界不作 FAIL 抑制门禁**（#294 实证其既非必要也非充分：` +
        `范围内照样出假 FAIL、高偏差的核验会话照样正常），它只决定「要不要再验一轮」`,
    );
  }
  // 编排说要确认的场景，逐个交代结果。**「没消息」不等于「已确认」**（#294 评审 P1）：
  // 先前这里只按 unconfirmedIds 是否为空来印「均已给出可信结论」，于是
  // 「仅因 R2 标定越界进候选、但确认轮没测到」的场景会被算成"已确认"——
  // 报告同页上一行还写着「1 个场景进入 retest-2」，自相矛盾。
  const candidateOutcomes = results
    .filter((r) => r.confirmExpected)
    .map((r) => ({ id: r.id, trusted: r.confirmTrusted, reason: r.confirmMissingReason }));
  const untrustedCandidates = candidateOutcomes.filter((c) => !c.trusted);
  if (untrustedCandidates.length > 0) {
    lines.push(
      `- ⚠️ 确认轮未给出可信结论：${untrustedCandidates.length}/${candidateOutcomes.length} 个候选场景（` +
        `${untrustedCandidates.map((c) => `${c.id}:${c.reason}`).join("，")}）——` +
        `编排要求它们由第三个 runner 给结论，但没有拿到。相关场景一律不判 FAIL` +
        (process.env.PERF_REQUIRE_COMPARISON === "1"
          ? "（本次要求完整比较 → 以 exit 2 报出）"
          : "（PR 运行只披露，不阻断）"),
    );
  } else if (candidateOutcomes.length > 0) {
    lines.push(
      `- 确认轮：${candidateOutcomes.length} 个候选场景均已给出可信结论（无 UNCONFIRMED）`,
    );
  }
  if (unconfirmedIds.length > 0) {
    lines.push(
      `- ⚠️ 未确认：${unconfirmedIds.length} 个场景（${unconfirmedIds.join(", ")}）——` +
        `本来会确认 FAIL（首轮 + 复测双超），但确认轮缺失 / 环境不可信 / 缺该指标，**结论不完整**。` +
        `这些场景一律不判 FAIL，请换 runner 重跑` +
        (process.env.PERF_REQUIRE_COMPARISON === "1"
          ? "（本次要求完整比较 → 以 exit 2 报出）"
          : "（PR 运行只披露，不阻断）"),
    );
  }
  const absoluteCount = results.filter((r) => r.absoluteEnabled).length;
  if (absoluteCount > 0) {
    lines.push(
      `- 绝对阈值参与判定：${absoluteCount}/${results.length} 个场景（帧间隔 p95 ≤ ${P95_BUDGET_FACTOR}× 帧预算、掉帧率 ≤ ${JANK_RATE_LIMIT_PCT}%）`,
    );
  }
  // 名单**从 PRIMARY_METRICS 派生**，不硬编码：之前写死的名单里有一个不存在的 inputMs
  // （把 inputSyncMs / inputPaintMs 两个主指标写成了一个并不存在的名字），
  // 而读者会据此理解"哪些指标能单独判 FAIL"。派生 + 单测断言，名单再漂移会当场失败。
  lines.push(
    `- 判定分层：主指标（${PRIMARY_METRICS.join(" / ")}）可单独判 FAIL；` +
      `派生指标（longTaskMs / longTaskCount / jankRate 等）需同场景有主指标**同样被判 FAIL**` +
      `（${payload.rounds.confirm ? "参与判定的每一轮都超阈值" : "首轮与复测都超阈值"}）才判 FAIL，否则只提示 WARN`,
  );
  // 判定轮次（#294）：必须显式报出本次结论是「几轮证据」支撑的。
  // 两轮判出来的 FAIL 与三轮判出来的 FAIL 证据强度不同，读者有权知道差别。
  lines.push(
    `- 判定轮次：首轮 ✓　复测 ${payload.rounds.retest ? "✓" : "—"}　确认 ${payload.rounds.confirm ? "✓" : "—"}` +
      `——**FAIL 须由「参与判定的每一轮都超阈值」确认**（#294：共享 runner 池内两个会话可能` +
      `被并发同时拖慢，双超不等于回归；实证 3 例换 runner 复跑全部证伪）` +
      (payload.rounds.confirm ? "" : `。本次无确认轮证据，R1∧R2 双超一律不判 FAIL（落 UNCONFIRMED）`),
  );
  // 生效地板（#270 方案 B）：小基数计数指标的登记常数若比它自身的跨运行散布还小，
  // 会被「由历史散布推导的下限」抬高。必须显式列出——否则读者看到"低于绝对地板"
  // 会以为是登记的那个常数，无法判断判定是否被悄悄放宽/收紧。
  // 「抬高」的判据是**严格大于登记常数**（#274）：推导值恰好等于登记常数时地板并没变，
  // 以前按 `absMin === floorDerived` 过滤会把这类行也算进去，让读者高估被收紧的行数。
  // 无登记常数的指标不算「抬高」（#285，见 judgment.isRaisedFloor）——它的地板完全来自
  // 历史散布，谈不上「登记常数不足」；此前用 `?? 0` 兜底会恒真、配上与事实相反的措辞。
  const raisedFloors = results.flatMap((r) =>
    r.metrics
      .filter((m) => isRaisedFloor(m.registeredAbsMin, m.floorDerived))
      .map((m) => `${r.id}:${m.metric} → ${round(m.absMin)}`),
  );
  if (raisedFloors.length > 0) {
    lines.push(
      `- 生效地板：${raisedFloors.length} 行按「同代码历史散布」抬高到 ${COUNT_FLOOR_FACTOR}×历史极差` +
        `（登记常数不足以覆盖该指标自身的噪声，见 #270 方案 B）：${raisedFloors.join("、")}`,
    );
  }
  if (absoluteCount < results.length) {
    lines.push(
      `- 其余 ${results.length - absoluteCount} 个场景未参与绝对判定：本次为 headless 测量（vsync 锁 60Hz，帧间隔反映显示器节拍而非单帧工作耗时）。要拿绝对结论请用 PERF_HEADED=1 或 PERF_UNCAPPED=1，或用 PERF_ABSOLUTE=1 强制开启`,
    );
  }
  lines.push("");
  // 「复测2」列（#294）：第三轮的值。未参与该行的场景填 `—`——它与"回落"是两件事，
  // 空单元格会被读成"测了但没数据"。
  lines.push("| 场景 | 指标 | baseline | 本次 | 复测 | 复测2 | 变化 | 3σ（占参考） | 判定 |");
  lines.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    // 不可比（或基线里没有可用指标）时必须显式出现在表里：
    // 否则读者会把"没有相对行"误读成"相对判定通过"
    const cov = coverageState(r);
    if (cov !== "OK") {
      lines.push(
        `| ${r.id} | 基线 | — | — | — | — | — | 未参与相对判定：${cov} |`,
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
        `| ${r.id} | ${m.metric} | ${m.base} | ${m.cur} | ${m.retest ?? "—"} | ${m.retest2 ?? "—"} | ${delta} | ${noiseCell} | ${
          m.verdict
        }${m.note ? `（${m.note}）` : ""} |`,
      );
    }
  }
  // 归因指标（issue #379）：与判定表分开，避免被读成 PASS/FAIL 行。
  const attributionRowsAll = results.flatMap((r) =>
    (r.attribution ?? []).map((row) => ({ id: r.id, ...row })),
  );
  if (attributionRowsAll.length > 0) {
    lines.push("");
    lines.push("### 归因指标（进基线、不参与判定，issue #379）");
    lines.push("");
    lines.push("| 场景 | 指标 | 基线参考 | 本次 | 变化 |");
    lines.push("|---|---|---|---|---|");
    for (const row of attributionRowsAll) {
      const delta =
        typeof row.base !== "number" || row.base === 0
          ? "—"
          : `${(((row.cur - row.base) / row.base) * 100).toFixed(1)}%`;
      lines.push(
        `| ${row.id} | ${row.metric} | ${row.base ?? "—"} | ${round(row.cur)} | ${delta} |`,
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

  // 「整轮确认轮没测到」（#294）：retest2.json 有候选，但 raw-retest2/ 一份采样都没有。
  // 这不是"结论不完整"而是"确认环节根本没跑"——复用「未测量」语义，PR 与 tag 一律 exit 2。
  // 判据只认「有候选 + 零采样」两件事，**不依赖 unconfirmedIds**（#294 评审 P1）：
  // 候选可能只因 R2 标定越界进、而该行 R2 并未超，那样的场景永远不会进 unconfirmedIds，
  // 挂上这个条件就会让「编排要求确认却一份采样都没有」静默以 exit 0 收尾。
  const confirmRoundMissing = confirmCandidates.length > 0 && run3.size === 0;

  // 方向 2（issue #247）：未测量场景是「没测到」（单场景超时/失败、无采样落盘），
  // 与覆盖不足同属"结论不完整"——exit 2 优先于 exit 1（已测场景的 FAIL 照常列在表格里）。
  // 放在覆盖不足判定**之前**：未测量是更具体的成因，先把清单指名道姓地报出来。
  if (unmeasuredIds.length > 0) {
    console.error(
      `[perf] 有 ${unmeasuredIds.length} 个场景未测量（timeout / 失败，无采样落盘）：${unmeasuredIds.join(", ")}\n` +
        `        已测场景照常参与判定；未测量场景在报告里单列（UNMEASURED），不计入 FAIL / WARN。\n` +
        `        本次结论**不完整**，请修复超时 / 失败后重跑（否则与"没回归"在退出码层面无法区分）。`,
    );
    process.exit(2);
  }
  // #294：确认轮整轮没测到 —— 候选存在却没有第三轮数据，属 infra 故障（exit 2）。
  // 为什么 PR 与 tag 一律 exit 2（不像 UNCONFIRMED 那样只在 tag 升级）：
  // 编排已经决定"这些场景要确认"，却一份采样都没落盘 —— 这是**链路故障**，
  // 和 #247 的未测量同性质。若只披露不报出，PR 会以 exit 0 收尾，
  // 而报告里明明写着 N 个场景未确认，读者只会以为"复测回落了"。
  if (confirmRoundMissing) {
    console.error(
      `[perf] 确认轮整轮未测量：${confirmCandidates.length} 个候选场景（${confirmCandidates.join(", ")}）` +
        `本应由 retest2 job 在新 runner 上复测，但 .perf-output/raw-retest2/ 无任何采样。\n` +
        `        这些场景一律不判 FAIL（落 UNCONFIRMED，见报告披露行）。\n` +
        `        本次结论**不完整**，请检查 retest2 job / 换 runner 重跑。`,
    );
    process.exit(2);
  }
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

  // UNCONFIRMED（#294）：本来会确认 FAIL，但确认轮缺失 / 环境不可信 / 缺该指标。
  // 与仓库既有口径一致——**结论不完整 ≠ 没回归**。tag 运行（PERF_REQUIRE_COMPARISON=1）
  // 以 exit 2 终止，不会伪装成绿；PR 运行只披露 + 逐行 WARN（不阻断合并，issue #216 既定要求）。
  if (unconfirmedIds.length > 0 && process.env.PERF_REQUIRE_COMPARISON === "1") {
    console.error(
      `[perf] 有 ${unconfirmedIds.length} 个场景未确认：${unconfirmedIds.join(", ")}\n` +
        `        它们本来会确认 FAIL（首轮 + 复测双超），但确认轮没能给出可信结论` +
        `（缺失 / 环境不可信 / 缺该指标），因此**一律不判 FAIL**。\n` +
        `        本次结论**不完整**：发版验证要求确认轮给出可信结论，请换 runner 重跑。`,
    );
    process.exit(2);
  }
  if (unconfirmedIds.length > 0) {
    console.log(
      `[perf] 未确认场景 ${unconfirmedIds.length} 个（${unconfirmedIds.join(", ")}）：` +
        `确认轮缺失 / 环境不可信 / 缺该指标，一律不判 FAIL——请换 runner 重跑以确认或排除`,
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
    // 轮次措辞必须与实际证据一致（#294）：三轮确认出来的 FAIL 与两轮不是一回事。
    const roundsWord =
      (payload.rounds.measured ? 1 : 0) +
      (payload.rounds.retest ? 1 : 0) +
      (payload.rounds.confirm ? 1 : 0);
    if (relativeFailed.length > 0) {
      console.error(
        `\n[perf] 相对回归确认（${roundsWord} 轮均超阈值）：${relativeFailed
          .map((f) => f.id)
          .join(", ")}`,
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

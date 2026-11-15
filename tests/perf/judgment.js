// 判定策略（report.mjs 运行期与单测共用同一份实现）
//
// 为什么单独成模块：这里的每个数字与每条分层规则都决定"什么算回归"，
// 判断错了产出的不是噪声而是误导性结论（曾出现同一份代码因 runner 抖动
// 被连续判定为 5 次"回归"）。抽出来后单测可以断言**线上实现**本身，
// 而不是断言它的副本。judgment.d.ts 提供类型。

/** 中位数（与 report 的聚合口径一致；统一在这里定义，避免多处实现漂移） */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 样本标准差（n-1）。少于 2 点无法估计，返回 null */
export function sampleSd(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  return Number.isFinite(sd) ? sd : null;
}

/**
 * 噪声门槛倍数：变化必须超过 **3σ** 才算可行动。
 *
 * 为什么必须有这一层（实测，同一份代码的 5 次 CI 运行）：
 *   ttiMs        基线 888ms   3σ≈241ms（占 27%）
 *   longTaskMs   基线 302ms   3σ≈161ms（占 53%）
 *   inputSyncMs  基线 1.9ms   3σ≈1.25ms（占 66%）
 *   frameMs.p95  基线 17.1ms  3σ≈0.39ms（占 2.3%，vsync 量化反而极稳）
 * 也就是"哪个指标能分辨多大差异"是**环境属性**，靠人给常数（15%）必然出错——
 * 本 PR 前几轮反复出现的假 FAIL 与漏检，根因都在这里。
 */
export const NOISE_SIGMA = 3;

/** 估计噪声所需的最少历史点数（少于 3 点不足以谈散布） */
export const NOISE_MIN_POINTS = 3;

/** 由历史序列估计 3σ 门槛；历史不足或零方差时返回 null（判定退化为百分比 + 绝对地板） */
export function noiseThreshold(history, sigma = NOISE_SIGMA) {
  if (!Array.isArray(history) || history.length < NOISE_MIN_POINTS) return null;
  const sd = sampleSd(history);
  if (sd === null || sd <= 0) return null;
  return sigma * sd;
}

/**
 * 参考值使用的**滚动窗口**长度（取历史里最近 K 点，issue #270 方案 C）。
 *
 * 取 4（HISTORY_MAX=8 的一半）：参考值要跟随 runner 池的**当前档位**，而历史里越早的点
 * 越可能来自更快的环境。实测 `scroll-M-rich.longFrameCount` 的全历史中位数是 0.75、
 * 最近两点是 3 和 2——用全历史当参考等于拿几天前的快机器当基准。
 *
 * ⚠️ **窗口化只用于「上抬」方向**，见 referenceValue 的说明：无偏地取窗口会让参考值跟着
 * 噪声一起下压，把判定系统性推向偏严。
 *
 * 注意：**散布估计（3σ）不跟着缩窗**——σ 的稳定性依赖点数（仓库纪律：3 点相对误差约 50%、
 * 8 点约 27%），而窗口更宽只会让门槛更保守，不会放松。
 */
export const REFERENCE_WINDOW = 4;

/**
 * 比较时使用的参考值：历史点数足够时，取**全历史中位数**与**最近 REFERENCE_WINDOW 点中位数**
 * 中的**较高者**；否则退化为全历史中位数，再退化为基线记录的点值。
 *
 * 为什么不用单点基线：实测 5 次同代码运行的聚合值整体偏移达 -8%~-25%
 * （基线那次恰好是偏慢的一次），单点参考会把整批指标一起判成"改善"或"恶化"。
 *
 * 为什么窗口只允许**上抬**（#270 方案 C 的实测取舍）：
 * - 本方案要修的成因只有一个方向——「参考值停在更快的旧环境」→ 参考偏低 → 相对变化被放大
 *   → 假 FAIL。`scroll-M-rich` 的 `longFrameCount` 就是这种（0.75 vs 近况 1.25）。
 * - 反方向（近况低于全历史中位数时把参考压下去）会让参考**系统性偏严**：实测 quick 档基线里
 *   46 行会被下压（最多 -50%，多数是 8 点中位数本就带着更早的快机器），只有 2 行上抬。
 *   把无偏窗口用上之后，本次待修的样本反而从 exit 0 变成 exit 1（`frameMs.p95` 参考 23.8→22.9，
 *   复测 +29.7% 越过 25% 阈值）——与"消除假 FAIL"的目标相反。
 * - 要让「环境变快」也能安全地反映到参考值上，前提是**环境归一化**（用会话标定 probeMs 把
 *   参考值缩放到当轮档位），那需要单独立项——本文件把 DRIFT_WARN_PCT 标定只做披露也是同一原因。
 */
export function referenceValue(entry, statistic = "median") {
  if (!entry) return undefined;
  const key = statistic === "p95" ? "historyP95" : "history";
  const history = entry[key];
  if (Array.isArray(history) && history.length >= NOISE_MIN_POINTS) {
    return Math.max(median(history), median(history.slice(-REFERENCE_WINDOW)));
  }
  return entry[statistic];
}

/** 取某个统计量对应的噪声门槛（3σ） */
export function noiseFor(entry, statistic = "median") {
  const key = statistic === "p95" ? "historyP95" : "history";
  return noiseThreshold(entry?.[key]);
}

/**
 * 噪声门槛的"分辨率"：3σ 占参考值的百分比。
 *
 * 它回答"这个指标在当前环境下最小能分辨多大的变化"——占比 50% 意味着
 * 小于一半的变化在统计上与抖动不可分，该行即使显示 PASS 也不能读成"没问题"。
 * 这正是"静默漏检"的来源：假 FAIL 会被人发现，掩盖真回归不会。
 *
 * σ 不可用（历史 <3 点或零方差）或参考值 ≤ 0 时返回 null（此时无门槛可谈）。
 */
export function resolutionPct(entry, statistic = "median") {
  const noise = noiseFor(entry, statistic);
  const reference = referenceValue(entry, statistic);
  if (noise === null || !(reference > 0)) return null;
  return (noise / reference) * 100;
}

/**
 * 会话标定指标（issue #236）：与编辑器代码无关的固定合成工作量（见 metrics.runSessionProbe）。
 *
 * 关键区别——**进基线，但不参与判定**：
 * - **要进基线**：只有持久化了历史，报告才能算出参考值、3σ 门槛与"环境异常"结论；
 * - **不参与判定**：`COMPARED_SCALARS` 是判定白名单，标定指标刻意不在其中——
 *   机器变慢不是代码回归，它绝不能被判成 FAIL/WARN。
 *
 * ⚠️ 这两个集合必须分开维护：`buildStats`（写基线）取两者的并集，
 * 判定循环只取 `COMPARED_SCALARS`。实测踩过——把标定值只留给"不持久化"的一侧，
 * 结果是播种产物里根本没有 `probeMs`，基线没有历史、归因行永远不出现。
 */
export const SESSION_PROBE_METRICS = ["probeMs", "probeLayoutMs", "probeCpuMs"];

/**
 * 归因指标（issue #379）：统计 / 大纲 / 标题定位 / KaTeX 的分解成本。
 *
 * 与 SESSION_PROBE_METRICS 同族——**进基线、不参与判定**：
 * 它们是「钱花在哪」的披露，不是用户可感知耗时的回归目标；把它们判成 FAIL/WARN
 * 会让归因行本身变成噪声源。真正的判定仍由 inputSyncMs / inputPaintMs / ttiMs 等主指标承担。
 *
 * 名称必须与 `tests/perf/metrics.ts` 的 ATTRIBUTION_BUCKETS 派生结果一致，
 * 单测 `perf-attribution.test.ts` 直接对账，防止两边漂移。
 */
export const ATTRIBUTION_METRICS = [
  "statsMs",
  "statsMaxMs",
  "statsCount",
  "statsSettleMs",
  "statsSettleMaxMs",
  "statsSettleCount",
  "outlineExtractMs",
  "outlineExtractMaxMs",
  "outlineExtractCount",
  "outlineSettleMs",
  "outlineSettleMaxMs",
  "outlineSettleCount",
  "headingLocateMs",
  "headingLocateMaxMs",
  "headingLocateCount",
  // outlinePublish 只计次数（perfProbeCount）：没有 Ms/MaxMs，见 metrics.COUNT_ONLY_BUCKETS
  "outlinePublishCount",
  "katexLoadMs",
  "katexLoadMaxMs",
  "katexLoadCount",
  "katexRenderMs",
  "katexRenderMaxMs",
  "katexRenderCount",
  "formulaNodeViewMs",
  "formulaNodeViewMaxMs",
  "formulaNodeViewCount",
  "formulaReadyMs",
  "formulaNodeViews",
  "formulaRendered",
  "formulaLateLongTaskCount",
  "formulaLateLongTaskMs",
];

/**
 * 分辨率提醒阈值（%）：3σ 达到参考值这个比例时，报告会显式列出该指标。
 *
 * 取 30% 的依据：默认劣化阈值是 15%（p95 为 25%），3σ 一旦超过两倍基础阈值，
 * 意味着"连默认阈值 2 倍幅度的变化都测不出来"，此时该指标的相对判定只剩
 * "抓大事故"的能力，读者必须知道。低于此值则门槛仍能覆盖默认阈值，无需提醒。
 */
export const RESOLUTION_WARN_PCT = 30;

/**
 * 整机漂移提醒阈值（%）：比基线差的相对行占比达到这个比例时，报告会提示
 * 「本次疑似整机变慢」。
 *
 * 取 70% 的依据：纯噪声下"变差"的行占比应在 50% 附近（参考值取历史中位数，
 * 上下对称）；实测一次共享 runner 被拖慢的运行是 **88%**（50/57 行、中位 Δ +18.7%，
 * 16 个场景里互不相关的指标一起变差），而同分支安静时段运行接近 50%。
 * 70% 落在两者之间，留有足够余量。
 *
 * **只做披露、不改判定**：整体变慢也可能是真实回归（例如全链路变慢），
 * 在共享 runner 上二者无法凭此区分——真正的区分需要环境无关的标定负载，
 * 属于后续工作。这里只把证据摆在 FAIL 旁边，避免读者误判成因。
 */
export const DRIFT_WARN_PCT = 70;

/** 默认劣化阈值（%）；可按指标覆盖 */
export const DEFAULT_PCT = 15;

/** p95 天然比中位数抖，在基础阈值上放宽 */
export const P95_EXTRA_PCT = 10;

/**
 * 指标阈值覆盖。标定依据都来自真实采样（同一份代码的多次运行）：
 *
 * - longTaskCount：基数常常是 0，纯百分比会被无限放大 → 要求「+20% 且 +5」同时成立
 * - longTaskMs：少数 long task 的求和（样本里只有 1~5 段），实测噪声样本为
 *   +25.0%/+34ms、+18.9%/+76ms、+16.5%/+69ms、+17.5%/+329ms、+35.7%/+81ms
 *   ——百分比与绝对值都无法单独区分噪声，故要求「+50% 且 +100ms」同时成立；
 *   真正的成倍恶化（136→250ms、227→500ms）仍会被判 FAIL
 * - inputSyncMs：**量级只有 1.5~2.5ms**，15% 阈值等于 0.29ms，完全埋在噪声里。
 *   同代码实测中位数：本机 1.5 / 1.6 / 2.0，CI 1.9 / 2.2 / 2.5（散布 ±0.5ms），
 *   故加绝对地板「Δ≥1ms」：CI 曾因 Δ0.3ms 判出假 FAIL
 * - saveMs：同代码实测 33.4 / 34.0 / 38.0ms（散布 4.6ms ≈ 13.5%，已逼近 15% 阈值），
 *   故加绝对地板「Δ≥8ms」
 * - longFrameCount：同 longTaskCount 的基数问题
 * - jankCount / jankRatePct：稳态基数为 0，用绝对增量门槛
 * - cls：基数极小（千分位），用绝对增量判定
 * - heapDeltaMB：波动天然大，放宽到 25%
 *
 * 通用原则：每个指标都有**可分辨的噪声地板**，低于地板的差异不可行动。
 * 地板必须由同代码的重复实测得出，不能凭感觉给。
 */
export const METRIC_RULES = {
  longTaskCount: { pct: 20, absMin: 5 },
  longTaskMs: { pct: 50, absMin: 100 },
  longFrameCount: { pct: 20, absMin: 3 },
  jankCount: { pct: 50, absMin: 6 },
  jankRatePct: { pct: 50, absMin: 5 },
  inputSyncMs: { pct: 15, absMin: 1 },
  saveMs: { pct: 15, absMin: 8 },
  cls: { abs: 0.02 },
  heapDeltaMB: { pct: 25 },
};

/**
 * 「小基数计数指标」需要额外保护的那一批（issue #270 方案 B）。
 *
 * 为什么单独列出来：这类指标的**参考值只有个位数**，百分比规则等于把小差异无限放大
 * （0.75 → 4 就是 +433%），而手写的 `absMin` 常数又往往比该指标**自身**的跨运行散布还小
 * （实测 `scroll-M-rich.longFrameCount` 的 history 极差就是 3，登记地板也是 3 → 门槛贴着噪声走）。
 * 反过来，L/XL 档上 `longFrameCount` 能到 100+，百分比规则本就有效，再额外收紧是多余的。
 */
export const COUNT_METRICS = ["longFrameCount", "jankCount", "longTaskCount"];

/** 参考值低于此值的计数指标被视为「小基数」——此时才启用历史推导地板 */
export const COUNT_SMALL_BASE = 10;

/**
 * 历史极差 → 地板下限的系数。
 *
 * 取 1.5 的依据：参考值取的是**中位数**，而同一份代码的极差是 R —— 一次运行落在极值、
 * 另一次落在中位数，delta 就已经接近 R；要求 1.5R 意味着「明显超出这份代码历史见过的范围」
 * 才可行动。真正的成倍恶化（0.75/1.25 量级 → 8+）仍远超该地板。
 */
export const COUNT_FLOOR_FACTOR = 1.5;

/**
 * 由**同一份代码的历史散布**推导的绝对地板下限（#270 方案 B）。
 *
 * 只对「小基数计数指标」生效，且只用于**收紧**（调用方取与登记常数的较大者）。
 * 依据来自基线自身的 history（同一环境、同一 fixture 的逐次运行），符合仓库纪律
 * 「地板必须由同代码的重复实测得出，不能凭感觉给」。
 */
export function historyFloor(entry, metric, statistic = "median") {
  if (!COUNT_METRICS.includes(baseMetric(metric))) return undefined;
  const key = statistic === "p95" ? "historyP95" : "history";
  const history = entry?.[key];
  if (!Array.isArray(history) || history.length < NOISE_MIN_POINTS) return undefined;
  const reference = referenceValue(entry, statistic);
  if (!(typeof reference === "number" && reference < COUNT_SMALL_BASE)) return undefined;
  const range = Math.max(...history) - Math.min(...history);
  return range > 0 ? COUNT_FLOOR_FACTOR * range : undefined;
}

/**
 * 该指标在当前基线上**生效**的绝对地板：登记常数与历史推导下限取较大者。
 * 返回 undefined 表示该指标没有地板（走纯百分比判定）。
 *
 * 单向性：`historyFloor` 只会抬高地板，永远不会把它降到登记值以下——所以本函数
 * 只可能收紧判定，不可能放宽。
 */
export function effectiveAbsMin(entry, metric, statistic = "median") {
  const rule = ruleFor(metric);
  if (rule.abs !== undefined) return undefined;
  const derived = historyFloor(entry, metric, statistic);
  if (rule.absMin === undefined) return derived;
  if (derived === undefined) return rule.absMin;
  return Math.max(rule.absMin, derived);
}

/**
 * 「生效地板」是否**真的**被历史推导值抬高（报告披露口径，#274 / #285）。
 *
 * 判据是**严格大于登记常数**（#274）：推导值恰好等于登记常数时地板并没变，
 * 列为「抬高」会让读者高估被收紧的行数。
 *
 * 没有登记常数时（`registeredAbsMin` 非数字）一律返回 false——那种指标的地板完全来自
 * 历史散布，谈不上「登记常数不足以覆盖该指标自身的噪声」（#285）。若按 `?? 0` 兜底，
 * `floorDerived > 0` 恒真，会把这类行配上与事实相反的措辞。当前 `COUNT_METRICS` 里的
 * 指标都登记了 `absMin`，本分支不可达，但它决定了将来扩展 `COUNT_METRICS` 时的语义。
 */
export function isRaisedFloor(registeredAbsMin, floorDerived) {
  return typeof registeredAbsMin === "number" && floorDerived > registeredAbsMin;
}

/**
 * 主指标：直接反映用户可感知的耗时，可以**单独**判定 FAIL。
 * 它们的量级大（数百毫秒级）且语义明确，CI 抖动的相对影响可控。
 */
export const PRIMARY_METRICS = [
  "ttiMs",
  "inputSyncMs",
  "inputPaintMs",
  "frameMs",
  "searchMs",
  "switchMs",
  "saveMs",
];

/**
 * 只有这些标量参与比较；matchCount / frameBudgetMs / step 之类是 fixture 属性或测量配置。
 */
export const COMPARED_SCALARS = [
  "longTaskCount",
  "longTaskMs",
  "longFrameCount",
  "jankCount",
  "jankRatePct",
  "cls",
  "heapDeltaMB",
];

/** 去掉 `.p95` 后缀，取基础指标名 */
export function baseMetric(metric) {
  return metric.endsWith(".p95") ? metric.slice(0, -4) : metric;
}

/** 是否为主指标（`.p95` 行继承其基础指标的分层） */
export function isPrimary(metric) {
  return PRIMARY_METRICS.includes(baseMetric(metric));
}

/**
 * 该指标是否**必须**有主指标佐证才能判 FAIL。
 *
 * 规则：只有显式登记在 PRIMARY_METRICS 里的指标才享有"单独判 FAIL"的能力，
 * 其余（派生/计数/求和/占比/未知指标）都要求同一场景内有主指标同样超阈值。
 * 理由：同一份代码在共享 CI runner 上，longTaskMs 这类派生标量能自然波动 35%
 * （实测），没有主指标佐证的"回归"不可行动；反过来，真正影响用户可感知耗时的
 * 退化必然会体现在主指标上。
 *
 * 未知指标默认纳入"需佐证"一侧——"能单独判 FAIL"是一种需要论证的特权，
 * 新指标想获得它，必须显式加进 PRIMARY_METRICS。
 */
export function requiresPrimaryCorroboration(metric) {
  return !isPrimary(metric);
}

/** 取指标对应的阈值规则（`xxx.p95` 行在基础规则上放宽，并继承绝对地板） */
export function ruleFor(metric) {
  if (METRIC_RULES[metric]) return METRIC_RULES[metric];
  if (metric.endsWith(".p95")) {
    const base = METRIC_RULES[baseMetric(metric)] ?? { pct: DEFAULT_PCT };
    return {
      pct: (base.pct ?? DEFAULT_PCT) + P95_EXTRA_PCT,
      // 绝对地板必须继承：否则 inputSyncMs.p95 这种 2ms 量级的尾部指标
      // 仍会被 0.3ms 的噪声顶过 25% 阈值
      ...(base.absMin !== undefined ? { absMin: base.absMin } : {}),
    };
  }
  return { pct: DEFAULT_PCT };
}

/**
 * 单指标是否劣化超阈值。
 * - 规则带 abs 时按绝对增量判定
 * - 基数为 0 时百分比无意义，退化为绝对增量门槛（absMin）
 * - 规则同时带 pct 与 absMin 时要求两者**同时**成立（避免小基数百分比放大）
 *
 * `absMin` 参数是**调用方算好的生效地板**（`effectiveAbsMin`，含历史推导下限，见 #270 方案 B）；
 * 不传即退回规则里登记的常数。调用方只允许传「登记值与推导值取大者」，
 * 传更小的值会放宽判定——这是本函数唯一的越权用法，故在 effectiveAbsMin 里做单向保证。
 */
export function isOver(metric, current, base, noise, absMin) {
  const rule = ruleFor(metric);
  const delta = current - base;
  if (rule.abs !== undefined) return delta > rule.abs;
  const floor = absMin === undefined ? rule.absMin : absMin;
  if (base === 0) {
    return delta > (floor ?? 0.5);
  }
  const pctOk = delta / base > rule.pct / 100;
  const minOk = floor === undefined || delta >= floor;
  // 噪声门槛：变化必须超过 3σ（来自基线历史），否则无法与运行间抖动区分
  const noiseOk = typeof noise !== "number" || delta > noise;
  return pctOk && minOk && noiseOk;
}

/**
 * 多轮聚合（issue #294）：把「哪几轮超阈值」折叠成一个终判。
 *
 * ## 为什么要第三个独立会话
 *
 * 修复前只有两轮（首轮 + 复测），而 `FAIL ⟺ R1 ∧ R2` 的防线有个盲区：
 * **两个会话可以同时被拖慢**。共享 runner 池内跨工作流的并发（自家 Build/test、
 * 打包、其他 Benchmark）会让同一次测量窗口里的两台 VM 一起变慢，此时
 * 「连续 2 次复现」成立，但结论是错的——2026-09-30 实证 3 例（main 与两个 PR），
 * 换 runner 静默复跑全部证伪。
 *
 * ## 规则：末轮仍超才算确认
 *
 * 只有**参与判定的最后一轮**仍超阈值、且此前各轮也都超，才算确认回归。
 * 末轮回落即降 WARN（抖动）——真回归跨 runner 稳定复现，而环境争用会随轮次收敛。
 *
 * 取「末轮仍超」而不是「多数 ≥2/3」：实测 3 例假 FAIL 的核验轮**全部**回落，
 * 2/3 多数会把其中 2 例继续判 FAIL。
 *
 * ## 调用方契约（report.mjs 负责，本函数不校验）
 *
 * `overRounds` 必须只包含**实际参与了本次判定**的轮次，且按轮次顺序排列：
 * - 有确认轮 → `[R1是否超, R2是否超, R3是否超]`（三段）
 * - 无确认轮 → `[R1是否超, R2是否超]`（两段；此时 report 还有一道门禁：
 *   双超但确认轮缺失一律落 UNCONFIRMED，**不会**把两段结果当成确认 FAIL）
 * - 没有复测轮 → `[R1是否超]`（一段，结果恒为 warn，符合「未复测 ≠ 没回归」）
 *
 * 「缺失」与「未超」必须由调用方区分后决定传不传：把缺失当成 `false` 塞进数组
 * 会让 `every(Boolean)` 误判成「回落」。缺测场景由 report.mjs 单独走 UNCONFIRMED
 * 分支，不经过本函数。
 */
export function confirmVerdict(overRounds) {
  if (!Array.isArray(overRounds) || overRounds.length === 0) return "pass";
  return overRounds.every(Boolean) ? "fail" : "warn";
}

/**
 * 一行"过了相对阈值、但被抑制"的原因；没有则返回 null。
 *
 * 为什么需要它：被抑制不等于"没变化"。若直接落成 PASS，读者会以为指标纹丝不动，
 * 而实际上它可能涨了 25%（只是幅度在实测噪声/绝对地板之内）。判定要可解释：
 * - "floor"：幅度低于该指标的绝对地板（如 inputSyncMs Δ<1ms，或小基数计数指标的历史推导下限）
 * - "noise"：幅度在运行噪声内（< 3σ，来自基线历史）
 *
 * `absMin` 与 `isOver` 同义：调用方传入的生效地板。
 */
export function suppressionReason(metric, current, base, noise, absMin) {
  const rule = ruleFor(metric);
  const delta = current - base;
  if (delta <= 0) return null; // 改善或持平不算"被抑制"
  if (rule.abs !== undefined) return null; // 绝对值型指标没有相对阈值可谈
  if (base === 0) return null; // 基数为 0 的走绝对增量门槛
  if (!(delta / base > rule.pct / 100)) return null; // 未过相对阈值 → 正常 PASS
  const floor = absMin === undefined ? rule.absMin : absMin;
  if (floor !== undefined && delta < floor) return "floor";
  if (typeof noise === "number" && delta <= noise) return "noise";
  return null;
}

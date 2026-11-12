// 归因探针与归因标量的单测（issue #379）
//
// 这里锁三件事：
// 1. 生产侧探针未安装时零记录（不能影响正常编辑路径）；
// 2. 轮次聚合只在真的采集到时产出标量（缺失不伪造 0）；
// 3. 采集桶派生出的标量名与 report/judgment 的持久化白名单完全一致——
//    两边漂移会让「进了基线但永远不显示」这种静默失效再次发生。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  perfProbeCount,
  perfProbeEnd,
  perfProbeStart,
} from "../../src/lib/perf-probe";
import {
  ATTRIBUTION_BUCKETS,
  COUNT_ONLY_BUCKETS,
  createAttributionAggregator,
} from "../perf/metrics.js";
import {
  ATTRIBUTION_METRICS,
  COMPARED_SCALARS,
  SESSION_PROBE_METRICS,
} from "../perf/judgment.js";

interface ProbeGlobal {
  __inklingPerfProbe?: {
    enabled: boolean;
    buckets: Record<string, { count: number; totalMs: number; maxMs: number }>;
  };
}

const globalWithProbe = globalThis as unknown as ProbeGlobal;

afterEach(() => {
  delete globalWithProbe.__inklingPerfProbe;
});

describe("生产侧归因探针（#379）", () => {
  it("未安装探针时不计时、不建桶", () => {
    expect(perfProbeStart()).toBeNull();
    perfProbeEnd("stats", 0);
    perfProbeCount("outlinePublish");
    expect(globalWithProbe.__inklingPerfProbe).toBeUndefined();
  });

  it("enabled=false 时同样不记录（导出基线产物时不会误开）", () => {
    globalWithProbe.__inklingPerfProbe = { enabled: false, buckets: {} };
    expect(perfProbeStart()).toBeNull();
    perfProbeCount("outlinePublish");
    expect(globalWithProbe.__inklingPerfProbe.buckets).toEqual({});
  });

  it("启用后记录累计耗时、最大耗时与次数", () => {
    globalWithProbe.__inklingPerfProbe = { enabled: true, buckets: {} };
    const start = perfProbeStart();
    expect(start).not.toBeNull();
    perfProbeEnd("stats", (start as number) - 5);
    perfProbeEnd("stats", (start as number) - 1);
    perfProbeCount("outlinePublish");
    perfProbeCount("outlinePublish");

    const buckets = globalWithProbe.__inklingPerfProbe.buckets;
    expect(buckets.stats.count).toBe(2);
    expect(buckets.stats.maxMs).toBeGreaterThanOrEqual(5);
    expect(buckets.stats.totalMs).toBeGreaterThanOrEqual(buckets.stats.maxMs);
    expect(buckets.outlinePublish.count).toBe(2);
    expect(buckets.outlinePublish.totalMs).toBe(0);
  });
});

describe("归因标量聚合（#379）", () => {
  it("多轮取均值，缺失的桶不输出（不伪造 0），覆盖状态暴露部分缺采", () => {
    const agg = createAttributionAggregator();
    agg.add({
      stats: { count: 2, totalMs: 10, maxMs: 6 },
      katexRender: { count: 4, totalMs: 40, maxMs: 15 },
    });
    agg.add({
      stats: { count: 4, totalMs: 30, maxMs: 12 },
    });

    expect(agg.scalars()).toEqual({
      statsMs: 20,
      statsMaxMs: 9,
      statsCount: 3,
      katexRenderMs: 40,
      katexRenderMaxMs: 15,
      katexRenderCount: 4,
    });
    // 两轮都完整，但 katexRender 只在 1 轮采到：均值 40 不再是「普通完整标量」，
    // coverage 明确给出 1/2（#379 评审 R4）
    const cov = agg.coverage();
    expect(cov.rounds).toBe(2);
    expect(cov.completeRounds).toBe(2);
    expect(cov.partial).toBe(false);
    expect(cov.metrics.statsMs).toEqual({ observed: 2, expected: 2 });
    expect(cov.metrics.katexRenderMs).toEqual({ observed: 1, expected: 2 });
  });

  it("测量窗口没走完的轮次，其计时桶不进入均值（#379 评审 R4）", () => {
    const agg = createAttributionAggregator();
    agg.add(
      { stats: { count: 1, totalMs: 10, maxMs: 10 } },
      { complete: true },
    );
    agg.add(
      { stats: { count: 1, totalMs: 90, maxMs: 90 } },
      { complete: false },
    );
    // 旧实现会给出 statsMs=50：把「测到一半」的 90ms 混进均值
    expect(agg.scalars()).toEqual({
      statsMs: 10,
      statsMaxMs: 10,
      statsCount: 1,
    });
    expect(agg.coverage()).toMatchObject({
      rounds: 2,
      completeRounds: 1,
      partial: true,
    });
    // expected 必须是**总轮数**：不完整轮本身是缺采，从分母剔除会让
    // 归因表把「1/2 轮测得」显示成满覆盖（R4 验收 F3）
    expect(agg.coverage().metrics.statsMs).toEqual({
      observed: 1,
      expected: 2,
    });
  });

  it("3 轮中缺 1 个 statsSettle：覆盖状态可区分 2/3 与 3/3（#379 评审 R4）", () => {
    const agg = createAttributionAggregator();
    const full = {
      outlineSettle: { count: 1, totalMs: 200, maxMs: 200 },
      statsSettle: { count: 1, totalMs: 300, maxMs: 300 },
    };
    agg.add(full);
    agg.add({ outlineSettle: full.outlineSettle }); // statsSettle 缺桶
    agg.add(full);
    const cov = agg.coverage();
    expect(cov.metrics.statsSettleMs).toEqual({ observed: 2, expected: 3 });
    expect(cov.metrics.outlineSettleMs).toEqual({ observed: 3, expected: 3 });
    // 均值只用真正采到的 2 轮，不把缺桶轮按 0ms 混入
    expect(agg.scalars().statsSettleMs).toBe(300);
  });

  it("一轮都没采到返回空对象", () => {
    expect(createAttributionAggregator().scalars()).toEqual({});
  });

  it("只计次的桶不输出 Ms/MaxMs（未计时不是 0ms）", () => {
    const agg = createAttributionAggregator();
    agg.add({
      outlinePublish: { count: 3, totalMs: 0, maxMs: 0 },
      outlineExtract: { count: 1, totalMs: 2, maxMs: 2 },
    });
    expect(agg.scalars()).toEqual({
      outlineExtractMs: 2,
      outlineExtractMaxMs: 2,
      outlineExtractCount: 1,
      outlinePublishCount: 3,
    });
  });

  it("只计次的桶按总轮数平均：某轮没记录按 0 次，而不是只平均有记录的轮", () => {
    const agg = createAttributionAggregator();
    agg.add({
      outlinePublish: { count: 3, totalMs: 0, maxMs: 0 },
      outlineExtract: { count: 1, totalMs: 2, maxMs: 2 },
    });
    agg.add({
      outlineExtract: { count: 1, totalMs: 4, maxMs: 4 },
    });
    expect(agg.scalars()).toEqual({
      outlineExtractMs: 3,
      outlineExtractMaxMs: 3,
      outlineExtractCount: 1,
      outlinePublishCount: 1.5,
    });
  });

  it("只计次的桶在所有轮都没有桶时输出 0（探针已装 = 每轮 0 次事件）", () => {
    // 背景（#379 评审 P1）：input-source 每轮都在测量窗口前安装 outlinePublish 探针。
    // 60 个字符的输入不改大纲结构，发布次数为 0 → 桶根本不出现。此前的实现
    // `entries.length === 0` 直接 continue，导致「发布次数」在 baseline 里整列消失，
    // 读者会以为没测，而不是「一次都没发布」。
    const agg = createAttributionAggregator({ countOnly: ["outlinePublish"] });
    agg.add({});
    agg.add({});
    agg.add({});
    expect(agg.scalars()).toEqual({ outlinePublishCount: 0 });
  });

  it("已声明只计次探针全零时覆盖记为满（0 次事件 ≠ 部分缺采）", () => {
    // 真实场景：input-source 每轮都装了 outlinePublish 探针、60 次输入不改
    // 大纲结构，所以两轮都没有桶。coverage 若按「有桶轮数」记成 0/2，
    // 报告会把「0 次发布」误标成 PARTIAL 0/2。
    const agg = createAttributionAggregator({ countOnly: ["outlinePublish"] });
    agg.add({});
    agg.add({});
    expect(agg.scalars()).toEqual({ outlinePublishCount: 0 });
    expect(agg.coverage().metrics.outlinePublishCount).toEqual({
      observed: 2,
      expected: 2,
    });
  });

  it("未声明 countOnly 的场景不伪造 0（没装探针 = 未测量）", () => {
    // open / scroll / input 场景不装大纲探针：全空必须继续按「未测量」处理，
    // 否则 0 会被读成「发布成本为零」，比缺一项更误导。
    const agg = createAttributionAggregator();
    agg.add({});
    agg.add({});
    expect(agg.scalars()).toEqual({});
  });

  it("声明 countOnly 不改变计时桶的缺失语义（计时仍不伪造 0ms）", () => {
    const agg = createAttributionAggregator({ countOnly: ["outlinePublish"] });
    agg.add({});
    expect(agg.scalars()).toEqual({ outlinePublishCount: 0 });
  });

  it("声明 countOnly 后仍按总轮数平均（部分轮有桶时不被全空逻辑干扰）", () => {
    const agg = createAttributionAggregator({ countOnly: ["outlinePublish"] });
    agg.add({ outlinePublish: { count: 4, totalMs: 0, maxMs: 0 } });
    agg.add({});
    agg.add({});
    expect(agg.scalars()).toEqual({ outlinePublishCount: 1.33 });
  });

  it("测量窗口没走完的轮次不参与只计次均值（不用「没测」冒充 0 次）", () => {
    // input-source 用 outlineSettle 桶是否存在判定窗口是否走完：某轮没走完
    // （防抖回调没跑）时，该轮没有发布桶既可能是 0 次发布、也可能是根本没测，
    // 必须剔除，不能按 0 计入分母。
    const agg = createAttributionAggregator({ countOnly: ["outlinePublish"] });
    agg.add({ outlinePublish: { count: 2, totalMs: 0, maxMs: 0 } }, { complete: true });
    agg.add({}, { complete: false });
    expect(agg.scalars()).toEqual({ outlinePublishCount: 2 });
  });

  it("所有轮次窗口都没走完 → 不输出（未测量，而不是 0 次）", () => {
    const agg = createAttributionAggregator({ countOnly: ["outlinePublish"] });
    agg.add({}, { complete: false });
    agg.add({}, { complete: false });
    expect(agg.scalars()).toEqual({});
  });

  it("countOnly 写错桶名（非只计次桶）直接抛错，不静默失效", () => {
    // 「声明了但永远不生效」产出的效果与本 PR 修的「整列从基线消失」一模一样，
    // 属于沉默错误，构造期就要炸。
    expect(() =>
      createAttributionAggregator({ countOnly: ["stat"] }),
    ).toThrow(/countOnly/);
  });

  it("桶派生名与 judgment 白名单一致（防止进了基线却永不显示）", () => {
    const derived = ATTRIBUTION_BUCKETS.flatMap((name) =>
      COUNT_ONLY_BUCKETS.has(name)
        ? [`${name}Count`]
        : [`${name}Ms`, `${name}MaxMs`, `${name}Count`],
    );
    const formulaExtras = [
      "formulaReadyMs",
      "formulaNodeViews",
      "formulaRendered",
      "formulaLateLongTaskCount",
      "formulaLateLongTaskMs",
    ];
    expect(new Set(ATTRIBUTION_METRICS)).toEqual(
      new Set([...derived, ...formulaExtras]),
    );
  });

  it("归因指标不与判定白名单重叠（只披露、不判 FAIL/WARN）", () => {
    const judged = new Set([
      ...COMPARED_SCALARS,
      ...SESSION_PROBE_METRICS,
    ]);
    for (const metric of ATTRIBUTION_METRICS) {
      expect(judged.has(metric)).toBe(false);
    }
  });

  it("每个桶名都在对应生产文件中以字面量出现（防改名单边漂移）", () => {
    // vitest 的 cwd 即项目根（happy-dom 下 import.meta.url 不是 file: URL）
    const repoRoot = process.cwd();
    const bucketFiles: Record<(typeof ATTRIBUTION_BUCKETS)[number], string> = {
      stats: "src/lib/stats.ts",
      statsSettle: "src/lib/useDeferredStats.ts",
      outlineExtract: "src/lib/outline.ts",
      outlineSettle: "src/components/Editor/SourceModeEditor.tsx",
      headingLocate: "src/components/Editor/SourceModeEditor.tsx",
      outlinePublish: "src/components/Editor/SourceModeEditor.tsx",
      katexLoad: "src/components/Editor/math.ts",
      katexRender: "src/components/Editor/math.ts",
      formulaNodeView: "src/components/Editor/math.ts",
    };
    for (const name of ATTRIBUTION_BUCKETS) {
      const file = bucketFiles[name];
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      expect(source, `${name} 未在 ${file} 中以字面量出现`).toContain(
        `"${name}"`,
      );
    }
  });
});

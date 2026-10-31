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
  it("多轮取均值，缺失的桶不输出（不伪造 0）", () => {
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

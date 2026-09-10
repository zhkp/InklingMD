// 场景 scroll：连续滚动 → 帧间隔 / long frame / 布局抖动（issue #216）
//
// 复用 tests/e2e/source-mode-scroll-race.spec.ts 的 rAF 逐帧驱动范式
// （frames++ + requestAnimationFrame(step)），这里补齐每帧时间戳采集。
//
// v3.1.0 那次真实性能问题就是滚动帧尖刺，而历史上三次问题都不是"平均 FPS 下降"，
// 而是 long task / 布局抖动，所以除帧间隔外必须同时采 longTask 与 CLS。

import { expect, test } from "@playwright/test";
import { PERF_DOC_PATH } from "../inject";
import { bootWithFiles, openFileInTree } from "../helpers";
import {
  installObservers,
  readObservers,
  runScrollFrames,
  waitRenderStable,
} from "../metrics";
import { waitScrollConverged } from "../../e2e/helpers";
import { EDITOR_SCROLL } from "../helpers";
import {
  detectEnv,
  fixtureFor,
  frameBudgetMs,
  kindsFor,
  readRunContext,
  shouldRun,
  writeRawFile,
} from "../runner";

const ctx = readRunContext();

/** 每档滚动帧数与单帧步长上限：档位越大滚得越久，保证覆盖足够长的滚动路径 */
const FRAMES: Record<string, number> = { S: 120, M: 120, L: 200, XL: 200, C: 150 };
const MAX_STEP = 240;

/**
 * 掉帧判定系数：帧间隔 > 1.5 × 帧预算才算掉帧（60Hz → >25ms，120Hz → >12.5ms）。
 *
 * 为什么不用「> 帧预算」的严格口径：实测 headless 60Hz 下严格口径会把 46.7% 的帧
 * 判为掉帧——那只是 vsync 抖动（帧间隔在 16.7ms 上下 ±1~2ms 波动），不是卡顿。
 * 严格口径只会把测量噪声变成"回归"，1.5 倍才是"至少漏掉一个刷新周期"的业界惯例。
 */
const JANK_FACTOR = 1.5;

for (const tier of ctx.tiers) {
  for (const kind of kindsFor("scroll")) {
    const id = `scroll-${tier}-${kind}`;

    test(id, async ({ page }) => {
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      const budget = frameBudgetMs();
      const frameSamples: number[] = [];
      const jankCounts: number[] = [];
      const jankRates: number[] = [];
      const longFrameCounts: number[] = [];
      const longTaskCount: number[] = [];
      const longTaskMs: number[] = [];
      const clsValues: number[] = [];
      const heapDeltas: number[] = [];
      const steps: number[] = [];
      const frames = FRAMES[tier] ?? 120;

      for (let round = 0; round < ctx.warmups + ctx.rounds; round += 1) {
        await bootWithFiles(page, [{ path: PERF_DOC_PATH, content: fixture.content }]);
        await openFileInTree(page, PERF_DOC_PATH, 120_000);
        await page.evaluate(waitRenderStable, {
          stableFrames: 10,
          maxFrames: 900,
        });

        await page.evaluate(installObservers);
        const scroll = await page.evaluate(runScrollFrames, {
          frames,
          maxStep: MAX_STEP,
        });
        const observers = await page.evaluate(readObservers);
        // 收尾等滚动稳定（在计时窗口之外，避免把 tail settle 算进帧间隔）
        await waitScrollConverged(page, EDITOR_SCROLL, 120_000);

        // 触底守卫（评审 P2-4）：触底后剩余帧测的是静止页面，样本无效
        expect(
          scroll.saturated,
          `${id}：滚动触底（maxScroll=${scroll.maxScroll}, final=${scroll.finalScrollTop}），` +
            `后半段测的是静止页面。请调大 FRAMES 或说明文档过短`,
        ).toBe(false);
        expect(scroll.intervals.length).toBe(frames);

        const jankLimit = budget * JANK_FACTOR;
        const jankCount = scroll.intervals.filter((ms) => ms > jankLimit).length;

        if (round >= ctx.warmups) {
          frameSamples.push(...scroll.intervals);
          jankCounts.push(jankCount);
          jankRates.push(Math.round((jankCount / frames) * 1000) / 10);
          longFrameCounts.push(scroll.intervals.filter((ms) => ms > 50).length);
          steps.push(scroll.step);
          longTaskCount.push(observers.longTaskCount);
          longTaskMs.push(observers.longTaskMs);
          clsValues.push(observers.cls);
          heapDeltas.push(
            observers.heapStartMB !== null && observers.heapEndMB !== null
              ? Math.round((observers.heapEndMB - observers.heapStartMB) * 100) / 100
              : 0,
          );
        }
      }

      writeRawFile({
        id,
        scenario: "scroll",
        tier,
        kind,
        env: detectEnv(),
        profile: ctx.profile,
        rounds: ctx.rounds,
        warmups: ctx.warmups,
        fixture: {
          version: fixture.version,
          hash: fixture.hash,
          lines: fixture.lines,
          source: fixture.source,
        },
        samples: { frameMs: frameSamples },
        scalars: {
          // 帧预算与步长是测量配置，随样本一起落盘（report 只比较白名单指标，不会误判为性能）
          frameBudgetMs: budget,
          jankFactor: JANK_FACTOR,
          step: avg(steps),
          jankCount: avg(jankCounts),
          jankRatePct: avg(jankRates),
          longFrameCount: avg(longFrameCounts),
          longTaskCount: avg(longTaskCount),
          longTaskMs: avg(longTaskMs),
          cls: avg(clsValues),
          heapDeltaMB: avg(heapDeltas),
        },
      });
    });
  }
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}

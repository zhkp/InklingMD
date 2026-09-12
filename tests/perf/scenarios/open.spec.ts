// 场景 open：打开大文档 → 首次可交互（TTI 近似）（issue #216）
//
// TTI 定义：从点击文件条目（页面内 pointerdown 打点）到
//   ① 标签激活 + ProseMirror 挂载可见 → ② 编辑器滚动高度收敛（内容渲染到位）
//   → ③ 连续两帧 rAF 完成（确已绘制）。
// 用页面内打点而不是 Playwright 侧计时，避免 CDP 往返误差进入测量值。
// 每轮都重新 goto + 注入：mockFs 模块状态随页面加载重置，必须重新注入。

import { expect, test } from "@playwright/test";
import { PERF_DOC_PATH } from "../inject";
import { bootWithFiles, openFileInTree } from "../helpers";
import {
  armTiming,
  installObservers,
  readObservers,
  readTimingStart,
  waitRenderStable,
  waitTwoFrames,
} from "../metrics";
import {
  detectEnv,
  fixtureFor,
  kindsFor,
  readRunContext,
  shouldRun,
  writeRawFile,
} from "../runner";

const ctx = readRunContext();

for (const tier of ctx.tiers) {
  for (const kind of kindsFor("open")) {
    const id = `open-${tier}-${kind}`;

    test(id, async ({ page }) => {
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      const ttiSamples: number[] = [];
      const longTaskCount: number[] = [];
      const longTaskMs: number[] = [];
      const clsValues: number[] = [];
      const heapDeltas: number[] = [];

      for (let round = 0; round < ctx.warmups + ctx.rounds; round += 1) {
        await bootWithFiles(page, [{ path: PERF_DOC_PATH, content: fixture.content }]);
        await page.evaluate(installObservers);
        await page.evaluate(armTiming, { event: "pointerdown" } as const);

        await openFileInTree(page, PERF_DOC_PATH, 120_000);
        // 页面内逐帧等高度收敛（避免 CDP 轮询开销进入测量值），最多等 900 帧
        await page.evaluate(waitRenderStable, {
          stableFrames: 10,
          maxFrames: 900,
        });
        const endAt = await page.evaluate(waitTwoFrames);
        const startAt = await page.evaluate(readTimingStart);
        const observers = await page.evaluate(readObservers);

        // warm-up 轮次只用来消除 Vite 首次编译 / PM 首次挂载 / JIT 预热的影响
        if (round >= ctx.warmups) {
          ttiSamples.push(endAt - startAt);
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

      expect(ttiSamples.length).toBe(ctx.rounds);

      writeRawFile({
        id,
        scenario: "open",
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
        samples: { ttiMs: ttiSamples },
        scalars: {
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

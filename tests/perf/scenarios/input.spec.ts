// 场景 input：连续输入 → 输入延迟（issue #216）
//
// 测量方式：页面内 rAF 循环 + execCommand('insertText')，逐字符记录
//   - inputSyncMs：单次插入的同步阻塞时长（PM 事务处理耗时）
//   - inputPaintMs：插入 → 下一帧绘制（更接近体感延迟，主判据）
// 不用 page.keyboard.type：它每个字符一次 CDP 往返，往返噪声远大于真实输入延迟。
//
// 两个指标都送进 baseline 比较，因为它们的敏感度互补（实测 1000 行档）：
//   - inputSyncMs ≈ 1.9ms：只含 JS 同步开销，无 vsync 量化，对亚帧级回归最敏感
//   - inputPaintMs ≈ 17ms：含等待下一帧，被 vsync 量化到 ~16.7ms 的整数倍，
//     但只有它能捕获布局/绘制侧的回归（JS 侧看不出来的那部分）
//
// 防假阴性：整批结束后必须校验文档文本长度真的增长了。execCommand 在未生效时
// 返回 false 且耗时接近 0，若不校验，"编辑器根本没接收输入"会被记录成"极快"。

import { expect, test } from "@playwright/test";
import { PERF_DOC_PATH } from "../inject";
import { bootWithFiles, focusEditorEnd, openFileInTree } from "../helpers";
import {
  installObservers,
  readObservers,
  runInputBurst,
  waitRenderStable,
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
const CHARS = 60;

for (const tier of ctx.tiers) {
  for (const kind of kindsFor("input")) {
    const id = `input-${tier}-${kind}`;

    test(id, async ({ page }) => {
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      const paintSamples: number[] = [];
      const syncSamples: number[] = [];
      const longTaskCount: number[] = [];
      const longTaskMs: number[] = [];
      const clsValues: number[] = [];
      const heapDeltas: number[] = [];

      for (let round = 0; round < ctx.warmups + ctx.rounds; round += 1) {
        // 每轮重新 goto + 注入：文档回到初始状态，无需 undo，也不会被上一轮的插入撑大
        await bootWithFiles(page, [{ path: PERF_DOC_PATH, content: fixture.content }]);
        await openFileInTree(page, PERF_DOC_PATH, 120_000);
        await page.evaluate(waitRenderStable, {
          stableFrames: 10,
          maxFrames: 900,
        });
        await focusEditorEnd(page);

        await page.evaluate(installObservers);
        const burst = await page.evaluate(runInputBurst, {
          count: CHARS,
          text: "x",
        });
        const observers = await page.evaluate(readObservers);

        // 假阴性守卫：输入必须真的落到文档里
        expect(burst.allApplied, `${id}：execCommand 未能插入文本`).toBe(true);
        expect(burst.inserted).toBeGreaterThanOrEqual(CHARS);

        if (round >= ctx.warmups) {
          paintSamples.push(...burst.paint);
          syncSamples.push(...burst.sync);
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

      expect(paintSamples.length).toBe(CHARS * ctx.rounds);

      writeRawFile({
        id,
        scenario: "input",
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
        samples: { inputPaintMs: paintSamples, inputSyncMs: syncSamples },
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

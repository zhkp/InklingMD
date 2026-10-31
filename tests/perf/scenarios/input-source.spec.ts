// 场景 input-source：源码模式（CodeMirror 6）连续输入 → 输入延迟（issue #379）
//
// 与 WYSIWYG input 场景刻意分开：源码模式每按键会同步触发 Markdown 发布、
// 大纲全文重解析与状态栏统计，这些成本在 WYSIWYG 里被 publisher 防抖掩盖，
// 不能拿 input 场景的数字代表源码模式。
//
// 测量口径与 input 一致（页面内 rAF + execCommand，避免 CDP 往返噪声）：
//   - inputSyncMs：单次插入的同步阻塞时长
//   - inputPaintMs：插入 → 下一帧绘制（主判据）
// 额外把归因探针（#379）随 raw 落盘：统计/大纲/标题定位各花了多少。

import { expect, test } from "@playwright/test";
import { PERF_DOC_PATH } from "../inject";
import {
  bootWithFiles,
  enterSourceMode,
  focusSourceModeEnd,
  openFileInTree,
} from "../helpers";
import {
  createAttributionAggregator,
  createSessionProbe,
  INPUT_LANDING_RETRIES,
  installObservers,
  installPerfProbe,
  readObservers,
  runSourceInputBurst,
  waitForProbeBuckets,
  waitRenderStable,
} from "../metrics";
import {
  detectEnv,
  fixtureFor,
  kindsFor,
  readRunContext,
  shouldRun,
  testTimeoutMs,
  writeRawFile,
} from "../runner";

const ctx = readRunContext();
const CHARS = 60;

for (const tier of ctx.tiers) {
  for (const kind of kindsFor("input-source")) {
    const id = `input-source-${tier}-${kind}`;

    test(id, async ({ page }) => {
      test.setTimeout(testTimeoutMs(tier));
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      const probe = createSessionProbe();
      const attribution = createAttributionAggregator();
      const paintSamples: number[] = [];
      const syncSamples: number[] = [];
      const longTaskCount: number[] = [];
      const longTaskMs: number[] = [];
      const clsValues: number[] = [];
      const heapDeltas: number[] = [];

      for (let round = 0; round < ctx.warmups + ctx.rounds; round += 1) {
        const measured = await (async () => {
          for (let attempt = 0; ; attempt += 1) {
            await bootWithFiles(page, [
              { path: PERF_DOC_PATH, content: fixture.content },
            ]);
            await openFileInTree(page, PERF_DOC_PATH, 120_000);
            await page.evaluate(waitRenderStable, {
              stableFrames: 10,
              maxFrames: 900,
            });
            await enterSourceMode(page);
            await focusSourceModeEnd(page);
            // 等源码模式切换过渡（滚动恢复 / 初始大纲通知）落定后再开测：
            // 探针此刻才安装，因此切换成本不会混进「每次按键」的归因。
            await page.evaluate(waitRenderStable, {
              stableFrames: 2,
              maxFrames: 30,
            });

            await page.evaluate(installObservers);
            await page.evaluate(installPerfProbe);
            const burst = await page.evaluate(runSourceInputBurst, {
              count: CHARS,
              text: "x",
            });
            const observers = await page.evaluate(readObservers);
            // 大纲/统计改为停笔后延迟刷新（#374/#375）：判定的 long task 仍只取
            // 输入期间，读完观测值后再等延迟刷新落地，才能拿到 settle 归因桶。
            // 轮询而不是固定等待：walk 到桶出现为止，慢机器不影响采集完整性。
            const buckets = await waitForProbeBuckets(page, [
              "outlineSettle",
              "statsSettle",
            ]);

            if (burst.allApplied && burst.inserted >= CHARS) {
              return { burst, observers, buckets };
            }
            if (attempt >= INPUT_LANDING_RETRIES) {
              expect(
                burst.allApplied,
                `${id}：源码模式 execCommand 未能插入文本（含 ${INPUT_LANDING_RETRIES} 次重试）`,
              ).toBe(true);
              expect(burst.inserted).toBeGreaterThanOrEqual(CHARS);
              return { burst, observers, buckets };
            }
            console.warn(
              `[perf] ${id} 第 ${round + 1} 轮源码输入未全部落地` +
                `（allApplied=${burst.allApplied}, inserted=${burst.inserted}），重新加载后重试 ${attempt + 1}/${INPUT_LANDING_RETRIES}`,
            );
          }
        })();
        const { burst, observers, buckets } = measured;

        if (round >= ctx.warmups) {
          await probe.measure(page);
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
          attribution.add(buckets);
        }
      }

      expect(paintSamples.length).toBe(CHARS * ctx.rounds);

      const attributionScalars = attribution.scalars();
      writeRawFile({
        id,
        scenario: "input-source",
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
          ...probe.scalars(),
          ...attributionScalars,
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

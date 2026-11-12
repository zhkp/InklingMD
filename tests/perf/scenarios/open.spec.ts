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
  countExpectedMathNodes,
  createAttributionAggregator,
  createSessionProbe,
  installObservers,
  installPerfProbe,
  readObservers,
  readPerfProbe,
  readTimingStart,
  waitFormulaSettled,
  waitRenderStable,
  waitTwoFrames,
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

for (const tier of ctx.tiers) {
  for (const kind of kindsFor("open")) {
    const id = `open-${tier}-${kind}`;

    test(id, async ({ page }) => {
      // 单测超时按档位（#247）：Playwright 的 test(details) 只认 tag/annotation，不认 timeout 选项
      test.setTimeout(testTimeoutMs(tier));
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      // 预期公式节点数（#379 评审 R4）：从 markdown 源文数出「成对 $$ 块 +
      // 行内 $...$」。>0 时 waitFormulaSettled 必须等到节点真的挂载，
      // 否则调用瞬间 nodeViews=0 会被 `0 >= 0` 当成「没有公式、已完成」。
      const expectedFormulaNodes = countExpectedMathNodes(fixture.content);
      const probe = createSessionProbe();
      const attribution = createAttributionAggregator();
      const ttiSamples: number[] = [];
      const longTaskCount: number[] = [];
      const longTaskMs: number[] = [];
      const clsValues: number[] = [];
      const heapDeltas: number[] = [];
      const formulaReadyMs: number[] = [];
      const formulaNodeViews: number[] = [];
      const formulaRendered: number[] = [];
      const formulaLateLongTaskCount: number[] = [];
      const formulaLateLongTaskMs: number[] = [];

      for (let round = 0; round < ctx.warmups + ctx.rounds; round += 1) {
        await bootWithFiles(page, [{ path: PERF_DOC_PATH, content: fixture.content }]);
        await page.evaluate(installObservers);
        await page.evaluate(installPerfProbe);
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

        // TTI 的既有口径不变（上面已读完判定用观测值）；公式归因在其后单独等待：
        // KaTeX 动态导入可能在 TTI 之后才落地，若不等待就会把「还没渲染」记成「零成本」。
        const formula = await page.evaluate(waitFormulaSettled, {
          maxFrames: 1800,
          expectedNodes: expectedFormulaNodes,
        });
        const observersAfterFormula = await page.evaluate(readObservers);
        const buckets = await page.evaluate(readPerfProbe);

        // warm-up 轮次只用来消除 Vite 首次编译 / PM 首次挂载 / JIT 预热的影响
        if (round >= ctx.warmups) {
          // 公式前提与完成条件都只在 measured 轮断言：warmup 的结果本就要丢弃，
          // 它的一次 KaTeX 抖动不该把整场景判成 UNMEASURED（exit 2）。
          // 公式密集档必须真的有 200+ 公式节点（#376 的测量前提），否则数据不能用于决策
          if (
            kind === "rich" &&
            (tier === "M" || tier === "L" || tier === "XL")
          ) {
            expect(
              formula.nodeViews,
              `${id}：公式节点数不足 200（实际 ${formula.nodeViews}），不满足 #376 测量前提`,
            ).toBeGreaterThanOrEqual(200);
            expect(
              formula.rendered + formula.empty,
              `${id}：KaTeX 未在等待窗口内渲染完全（${formula.rendered}+${formula.empty} 空/${formula.nodeViews}）`,
            ).toBeGreaterThanOrEqual(formula.nodeViews);
          }
          // 含公式档位（含 S-rich / custom）必须先确认节点真的挂载且渲染完全
          // （#379 评审 R4）：帧预算耗尽时 formula.at 只是超时时刻，拿它当
          // formulaReadyMs 等于把「还没渲染完」记成「渲染耗时」。测量失败就判红
          // ——本轮不落 raw，场景按「未测量」处理（exit 2）。
          if (expectedFormulaNodes > 0) {
            expect(
              formula.nodeViews,
              `${id}：预期 ${expectedFormulaNodes} 个公式节点，实际只挂载 ` +
                `${formula.nodeViews} 个（等待 ${formula.frames} 帧），按 UNMEASURED 处理`,
            ).toBeGreaterThanOrEqual(expectedFormulaNodes);
          }
          expect(
            formula.complete,
            `${id}：KaTeX 未在 ${formula.frames} 帧内渲染完全` +
              `（${formula.rendered}+${formula.empty} 空/${formula.nodeViews}），` +
              `公式归因按测量失败处理`,
          ).toBe(true);
          expect(
            formula.unmeasured,
            `${id}：公式节点未挂载却被判为已完成（UNMEASURED）`,
          ).toBe(false);
          // 标定负载：#236 与编辑器代码无关的固定工作量，用于把「机器慢」与「代码回归」分开
          await probe.measure(page);
          ttiSamples.push(endAt - startAt);
          longTaskCount.push(observers.longTaskCount);
          longTaskMs.push(observers.longTaskMs);
          clsValues.push(observers.cls);
          heapDeltas.push(
            observers.heapStartMB !== null && observers.heapEndMB !== null
              ? Math.round((observers.heapEndMB - observers.heapStartMB) * 100) / 100
              : 0,
          );
          attribution.add(buckets);
          // 走到这里说明上面「节点存在 + 等到完成条件」的断言已通过。
          // 含公式档位一律写标量，S-rich / custom 不再被 `nodeViews > 0` 静默跳过。
          if (expectedFormulaNodes > 0) {
            formulaReadyMs.push(formula.at - startAt);
            formulaNodeViews.push(formula.nodeViews);
            formulaRendered.push(formula.rendered);
            // 只把 TTI 之后新增的 long task 算作「公式尾部渲染」的归因
            formulaLateLongTaskCount.push(
              Math.max(0, observersAfterFormula.longTaskCount - observers.longTaskCount),
            );
            formulaLateLongTaskMs.push(
              Math.max(0, observersAfterFormula.longTaskMs - observers.longTaskMs),
            );
          }
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
          ...probe.scalars(),
          ...attribution.scalars(),
          ...(formulaReadyMs.length > 0
            ? {
                formulaReadyMs: avg(formulaReadyMs),
                formulaNodeViews: avg(formulaNodeViews),
                formulaRendered: avg(formulaRendered),
                formulaLateLongTaskCount: avg(formulaLateLongTaskCount),
                formulaLateLongTaskMs: avg(formulaLateLongTaskMs),
              }
            : {}),
          longTaskCount: avg(longTaskCount),
          longTaskMs: avg(longTaskMs),
          cls: avg(clsValues),
          heapDeltaMB: avg(heapDeltas),
        },
        // 归因标量的覆盖状态（#379 评审 R4）：部分缺采必须在产物里可见
        attributionCoverage: attribution.coverage(),
        // 公式测量覆盖状态：预期节点数 / 实际记到完整样本的轮数。
        // 判红时本 raw 根本不落盘，report 会给出 UNMEASURED 行；这里让
        // 「有公式档位却没写 formulaReadyMs」也无法伪装成纯文本档。
        formulaCoverage: {
          expectedNodes: expectedFormulaNodes,
          measuredRounds: formulaReadyMs.length,
          expectedRounds: ctx.rounds,
          unmeasured:
            expectedFormulaNodes > 0 && formulaReadyMs.length < ctx.rounds,
        },
      });
    });
  }
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 100) / 100;
}



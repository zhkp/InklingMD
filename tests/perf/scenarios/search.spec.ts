// 场景 search：编辑器内查找 → 耗时（issue #216）
//
// 口径：issue 写的是"全文搜索"，这里取编辑器内查找（mod+f），因为它承载编辑器渲染
// 性能；全局搜索（GlobalSearchPanel）主要是扫描/IO 逻辑，与编辑器性能正交，不塞进本期。
//
// 计时：起点 = 页面内捕获到的第一次 keydown（mod+f），终点 = 页面内 MutationObserver
// 判定 .search-count 连续两次不变的时刻。两端都在页面内，避免 CDP 往返与轮询滞后。

import { expect, test } from "@playwright/test";
import { PERF_DOC_PATH } from "../inject";
import { bootWithFiles, openFileInTree } from "../helpers";
import {
  armSearchWatch,
  armTiming,
  installObservers,
  readObservers,
  readSearchDone,
  readTimingStart,
  waitRenderStable,
} from "../metrics";
import { MOD } from "../../e2e/helpers";
import {
  detectEnv,
  fixtureFor,
  kindsFor,
  pickSearchKeyword,
  readRunContext,
  shouldRun,
  writeRawFile,
} from "../runner";

const ctx = readRunContext();

for (const tier of ctx.tiers) {
  for (const kind of kindsFor("search")) {
    const id = `search-${tier}-${kind}`;

    test(id, async ({ page }) => {
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      // 关键词必须从文档本身推导：用户自带文档里不会有生成 fixture 的 "bench-" 编号
      const keyword = pickSearchKeyword(fixture.content);
      const searchSamples: number[] = [];
      const matchCounts: number[] = [];
      const longTaskCount: number[] = [];
      const longTaskMs: number[] = [];
      const clsValues: number[] = [];
      const heapDeltas: number[] = [];

      for (let round = 0; round < ctx.warmups + ctx.rounds; round += 1) {
        await bootWithFiles(page, [{ path: PERF_DOC_PATH, content: fixture.content }]);
        await openFileInTree(page, PERF_DOC_PATH, 120_000);
        await page.evaluate(waitRenderStable, {
          stableFrames: 10,
          maxFrames: 900,
        });

        await page.evaluate(installObservers);
        await page.evaluate(armSearchWatch);
        await page.evaluate(armTiming, { event: "keydown" } as const);

        await page.keyboard.press(`${MOD}+f`);
        const input = page.locator(".search-panel .search-input").first();
        await expect(input).toBeVisible({ timeout: 10_000 });
        // 用 fill 而不是逐字符 type：逐字符 CDP 往返噪声会淹没搜索本身的耗时
        await input.fill(keyword);

        await expect
          .poll(async () => (await page.evaluate(readSearchDone)) !== null, {
            timeout: 30_000,
            intervals: [30, 50, 80],
          })
          .toBe(true);

        const doneAt = await page.evaluate(readSearchDone);
        const startAt = await page.evaluate(readTimingStart);
        const observers = await page.evaluate(readObservers);
        const countText =
          (await page.locator(".search-count").first().textContent())?.trim() ?? "";

        expect(doneAt).not.toBeNull();
        const matched = /(\d+)\/(\d+)/.exec(countText);
        expect(matched, `${id}：搜索未产生匹配结果（count="${countText}"）`).not.toBeNull();
        const total = Number(matched![2]);
        expect(total).toBeGreaterThan(0);

        if (round >= ctx.warmups) {
          searchSamples.push(doneAt! - startAt);
          matchCounts.push(total);
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
        scenario: "search",
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
        samples: { searchMs: searchSamples },
        scalars: {
          matchCount: avg(matchCounts),
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

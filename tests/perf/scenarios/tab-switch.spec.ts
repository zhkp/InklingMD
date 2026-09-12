// 场景 tab-switch：标签切换 → 完成耗时（issue #216）
//
// 打开两个文档（目标档位 A + 小文档 B），测 A→B 与 B→A 两个方向并都记入样本，
// 消除"切出 / 切回"的方向性偏差。计时同样用页面内 pointerdown 打点。

import { expect, test } from "@playwright/test";
import { PERF_DOC_PATH, PERF_SECOND_DOC_PATH } from "../inject";
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
import { buildFixture } from "../fixtures";

const ctx = readRunContext();

/** 副文档：固定 200 行纯文本，代表"另一个已打开的普通文件" */
const SECOND_DOC = buildFixture({ lines: 200, kind: "plain" });

async function clickTab(page: import("@playwright/test").Page, name: string) {
  const tab = page.locator(".tab").filter({ hasText: name }).first();
  await tab.click();
  await expect(page.locator(".tab-active")).toContainText(name, {
    timeout: 60_000,
  });
}

for (const tier of ctx.tiers) {
  for (const kind of kindsFor("tab-switch")) {
    const id = `tab-switch-${tier}-${kind}`;

    test(id, async ({ page }) => {
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      const switchSamples: number[] = [];
      const longTaskCount: number[] = [];
      const longTaskMs: number[] = [];
      const clsValues: number[] = [];
      const heapDeltas: number[] = [];

      for (let round = 0; round < ctx.warmups + ctx.rounds; round += 1) {
        await bootWithFiles(page, [
          { path: PERF_DOC_PATH, content: fixture.content },
          { path: PERF_SECOND_DOC_PATH, content: SECOND_DOC },
        ]);
        await openFileInTree(page, PERF_DOC_PATH, 120_000);
        await openFileInTree(page, PERF_SECOND_DOC_PATH, 120_000);
        await page.evaluate(waitRenderStable, {
          stableFrames: 10,
          maxFrames: 900,
        });

        const collect =
          round >= ctx.warmups
            ? (ms: number) => switchSamples.push(ms)
            : (_ms: number) => {};

        await page.evaluate(installObservers);

        // A（大文档）→ B（小文档）
        await clickTab(page, "readme.md");
        await page.evaluate(armTiming, { event: "pointerdown" } as const);
        await clickTab(page, "todo.md");
        await page.evaluate(waitRenderStable, {
          stableFrames: 6,
          maxFrames: 600,
        });
        const endB = await page.evaluate(waitTwoFrames);
        const startB = await page.evaluate(readTimingStart);
        collect(endB - startB);

        // B → A
        await page.evaluate(armTiming, { event: "pointerdown" } as const);
        await clickTab(page, "readme.md");
        await page.evaluate(waitRenderStable, {
          stableFrames: 6,
          maxFrames: 600,
        });
        const endA = await page.evaluate(waitTwoFrames);
        const startA = await page.evaluate(readTimingStart);
        collect(endA - startA);

        const observers = await page.evaluate(readObservers);
        if (round >= ctx.warmups) {
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

      expect(switchSamples.length).toBe(ctx.rounds * 2);

      writeRawFile({
        id,
        scenario: "tab-switch",
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
        samples: { switchMs: switchSamples },
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

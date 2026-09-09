// 场景 save：保存 → 完成耗时（issue #216）
//
// 关键时序约束：应用有 2 秒防抖的自动保存（src/lib/useAutoSave.ts），且默认开启。
// 所以「编辑 → 立刻 Ctrl/Cmd+S」必须一气呵成，否则防抖自动保存会先把脏标记清掉，
// 手动保存变成空操作，测出来的是 0ms 的假数据。
// 因此每一步都加了守卫：按下快捷键前必须先确认脏标记真实存在。
//
// 说明：浏览器 mock 下写入是内存操作（fs.ts 的 writeTextFile mock 分支），
// 该值主要反映「序列化 + 状态更新 + 重新渲染」的开销，不含真实磁盘 IO。

import { expect, test } from "@playwright/test";
import { PERF_DOC_PATH } from "../inject";
import { bootWithFiles, focusEditorEnd, openFileInTree } from "../helpers";
import {
  armDirtyWatch,
  armTiming,
  installObservers,
  readDirtyGone,
  readObservers,
  readTimingStart,
  runInputBurst,
  waitRenderStable,
} from "../metrics";
import { MOD } from "../../e2e/helpers";
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
  for (const kind of kindsFor("save")) {
    const id = `save-${tier}-${kind}`;

    test(id, async ({ page }) => {
      test.skip(!shouldRun(id, ctx), "不在本次运行范围（复测过滤）");

      const fixture = fixtureFor(tier, kind);
      const saveSamples: number[] = [];
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
        await focusEditorEnd(page);

        // 制造脏状态：插入一个字符
        const burst = await page.evaluate(runInputBurst, {
          count: 1,
          text: "x",
        });
        expect(burst.allApplied, `${id}：未能插入字符，无法制造脏状态`).toBe(true);

        const dirty = page.locator(".tab-active .tab-dirty");
        await expect(
          dirty,
          `${id}：脏标记未出现，自动保存可能已抢先保存，保存耗时将失真`,
        ).toHaveCount(1, { timeout: 5_000 });

        await page.evaluate(installObservers);
        await page.evaluate(armDirtyWatch);
        await page.evaluate(armTiming, { event: "keydown" } as const);
        await page.keyboard.press(`${MOD}+s`);

        await expect
          .poll(async () => (await page.evaluate(readDirtyGone)) !== null, {
            timeout: 30_000,
            intervals: [20, 30, 50],
          })
          .toBe(true);

        const doneAt = await page.evaluate(readDirtyGone);
        const startAt = await page.evaluate(readTimingStart);
        const observers = await page.evaluate(readObservers);
        await expect(dirty).toHaveCount(0);

        expect(doneAt).not.toBeNull();

        if (round >= ctx.warmups) {
          saveSamples.push(doneAt! - startAt);
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
        scenario: "save",
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
        },
        samples: { saveMs: saveSamples },
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

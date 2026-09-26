// #257 回归：milkdown 编辑器留下的 3s Timer 超时必须在文件结束时被清理
//
// 不清理时：环境销毁（happy-dom 全局被收回）后超时回调调用裸全局 `removeEventListener`
// → ReferenceError → vitest 记为 unhandled error（用例全绿，但 `pnpm test` 随机 exit 1）。
// 本用例在原地模拟「环境销毁」并等满 3s 窗口，断言清理后回调不再触发。

import { describe, expect, it } from "vitest";
import { createHarness } from "../fixtures/smartPasteHarness";
import {
  drainHostedTimers,
  isTimerHostInstalled,
  pendingHostedTimers,
} from "../fixtures/hostedTimers";

describe("测试期定时器托管（#257）", () => {
  it("setup 已接线，且 Milkdown 编辑器创建的 3s 超时会被登记与清理", async () => {
    expect(isTimerHostInstalled()).toBe(true);

    const h = await createHarness({ markdown: "# x" });
    expect(pendingHostedTimers()).toBeGreaterThan(0);
    await h.destroy();

    drainHostedTimers();
    expect(pendingHostedTimers()).toBe(0);
  });

  it("清理后即使环境全局消失，3s 超时回调也不再抛错", async () => {
    const h = await createHarness({ markdown: "# x" });
    await h.destroy();

    // 模拟环境销毁：收回 happy-dom 提供的全局，裸 removeEventListener 不复存在
    const realRemoveEventListener = globalThis.removeEventListener;
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", onUncaught);
    try {
      Reflect.deleteProperty(globalThis, "removeEventListener");
      expect("removeEventListener" in globalThis).toBe(false);

      drainHostedTimers();
      // 3s 炸弹窗口：清理失效时 milkdown 的超时回调会在此窗口内抛 ReferenceError
      await new Promise((resolve) => setTimeout(resolve, 3300));
    } finally {
      globalThis.removeEventListener = realRemoveEventListener;
      process.off("uncaughtException", onUncaught);
    }

    expect(uncaught).toEqual([]);
  }, 10000);
});
// 测试期定时器托管（#257）
//
// 背景：`@milkdown/ctx` 的 `Timer.start()` 在注册监听后**无条件**挂一个 3s 超时
// （`timer.ts` 的 `#waitTimeout`），超时回调里调用**裸全局** `removeEventListener`。
// 用例文件结束、happy-dom 环境被销毁（全局被收回）后，仍挂在 node 事件循环上的这些回调
// 才触发 → `ReferenceError: removeEventListener is not defined`：用例全绿，但 vitest 记为
// unhandled error，`pnpm test` 随机 exit 1。
//
// 这些 3s 超时对已结束的用例没有任何语义（对应 waitFor 早已 resolve），因此在文件结束时
// 统一清掉。安装与清理在 `tests/setup.ts`（`hostTimeouts` + `afterAll(drainHostedTimers)`）。

/** 托管期内创建的、尚未触发的定时器句柄 */
const hosted = new Set<ReturnType<typeof setTimeout>>();

let installed = false;

/** setup 是否已安装托管（回归用例断言接线） */
export const isTimerHostInstalled = () => installed;

/** 当前挂起的托管定时器数量（回归用例断言编辑器确实登记了 3s 超时） */
export const pendingHostedTimers = () => hosted.size;

/**
 * 包装全局 `setTimeout`：登记托管期内创建的定时器（触发后自行移出）。
 *
 * 返回值原样透传，与 `clearTimeout` 的兼容性不变；`vi.useFakeTimers()` 替换的是本包装，
 * `useRealTimers()` 原样还原。
 */
export function hostTimeouts(): void {
  if (installed) return;
  installed = true;
  const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
  globalThis.setTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    // 字符串处理器（本仓库测试不使用）不托管，原样透传
    if (typeof handler !== "function") return hostSetTimeout(handler, timeout, ...args);
    const id = hostSetTimeout(() => {
      hosted.delete(id);
      handler(...args);
    }, timeout);
    hosted.add(id);
    return id;
  }) as typeof setTimeout;
}

/** 清理所有挂起的托管定时器（文件结束时调用；已触发的已自行移出） */
export function drainHostedTimers(): void {
  for (const id of hosted) clearTimeout(id);
  hosted.clear();
}
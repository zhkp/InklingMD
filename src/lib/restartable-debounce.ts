// 可重启的一次性防抖任务（#375）
//
// 为什么单独抽出来：源码模式「停笔 250ms 内大纲更新」这条验收此前只有
// 「5 秒内最终更新」的 E2E 兜着——退化成秒级也照样绿，等于没有验收。
// 把「延迟参数 + 回调内同步执行 + 最后一次重置为准」做成不依赖 DOM 的纯逻辑后，
// 这三个性质都能用假时钟确定性地断言，不再依赖浏览器调度的绝对计时。

/** 源码模式大纲防抖窗口：停笔后 200ms 重算，余量留给重算与面板渲染 */
export const SOURCE_OUTLINE_DEBOUNCE_MS = 200;

/**
 * 验收上限（#375）：停笔 → 大纲更新不得超过 250ms。
 * 常量与上限分开声明，改防抖时同步暴露「是否还在验收窗口内」。
 */
export const SOURCE_OUTLINE_DEADLINE_MS = 250;

export interface RestartableDebounce {
  /** 重置计时窗口；任意时刻最多只有一个待执行回调 */
  schedule(): void;
  /** 取消待执行回调（卸载 / 退出） */
  cancel(): void;
  readonly pending: boolean;
}

/**
 * 创建可重启防抖任务。
 *
 * 回调**在定时器回调内同步执行**——调用方直接在这里重算并发布，不能再套
 * rAF / setTimeout，否则「停笔 250ms 内更新」会变成「250ms + 一帧」。
 */
export function createRestartableDebounce(opts: {
  delayMs: number;
  run: () => void;
  /** 定时器注入点（缺省用 window，便于在非 DOM 环境复用） */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}): RestartableDebounce {
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number): number => window.setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((id: number): void => window.clearTimeout(id));
  let timer: number | null = null;

  return {
    schedule(): void {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        opts.run();
      }, opts.delayMs);
    },
    cancel(): void {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
    get pending(): boolean {
      return timer !== null;
    },
  };
}

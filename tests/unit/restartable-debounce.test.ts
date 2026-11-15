// 源码模式大纲防抖（#375）的确定性锁
//
// 为什么不再靠 E2E 的 5 秒轮询：那条断言只证明「最终会更新」，退化成 1s 甚至数秒
// 也照样绿，而验收要求是「停笔 250ms 内更新」。这里用假时钟锁三件事：
// ① 防抖窗口参数与验收上限的关系；② 回调在定时器内**同步**执行（不再多等一帧）；
// ③ 连续输入以最后一次输入为起点重开窗口，且只发布一次。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRestartableDebounce,
  SOURCE_OUTLINE_DEBOUNCE_MS,
  SOURCE_OUTLINE_DEADLINE_MS,
} from "../../src/lib/restartable-debounce";

describe("源码模式大纲防抖（#375）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("防抖窗口 200ms，且落在 250ms 验收上限之内", () => {
    expect(SOURCE_OUTLINE_DEBOUNCE_MS).toBe(200);
    expect(SOURCE_OUTLINE_DEADLINE_MS).toBe(250);
    // 余量给重算全文 + 面板渲染；调大防抖必须先让这条断言变红
    expect(SOURCE_OUTLINE_DEBOUNCE_MS).toBeLessThan(SOURCE_OUTLINE_DEADLINE_MS);
  });

  it("停笔后在定时器回调内同步执行（不等下一帧或微任务）", () => {
    let published = 0;
    const debounce = createRestartableDebounce({
      delayMs: SOURCE_OUTLINE_DEBOUNCE_MS,
      run: () => {
        published += 1;
      },
    });

    debounce.schedule();
    vi.advanceTimersByTime(SOURCE_OUTLINE_DEBOUNCE_MS - 1);
    expect(published).toBe(0);
    expect(debounce.pending).toBe(true);

    vi.advanceTimersByTime(1);
    // 同步执行：advanceTimersByTime 返回时回调已经跑完（没有 await / 额外 tick）
    expect(published).toBe(1);
    expect(debounce.pending).toBe(false);
  });

  it("连续输入以最后一次输入为起点：距首次 300ms 仍未执行，距末次 200ms 才执行一次", () => {
    const run = vi.fn();
    const debounce = createRestartableDebounce({
      delayMs: SOURCE_OUTLINE_DEBOUNCE_MS,
      run,
    });

    debounce.schedule();
    vi.advanceTimersByTime(150);
    debounce.schedule(); // 第二次输入重开窗口
    vi.advanceTimersByTime(150); // 距第一次 300ms，距最后一次 150ms
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SOURCE_OUTLINE_DEBOUNCE_MS - 150);
    expect(run).toHaveBeenCalledTimes(1);
    expect(debounce.pending).toBe(false);
  });

  it("取消后不再执行（卸载 / 退出源码模式路径）", () => {
    const run = vi.fn();
    const debounce = createRestartableDebounce({
      delayMs: SOURCE_OUTLINE_DEBOUNCE_MS,
      run,
    });

    debounce.schedule();
    debounce.cancel();
    expect(debounce.pending).toBe(false);
    vi.advanceTimersByTime(SOURCE_OUTLINE_DEBOUNCE_MS * 10);
    expect(run).not.toHaveBeenCalled();
  });

  it("执行后可以再次调度（下一次输入重新起窗口）", () => {
    const run = vi.fn();
    const debounce = createRestartableDebounce({
      delayMs: SOURCE_OUTLINE_DEBOUNCE_MS,
      run,
    });

    debounce.schedule();
    vi.advanceTimersByTime(SOURCE_OUTLINE_DEBOUNCE_MS);
    debounce.schedule();
    expect(debounce.pending).toBe(true);
    vi.advanceTimersByTime(SOURCE_OUTLINE_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

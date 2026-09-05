// useEditorFallback（issue #172）测试
// 锁定修复语义：慢启动（create() 在途 >3s）只亮提示、绝不卸载/降级；
// 真失败只有两种——工厂同步抛错（markFactoryFailed）与 create 异步失败
// （loading=false 后 getEditor() 仍为空）。
// 变异验证：把 loading 分支从「仅提示」改回旧实现的 setFallback(true)，
// 用例 1 会失败（fallback 提前变 true）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  useEditorFallback,
  SLOW_START_HINT_MS,
} from "../../src/components/Editor/useEditorFallback";
import type { Editor } from "@milkdown/kit/core";

/** 可变 editor 持有者：同一函数实例跨 rerender，模拟 useInstance 的稳定 getEditor */
function makeHarness() {
  const holder: { editor?: Editor } = {};
  const getEditor = () => holder.editor;
  return { holder, getEditor };
}

describe("useEditorFallback（issue #172 慢启动不卸载）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("慢启动：loading 超过阈值只亮 slowStart 提示，fallback 保持 false（不卸载）", () => {
    const { holder, getEditor } = makeHarness();
    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => useEditorFallback(loading, getEditor),
      { initialProps: { loading: true } },
    );

    expect(result.current.fallback).toBe(false);
    expect(result.current.slowStart).toBe(false);

    // create() 在途超过 3 秒（工厂已成功、只是慢）：旧实现会在这里
    // setFallback(true) 卸载 <Milkdown/>——正是 issue #172 的缺陷
    act(() => {
      vi.advanceTimersByTime(SLOW_START_HINT_MS);
    });
    expect(result.current.slowStart).toBe(true);
    expect(result.current.fallback).toBe(false);

    // create 最终完成：loading=false 且实例就绪 → 恢复正常，提示消失
    holder.editor = {} as Editor;
    act(() => {
      rerender({ loading: false });
    });
    expect(result.current.fallback).toBe(false);
    expect(result.current.slowStart).toBe(false);
  });

  it("工厂同步抛错（markFactoryFailed）：立即降级，不依赖慢启动超时", () => {
    const { getEditor } = makeHarness();
    const { result } = renderHook(() => useEditorFallback(true, getEditor));

    act(() => {
      result.current.markFactoryFailed();
    });
    expect(result.current.fallback).toBe(true);
    expect(result.current.slowStart).toBe(false);

    // loading 永不结束的背景下继续等更久，仍是降级而非提示
    act(() => {
      vi.advanceTimersByTime(SLOW_START_HINT_MS * 10);
    });
    expect(result.current.fallback).toBe(true);
  });

  it("create 异步失败：loading=false 后 getEditor() 仍为空 → 降级", () => {
    const { getEditor } = makeHarness();
    const { result } = renderHook(() => useEditorFallback(false, getEditor));

    expect(result.current.fallback).toBe(true);
    expect(result.current.slowStart).toBe(false);
  });

  it("快速就绪：阈值内 loading 结束，不亮提示、不降级，定时器被清理", () => {
    const { holder, getEditor } = makeHarness();
    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => useEditorFallback(loading, getEditor),
      { initialProps: { loading: true } },
    );

    // 1 秒内就绪（未达阈值）
    holder.editor = {} as Editor;
    act(() => {
      vi.advanceTimersByTime(SLOW_START_HINT_MS - 1000);
      rerender({ loading: false });
    });
    expect(result.current.fallback).toBe(false);
    expect(result.current.slowStart).toBe(false);

    // 清理后继续走时间：也不应再亮提示（定时器已被 loading 结束清理）
    act(() => {
      vi.advanceTimersByTime(SLOW_START_HINT_MS);
    });
    expect(result.current.slowStart).toBe(false);
    expect(result.current.fallback).toBe(false);
  });
});

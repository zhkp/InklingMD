// 状态栏统计的延迟刷新（issue #374）
//
// countStats 对全文做多次 O(n) 遍历；源码模式下内容每次按键都会发布，
// 逐键统计在 20k 行档单次可达 10ms+。这里把统计防抖到「输入停顿后」，
// 显示保留上一次结果（不闪空），并在切 tab / 保存时立即刷新，避免数字停留。

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { perfProbeEnd, perfProbeStart } from "./perf-probe";
import { countStats, type DocStats } from "./stats";

/** 输入停顿后多久刷新统计（#374 建议 300–500ms；WYSIWYG 侧还有 150ms 发布防抖） */
export const STATS_DEBOUNCE_MS = 300;

/**
 * @param content 当前文档全文（已是 store 的事实源）
 * @param file 当前文件路径；切换文件时立即重算，不等防抖
 * @param flushOn 保存等「必须立即看到最新数字」的信号：为 true 时若有待刷新则立刻计算
 */
export function useDeferredStats(
  content: string,
  file: string | null,
  flushOn: boolean,
): DocStats {
  const [stats, setStats] = useState<DocStats>(() => countStats(content));
  /** 最近一次已用于统计的内容：相同就不重复计算 */
  const computedContentRef = useRef(content);
  /** 最新内容（定时器回调可能晚于多次渲染） */
  const latestContentRef = useRef(content);
  latestContentRef.current = content;
  const fileRef = useRef(file);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 最近一次内容变化的时间点（探针未启用时为 null） */
  const pendingSinceRef = useRef<number | null>(null);

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingSinceRef.current = null;
  }, []);

  const computeNow = useCallback((text: string) => {
    cancelPending();
    computedContentRef.current = text;
    setStats(countStats(text));
  }, [cancelPending]);

  // 用 layout effect：切 tab 时必须在首帧前换掉旧统计。若用 useEffect，
  // 首帧会是「新文件名 + 上一文件的字数」，下一次渲染才纠正。
  useLayoutEffect(() => {
    const fileChanged = fileRef.current !== file;
    fileRef.current = file;

    if (fileChanged) {
      // 切 tab：立即刷新，避免新文件短暂显示上一篇的字数
      if (content !== computedContentRef.current) computeNow(content);
      else cancelPending();
      return;
    }

    if (content === computedContentRef.current) return;

    cancelPending();
    pendingSinceRef.current = perfProbeStart();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const latest = latestContentRef.current;
      computedContentRef.current = latest;
      setStats(countStats(latest));
      // 计时结束放在计算之后：statsSettle 表示「内容变化 → 新数字可用」的完整时延，
      // 不是只含防抖等待的定时器延迟（#379 归因口径）
      perfProbeEnd("statsSettle", pendingSinceRef.current);
      pendingSinceRef.current = null;
    }, STATS_DEBOUNCE_MS);
    return cancelPending;
  }, [content, file, computeNow, cancelPending]);

  // 同样用 layout effect：保存开始的那一帧就要换掉待刷新数字，
  // 不能等到绘制后再补（否则状态栏会短暂显示旧字数）。
  useLayoutEffect(() => {
    // 保存前强制刷新一次：待刷新内容就是即将保存的内容
    if (!flushOn || timerRef.current === null) return;
    computeNow(latestContentRef.current);
  }, [flushOn, computeNow]);

  return stats;
}

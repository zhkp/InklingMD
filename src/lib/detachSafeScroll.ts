/**
 * 卸载/切换时读取容器滚动几何的安全守卫（issue #174，与 #136 同源）。
 *
 * SourceModeEditor 的 layout-effect cleanup 在 DOM 移除之后才运行，脱链容器的
 * clientHeight/scrollHeight/scrollTop 都会读 0；切换过渡期还可能在容器塌缩的
 * 中间帧读到偏小值。因此「现场读数」只有当容器仍在线且布局可信时才采用。
 *
 * 与高度不同，scrollTop 不是单调量（用户会向上滚），不能取峰值；这里用
 * 「最后一次可信读数」兜底：容器在线期间每次滚动/尺寸变化都刷新缓存，cleanup
 * 时若现场已不可信（clientHeight<=1）则回退缓存——用户若真的在顶部，缓存同样
 * 是 0，回退不会造成错误恢复。
 */

export interface CachedScrollReadout {
  /** 最后一次可信的 scrollTop（容器在线且有布局时读到） */
  scrollTop: number;
  /** 最后一次可信的 scrollHeight */
  scrollHeight: number;
}

export interface ScrollReadout {
  scrollTop: number;
  scrollHeight: number;
}

/**
 * 读取滚动几何：`clientHeight > 1` 视为容器在线且布局可信（与 SourceModeEditor
 * 内部 refreshCursorVisible 的峰值缓存同判据），取现场值；否则回退缓存值。
 */
export function readDetachSafeScrollMetrics(
  el: HTMLElement,
  cached: CachedScrollReadout,
): ScrollReadout {
  const live = el.clientHeight > 1;
  return {
    scrollTop: live ? el.scrollTop : cached.scrollTop,
    scrollHeight: live ? el.scrollHeight : cached.scrollHeight,
  };
}

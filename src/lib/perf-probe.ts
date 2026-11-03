// 性能归因探针（issue #379）
//
// 只在 Playwright 基准页显式安装 `globalThis.__inklingPerfProbe` 后生效：
// 应用正常运行时这里只做一次属性读取，不记录、不打日志、不改变行为。
// 用途是把「一次输入里到底花在哪」拆开（统计 / 大纲提取 / 标题定位 / KaTeX），
// 供 benchmark 把归因标量随 raw 一起落盘，而不是拿 Node 微基准冒充浏览器数据。

interface PerfProbeBucket {
  /** 调用次数 */
  count: number;
  /** 累计耗时（ms） */
  totalMs: number;
  /** 单次最大耗时（ms） */
  maxMs: number;
}

interface PerfProbeState {
  enabled: boolean;
  buckets: Record<string, PerfProbeBucket>;
}

const PROBE_KEY = "__inklingPerfProbe";

function probeState(): PerfProbeState | undefined {
  return (globalThis as unknown as Record<string, PerfProbeState | undefined>)[
    PROBE_KEY
  ];
}

/** 返回计时起点；探针未启用时返回 null（调用方据此跳过后续开销） */
export function perfProbeStart(): number | null {
  const state = probeState();
  return state?.enabled ? performance.now() : null;
}

/** 结束一次计时；start 为 null（未启用）时直接返回 */
export function perfProbeEnd(name: string, start: number | null): void {
  if (start === null) return;
  const state = probeState();
  if (!state?.enabled) return;
  const elapsed = performance.now() - start;
  const bucket = state.buckets[name] ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
  };
  bucket.count += 1;
  bucket.totalMs += elapsed;
  if (elapsed > bucket.maxMs) bucket.maxMs = elapsed;
  state.buckets[name] = bucket;
}

/** 只计次数（不占计时窗口），用于发布次数这类计数归因 */
export function perfProbeCount(name: string): void {
  const state = probeState();
  if (!state?.enabled) return;
  const bucket = state.buckets[name] ?? {
    count: 0,
    totalMs: 0,
    maxMs: 0,
  };
  bucket.count += 1;
  state.buckets[name] = bucket;
}

// 页面内性能采集器（issue #216）
//
// 这些函数通过 page.evaluate 序列化到浏览器里执行，因此必须满足两条约束：
// 1. 不引用任何模块作用域的变量/导入（序列化只传函数体）——全部用入参或字面量
// 2. 返回值必须可 JSON 序列化
//
// 采集内容按 issue 指标清单：long task（>50ms 主线程阻塞）、layout shift、
// 堆占用、帧间隔、输入延迟。历史上三次性能问题都不是 FPS 问题而是 long task /
// 布局抖动问题，所以 long task 与 CLS 与帧间隔同等重要。

interface PerfWindowState {
  longTasks: number[];
  cls: number;
  heapStartMB: number | null;
}

interface WindowWithPerf {
  __perf?: PerfWindowState;
  __perfStart?: number | null;
  __perfSearchText?: string;
  __perfSearchStable?: number;
  __perfSearchDone?: number | null;
  __perfDirtyGone?: number | null;
}

type LayoutShiftEntry = PerformanceEntry & {
  hadRecentInput?: boolean;
  value?: number;
};

/**
 * 读取 JS 堆占用（MB）。
 * 注意：下面每个导出函数在被 page.evaluate 序列化后是**独立**的，
 * 彼此不能调用、也不能调用模块作用域的函数，所以堆读取逻辑在用到的地方各写一份。
 * 这是刻意的重复，不是遗漏。
 */

/**
 * 安装 longtask 与 layout-shift 观察器。
 * 必须在被测动作（点击/输入/滚动）之前调用，否则采集窗口不完整。
 */
export function installObservers(): void {
  const w = window as unknown as WindowWithPerf;
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const mem = perf.memory;
  const heapStartMB =
    mem && typeof mem.usedJSHeapSize === "number"
      ? Math.round((mem.usedJSHeapSize / 1024 / 1024) * 100) / 100
      : null;
  w.__perf = { longTasks: [], cls: 0, heapStartMB };

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        w.__perf?.longTasks.push(entry.duration);
      }
    }).observe({ type: "longtask", buffered: false });
  } catch {
    /* 浏览器不支持 longtask 时降级：该指标记 0，不影响其他采集 */
  }

  try {
    new PerformanceObserver((list) => {
      for (const raw of list.getEntries()) {
        const entry = raw as LayoutShiftEntry;
        // 只统计非用户输入窗口内的位移，否则会把用户主动操作引发的位移算成回归
        if (entry.hadRecentInput) continue;
        w.__perf!.cls += entry.value ?? 0;
      }
    }).observe({ type: "layout-shift", buffered: false });
  } catch {
    /* 同上：不支持则 CLS 记 0 */
  }
}

/** 停止并读出观察器累计值 */
export function readObservers(): {
  longTaskCount: number;
  longTaskMs: number;
  cls: number;
  heapStartMB: number | null;
  heapEndMB: number | null;
} {
  const w = window as unknown as WindowWithPerf;
  const state = w.__perf;
  const longTaskMs = state
    ? state.longTasks.reduce((sum, d) => sum + d, 0)
    : 0;
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize?: number };
  };
  const mem = perf.memory;
  const heapEndMB =
    mem && typeof mem.usedJSHeapSize === "number"
      ? Math.round((mem.usedJSHeapSize / 1024 / 1024) * 100) / 100
      : null;
  return {
    longTaskCount: state ? state.longTasks.length : 0,
    longTaskMs: Math.round(longTaskMs * 100) / 100,
    cls: state ? Math.round(state.cls * 10000) / 10000 : 0,
    heapStartMB: state ? state.heapStartMB : null,
    heapEndMB,
  };
}

/**
 * 埋设计时起点：捕获阶段记录首个指定事件的时刻（pointerdown / keydown）。
 * 用页面内打点而不是 Playwright 侧的 Date.now()，避免 CDP 往返误差进入测量值。
 */
export function armTiming(opts: { event: "pointerdown" | "keydown" }): void {
  const w = window as unknown as WindowWithPerf;
  w.__perfStart = null;
  document.addEventListener(
    opts.event,
    () => {
      if (w.__perfStart === null) w.__perfStart = performance.now();
    },
    { capture: true, once: true },
  );
}

/** 读取埋设的计时起点（未触发则回退为当前时刻） */
export function readTimingStart(): number {
  const w = window as unknown as WindowWithPerf;
  return w.__perfStart ?? performance.now();
}

/**
 * 监视搜索结果计数（.search-count）的稳定时刻，作为"搜索完成"的时间点。
 *
 * 为什么不用 Playwright 的 expect.poll 轮询：轮询的观察滞后（几十到上百毫秒）
 * 会直接进入 searchMs，把"我什么时候看到的"当成"它什么时候完成的"。
 * MutationObserver 在页面内判定，时间戳就是真实完成时刻。
 *
 * 面板是按下 mod+f 之后才挂载的，因此必须观察 document.body 的 subtree。
 */
export function armSearchWatch(): void {
  const w = window as unknown as WindowWithPerf;
  w.__perfSearchText = "";
  w.__perfSearchStable = 0;
  w.__perfSearchDone = null;

  const readCount = (): string => {
    const node = document.querySelector(".search-count");
    return (node?.textContent ?? "").trim();
  };

  // 用逐帧采样而不是 MutationObserver 计数：计数定格后不会再有 mutation，
  // 「连续两次 mutation 文本相同」的条件永远等不到第二次（实测踩过）。
  // 逐帧比对：文本匹配 n/m 且连续 2 帧未变即判定完成，滞后约 1 帧。
  const MAX_FRAMES = 1800;
  let frames = 0;
  const tick = (): void => {
    const text = readCount();
    if (/\d+\/\d+/.test(text)) {
      if (w.__perfSearchText === text) {
        w.__perfSearchStable = (w.__perfSearchStable ?? 0) + 1;
      } else {
        w.__perfSearchText = text;
        w.__perfSearchStable = 1;
      }
      if (w.__perfSearchStable >= 2 && w.__perfSearchDone === null) {
        w.__perfSearchDone = performance.now();
        return;
      }
    } else {
      w.__perfSearchText = text;
      w.__perfSearchStable = 0;
    }
    frames += 1;
    if (frames < MAX_FRAMES) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** 读取搜索完成时刻（未完成返回 null） */
export function readSearchDone(): number | null {
  const w = window as unknown as WindowWithPerf;
  return w.__perfSearchDone ?? null;
}

/**
 * 监视「未保存」标记（.tab-active .tab-dirty）消失的时刻，作为保存完成点。
 * 与搜索场景不同，这里用 MutationObserver 是合适的：标记是**被移除**，
 * 移除动作本身就是一次 mutation，不存在"定格后没有第二次事件"的问题。
 */
export function armDirtyWatch(): void {
  const w = window as unknown as WindowWithPerf;
  w.__perfDirtyGone = null;
  const observer = new MutationObserver(() => {
    if (w.__perfDirtyGone !== null) return;
    if (!document.querySelector(".tab-active .tab-dirty")) {
      w.__perfDirtyGone = performance.now();
      observer.disconnect();
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
  });
}

/** 读取保存完成时刻（未完成返回 null） */
export function readDirtyGone(): number | null {
  const w = window as unknown as WindowWithPerf;
  return w.__perfDirtyGone ?? null;
}

/** 等待「内容已绘制」：连续两帧 rAF 完成，返回第二帧时刻 */
export function waitTwoFrames(): Promise<number> {
  return new Promise<number>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve(performance.now()));
    });
  });
}

/**
 * 在页面内等待编辑器高度收敛（内容渲染到位），返回收敛时刻。
 *
 * 为什么不复用 e2e 的 waitScrollConverged：它靠 Playwright expect.poll 采样，
 * 最快也要 3×(100~160ms) ≈ 390ms 的固定开销，会把 TTI 的基数抬高一大截，
 * 同样的回归幅度在百分比上被稀释。逐帧判定把这个开销降到 ~10 帧（约 166ms）。
 */
export function waitRenderStable(opts: {
  stableFrames: number;
  maxFrames: number;
}): Promise<{ at: number; frames: number; height: number }> {
  const el = document.querySelector(".editor-scroll") as HTMLElement | null;
  if (!el) throw new Error("perf: 未找到 .editor-scroll");
  let lastHeight = -1;
  let stable = 0;
  let frames = 0;
  return new Promise<{ at: number; frames: number; height: number }>((resolve) => {
    const step = (): void => {
      frames += 1;
      const height = el.scrollHeight;
      stable = height === lastHeight ? stable + 1 : 0;
      lastHeight = height;
      const done = stable >= opts.stableFrames || frames >= opts.maxFrames;
      if (!done) {
        requestAnimationFrame(step);
        return;
      }
      requestAnimationFrame(() =>
        resolve({ at: performance.now(), frames, height }),
      );
    };
    requestAnimationFrame(step);
  });
}

/**
 * 逐帧驱动滚动并采集帧间隔。
 * 复用 tests/e2e/source-mode-scroll-race.spec.ts 的 rAF 范式（frames++ + rAF(step)），
 * 这里补齐了每帧时间戳采集。
 *
 * 步长自适应（评审 P2-4）：固定 240px × 120 帧 = 28,800px，短文档会中途触底，
 * 之后所有帧测的是静止页面的 vsync，既稀释样本又掩盖下半篇的滚动开销。
 * 因此按文档实际可滚动距离反推步长，并额外回报最终位置与是否触底，交由调用方断言。
 */
export function runScrollFrames(opts: {
  frames: number;
  maxStep: number;
}): Promise<{
  intervals: number[];
  maxScroll: number;
  finalScrollTop: number;
  saturated: boolean;
  step: number;
}> {
  const el = document.querySelector(".editor-scroll") as HTMLElement | null;
  if (!el) throw new Error("perf: 未找到 .editor-scroll");

  const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
  // 预留 10% 余量，避免最后一帧正好压到底部边界
  const step = Math.max(
    24,
    Math.min(opts.maxStep, Math.floor((maxScroll * 0.9) / opts.frames)),
  );

  const intervals: number[] = [];
  let frames = 0;
  let last = performance.now();
  return new Promise<{
    intervals: number[];
    maxScroll: number;
    finalScrollTop: number;
    saturated: boolean;
    step: number;
  }>((resolve) => {
    const stepFn = (): void => {
      frames += 1;
      el.scrollTop += step;
      const now = performance.now();
      intervals.push(now - last);
      last = now;
      if (frames < opts.frames) {
        requestAnimationFrame(stepFn);
        return;
      }
      const finalScrollTop = el.scrollTop;
      resolve({
        intervals,
        maxScroll,
        finalScrollTop,
        saturated: finalScrollTop >= maxScroll - 1,
        step,
      });
    };
    requestAnimationFrame(stepFn);
  });
}

/**
 * 连续输入采集：每个字符一次 execCommand('insertText')（走真实 beforeinput 路径，
 * 全程在页面内，不受 CDP 往返噪声污染）。
 * 返回两类延迟 + 实际插入长度，供上层做「是否真的插进去了」的假阴性校验。
 */
export function runInputBurst(opts: {
  count: number;
  text: string;
}): Promise<{ sync: number[]; paint: number[]; inserted: number; allApplied: boolean }> {
  const editor = document.querySelector(".ProseMirror") as HTMLElement | null;
  if (!editor) throw new Error("perf: 未找到 .ProseMirror");
  const before = (editor.textContent ?? "").length;
  const sync: number[] = [];
  const paint: number[] = [];
  let allApplied = true;

  const nextFrame = (): Promise<void> =>
    new Promise<void>((r) => requestAnimationFrame(() => r()));

  return (async () => {
    for (let i = 0; i < opts.count; i += 1) {
      await nextFrame();
      const t0 = performance.now();
      const applied = document.execCommand("insertText", false, opts.text);
      const t1 = performance.now();
      await nextFrame();
      const t2 = performance.now();
      if (!applied) allApplied = false;
      sync.push(t1 - t0);
      paint.push(t2 - t0);
    }
    const after = (editor.textContent ?? "").length;
    return { sync, paint, inserted: after - before, allApplied };
  })();
}

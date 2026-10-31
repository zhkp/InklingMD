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
 * 会话标定负载：与编辑器代码无关的**固定合成工作量**，用来回答"这台 runner 这一轮有多快"（issue #236）。
 *
 * 为什么需要：基线比对是跨运行比较——若 runner 本身变慢（共享宿主机争用 / VM 放置差异），
 * 所有应用指标会一起变差，而多轮复现过滤不掉它（#234 实测：一次慢会话里 88% 的相对行
 * 同时变差、中位 Δ +18.7%；#294 进一步发现**两个**会话可以同时被拖慢，所以确认轮
 * 自身标定越界时不得确认 FAIL）。有了一段**不受被测代码影响**的参照，才能把"机器慢"从"代码回归"里
 * 分离出来。用应用自己的指标当锚点不行：它同时受"机器慢"与"代码变慢"影响，会掩盖真实回归。
 *
 * 工作量必须**写死**（下两个常量），否则标定值本身不可比。
 */
export const PROBE_NODES = 1500;
export const PROBE_LOOP_ITERS = 20_000_000;

/**
 * 在页面内执行标定负载（经 page.evaluate 序列化，故不引用模块作用域变量）。
 * 两条路径分别覆盖：① **DOM 构建 / 样式 / 布局**（固定数量节点 + 强制 layout）② 纯 CPU（固定步数计算）。
 * 注意：① 是**离屏 + visibility:hidden** 的子树，只走 style recalc 与 layout，**不产生 paint/光栅化**——
 * 所以措辞里不写「覆盖绘制」（评审 #P2-2 指出过：声称覆盖绘制而实际不绘制，等于虚报覆盖）。
 *
 * ⚠️ 工作量在函数体内写成字面量（序列化只带函数体，拿不到 PROBE_NODES / PROBE_LOOP_ITERS），
 * 单测 `perf-session-probe` 用 `runSessionProbe.toString()` 断言函数体里的字面量与常量一致——
 * 只改一处、忘改另一处会当场失败（此前只断言常量本身，守卫是虚的，评审 #P1-1 指出）。
 * 量级选择：实测本机约 8ms 布局 + 30ms CPU——太短会让标定值自身抖动（±1ms 即 10%+），
 * 分辨率不足以判"机器变慢 20%"；总量 ~40ms 相对场景耗时（秒级）可忽略。
 */
export function runSessionProbe(): Promise<{
  layoutMs: number;
  cpuMs: number;
  totalMs: number;
}> {
  const nodes = 1500;
  const iters = 20_000_000;
  return (async () => {
    // ① DOM 构建/样式/布局路径：固定数量节点 + 固定样式；离屏（contain:strict + visibility:hidden）
    const host = document.createElement("div");
    host.style.cssText =
      "position:absolute;left:-99999px;top:0;width:800px;contain:strict;visibility:hidden";
    const t0 = performance.now();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < nodes; i += 1) {
      const d = document.createElement("div");
      d.style.cssText = "height:3px;margin:1px;padding:1px;border:1px solid #333";
      d.textContent = "x";
      frag.appendChild(d);
    }
    host.appendChild(frag);
    document.body.appendChild(host);
    // 读一次尺寸强制 flush 布局（只创建不布局的话测不到 layout 成本）
    void host.offsetHeight;
    const layoutMs = performance.now() - t0;
    host.remove();

    // ② CPU 路径：固定步数的纯计算
    const t1 = performance.now();
    let acc = 0;
    for (let i = 1; i <= iters; i += 1) acc += (i % 7) * 0.5;
    const cpuMs = performance.now() - t1;
    // 防死代码消除：结果必须被"用到"，否则 V8 可能把整个循环优化掉
    if (!Number.isFinite(acc) || acc <= 0) throw new Error("perf: 标定负载被优化掉");

    return { layoutMs, cpuMs, totalMs: layoutMs + cpuMs };
  })();
}

/** 标定负载的采集器：每轮调一次 measure，最后取中位数成标量（与其它 scalars 一起进基线） */
export function createSessionProbe() {
  const layout: number[] = [];
  const cpu: number[] = [];
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    async measure(page: { evaluate: (fn: () => unknown) => Promise<unknown> }): Promise<void> {
      const r = (await page.evaluate(runSessionProbe)) as {
        layoutMs: number;
        cpuMs: number;
      };
      layout.push(r.layoutMs);
      cpu.push(r.cpuMs);
    },
    /** 未采集到任何样本时返回空对象（例如老版本产物的回放），不伪造 0 */
    scalars(): Record<string, number> {
      if (layout.length === 0 || cpu.length === 0) return {};
      const l = round2(median(layout));
      const c = round2(median(cpu));
      return { probeLayoutMs: l, probeCpuMs: c, probeMs: round2(l + c) };
    },
  };
}

/**
 * 「输入未落地」时的重试上限（配合 runInputBurst 的 allApplied 守卫）。
 *
 * 为什么需要：`execCommand('insertText')` 偶发返回 false（实测 2 万行档在共享 runner 上
 * 约 1/4 的运行会命中一次，见 run 34850353239），此时代码块"根本没接收输入"，
 * 这批数据**无效**——不校验就会把"没输入"记成"极快"。
 *
 * 正确做法不是删掉守卫，而是**重新加载文档重测一轮**：每轮的 goto + 注入本就把文档
 * 复位，重试代价小且不污染测量；重试到上限仍不落地才判测量故障（保持守卫语义）。
 */
export const INPUT_LANDING_RETRIES = 2;

/**
 * 源码模式连续输入采集（issue #379）。
 *
 * 与 runInputBurst 同范式（页面内 rAF + execCommand，避免 CDP 往返），
 * 但落点换成 CodeMirror：`.cm-content` 会视口化，不能按整篇 textContent 判落地，
 * 因此用**活动行**长度增长做假阴性守卫。
 */
export function runSourceInputBurst(opts: {
  count: number;
  text: string;
}): Promise<{ sync: number[]; paint: number[]; inserted: number; allApplied: boolean }> {
  const root = document.querySelector(
    '[data-testid="source-mode-editor"]',
  ) as HTMLElement | null;
  const content = root?.querySelector(".cm-content") as HTMLElement | null;
  if (!root || !content) throw new Error("perf: 未找到源码模式编辑器");
  const activeLine = (): HTMLElement | null =>
    root.querySelector(".cm-activeLine");
  const before = (activeLine()?.textContent ?? "").length;
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
    const after = (activeLine()?.textContent ?? "").length;
    return { sync, paint, inserted: after - before, allApplied };
  })();
}

/**
 * 安装归因探针（issue #379）。探针本身由生产代码里的 `perf-probe` 读取：
 * 未安装时生产侧只有一次属性读取，不记录任何东西。
 */
export function installPerfProbe(): void {
  (window as unknown as { __inklingPerfProbe?: unknown }).__inklingPerfProbe = {
    enabled: true,
    buckets: {},
  };
}

export interface PerfProbeBuckets {
  [name: string]: { count: number; totalMs: number; maxMs: number };
}

/** 读出归因桶；未安装时返回空对象（不伪造 0） */
export function readPerfProbe(): PerfProbeBuckets {
  const state = (window as unknown as {
    __inklingPerfProbe?: { buckets?: PerfProbeBuckets };
  }).__inklingPerfProbe;
  return state?.buckets ?? {};
}

/**
 * 等指定归因桶出现（Node 侧轮询）。
 *
 * 固定 waitForTimeout 不可靠：WYSIWYG 的发布防抖要等全文序列化（L 档可达秒级），
 * 之后还有 300ms 统计防抖；同样的 700ms 在 M 档够、L 档不够。轮询到桶出现为止，
 * 超时则按「未采集」返回（不伪造 0），调用方不用为采集延迟调整判定口径。
 */
export async function waitForProbeBuckets(
  page: { evaluate: (fn: () => PerfProbeBuckets) => Promise<PerfProbeBuckets> },
  names: readonly string[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PerfProbeBuckets> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let buckets = await page.evaluate(readPerfProbe);
  while (!names.every((name) => buckets[name]) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    buckets = await page.evaluate(readPerfProbe);
  }
  // 超时不能静默：缺桶会让归因表少一行，读者却以为「这项成本为 0/未发生」。
  // 仍不算测量失败（场景主指标有效），按未采集处理并在输出里点名。
  const missing = names.filter((name) => !buckets[name]);
  if (missing.length > 0) {
    console.warn(
      `[perf] 归因桶等待 ${timeoutMs}ms 仍未出现：${missing.join(", ")}` +
        "（按未采集处理，不伪造 0）",
    );
  }
  return buckets;
}

/**
 * 等待公式真正渲染完成（issue #379 / #376）。
 *
 * 返回节点数、已出现 KaTeX 输出的数量、空公式数量与完成时刻。
 * 空公式（如 `$ $`）渲染的是占位提示而不是 `.katex`，把它们算进「未渲染」会让
 * 全等断言在含空公式的 fixture 上永远失败；完成条件因此是 rendered + empty >= nodeViews。
 * TTI 的既有定义不因它改变：调用方在读完 TTI 观测值之后再调用，用于单独归因
 * 「KaTeX 模块加载 + 逐公式渲染」的 JS 尾部耗时（不覆盖 DOM 布局/绘制）。
 */
export function waitFormulaSettled(opts: { maxFrames: number }): Promise<{
  at: number;
  nodeViews: number;
  rendered: number;
  empty: number;
  frames: number;
}> {
  const nodeViews = document.querySelectorAll(
    "[data-math-inline], [data-math-display]",
  ).length;
  const empty = document.querySelectorAll(
    '[data-math-inline][data-value=""], [data-math-display][data-value=""]',
  ).length;
  let frames = 0;
  return new Promise<{
    at: number;
    nodeViews: number;
    rendered: number;
    empty: number;
    frames: number;
  }>((resolve) => {
    const settle = (): void => {
      const rendered = document.querySelectorAll(
        "[data-math-inline] .katex, [data-math-display] .katex",
      ).length;
      if (rendered + empty >= nodeViews || frames >= opts.maxFrames) {
        resolve({ at: performance.now(), nodeViews, rendered, empty, frames });
        return;
      }
      frames += 1;
      requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  });
}

/**
 * 归因桶的轮次聚合（Node 侧，issue #379）。
 *
 * 每个桶输出 `<name>Ms`（每轮总耗时均值）、`<name>MaxMs`（单次最大耗时均值）、
 * `<name>Count`（每轮调用次数均值）。缺失的桶不输出——纯文本档没有公式，
 * 伪造 0 会让「未测量」看起来像「零成本」。
 */
export const ATTRIBUTION_BUCKETS = [
  "stats",
  "statsSettle",
  "outlineExtract",
  "outlineSettle",
  "headingLocate",
  "outlinePublish",
  "katexLoad",
  "katexRender",
  "formulaNodeView",
] as const;

/**
 * 只计次数的桶（`perfProbeCount`）——totalMs/maxMs 恒为 0，不是「耗时为零」。
 * 对它们只派生 `<name>Count`，否则归因表会显示一列 0ms，把「未计时」读成「无成本」。
 */
export const COUNT_ONLY_BUCKETS: ReadonlySet<string> = new Set([
  "outlinePublish",
]);

export function createAttributionAggregator() {
  const rounds: PerfProbeBuckets[] = [];
  const round2 = (n: number): number => Math.round(n * 100) / 100;

  return {
    add(buckets: PerfProbeBuckets): void {
      rounds.push(buckets ?? {});
    },
    scalars(): Record<string, number> {
      const out: Record<string, number> = {};
      if (rounds.length === 0) return out;
      for (const name of ATTRIBUTION_BUCKETS) {
        const entries = rounds
          .map((r) => r[name])
          .filter((b): b is { count: number; totalMs: number; maxMs: number } =>
            Boolean(b),
          );
        if (entries.length === 0) continue;
        // 只计次的桶：探针在测量窗口开始前已安装，某轮没有桶 = 该轮 0 次事件，
        // 必须按总轮数平均；否则「3 轮里只发生 1 次」会被算成「每轮 1 次」。
        // 计时桶缺失仍视为未测量，只对有桶的轮取均值（不伪造 0ms）。
        const divisor = COUNT_ONLY_BUCKETS.has(name)
          ? rounds.length
          : entries.length;
        const avg = (pick: (b: (typeof entries)[number]) => number): number =>
          entries.reduce((sum, b) => sum + pick(b), 0) / divisor;
        if (!COUNT_ONLY_BUCKETS.has(name)) {
          out[`${name}Ms`] = round2(avg((b) => b.totalMs));
          out[`${name}MaxMs`] = round2(avg((b) => b.maxMs));
        }
        out[`${name}Count`] = round2(avg((b) => b.count));
      }
      return out;
    },
  };
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

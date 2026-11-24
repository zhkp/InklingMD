// 标签页编辑器状态缓存与渐进式文档水合（issue #426）
//
// 背景：切回已打开的大文档 tab 时，重建 Milkdown 实例会同步执行全文 Markdown 解析、
// 全量 DOM 节点创建、同步全量序列化与多次强制布局，导致 0.6–0.8s 单次长任务。
// 方案：
// 1. 复用同一个 Milkdown 编辑器实例，切走时将旧 tab 的完整 ProseMirror doc、
//    选区、撤销历史、lastSynced 基线与大纲快照写入按路径索引的有界 LRU 缓存；
// 2. 切回缓存命中的文档时跳过 Markdown 解析与冗余序列化，先挂载首屏分片，
//    再按**宏任务**追加尾部块（rAF 会和页面自身的逐帧布局读取挤进同一个渲染任务，
//    见 startDocHydration 里的实测说明），把每帧主线程耗时压到 50ms 以下；
// 3. 水合期间用 `min-height` 占位撑住滚动容器高度，避免「逐帧长高」把
//    「等高度收敛」类判定（switchMs）拉长成整个水合时长。

import { PluginKey, TextSelection, type EditorState, type Plugin, type Transaction } from "@milkdown/kit/prose/state";
import { Fragment, type Node as PMNode } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { EditorOutlineSnapshot } from "../../lib/outline";

/**
 * 分片大小按路径分档（#426 实测）：
 * - 首次打开（无缓存、要从 Markdown 解析）：可选块多、没有历史高度可占位，
 *   TTI 由总工作量决定，分片越大帧数越少、总耗时越短（实测 250 块/片比 32 块/片
 *   快 2.6 倍），因此用大分片；
 * - 切回已缓存的 tab：高度占位已经把「等高度收敛」的窗口缩到首帧，
 *   单帧越小越不会顶出长任务，因此用小分片。
 */
export const HYDRATION_CHUNK_SIZE_FIRST_OPEN = 250;
export const HYDRATION_CHUNK_SIZE_TAB_SWITCH = 32;

/** 默认最多缓存的标签页数量 */
export const DEFAULT_MAX_CACHED_TABS = 12;

export interface HydrationMeta {
  hydrating: true;
  done: boolean;
  /** 缓存恢复时文档节点已带完整 heading id / 公式编号 */
  fromCache?: boolean;
  /** 尾部追加分片时，给出新增起始块索引与旧 doc 末尾位置，供插件做 O(chunk) 增量更新 */
  appendFromIndex?: number;
  appendFromPos?: number;
  /** 可选：切回缓存 tab 时首帧即发布已缓存的大纲快照 */
  initialOutline?: EditorOutlineSnapshot | null;
}

export const hydrationMetaKey = new PluginKey<HydrationMeta>("inkling-tab-hydration");

export interface TabEditorSnapshot {
  filePath: string;
  revision: number;
  /** 当初构建/最近同步时的 tab.content，用于校验后台分屏或全局替换未改脏内容 */
  cachedContent: string;
  fullDoc: PMNode;
  selection: { anchor: number; head: number };
  historyState: unknown;
  lastSynced: string;
  outlineSnapshot: EditorOutlineSnapshot | null;
  /**
   * 切走时滚动容器的 scrollHeight（0 = 未测到）。
   * 分片水合期间用它撑住容器高度，滚动条与 `waitRenderStable` 类「高度稳定」
   * 判定不会因为尾部块逐帧追加而持续变化（#426）。
   */
  totalHeight: number;
}

export interface TabEditorCache {
  get(filePath: string, revision: number, content: string): TabEditorSnapshot | null;
  set(entry: TabEditorSnapshot): void;
  delete(filePath: string): void;
  prune(openPaths: ReadonlySet<string>): void;
  clear(): void;
  size(): number;
}

export function createTabEditorCache(maxEntries = DEFAULT_MAX_CACHED_TABS): TabEditorCache {
  const map = new Map<string, TabEditorSnapshot>();
  const cap = Math.max(0, Math.floor(maxEntries));

  return {
    get(filePath, revision, content) {
      const hit = map.get(filePath);
      if (!hit) return null;
      if (hit.revision !== revision || hit.cachedContent !== content) {
        map.delete(filePath);
        return null;
      }
      // LRU 触碰：移至最新端
      map.delete(filePath);
      map.set(filePath, hit);
      return hit;
    },
    set(entry) {
      if (cap === 0) return;
      map.delete(entry.filePath);
      map.set(entry.filePath, entry);
      while (map.size > cap) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
      }
    },
    delete(filePath) {
      map.delete(filePath);
    },
    prune(openPaths) {
      for (const key of [...map.keys()]) {
        if (!openPaths.has(key)) map.delete(key);
      }
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
  };
}

type HistoryPluginLike = Plugin & {
  key: string;
  spec: { state?: { init: () => unknown } };
  getState: (state: EditorState) => unknown;
};

function findHistoryPlugin(plugins: readonly Plugin[]): HistoryPluginLike | undefined {
  return plugins.find((p) => {
    const k = (p as { key?: string }).key;
    return typeof k === "string" && k.startsWith("history");
  }) as HistoryPluginLike | undefined;
}

/** 读取当前 EditorState 中保存的 prosemirror-history 状态 */
export function readHistoryState(state: EditorState): unknown {
  const plugin = findHistoryPlugin(state.plugins);
  if (!plugin) return undefined;
  return plugin.getState(state);
}

/** 若编辑器装配了 prosemirror-history，在事务中写入目标历史状态 */
export function applyHistoryStateMeta(
  tr: Transaction,
  plugins: readonly Plugin[],
  historyState: unknown,
): Transaction {
  const plugin = findHistoryPlugin(plugins);
  if (!plugin?.spec.state) return tr;
  const target = historyState !== undefined ? historyState : plugin.spec.state.init();
  return tr.setMeta(plugin.key, { historyState: target });
}

function applySafeSelection(
  tr: Transaction,
  selection: { anchor: number; head: number } | null | undefined,
): void {
  if (!selection) return;
  const max = tr.doc.content.size;
  const anchor = Math.max(0, Math.min(selection.anchor, max));
  const head = Math.max(0, Math.min(selection.head, max));
  try {
    tr.setSelection(TextSelection.create(tr.doc, anchor, head));
  } catch {
    try {
      tr.setSelection(TextSelection.near(tr.doc.resolve(head)));
    } catch {
      // 兜底保留默认选区
    }
  }
}

// 在途水合任务注册表：按 EditorView 索引。主编辑器与分屏是两个独立实例，
// 「本编辑器是否还在水合」必须按 view 判定，否则分屏水合会误伤主编辑器的光标恢复
// （#426 评审 S5）。
const activeHydrations = new Map<EditorView, () => void>();

export function flushActiveHydration(view?: EditorView): void {
  const targets = view ? (activeHydrations.has(view) ? [activeHydrations.get(view)!] : []) : [...activeHydrations.values()];
  for (const flush of targets) {
    flush();
  }
}

export function hasActiveHydration(view?: EditorView): boolean {
  return view ? activeHydrations.has(view) : activeHydrations.size > 0;
}

export interface HydrationTask {
  fullDoc: PMNode;
  selection: { anchor: number; head: number } | null;
  historyState: unknown;
  /**
   * 估算「完整文档在当前滚动容器里应有多高」（#426 高度占位用）。
   * 占位已在撑高度时直接返回占位值；否则按「已水合块的平均高度 × 总块数」外推。
   */
  estimateFullHeight: () => number;
  cancel: () => void;
  flush: () => void;
  isActive: () => boolean;
}

export interface StartHydrationOptions {
  view: EditorView;
  fullDoc: PMNode;
  fromCache: boolean;
  selection?: { anchor: number; head: number } | null;
  historyState?: unknown;
  initialOutline?: EditorOutlineSnapshot | null;
  /**
   * 水合期间用于撑住高度的占位元素（通常为 `.md-editor-wysiwyg`）与目标高度。
   * 只在缓存命中且有历史高度时传入：让滚动容器高度从首帧起就等于完整文档高度，
   * 避免「逐帧长高」把 `switchMs`（等高度收敛）拉长到整个水合时长（#426）。
   */
  heightPlaceholder?: { el: HTMLElement; height: number } | null;
  chunkSize?: number;
  onComplete?: () => void;
}

/**
 * 将 fullDoc 写入 ProseMirror 视图。
 * 小文档（childCount <= chunkSize）单步同步替换；
 * 大文档先挂载首个分片保证首屏立即可见，随后按帧追加尾部块。
 */
export function startDocHydration({
  view,
  fullDoc,
  fromCache,
  selection,
  historyState,
  initialOutline,
  heightPlaceholder,
  chunkSize = HYDRATION_CHUNK_SIZE_TAB_SWITCH,
  onComplete,
}: StartHydrationOptions): HydrationTask {
  const plugins = view.state.plugins;
  const safeChunk = Math.max(1, Math.floor(chunkSize));

  // 高度占位：先撑到完整文档高度，水合结束后再撤掉（此时真实内容已接近该高度，
  // 撤掉不会产生可见跳变）。首帧即固定高度，滚动条与「高度稳定」判定都不再逐帧变化。
  const placeholderEl = heightPlaceholder?.el ?? null;
  const placeholderHeight = heightPlaceholder?.height ?? 0;
  let placeholderApplied = false;
  const applyPlaceholder = () => {
    if (!placeholderEl || placeholderApplied || placeholderHeight <= 0) return;
    placeholderApplied = true;
    placeholderEl.style.minHeight = `${placeholderHeight}px`;
  };
  const clearPlaceholder = () => {
    if (!placeholderEl || !placeholderApplied) return;
    placeholderApplied = false;
    placeholderEl.style.minHeight = "";
  };
  applyPlaceholder();

  if (fullDoc.childCount <= safeChunk) {
    const tr = view.state.tr
      .replaceWith(0, view.state.doc.content.size, fullDoc.content)
      .setMeta("addToHistory", false)
      .setMeta(hydrationMetaKey, {
        hydrating: true,
        done: true,
        fromCache,
        initialOutline,
      } satisfies HydrationMeta);
    applySafeSelection(tr, selection);
    applyHistoryStateMeta(tr, plugins, historyState);
    view.dispatch(tr);
    // 内容已整体到位，占位高度可以撤掉（真实高度与占位一致，无可见跳变）
    clearPlaceholder();
    onComplete?.();
    return {
      fullDoc,
      selection: selection ?? null,
      historyState,
      estimateFullHeight: () => placeholderHeight,
      cancel: () => {},
      flush: () => {},
      isActive: () => false,
    };
  }

  const children: PMNode[] = [];
  for (let i = 0; i < fullDoc.childCount; i += 1) {
    children.push(fullDoc.child(i));
  }

  // 第一片：同步替换旧文档为前 safeChunk 块
  const firstBatch = children.slice(0, safeChunk);
  const tr1 = view.state.tr
    .replaceWith(0, view.state.doc.content.size, Fragment.fromArray(firstBatch))
    .setMeta("addToHistory", false)
    .setMeta(hydrationMetaKey, {
      hydrating: true,
      done: false,
      fromCache,
      initialOutline,
    } satisfies HydrationMeta);
  applySafeSelection(tr1, { anchor: 0, head: 0 });
  applyHistoryStateMeta(tr1, plugins, undefined);
  view.dispatch(tr1);

  let nextIndex = safeChunk;
  let cancelled = false;
  let completed = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    activeHydrations.delete(view);
  };

  const applyRange = (endIndex: number) => {
    if (cancelled || completed || view.isDestroyed) {
      cleanup();
      return;
    }
    const clampedEnd = Math.min(children.length, endIndex);
    const batch = children.slice(nextIndex, clampedEnd);
    const appendFromIndex = view.state.doc.childCount;
    const appendFromPos = view.state.doc.content.size;
    nextIndex = clampedEnd;
    const isLast = nextIndex >= children.length;

    const tr = view.state.tr
      .insert(appendFromPos, Fragment.fromArray(batch))
      .setMeta("addToHistory", false)
      .setMeta(hydrationMetaKey, {
        hydrating: true,
        done: isLast,
        fromCache,
        appendFromIndex,
        appendFromPos,
        ...(isLast ? { initialOutline } : {}),
      } satisfies HydrationMeta);

    if (isLast) {
      applySafeSelection(tr, selection);
      applyHistoryStateMeta(tr, plugins, historyState);
    } else {
      applyHistoryStateMeta(tr, plugins, undefined);
    }

    view.dispatch(tr);

    if (isLast) {
      completed = true;
      cleanup();
      clearPlaceholder();
      onComplete?.();
    }
  };

  const flush = () => {
    if (cancelled || completed) return;
    applyRange(children.length);
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    cleanup();
    clearPlaceholder();
  };

  // 用宏任务而非 rAF 排下一片（#426 实测）：rAF 回调与页面自身的逐帧布局读取
  // （如 scrollHeight 轮询）落在**同一个渲染任务**里，两者叠加会把单任务顶到
  // 60–80ms；改走宏任务后插入与「下一帧的布局」分属两个任务，各自远低于 50ms。
  const scheduleNext = () => {
    if (cancelled || completed) return;
    timerId = setTimeout(() => {
      timerId = null;
      if (cancelled || completed || view.isDestroyed) {
        cleanup();
        return;
      }
      applyRange(nextIndex + safeChunk);
      if (!cancelled && !completed && nextIndex < children.length) {
        scheduleNext();
      }
    }, 0);
  };

  activeHydrations.set(view, flush);
  scheduleNext();

  const estimateFullHeight = (): number => {
    // 占位已在撑高度（切 tab 路径）时，占位值本身就是完整高度
    if (placeholderHeight > 0) return placeholderHeight;
    const el =
      (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
      view.dom.closest<HTMLElement>(".editor-scroll");
    if (!el) return 0;
    const hydrated = view.state.doc.childCount;
    const expected = fullDoc.childCount;
    const measured = el.scrollHeight;
    if (hydrated <= 0 || expected <= hydrated) return measured;
    // 首开中途被切走：按「已水合块的平均高度」外推完整高度，供下次切回时占位
    return Math.round((measured * expected) / hydrated);
  };

  return {
    fullDoc,
    selection: selection ?? null,
    historyState,
    estimateFullHeight,
    cancel,
    flush,
    isActive: () => !cancelled && !completed,
  };
}

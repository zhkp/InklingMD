// 大纲当前标题跟踪插件
// 从 ProseMirror 视图发布渲染标题及当前标题，供主编辑器大纲面板使用。
//
// 性能（v2.3.3）：滚动路径不再用 posAtCoords 采样视口位置——它需要
// 线性扫描文档级子节点的 rect，在数十万像素高的万行文档上单次耗时
// 50ms+，是引用块区域滚动掉帧的主因（v2.1.0 无大纲面板故无此开销）。
// 改为缓存各标题元素在滚动坐标系中的位置（批量读取一次布局），
// 滚动采样只做 scrollTop 与缓存数组的二分比较，纯数值运算微秒级。
// 缓存在文档变更后防抖重建；采样时若滚动总高/宽度变化（图表渲染、
// 窗口缩放、布局切换）也会触发重建。
//
// 修复（v2.3.4）：切 tab 重灌文档后大纲高亮停在顶部、需手动滚动才
// 恢复。根因：重算回调按选区推导当前章节，而整文档替换后选区被钳
// 到文档头。改为重算完成后按当前 scrollTop 采样定位；防抖窗口内
// （stale）跳过采样与选区推导，避免旧文档标题集产出错误高亮。

import { Plugin, PluginKey, type Transaction } from "@milkdown/kit/prose/state";
import {
  extractEditorOutline,
  findActiveHeadingIndex,
  type EditorOutlineHeading,
  type EditorOutlineSnapshot,
} from "../../lib/outline";

const key = new PluginKey("inkling-outline-tracker");
/** 视口顶部的采样偏移：标题顶端滚过视口顶该距离即视为当前章节 */
const VIEWPORT_HEADING_OFFSET = 12;
/** 滚动采样节流间隔：目录高亮延迟 120ms 人眼不可辨 */
const SAMPLE_MIN_INTERVAL_MS = 120;
/**
 * 滚动停歇后多久做几何刷新（失效检测 + 批量重建 + 重新采样）。
 * 也是「整文档替换后高亮恢复跟手」的最长等待。
 */
const GEO_REFRESH_MS = 200;

/** 同步刷新请求：只在事务上存活，需要落进 plugin state 才能被 view.update 读到 */
interface ImmediateRefreshRequest {
  /** 已处理到的请求序号（单调递增，用来判定「这是新请求」） */
  seq: number;
  /** 发起方给出的退出瞬间快照（身份重映射兜底，见 remapActiveIndex） */
  active: EditorOutlineSnapshot | null;
  /**
   * 源码视口顶部内容锚点（阅读位置）换算到新文档的 ProseMirror 位置。
   * 这是**最新文档**的位置信息，优先于可能滞后一个防抖窗口的 store 快照。
   */
  anchorPos: number | null;
  /** 源码光标（编辑位置）换算到新文档的 PM 位置；与 anchorPos 取较靠后者 */
  caretPos: number | null;
}

const NO_REFRESH_REQUEST: ImmediateRefreshRequest = {
  seq: 0,
  active: null,
  anchorPos: null,
  caretPos: null,
};

/**
 * 标题文本归一化，仅用于「同一个标题」的比对（#375）。
 *
 * 两侧文本来源不同：源码模式来自 markdown 原文（`extractMarkdownOutline`），
 * WYSIWYG 来自 ProseMirror 的文本节点。行内公式/脚注在 PM 侧是原子节点、
 * 不贡献文本（`getEditorHeadingText` 只累加 text/image/hardbreak），而 markdown
 * 侧保留 `$a^2$`、`` `x` ``、`[^1]` 这些源码标记。不归一化会让「# 公式 $a^2$」
 * 在新列表里永远匹配不到，退化成按索引取——正是重映射要修的错位。
 */
function normalizeOutlineText(text: string): string {
  return text
    .replace(/\$[^$\n]*\$/g, "") // 行内公式：PM 侧不留文本
    .replace(/`([^`\n]*)`/g, "$1") // 行内代码：PM 侧保留代码内容
    .replace(/\[\^[^\]\n]*\]/g, "") // 脚注引用：PM 侧是原子节点
    .replace(/\s+/g, "")
    .trim();
}

/** 身份键：level + 归一化文本（大文档只归一化一次，避免 O(n²) 次正则） */
const headingKey = (h: EditorOutlineHeading): string =>
  `${h.level}\u0000${normalizeOutlineText(h.text)}`;

/** 两个标题序列的最长公共前缀长度（用于「哪一个同身份项才是原来那一项」消歧） */
function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

/**
 * 把「退出瞬间面板上的活动标题」映射到替换后的标题集（#375 评审 R4）。
 *
 * 旧实现按「同身份项在旧列表里的出现次序 ordinal」取新列表第 ordinal 个，
 * 但用户在**活动项之前插入一个同身份标题**时，新列表多出一项、ordinal 不变，
 * 会选中新插入的那一项（例：旧 [A,B] 高亮 B，新 [A,B,B] 应选 index 2，
 * 旧实现给 1）。身份本身无法区分两个完全相同的标题，必须用上下文对齐。
 *
 * 因此对每个同身份候选 j，用「旧活动项之前的序列与新列表 j 之前的公共前缀」
 * +「旧活动项之后的序列与新列表 j 之后的公共前缀」打分；平局取靠后的候选
 * （插入发生在活动项之前时原项后移）。找不到任何同身份项（改名/删除）时退回
 * 原索引并钳进新列表长度。
 *
 * **已知歧义**：若新旧列表只差一个同身份项、活动项又在末尾，「插在其前」与
 * 「插在其后」在身份上完全对称，任何纯身份算法都无法区分；这里按评审复现
 * （插入在前）取靠后。正常退出时 `markOutlineImmediateRefresh` 会带上
 * `anchorPos`（光标可见时还有 `caretPos`），用最新文档的位置二分定位并优先
 * 于本兜底；只有「连位置信息都没有」的异常路径（`snap` 缺失时两个位置都不传）
 * 才退回身份重映射，歧义仅在那里出现。
 */
function remapActiveIndex(
  next: readonly EditorOutlineHeading[],
  active: EditorOutlineSnapshot | null,
): number | null {
  const index = active?.activeIndex;
  if (active == null || typeof index !== "number") return null;
  if (next.length === 0) return null;
  const clamp = (i: number) => Math.min(Math.max(i, 0), next.length - 1);
  const target = active.headings[index];
  if (!target) return clamp(index);

  const nextKeys = next.map(headingKey);
  const oldKeys = active.headings.map(headingKey);
  const targetKey = oldKeys[index];
  const candidates: number[] = [];
  for (let i = 0; i < nextKeys.length; i += 1) {
    if (nextKeys[i] === targetKey) candidates.push(i);
  }
  if (candidates.length === 0) return clamp(index);

  const before = oldKeys.slice(0, index);
  const after = oldKeys.slice(index + 1);
  let best = candidates[0];
  let bestScore = -1;
  for (const j of candidates) {
    const score =
      commonPrefix(before, nextKeys.slice(0, j)) +
      commonPrefix(after, nextKeys.slice(j + 1));
    if (score >= bestScore) {
      bestScore = score;
      best = j;
    }
  }
  return best;
}

/**
 * 请求「整文档替换后同帧刷新大纲」（#375）。
 *
 * 退出源码模式时 `useSourceModeTransition` 用一次全量 `replaceWith` 把源码灌回
 * ProseMirror：若该事务只走 150ms 防抖，面板会带着退出前的旧快照进入首个可见帧
 * （用户在源码里新增的标题要等防抖落地才出现）。带上此标记的替换在本帧内
 * 重算并发布，不额外开一个异步窗口。
 *
 * `anchorPos`（视口锚点＝阅读位置）与 `caretPos`（源码光标＝编辑位置）都必须换算
 * 到**新文档**的 PM 位置：它们来自最新源码，不受 store 快照滞后一个防抖窗口影响，
 * 也能消歧「活动项前插入同身份标题」。首帧取两者二分结果中较靠后的章节（用户
 * 最近接触的内容）；`active` 快照仅在两者都缺失时作身份重映射兜底。
 *
 * 只由「整文档替换」这类昂贵且用户可见的过渡使用——按键路径仍是防抖，
 * 否则每敲一个字都要遍历全文（#375 的性能前提）。
 */
export const markOutlineImmediateRefresh = (
  tr: Transaction,
  opts: {
    active?: EditorOutlineSnapshot | null;
    anchorPos?: number | null;
    caretPos?: number | null;
  } = {},
): Transaction => {
  const finitePos = (p?: number | null): number | null =>
    typeof p === "number" && Number.isFinite(p) ? p : null;
  return tr.setMeta(key, {
    active: opts.active ?? null,
    anchorPos: finitePos(opts.anchorPos),
    caretPos: finitePos(opts.caretPos),
  } as Partial<ImmediateRefreshRequest>);
};

export const outlineTrackerPlugin = (
  onChange: (snapshot: EditorOutlineSnapshot) => void,
) =>
  new Plugin({
    key,
    state: {
      init: (): ImmediateRefreshRequest => NO_REFRESH_REQUEST,
      apply: (tr, value): ImmediateRefreshRequest => {
        const meta = tr.getMeta(key) as
          | Partial<ImmediateRefreshRequest>
          | undefined;
        if (!meta) return value;
        return {
          seq: value.seq + 1,
          active: meta.active ?? null,
          anchorPos: meta.anchorPos ?? null,
          caretPos: meta.caretPos ?? null,
        };
      },
    },
    view: (view) => {
      let headings = extractEditorOutline(view.state.doc);
      let activeIndex = findActiveHeadingIndex(
        headings,
        view.state.selection.head,
      );
      /** 已处理到的同步刷新序号（初值取当前状态，避免把历史请求当成新请求） */
      let refreshSeq = (
        key.getState(view.state) ?? NO_REFRESH_REQUEST
      ).seq;
      /**
       * 几何缓存已失效：整文档替换后缓存描述的是替换前的 DOM。
       * 由 `rebuildHeadingTops` 单点清除——散在调用点维护必然漏清一次，
       * 漏掉的代价是同一回调里重建两遍（425 标题约 54ms 强制布局）。
       */
      let geometryDirty = false;
      let scrollFrame: number | null = null;
      let sampleTimer: ReturnType<typeof setTimeout> | null = null;
      let lastSampleAt = 0;
      // doc 变更防抖窗口内的采样会用到旧文档的标题集/位置缓存（切 tab
      // 重灌文档时旧数据完全错误），窗口内跳过采样，重算后按当前
      // scrollTop 一次性定位（v2.3.4：修复切 tab 后大纲高亮停在顶部、
      // 需手动滚动才恢复——此前重算按选区计算，重灌后选区被钳到文档头）
      let stale = false;
      // 编辑时全文遍历提取标题开销大（万行文档每键 O(n)），防抖到输入停顿后
      let extractTimer: ReturnType<typeof setTimeout> | null = null;
      const scroller = view.dom.closest<HTMLElement>(".editor-scroll");

      // ---- 标题位置缓存（滚动坐标系） ----
      let headingTops: number[] = [];
      let builtScrollHeight = -1;
      let builtClientWidth = -1;

      /**
       * 批量重建标题位置缓存：所有 rect 在同一帧内读取，只触发一次布局。
       * 同时清除 `geometryDirty`——缓存重建只有这一个入口，失效标记也只在
       * 这里结束，避免「谁调用谁记得清」导致的重复布局。
       */
      const rebuildHeadingTops = () => {
        geometryDirty = false;
        if (!scroller) {
          headingTops = [];
          builtScrollHeight = -1;
          builtClientWidth = -1;
          return;
        }
        const scrollerRect = scroller.getBoundingClientRect();
        // viewport 坐标 → 滚动内容坐标的换算基点
        const base = scroller.scrollTop - scrollerRect.top;
        headingTops = headings.map((h) => {
          const dom = view.nodeDOM(h.pos);
          const el =
            dom instanceof Element ? dom : (dom?.parentElement ?? null);
          if (!el || !el.isConnected) return Number.POSITIVE_INFINITY;
          return base + el.getBoundingClientRect().top;
        });
        builtScrollHeight = scroller.scrollHeight;
        builtClientWidth = scroller.clientWidth;
      };

      onChange({ headings, activeIndex });

      const sampleViewport = () => {
        // 防抖窗口内旧文档的标题集/位置缓存不可用，跳过（见 stale 声明）
        if (stale) return;
        lastSampleAt = performance.now();
        if (!view.dom.isConnected || !scroller) return;
        // #212：滚动采样路径零几何读取（scrollTop 是滚动状态属性，不触发
        // 布局）。失效检测（scrollHeight/clientWidth 读取会强制布局）与
        // rebuildHeadingTops（425 个标题批量 rect，实测单次 27ms 强制布局）
        // 一并移到滚动停歇后的 refreshGeometryAndSample——滚动帧里逐次
        // 强制重排是 p99 尖刺来源；停歇时机一次重排无掉帧顾虑。
        // 滚动中沿用缓存 headingTops 做纯二分：向下滚动时新挂载内容位于
        // 视口下方，视口上方块的文档内位置不变，缓存仍然准确；停歇后
        // 200ms（GEO_REFRESH_MS）内完成校正。
        //
        // 整文档替换后的缓存属于替换前的 DOM：重建完成前不采样，避免用旧
        // 几何算出错误高亮。重建由 scheduleGeometryRefresh 在 GEO_REFRESH_MS
        // 内无条件触发（不依赖 scroll 事件），之后滚动采样正常跟手；重建本身
        // 不在滚动帧内，守住 #212。
        if (geometryDirty) return;
        if (headingTops.length === 0) return;
        // 二分找最后一个 top <= scrollTop + offset 的标题（升序保证）
        const probe = scroller.scrollTop + VIEWPORT_HEADING_OFFSET;
        let lo = 0;
        let hi = headingTops.length - 1;
        let idx = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (headingTops[mid] <= probe) {
            idx = mid;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
        // probe 在首个标题之上（文档顶部 padding/前言区，.milkdown 有
        // 2.5rem 顶部内边距 + 标题自身 margin）：归到首标题而非清成
        // null——清空会让顶部小幅滚动时高亮消失又恢复（闪烁），且此时
        // 首标题通常就在视口内，保持高亮才是正确语义
        const next = headings[idx >= 0 ? idx : 0].index;
        if (next === activeIndex) return;
        activeIndex = next;
        onChange({ headings, activeIndex });
      };

      /**
       * 整文档替换后的**无条件**几何重建调度（#375 评审 R4）。
       *
       * 不能复用 `restTimer`：每个 scroll 事件都会 clear 并重排它，持续滚动时
       * 永远不触发，高亮会冻结整个滚动会话。这条 timer 独立于 scroll 事件，
       * 退出后最多 GEO_REFRESH_MS 必然重建一次，之后滚动采样就能正常跟手；
       * 重建本身发生在宏任务里而不是滚动帧，仍守住 #212「滚动帧零几何读取」。
       */
      let geometryTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleGeometryRefresh = () => {
        if (geometryTimer !== null) return;
        geometryTimer = setTimeout(() => {
          geometryTimer = null;
          refreshGeometryAndSample();
        }, GEO_REFRESH_MS);
      };

      /** 滚动停歇后的几何刷新：失效检测 + 批量重建 + 重新采样定位 */
      const refreshGeometryAndSample = () => {
        // 无论谁触发的，几何一旦刷新就取消尚未触发的无条件调度，避免重复重建
        if (geometryTimer !== null) {
          clearTimeout(geometryTimer);
          geometryTimer = null;
        }
        if (stale) {
          // doc 变更防抖窗口内，通常由 150ms 重算回调重建；若那条路径没走到，
          // 再排一次自己的调度兜底（不占用滚动帧）
          scheduleGeometryRefresh();
          return;
        }
        if (!view.dom.isConnected || !scroller) return;
        if (
          geometryDirty ||
          headingTops.length !== headings.length ||
          scroller.scrollHeight !== builtScrollHeight ||
          scroller.clientWidth !== builtClientWidth
        ) {
          rebuildHeadingTops(); // 内部清 geometryDirty
        }
        sampleViewport();
      };

      // ProseMirror 不会为纯滚动产生 transaction，因此单独从视口位置
      // 更新阅读章节；按动画帧合并 + 时间节流，采样本身只做数值比较。
      // #212：几何刷新（失效检测 + 批量重建，含强制布局）安排在滚动
      // 停歇后（trailing 200ms），不占滚动帧。
      let restTimer: ReturnType<typeof setTimeout> | null = null;
      const handleScroll = () => {
        if (!scroller) return;
        if (restTimer !== null) clearTimeout(restTimer);
        restTimer = setTimeout(() => {
          restTimer = null;
          refreshGeometryAndSample();
        }, GEO_REFRESH_MS);
        if (scrollFrame != null) return;
        scrollFrame = requestAnimationFrame(() => {
          scrollFrame = null;
          const elapsed = performance.now() - lastSampleAt;
          if (elapsed >= SAMPLE_MIN_INTERVAL_MS) {
            sampleViewport();
            return;
          }
          // 节流窗口内：安排一次尾随采样，保证停止滚动后高亮收敛
          if (sampleTimer == null) {
            sampleTimer = setTimeout(
              () => {
                sampleTimer = null;
                sampleViewport();
              },
              SAMPLE_MIN_INTERVAL_MS - elapsed,
            );
          }
        });
      };
      scroller?.addEventListener("scroll", handleScroll, { passive: true });
      // 初始按当前滚动位置采样一次（打开文件恢复 scrollTop=0 时无
      // scroll 事件可触发，靠这里兜底首帧高亮）；初始布局未稳定时由
      // 停歇路径的 refreshGeometryAndSample 校正
      requestAnimationFrame(() => sampleViewport());

      return {
        update: (nextView, previousState) => {
          const docChanged = nextView.state.doc !== previousState.doc;
          const selectionChanged = !nextView.state.selection.eq(
            previousState.selection,
          );
          // 同步刷新请求（#375）：只由整文档替换携带，见 markOutlineImmediateRefresh
          const request = key.getState(nextView.state) ?? NO_REFRESH_REQUEST;
          const immediateRefresh = request.seq !== refreshSeq;
          refreshSeq = request.seq;

          if (docChanged) {
            // 整文档替换（退出源码模式）：本帧同步重算并发布，首个可见帧
            // 不得是替换前的旧快照（#375）。防抖窗口若还挂着旧文档的重算，
            // 直接丢弃——它算的是替换前的标题集。
            if (immediateRefresh) {
              if (extractTimer) {
                clearTimeout(extractTimer);
                extractTimer = null;
              }
              const previousActive = activeIndex;
              headings = extractEditorOutline(nextView.state.doc);
              // 此刻 WYSIWYG 的选区与滚动还没恢复（退出过渡在 2 帧后才做锚点
              // 恢复），按当前 PM 选区推导会把高亮闪回首标题。四级兜底：
              //   ① 视口锚点 + 源码光标换算到「新文档」的 PM 位置，二分定位后
              //      取较靠后的章节（用户最近接触的内容；不受 store 快照滞后
              //      一个防抖窗口影响，也能消歧同身份插入）；
              //   ② 给了快照 → 按标题身份 + 上下文对齐重映射；
              //   ③ 完全没给快照（tracker 被别的调用方复用）→ 用自己手里的索引；
              //   ④ 仍为空（例如快照属于别的文件）→ 选区推导。
              // ③只在「完全没快照」时生效：给了快照却仍沿用旧索引，正是
              // 让高亮闪回进入源码模式前章节的那条路径。
              const locate = (pos: number | null): number | null =>
                typeof pos === "number" && pos >= 0
                  ? findActiveHeadingIndex(headings, pos)
                  : null;
              const positioned = [
                locate(request.anchorPos),
                locate(request.caretPos),
              ].filter((i): i is number => typeof i === "number");
              const byPosition = positioned.length
                ? Math.max(...positioned)
                : null;
              const preferred =
                byPosition ??
                (request.active
                  ? remapActiveIndex(headings, request.active)
                  : previousActive);
              activeIndex =
                typeof preferred === "number" &&
                preferred >= 0 &&
                preferred < headings.length
                  ? preferred
                  : findActiveHeadingIndex(
                      headings,
                      nextView.state.selection.head,
                    );
              // 几何缓存在这一帧不重建：退出帧已付全文解析 + 整文档替换，
              // 再叠加 N 次 getBoundingClientRect（425 标题实测 27ms）会把
              // 首帧继续推后。排一次与 scroll 事件无关的无条件重建——
              // 否则「退出后没有 scroll / 持续滚动」会让高亮一直冻结。
              geometryDirty = true;
              scheduleGeometryRefresh();
              stale = false;
              onChange({ headings, activeIndex });
              return;
            }
            // 标题集合防抖重算；窗口内采样跳过（stale），重算完成后
            // 重建位置缓存并按当前 scrollTop 定位当前章节
            stale = true;
            if (extractTimer) clearTimeout(extractTimer);
            extractTimer = setTimeout(() => {
              extractTimer = null;
              if (!view.dom.isConnected) {
                stale = false;
                return;
              }
              headings = extractEditorOutline(view.state.doc);
              activeIndex = findActiveHeadingIndex(
                headings,
                view.state.selection.head,
              );
              rebuildHeadingTops();
              stale = false;
              onChange({ headings, activeIndex });
              // 按滚动位置覆盖选区推导的初值：切 tab 重灌文档后选区被
              // 钳到文档头，阅读位置（已恢复的 scrollTop）才是大纲
              // 高亮的正确语义（v2.3.4）
              sampleViewport();
            }, 150);
            return;
          }

          if (selectionChanged) {
            if (stale) return; // 旧标题集上推导无意义，等重算后按滚动定位
            const nextActiveIndex = findActiveHeadingIndex(
              headings,
              nextView.state.selection.head,
            );
            if (nextActiveIndex !== activeIndex) {
              activeIndex = nextActiveIndex;
              onChange({ headings, activeIndex });
            }
          }
        },
        destroy: () => {
          scroller?.removeEventListener("scroll", handleScroll);
          if (scrollFrame != null) cancelAnimationFrame(scrollFrame);
          if (sampleTimer) clearTimeout(sampleTimer);
          if (extractTimer) clearTimeout(extractTimer);
          if (restTimer) clearTimeout(restTimer);
          if (geometryTimer) clearTimeout(geometryTimer);
        },
      };
    },
  });

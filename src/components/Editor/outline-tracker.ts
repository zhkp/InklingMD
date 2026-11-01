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
  type EditorOutlineSnapshot,
} from "../../lib/outline";

const key = new PluginKey("inkling-outline-tracker");
/** 视口顶部的采样偏移：标题顶端滚过视口顶该距离即视为当前章节 */
const VIEWPORT_HEADING_OFFSET = 12;
/** 滚动采样节流间隔：目录高亮延迟 120ms 人眼不可辨 */
const SAMPLE_MIN_INTERVAL_MS = 120;

/** 同步刷新请求：只在事务上存活，需要落进 plugin state 才能被 view.update 读到 */
interface ImmediateRefreshRequest {
  /** 已处理到的请求序号（单调递增，用来判定「这是新请求」） */
  seq: number;
  /** 发起方给出的活动标题索引（退出源码模式时面板上正显示的那个） */
  activeIndex: number | null;
}

const NO_REFRESH_REQUEST: ImmediateRefreshRequest = { seq: 0, activeIndex: null };

/**
 * 请求「整文档替换后同帧刷新大纲」（#375）。
 *
 * 退出源码模式时 `useSourceModeTransition` 用一次全量 `replaceWith` 把源码灌回
 * ProseMirror：若该事务只走 150ms 防抖，面板会带着退出前的旧快照进入首个可见帧
 * （用户在源码里新增的标题要等防抖落地才出现）。带上此标记的替换在本帧内
 * 重算并发布，不额外开一个异步窗口。
 *
 * `activeIndex` 是退出瞬间面板上的活动标题（源码侧已经按最新文档定位过）。必须由
 * 调用方给出：tracker 自身在源码模式期间是静默的，它手里的索引停留在「进入源码
 * 模式那一刻」，直接沿用会让高亮闪回进入前的章节。
 *
 * 只由「整文档替换」这类昂贵且用户可见的过渡使用——按键路径仍是防抖，
 * 否则每敲一个字都要遍历全文（#375 的性能前提）。
 */
export const markOutlineImmediateRefresh = (
  tr: Transaction,
  opts: { activeIndex?: number | null } = {},
): Transaction =>
  tr.setMeta(key, {
    activeIndex:
      typeof opts.activeIndex === "number" ? opts.activeIndex : null,
  });

export const outlineTrackerPlugin = (
  onChange: (snapshot: EditorOutlineSnapshot) => void,
) =>
  new Plugin({
    key,
    state: {
      init: (): ImmediateRefreshRequest => NO_REFRESH_REQUEST,
      apply: (tr, value): ImmediateRefreshRequest => {
        const meta = tr.getMeta(key) as { activeIndex?: number | null } | undefined;
        if (!meta) return value;
        return {
          seq: value.seq + 1,
          activeIndex:
            typeof meta.activeIndex === "number" ? meta.activeIndex : null,
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
      /** 几何缓存已失效：整文档替换后由第一次采样重建（不在退出帧里强制布局） */
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

      /** 批量重建标题位置缓存：所有 rect 在同一帧内读取，只触发一次布局 */
      const rebuildHeadingTops = () => {
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
        // 150ms 内完成校正。
        //
        // 唯一例外是整文档替换后的第一次采样（#375）：此时缓存描述的是
        // 替换前的 DOM，必须重建。放在这里而不是替换那一帧，是因为退出
        // 过渡已经把「解析全文 + 整文档替换」压在同一帧，再叠加 N 次
        // getBoundingClientRect 会把首帧继续推后；而采样发生在滚动恢复
        // 之后的帧里，布局本来就要重算。
        if (geometryDirty) {
          rebuildHeadingTops();
          geometryDirty = false;
        }
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

      /** 滚动停歇后的几何刷新：失效检测 + 批量重建 + 重新采样定位 */
      const refreshGeometryAndSample = () => {
        if (stale) return; // doc 变更防抖窗口内，交由 update 的重建路径
        if (!view.dom.isConnected || !scroller) return;
        if (
          geometryDirty ||
          headingTops.length !== headings.length ||
          scroller.scrollHeight !== builtScrollHeight ||
          scroller.clientWidth !== builtClientWidth
        ) {
          rebuildHeadingTops();
          geometryDirty = false;
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
        }, 200);
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
              // 恢复），按选区推导会把高亮闪回首标题。优先用调用方给的索引
              // （退出瞬间面板上正显示的那个，源码侧已按最新文档定位过）；
              // 其次保留 tracker 手里的原索引；越界才退回选区推导。
              const preferred = request.activeIndex;
              activeIndex =
                typeof preferred === "number" &&
                preferred >= 0 &&
                preferred < headings.length
                  ? preferred
                  : typeof previousActive === "number" &&
                      previousActive >= 0 &&
                      previousActive < headings.length
                    ? previousActive
                    : findActiveHeadingIndex(
                        headings,
                        nextView.state.selection.head,
                      );
              // 几何缓存在这一帧不重建：退出帧已付全文解析 + 整文档替换，
              // 再叠加 N 次 getBoundingClientRect（425 标题实测 27ms）会把
              // 首帧继续推后。交给替换后的第一次采样重建（滚动恢复必触发）。
              geometryDirty = true;
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
        },
      };
    },
  });

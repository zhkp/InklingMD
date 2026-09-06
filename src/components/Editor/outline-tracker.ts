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

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
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

export const outlineTrackerPlugin = (
  onChange: (snapshot: EditorOutlineSnapshot) => void,
) =>
  new Plugin({
    key,
    view: (view) => {
      let headings = extractEditorOutline(view.state.doc);
      let activeIndex = findActiveHeadingIndex(
        headings,
        view.state.selection.head,
      );
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
          headingTops.length !== headings.length ||
          scroller.scrollHeight !== builtScrollHeight ||
          scroller.clientWidth !== builtClientWidth
        ) {
          rebuildHeadingTops();
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

          if (docChanged) {
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

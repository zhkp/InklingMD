// 源代码模式编辑器：整页 CodeMirror 6 编辑原始 Markdown

import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openSearchPanel, replaceNext } from "@codemirror/search";
import { createSourceModeExtensions } from "../../lib/codemirror-shared";
import {
  extractMarkdownOutline,
  findActiveMarkdownHeadingIndexByLine,
  findSourceModeHeadingOffset,
  isSameMarkdownOutline,
  type EditorOutlineHeading,
  type EditorOutlineSnapshot,
} from "../../lib/outline";
import {
  registerSourceModeScroll,
  unregisterSourceModeScroll,
} from "../../lib/source-mode-scroll";
import {
  registerSourceModeSearch,
  unregisterSourceModeSearch,
} from "../../lib/source-mode-search";
import { mapScrollTop } from "../../lib/source-mode-cursor";
import { readDetachSafeScrollMetrics } from "../../lib/detachSafeScroll";
import {
  perfProbeCount,
  perfProbeEnd,
  perfProbeStart,
} from "../../lib/perf-probe";
import { useSettings } from "../../store/settings";

/** 输入停顿后重算大纲：满足「停笔 250ms 内更新」，与 WYSIWYG tracker 的 150ms 同量级 */
const OUTLINE_DEBOUNCE_MS = 200;
/** 视口顶部采样偏移（与 WYSIWYG outline-tracker 的 VIEWPORT_HEADING_OFFSET 一致） */
const VIEWPORT_HEADING_OFFSET = 12;

export interface SourceModeSnapshot {
  cursor: number;
  scrollTop: number;
  /** CM 滚动容器总高度（比例映射兜底用） */
  scrollHeight: number;
  /** 视口顶部可见行的 markdown 偏移（内容锚点，#136）：退出时把印记容器
   *  滚到同一段内容，密度不均也不丢阅读位置 */
  anchorOffset: number;
  /** 光标所在行是否在视口内（#136）：退出恢复仅在光标可见时做可见性微调 */
  cursorVisible: boolean;
}

export interface SourceModeEditorProps {
  /** 当前文件完整路径，用于查找命令路由（issue #29） */
  filePath: string;
  value: string;
  onChange: (markdown: string) => void;
  /** 进入源码模式时的初始光标（markdown 字符串 offset） */
  initialCursor?: number;
  /** 进入时的初始 scrollTop（比例映射兜底用） */
  initialScrollTop?: number;
  /** 进入前 WYSIWYG 滚动容器总高度（比例映射兜底用） */
  initialScrollHeight?: number;
  /** 进入前 WYSIWYG 视口顶部内容对应的 markdown 偏移（内容锚点，优先于比例映射） */
  initialAnchorOffset?: number;
  spellcheck: boolean;
  /** 卸载前回传 CM 光标与滚动位置 */
  onUnmountSnapshot?: (snapshot: SourceModeSnapshot) => void;
  /** 大纲变更通知（Issue #118） */
  onOutlineChange?: (snapshot: EditorOutlineSnapshot) => void;
}

export function SourceModeEditor({
  filePath,
  value,
  onChange,
  initialCursor = 0,
  initialScrollTop = 0,
  initialScrollHeight = 0,
  initialAnchorOffset,
  spellcheck,
  onUnmountSnapshot,
  onOutlineChange,
}: SourceModeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onUnmountRef = useRef(onUnmountSnapshot);
  onUnmountRef.current = onUnmountSnapshot;
  const onOutlineChangeRef = useRef(onOutlineChange);
  onOutlineChangeRef.current = onOutlineChange;
  const lastEmittedRef = useRef(value);
  const themeCompRef = useRef(new Compartment());

  const codeBlockTheme = useSettings((s) => s.codeBlockTheme);

  // 用 useLayoutEffect 确保卸载 cleanup 在父组件 layout effect 读取快照之前执行
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const safeCursor = Math.max(0, Math.min(initialCursor, value.length));
    const themeComp = themeCompRef.current;

    // 视口顶部 → 当前标题：一次几何读取（lineBlockAtHeight）+ 对标题行号二分。
    // 旧实现对每个标题调用 lineBlockAt，1500 个标题时单次 4ms+，且随标题数线性增长。
    const locateActiveHeading = (
      view: EditorView,
      headings: EditorOutlineHeading[],
    ): number => {
      const probeStart = perfProbeStart();
      if (headings.length === 0) {
        perfProbeEnd("headingLocate", probeStart);
        return -1;
      }
      const scroller = view.scrollDOM;
      const height = Math.min(
        view.contentHeight,
        Math.max(0, scroller.scrollTop + VIEWPORT_HEADING_OFFSET),
      );
      const line = view.state.doc.lineAt(
        view.lineBlockAtHeight(height).from,
      ).number;
      const located = findActiveMarkdownHeadingIndexByLine(headings, line);
      perfProbeEnd("headingLocate", probeStart);
      // 视口在首个标题之上时归到首标题（与旧行为/ WYSIWYG tracker 一致，
      // 避免顶部小幅滚动时高亮消失再出现）
      return located ?? headings[0].index;
    };

    let scrollRaf: number | null = null;
    let activeHeadings = extractMarkdownOutline(value);
    let currentActiveIndex = -1;
    let outlineTimer: number | null = null;
    /** 最近一次内容变化的时间点（探针未启用时为 null） */
    let outlineSettleStart: number | null = null;
    // 防抖窗口内旧标题的行号已失效：滚动采样与发布一律跳过，
    // 重算完成后按当前视口一次性定位（沿用 WYSIWYG tracker 的 stale 语义）
    let outlineStale = false;
    // 持续缓存的几何与光标可见性（#136）：layout-effect cleanup 在 DOM 移除
    // 之后才运行，脱链容器的 clientHeight/scrollHeight 读 0；过渡期还可能在
    // 容器塌缩的中间帧读到偏小值。策略：容器高度取「可信读数的峰值」
    // （稳定后容器不会合法变大，峰值即稳态值），可见性判定用 CM 自报的
    // 视口范围与光标行块求交，不依赖某一帧的容器测量
    let cachedClientHeight = 0;
    let cachedScrollHeight = 0;
    // 最后一次可信 scrollTop（issue #174）：cleanup 时容器可能已脱链，scrollTop
    // 现场读为 0；与高度不同它非单调，不能用峰值，只能缓存「最后可信读数」。
    // 用户若真的滚回顶部，缓存同样是 0，回退不产生错误恢复。
    let cachedScrollTop = 0;
    let cursorVisibleCache = true;
    const refreshCursorVisible = (v: EditorView) => {
      const el = v.scrollDOM;
      // 只有现场布局可信（>1）才参与峰值缓存：挂载首帧布局未完成、或过渡期
      // 容器已脱链/隐藏时读到 0（或塌缩中间帧偏小值），保留最后一次稳态值
      const liveCh = el.clientHeight;
      if (liveCh > 1) {
        cachedClientHeight = Math.max(cachedClientHeight, liveCh);
        cachedScrollHeight = Math.max(cachedScrollHeight, el.scrollHeight);
        cachedScrollTop = el.scrollTop;
      }
      if (cachedClientHeight <= 1) return;
      const head = v.state.selection.main.head;
      const block = v.lineBlockAt(Math.min(head, v.state.doc.length));
      const st = el.scrollTop;
      cursorVisibleCache =
        block.bottom >= st - 1 && block.top <= st + cachedClientHeight + 1;
    };

    const publishOutline = (
      headings: EditorOutlineHeading[],
      activeIndex: number,
    ) => {
      currentActiveIndex = activeIndex;
      perfProbeCount("outlinePublish");
      onOutlineChangeRef.current?.({ headings, activeIndex });
    };

    const notifyOutline = (view: EditorView) => {
      publishOutline(activeHeadings, locateActiveHeading(view, activeHeadings));
    };

    const state = EditorState.create({
      doc: value,
      selection: { anchor: safeCursor, head: safeCursor },
      extensions: [
        themeComp.of(createSourceModeExtensions({ codeBlockTheme, spellcheck })),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const md = update.state.doc.toString();
          if (md !== lastEmittedRef.current) {
            lastEmittedRef.current = md;
            onChangeRef.current(md);
          }
          // 不在按键路径上重解析全文/逐标题定位：只重置防抖，停笔后统一重算。
          // 结构未变时不发布，避免 OutlinePanel 整表重渲染。
          outlineStale = true;
          if (outlineTimer !== null) window.clearTimeout(outlineTimer);
          outlineSettleStart = perfProbeStart();
          outlineTimer = window.setTimeout(() => {
            outlineTimer = null;
            // 用回调时刻的最新文档：防抖窗口内可能还有别的更新路径
            const nextHeadings = extractMarkdownOutline(
              update.view.state.doc.toString(),
            );
            const nextActive = locateActiveHeading(update.view, nextHeadings);
            const structureChanged = !isSameMarkdownOutline(
              activeHeadings,
              nextHeadings,
            );
            // 行号/文本都没变时也换成本次结果：标题偏移可能因上方行变长而移动，
            // scrollToHeading 的兜底 pos 需要最新值；不发布则不会触发面板重渲染。
            activeHeadings = nextHeadings;
            if (structureChanged || nextActive !== currentActiveIndex) {
              publishOutline(activeHeadings, nextActive);
            }
            outlineStale = false;
            // 计时结束放在重算/发布之后：outlineSettle 表示「停笔 → 大纲更新完成」
            // 的完整时延，而不是只含防抖等待的定时器延迟（#379 归因口径）
            perfProbeEnd("outlineSettle", outlineSettleStart);
            outlineSettleStart = null;
          }, OUTLINE_DEBOUNCE_MS);
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;

    // 注册大纲点击滚动与跳转（Issue #118）
    registerSourceModeScroll(filePath, {
      scrollToHeading: (heading) => {
        const v = viewRef.current;
        if (!v) return;
        const currentDoc = v.state.doc.toString();
        const offset = findSourceModeHeadingOffset(currentDoc, heading);

        let targetPos = offset ?? -1;
        if (targetPos < 0 || targetPos > currentDoc.length) {
          // 若大纲匹配未命中，且原 heading.pos 合法，则尝试原 heading.pos
          if (heading.pos >= 0 && heading.pos <= currentDoc.length) {
            targetPos = heading.pos;
          } else {
            return;
          }
        }

        // 移动光标并平滑滚动到该行
        v.dispatch({
          selection: { anchor: targetPos, head: targetPos },
          effects: EditorView.scrollIntoView(targetPos, { y: "start", yMargin: 20 }),
        });
        v.focus();
      },
      getScrollAndCursor: () => {
        const head = view.state.selection.main.head;
        const block = view.lineBlockAt(Math.min(head, view.state.doc.length));
        const st = view.scrollDOM.scrollTop;
        const ch = view.scrollDOM.clientHeight || cachedClientHeight;
        return {
          scrollTop: st,
          cursor: head,
          scrollHeight: view.scrollDOM.scrollHeight || cachedScrollHeight,
          anchorOffset: view.lineBlockAtHeight(st).from,
          cursorVisible: block.top >= st - 1 && block.bottom <= st + ch + 1,
        };
      },
    });

    // 监听滚动更新大纲高亮（Issue #118）：定位只做一次行块读取 + 二分
    const handleScroll = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        const v = viewRef.current;
        if (!v) return;
        refreshCursorVisible(v);
        if (outlineStale) return;
        const nextActive = locateActiveHeading(v, activeHeadings);
        if (nextActive !== currentActiveIndex) {
          publishOutline(activeHeadings, nextActive);
        }
      });
    };
    view.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });
    refreshCursorVisible(view);
    // 外部布局变化（工具栏/大纲开合）不发 scroll 事件但会改容器高度：
    // 用 ResizeObserver 兜底刷新，避免缓存停在旧高度
    const resizeObs =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => {
            const v = viewRef.current;
            if (v) refreshCursorVisible(v);
          })
        : null;
    resizeObs?.observe(view.scrollDOM);

    // 初始通知大纲
    notifyOutline(view);

    // 注册查找命令路由：全局 Ctrl+F/Ctrl+R 在源码模式打开 CM 内置面板（issue #29）
    registerSourceModeSearch(filePath, (opts) => {
      const v = viewRef.current;
      if (!v) return;
      // 新版 @codemirror/search 无独立 replace 命令：替换框内建在搜索面板里。
      // replace 模式用 replaceNext（未选中匹配时打开面板，否则逐个替换）。
      const cmd = opts.replace ? replaceNext : openSearchPanel;
      cmd(v);
      v.focus();
    });
    // 进入源码模式的滚动恢复（issue #136）：内容锚点优先——把进入前
    // WYSIWYG 视口顶部那段内容对应的 markdown 偏移（initialAnchorOffset）
    // 滚到 CM 视口顶部。两容器密度分布不同（标题/段落/代码块渲染高度 ≠
    // 等宽行高），按滚动比例映射会保住「百分比」但落到不同内容上；
    // 锚到同一行内容则密度差异无关。比例映射仅作无锚点时的兜底。
    // CM6 视口化渲染 + 高度估算：挂载瞬间的 scrollHeight/行位置不是最终
    // 值，单次赋值会被钳制在错误位置后不再收敛。改为「立即设置 + 逐帧
    // 重试直到收敛」（30 帧上限，测量稳定后通常 1-2 帧到位），每帧用
    // 当前最新测量重算目标。
    // 注意：收敛后不做「滚动到光标」校正——强行把视口拽到光标会在
    // 「只滚动未动光标」场景下把视口拽回旧光标处，覆盖正确结果。
    const scroller = view.scrollDOM;
    let restoreRaf: number | null = null;
    const computeTarget = () => {
      if (initialAnchorOffset != null && initialAnchorOffset > 0) {
        const off = Math.min(initialAnchorOffset, view.state.doc.length);
        // 减去首行 top（= 内容区 padding），让锚点行精确贴住视口顶部
        const pad = view.lineBlockAt(0).top;
        return Math.max(0, view.lineBlockAt(off).top - pad);
      }
      return initialScrollHeight > 0 && scroller.scrollHeight > 0
        ? mapScrollTop(initialScrollTop, initialScrollHeight, scroller.scrollHeight)
        : initialScrollTop;
    };
    if (initialScrollTop > 0 || (initialAnchorOffset ?? 0) > 0) {
      const apply = () => {
        if (scroller.isConnected) scroller.scrollTop = computeTarget();
      };
      apply();
      let frames = 0;
      const settle = () => {
        restoreRaf = null;
        if (!scroller.isConnected) return;
        const target = computeTarget();
        if (Math.abs(scroller.scrollTop - target) < 1 || ++frames > 30) return;
        apply();
        restoreRaf = requestAnimationFrame(settle);
      };
      restoreRaf = requestAnimationFrame(settle);
    }
    requestAnimationFrame(() => view.focus());

    return () => {
      if (restoreRaf !== null) cancelAnimationFrame(restoreRaf);
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      if (outlineTimer !== null) {
        window.clearTimeout(outlineTimer);
        outlineTimer = null;
      }
      outlineSettleStart = null;
      resizeObs?.disconnect();
      unregisterSourceModeScroll(filePath);
      unregisterSourceModeSearch(filePath);
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      {
        // 脱链后 clientHeight/scrollHeight/scrollTop 读 0：刷新是幂等的，仅更新缓存
        refreshCursorVisible(view);
        const head = view.state.selection.main.head;
        // issue #174：scrollTop/anchorOffset 此前是现场读，cleanup 若在容器已
        // 脱链或塌缩的帧执行会读到 0，退出源码模式后阅读位置回到文档第一行。
        // 与高度同判据（clientHeight>1）判定现场是否可信，否则回退最后可信读数。
        const scroller = view.scrollDOM;
        const { scrollTop, scrollHeight } = readDetachSafeScrollMetrics(scroller, {
          scrollTop: cachedScrollTop,
          scrollHeight: cachedScrollHeight,
        });
        onUnmountRef.current?.({
          cursor: head,
          scrollTop,
          scrollHeight,
          anchorOffset: view.lineBlockAtHeight(scrollTop).from,
          cursorVisible: cursorVisibleCache,
        });
      }
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- CM 实例只在挂载时创建一次
  }, [filePath]);

  // 外部 value 变化（切 tab、file watcher）同步到 CM
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    if (value === cur) return;
    lastEmittedRef.current = value;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  // 代码块主题变化时重配
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompRef.current.reconfigure(
        createSourceModeExtensions({ codeBlockTheme, spellcheck }),
      ),
    });
  }, [codeBlockTheme, spellcheck]);

  return (
    <div
      className="source-mode-editor"
      spellCheck={spellcheck}
      data-testid="source-mode-editor"
      // a11y（issue #28）：声明文本编辑语义与模式上下文，屏幕阅读器可感知
      role="textbox"
      aria-multiline="true"
      aria-label="Markdown 源代码编辑器"
    >
      <div ref={hostRef} className="source-mode-cm-host" />
    </div>
  );
}

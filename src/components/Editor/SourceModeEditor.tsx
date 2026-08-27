// 源代码模式编辑器：整页 CodeMirror 6 编辑原始 Markdown

import { useEffect, useLayoutEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openSearchPanel, replaceNext } from "@codemirror/search";
import { createSourceModeExtensions } from "../../lib/codemirror-shared";
import {
  extractMarkdownOutline,
  findSourceModeHeadingOffset,
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
import { useSettings } from "../../store/settings";

export interface SourceModeSnapshot {
  cursor: number;
  scrollTop: number;
  /** CM 滚动容器总高度，用于退出时按比例映射到印记容器滚动位置 */
  scrollHeight: number;
}

export interface SourceModeEditorProps {
  /** 当前文件完整路径，用于查找命令路由（issue #29） */
  filePath: string;
  value: string;
  onChange: (markdown: string) => void;
  /** 进入源码模式时的初始光标（markdown 字符串 offset） */
  initialCursor?: number;
  /** 进入时的初始 scrollTop */
  initialScrollTop?: number;
  /** 进入前 WYSIWYG 滚动容器总高度，用于按比例把阅读进度映射到 CM 容器 */
  initialScrollHeight?: number;
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

    // 辅助函数：根据当前滚动条位置估算当前活动标题
    const computeActiveHeadingIndex = (
      view: EditorView,
      headings: ReturnType<typeof extractMarkdownOutline>,
    ): number => {
      if (headings.length === 0) return -1;
      const scroller = view.scrollDOM;
      const targetTop = scroller.scrollTop + 12;

      let bestIndex = 0;
      for (let i = 0; i < headings.length; i++) {
        const lineInfo = view.lineBlockAt(
          Math.min(headings[i].pos, view.state.doc.length),
        );
        if (lineInfo.top <= targetTop) {
          bestIndex = i;
        } else {
          break;
        }
      }
      return bestIndex;
    };

    let scrollRaf: number | null = null;
    let activeHeadings = extractMarkdownOutline(value);
    let currentActiveIndex = -1;

    const notifyOutline = (view: EditorView) => {
      const activeIdx = computeActiveHeadingIndex(view, activeHeadings);
      currentActiveIndex = activeIdx;
      onOutlineChangeRef.current?.({
        headings: activeHeadings,
        activeIndex: activeIdx,
      });
    };

    const state = EditorState.create({
      doc: value,
      selection: { anchor: safeCursor, head: safeCursor },
      extensions: [
        themeComp.of(createSourceModeExtensions({ codeBlockTheme, spellcheck })),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const md = update.state.doc.toString();
            if (md !== lastEmittedRef.current) {
              lastEmittedRef.current = md;
              onChangeRef.current(md);
            }
            activeHeadings = extractMarkdownOutline(md);
            notifyOutline(update.view);
          }
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
      getScrollAndCursor: () => ({
        scrollTop: view.scrollDOM.scrollTop,
        cursor: view.state.selection.main.head,
        scrollHeight: view.scrollDOM.scrollHeight,
      }),
    });

    // 监听滚动更新大纲高亮（Issue #118）
    const handleScroll = () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        const v = viewRef.current;
        if (!v) return;
        const nextActive = computeActiveHeadingIndex(v, activeHeadings);
        if (nextActive !== currentActiveIndex) {
          currentActiveIndex = nextActive;
          onOutlineChangeRef.current?.({
            headings: activeHeadings,
            activeIndex: nextActive,
          });
        }
      });
    };
    view.scrollDOM.addEventListener("scroll", handleScroll, { passive: true });

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
    // 进入源码模式的滚动恢复（issue #136）：CM6 视口化渲染 + 高度估算，
    // 挂载瞬间的 scrollHeight 不是最终值，单次赋值会被钳制在错误的
    // maxScroll 后不再收敛。与退出方向一致改为「立即设置 + 逐帧重试直到
    // 收敛」（30 帧上限，测量稳定后通常 1-2 帧到位），收敛后兜底保证光标可见。
    // 两容器高度不同（渲染视图 ≠ 源码文本），目标值按高度比例映射，
    // 且每帧用当前最新 scrollHeight 重算，跟随 CM 测量修正
    const scroller = view.scrollDOM;
    let restoreRaf: number | null = null;
    const computeTarget = () =>
      initialScrollHeight > 0 && scroller.scrollHeight > 0
        ? mapScrollTop(initialScrollTop, initialScrollHeight, scroller.scrollHeight)
        : initialScrollTop;
    const ensureCursorVisible = () => {
      restoreRaf = null;
      const v = viewRef.current;
      if (!v || !scroller.isConnected) return;
      const head = v.state.selection.main.head;
      const coords = v.coordsAtPos(head);
      if (!coords) return;
      const box = scroller.getBoundingClientRect();
      if (coords.top < box.top || coords.bottom > box.bottom) {
        v.dispatch({
          effects: EditorView.scrollIntoView(head, { y: "center" }),
        });
      }
    };
    if (initialScrollTop > 0) {
      const apply = () => {
        if (scroller.isConnected) scroller.scrollTop = computeTarget();
      };
      apply();
      let frames = 0;
      const settle = () => {
        restoreRaf = null;
        if (!scroller.isConnected) return;
        const target = computeTarget();
        if (Math.abs(scroller.scrollTop - target) < 1 || ++frames > 30) {
          ensureCursorVisible();
          return;
        }
        apply();
        restoreRaf = requestAnimationFrame(settle);
      };
      restoreRaf = requestAnimationFrame(settle);
    } else {
      // 无滚动目标（停留在顶部）也要保证恢复的光标在可视区域
      restoreRaf = requestAnimationFrame(ensureCursorVisible);
    }
    requestAnimationFrame(() => view.focus());

    return () => {
      if (restoreRaf !== null) cancelAnimationFrame(restoreRaf);
      if (scrollRaf !== null) cancelAnimationFrame(scrollRaf);
      unregisterSourceModeScroll(filePath);
      unregisterSourceModeSearch(filePath);
      view.scrollDOM.removeEventListener("scroll", handleScroll);
      onUnmountRef.current?.({
        cursor: view.state.selection.main.head,
        scrollTop: view.scrollDOM.scrollTop,
        scrollHeight: view.scrollDOM.scrollHeight,
      });
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

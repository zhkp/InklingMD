// 编辑位置记忆插件：选区/滚动变化时缓存到本地，
// 防抖 300ms、失焦或销毁时再落 store，避免每次光标移动都
// 写 openTabs 触发 TabsBar 等订阅组件重渲染。
// 落盘绑定 filePath：destroy / 切 tab flush 时 activeTabPath 可能已切
// 到新 tab，写活跃 tab 会把旧文件状态串写过去（issue #30）。
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { hydrationMetaKey } from "./tab-editor-cache";

export const cursorSaverKey = new PluginKey<{ skipSeq: number }>("inkling-cursor-saver");

const tabResetters = new WeakMap<EditorView, (outgoingPath: string) => void>();

/**
 * 切 tab 前同步落盘旧 tab 的光标与滚动位置，并重置定时器与缓存状态，
 * 避免复用 EditorView 时把旧 tab 防抖窗口内的位置串写到新 tab（issue #426）。
 */
export function flushCursorSaverForTabSwitch(view: EditorView, outgoingPath: string): void {
  tabResetters.get(view)?.(outgoingPath);
}

export function cursorSaverPlugin(
  filePathOrGetter: string | (() => string),
  getSaveCursorState: () => (path: string, pos: number, scrollTop: number) => void,
) {
  const resolveFilePath =
    typeof filePathOrGetter === "function" ? filePathOrGetter : () => filePathOrGetter;

  return new Plugin({
    key: cursorSaverKey,
    state: {
      init: () => ({ skipSeq: 0 }),
      apply: (tr, prev) => {
        const hydrating = tr.getMeta(hydrationMetaKey)?.hydrating;
        return hydrating ? { skipSeq: prev.skipSeq + 1 } : prev;
      },
    },
    view: (view: EditorView) => {
      let lastPos = -1;
      let scheduledFile: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      // scrollTop 用 passive 监听缓存：每个 transaction 或 view 初始化时直接读
      // scrollTop 会在大文档挂载/按键时强制同步布局（issue #426 CDP 实测 94ms）
      const scrollEl =
        (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
        view.dom.closest<HTMLElement>(".editor-scroll");
      let cachedScrollTop = 0;
      let lastSkipSeq = cursorSaverKey.getState(view.state)?.skipSeq ?? 0;

      const flush = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (lastPos < 0) return;
        const targetFile = scheduledFile ?? resolveFilePath();
        getSaveCursorState()(targetFile, lastPos, cachedScrollTop);
      };
      const schedule = (pos: number) => {
        lastPos = pos;
        scheduledFile = resolveFilePath();
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 300);
      };
      const onScroll = () => {
        cachedScrollTop = scrollEl ? scrollEl.scrollTop : 0;
        // 纯滚动不产生 transaction，补记一次，
        // 否则滚动后切 tab 会丢失阅读进度
        schedule(view.state.selection.head);
      };

      tabResetters.set(view, (outgoingPath: string) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        const liveScroll = scrollEl && scrollEl.isConnected ? scrollEl.scrollTop : cachedScrollTop;
        const pos = lastPos >= 0 ? lastPos : view.state.selection.head;
        getSaveCursorState()(outgoingPath, pos, liveScroll);
        lastPos = -1;
        scheduledFile = null;
        cachedScrollTop = 0;
        lastSkipSeq = cursorSaverKey.getState(view.state)?.skipSeq ?? lastSkipSeq;
      });

      scrollEl?.addEventListener("scroll", onScroll, { passive: true });
      // 失焦立即落盘
      view.dom.addEventListener("blur", flush);
      return {
        update: (nextView) => {
          const skipSeq = cursorSaverKey.getState(nextView.state)?.skipSeq ?? lastSkipSeq;
          if (skipSeq !== lastSkipSeq) {
            lastSkipSeq = skipSeq;
            return;
          }
          schedule(nextView.state.selection.head);
        },
        destroy: () => {
          tabResetters.delete(view);
          flush();
          scrollEl?.removeEventListener("scroll", onScroll);
          view.dom.removeEventListener("blur", flush);
        },
      };
    },
  });
}

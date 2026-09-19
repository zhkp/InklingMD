// 全局快捷键：通过 useShortcuts store 读取用户自定义绑定。
// 编辑器内 Milkdown 预设的快捷键（加粗等）不在自定义范围。
// 面板开关等回调通过 handlers 注入，内部用 ref 持有避免重复挂载监听器。
import { useEffect, useRef } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { useUI } from "../store/ui";
import { useSettings } from "../store/settings";
import { useShortcuts, matchBinding, type ShortcutId } from "../store/shortcuts";
import { useWorkspace } from "../store/workspace";
import { runSourceModeSearch } from "./source-mode-search";

export interface GlobalShortcutHandlers {
  /** Ctrl/Cmd+N 新建未命名草稿（编辑器就绪后自动聚焦） */
  onNewTab: () => void;
  /** Ctrl/Cmd+Shift+F 打开全局搜索 */
  openGlobalSearch: () => void;
  /** Ctrl/Cmd+P 打开快速打开面板（#228） */
  openQuickOpen: () => void;
  /** Ctrl/Cmd+F / Ctrl/Cmd+R 打开当前文件查找/替换面板 */
  openFindPanel: (showReplace: boolean) => void;
  /** Ctrl/Cmd+/ 切换快捷键帮助 */
  toggleShortcutsHelp: () => void;
  /** Ctrl/Cmd+, 打开偏好设置 */
  openSettings: () => void;
  /** 打开插入链接弹窗 */
  openLinkDialog?: () => void;
  /** 主编辑器实例获取函数 */
  getEditor: () => Editor | undefined;
}

export function useGlobalShortcuts(handlers: GlobalShortcutHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const { toggleZenMode, setZenMode, toggleSidebar, toggleOutline } =
        useUI.getState();
      // F11 切换禅模式（非修饰键，独立处理）
      if (e.key === "F11") {
        e.preventDefault();
        toggleZenMode();
        return;
      }
      // 禅模式下 Esc 退出
      if (e.key === "Escape" && useUI.getState().zenMode) {
        setZenMode(false);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ctrl/Cmd+N 新建未命名草稿（不关联磁盘文件，Ctrl+S 时另存为）
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        handlersRef.current.onNewTab();
        return;
      }
      // Ctrl/Cmd+Shift+F 全局搜索（优先于当前文件查找）
      if (e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        handlersRef.current.openGlobalSearch();
        return;
      }
      // Ctrl/Cmd+R 打开替换面板（Typora 标准：展开替换框，可逐个或全部替换）
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        const tabPath = useWorkspace.getState().activeTabPath;
        if (tabPath && useWorkspace.getState().getTabSourceMode(tabPath)) {
          // 源码模式：打开 CM 内置替换面板（issue #29）
          runSourceModeSearch(tabPath, { replace: true });
          return;
        }
        handlersRef.current.openFindPanel(true);
        return;
      }
      // Ctrl/Cmd+K 插入链接（Typora 标准）：打开链接插入对话框
      if (!e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const tabPath = useWorkspace.getState().activeTabPath;
        if (tabPath && useWorkspace.getState().getTabSourceMode(tabPath)) {
          return;
        }
        handlersRef.current.openLinkDialog?.();
        return;
      }
      // Ctrl/Cmd+Alt+0 转普通段落（Typora 标准：清除块格式，标题/引用/列表等转回段落）
      if (e.altKey && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        const tabPath = useWorkspace.getState().activeTabPath;
        if (tabPath && useWorkspace.getState().getTabSourceMode(tabPath)) {
          return;
        }
        const editor = handlersRef.current.getEditor();
        if (editor) {
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            const { state } = view;
            const para = state.schema.nodes.paragraph;
            if (!para) return;
            const { $from, $to } = state.selection;
            const range = $from.blockRange($to);
            if (!range) return;
            view.dispatch(state.tr.setBlockType(range.start, range.end, para).scrollIntoView());
            view.focus();
          });
        }
        return;
      }
      // Ctrl/Cmd+0 重置编辑器缩放到 100%（浏览器/Typora 标准）
      if (!e.shiftKey && !e.altKey && e.key === "0") {
        e.preventDefault();
        useSettings.getState().resetEditorZoom();
        return;
      }
      const store = useShortcuts.getState();
      const tryMatch = (id: ShortcutId) => matchBinding(store.getBinding(id), e);
      if (tryMatch("find")) {
        e.preventDefault();
        const tabPath = useWorkspace.getState().activeTabPath;
        if (tabPath && useWorkspace.getState().getTabSourceMode(tabPath)) {
          // 源码模式：打开 CM 内置查找面板（issue #29）
          runSourceModeSearch(tabPath, { replace: false });
          return;
        }
        handlersRef.current.openFindPanel(false);
      } else if (tryMatch("toggleSidebar")) {
        e.preventDefault();
        toggleSidebar();
      } else if (tryMatch("toggleOutline")) {
        e.preventDefault();
        toggleOutline();
      } else if (tryMatch("showShortcuts")) {
        e.preventDefault();
        handlersRef.current.toggleShortcutsHelp();
      } else if (tryMatch("openSettings")) {
        e.preventDefault();
        handlersRef.current.openSettings();
      } else if (tryMatch("quickOpen")) {
        // Ctrl/Cmd+P：Chromium 下是原生打印，必须先 preventDefault 再打开面板
        e.preventDefault();
        handlersRef.current.openQuickOpen();
      } else if (tryMatch("toggleSourceMode")) {
        e.preventDefault();
        useWorkspace.getState().toggleTabSourceMode();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

import { useCallback, useRef, useState, useEffect } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { EditorBody } from "./components/Editor/EditorBody";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { StatusBar } from "./components/StatusBar/StatusBar";
import { OutlinePanel } from "./components/Outline/OutlinePanel";
import { TabsBar } from "./components/Tabs/TabsBar";
import { SettingsPanel } from "./components/Settings/SettingsPanel";
import { ShortcutsHelp } from "./components/Shortcuts/ShortcutsHelp";
import { GlobalSearchPanel } from "./components/GlobalSearch/GlobalSearchPanel";
import { QuickOpenPanel } from "./components/QuickOpen/QuickOpenPanel";
import { ConflictDialog } from "./components/FileConflict/ConflictDialog";
import { ShortcutsCustomize } from "./components/Shortcuts/ShortcutsCustomize";
import { LinkDialog } from "./components/Editor/LinkDialog";
import { EditorTopbar } from "./components/Topbar/EditorTopbar";
import { useWorkspace } from "./store/workspace";
import { useUI } from "./store/ui";
import { useSettings } from "./store/settings";
import { useAutoSave } from "./lib/useAutoSave";
import { useFileWatcher } from "./lib/useFileWatcher";
import { useCtrlWheelZoom } from "./lib/useCtrlWheelZoom";
import { useGlobalShortcuts } from "./lib/useGlobalShortcuts";
import { resolveModalAction, type ModalId } from "./lib/modals";
import { useStartupFile } from "./lib/useStartupFile";
import { useExitHandler } from "./lib/useExitHandler";
import { type EditorOutlineSnapshot } from "./lib/outline";
import { useOutline } from "./store/outline";
import { IconPanelLeft } from "./components/icons";
import "./App.css";

function App() {
  const currentFile = useWorkspace((s) => s.currentFile);
  // 分屏：右侧第二面板
  const splitFile = useWorkspace((s) => s.splitFile);
  const mainSourceMode = useWorkspace((s) => {
    if (!s.activeTabPath) return false;
    return s.openTabs.find((t) => t.path === s.activeTabPath)?.sourceMode ?? false;
  });
  const splitSourceMode = useWorkspace((s) => {
    if (!s.splitFile) return false;
    return s.openTabs.find((t) => t.path === s.splitFile)?.sourceMode ?? false;
  });
  const mainRevision = useWorkspace((s) => {
    if (!s.activeTabPath) return 0;
    return s.openTabs.find((t) => t.path === s.activeTabPath)?.revision ?? 0;
  });
  const splitRevision = useWorkspace((s) => {
    if (!s.splitFile) return 0;
    return s.openTabs.find((t) => t.path === s.splitFile)?.revision ?? 0;
  });
  // 分屏编辑器实例引用（独立于主编辑器）
  const splitEditorRef = useRef<(() => Editor | undefined) | null>(null);

  // 持有编辑器实例获取函数，供大纲面板与导出使用
  const getEditorRef = useRef<(() => Editor | undefined) | null>(null);
  // Ctrl+N 新建未命名草稿后，编辑器重建完成时自动聚焦
  const pendingFocusRef = useRef(false);
  const handleEditorReady = useCallback(
    (getEditor: (() => Editor | undefined) | null) => {
      getEditorRef.current = getEditor;
      if (getEditor && pendingFocusRef.current) {
        pendingFocusRef.current = false;
        const editor = getEditor();
        if (editor) {
          // 延迟一帧等编辑器挂载稳定
          requestAnimationFrame(() => {
            editor.action((ctx) => {
              ctx.get(editorViewCtx).focus();
            });
          });
        }
      }
    },
    [],
  );
  const handleSplitEditorReady = useCallback(
    (getEditor: (() => Editor | undefined) | null) => {
      splitEditorRef.current = getEditor;
    },
    [],
  );
  // 主编辑器发布的大纲快照直接写独立 store，仅 OutlinePanel 订阅：
  // 经 App useState 中转会导致滚动时整棵 App 树高频重渲染（issue #31）。
  const handleOutlineChange = useCallback(
    (snapshot: EditorOutlineSnapshot) => {
      useOutline
        .getState()
        .publish(useWorkspace.getState().currentFile, snapshot);
    },
    [],
  );

  // 查找替换面板展开状态
  const [searchOpen, setSearchOpen] = useState(false);
  // 查找面板是否显示替换框（受控，便于 Ctrl+R 直接展开替换）
  const [searchShowReplace, setSearchShowReplace] = useState(false);

  // 互斥模态：此前是 6 个彼此不可知的布尔量，导致「全局搜索打开时按 mod+p」会叠加弹层。
  // 收敛为单值后，由 resolveModalAction 统一决定 打开 / 关闭 / 忽略（#228）。
  // 注意：编辑器内的查找面板（searchOpen）不是遮挡式模态，不进这个体系。
  const [activeModal, setActiveModal] = useState<ModalId | null>(null);

  /** 用户发起的模态请求：经互斥规则归并，不叠加 */
  const requestModal = useCallback((id: ModalId) => {
    setActiveModal((current) => {
      const action = resolveModalAction(current, id);
      if (action === "open") return id;
      if (action === "close") return null;
      return current; // ignore：已有其他模态在展示，直接忽略
    });
  }, []);

  // UI 可见性状态
  const sidebarVisible = useUI((s) => s.sidebarVisible);
  const outlineVisible = useUI((s) => s.outlineVisible);
  const toggleSidebar = useUI((s) => s.toggleSidebar);
  const zenMode = useUI((s) => s.zenMode);
  const toggleZenMode = useUI((s) => s.toggleZenMode);

  // 编辑器缩放倍率（Ctrl/Cmd + 滚轮调整，Ctrl/Cmd+0 重置）
  const editorZoom = useSettings((s) => s.editorZoom);

  // 进入源代码模式时关闭查找面板，避免对隐藏 WYSIWYG 的替换被丢弃
  useEffect(() => {
    if (mainSourceMode) {
      setSearchOpen(false);
      setSearchShowReplace(false);
    }
  }, [mainSourceMode]);

  // Ctrl/Cmd + 滚轮缩放文档：拦截浏览器原生页面缩放，改用应用内 zoom
  // 性能关键：仅在 Ctrl/Cmd 按下时才挂载 passive:false 监听器，
  // 普通滚动时无任何 wheel 监听器，让浏览器走合成线程快速滚动路径。
  // 万行文档下若 passive:false 常驻，主线程被布局/绘制占用时滚轮会严重卡顿。
  // 逻辑抽到 useCtrlWheelZoom hook 便于单元测试覆盖。
  useCtrlWheelZoom();

  // 启用 Ctrl/Cmd+S 手动保存 + 防抖 2 秒自动保存
  useAutoSave();
  // 启用外部文件修改监听（仅桌面端）
  useFileWatcher();
  // 启动时打开目标文件（派生窗口 / 文件关联 / 单实例转发）
  useStartupFile();
  useExitHandler();

  // 稳定引用：避免 OutlinePanel 列表项 memo 因 getEditor 身份变化失效
  const getEditor = useCallback(() => getEditorRef.current?.(), []);

  // 全局快捷键（自定义绑定经 useShortcuts store 生效）
  useGlobalShortcuts({
    onNewTab: () => {
      pendingFocusRef.current = true;
      useWorkspace.getState().newTab();
    },
    // 模态类快捷键一律走 requestModal：互斥规则只在这一处生效
    openGlobalSearch: () => requestModal("globalSearch"),
    openQuickOpen: () => requestModal("quickOpen"),
    openFindPanel: (showReplace) => {
      setSearchShowReplace(showReplace);
      setSearchOpen(true);
    },
    toggleShortcutsHelp: () => requestModal("shortcutsHelp"),
    openSettings: () => requestModal("settings"),
    openLinkDialog: () => requestModal("linkDialog"),
    getEditor,
  });

  // 模态层：**必须在禅模式分支也渲染**（issue #228 评审 P2-2）。
  // 收敛为单值 activeModal 后，「模态不渲染 + requestModal 照常置位」会变成全局静默锁：
  // 禅模式下按 mod+p 无任何可见反馈，随后 mod+shift+f 会被 resolveModalAction 判为
  // ignore 一并吞掉，用户看到的是「快速打开和全局搜索都按不出来」，只能再按一次
  // mod+p 把它 toggle 掉或 Esc 退出禅模式才恢复。
  //（此前 6 个独立布尔量同样不可见，但每个快捷键都「生效」，退出禅模式后一起显示；
  //  即叠加 bug 与这个死键是同一处结构造成的。）
  // ConflictDialog 一并放这里：它是阻塞式确认，「不可渲染」意味着保存被静默卡住。
  const modalLayer = (
    <>
      {activeModal === "settings" && (
        <SettingsPanel onClose={() => setActiveModal(null)} />
      )}
      {activeModal === "shortcutsHelp" && (
        <ShortcutsHelp
          onClose={() => setActiveModal(null)}
          onCustomize={() => {
            // 模态之间的显式切换：直接置值，不走互斥归并
            // （否则「帮助 → 自定义」会被判为 ignore 而卡住）
            setActiveModal("shortcutsCustomize");
          }}
        />
      )}
      {activeModal === "shortcutsCustomize" && (
        <ShortcutsCustomize onClose={() => setActiveModal(null)} />
      )}
      {activeModal === "globalSearch" && (
        <GlobalSearchPanel
          getEditor={getEditor}
          onClose={() => setActiveModal(null)}
        />
      )}
      {activeModal === "quickOpen" && (
        <QuickOpenPanel onClose={() => setActiveModal(null)} />
      )}
      {activeModal === "linkDialog" && (
        <LinkDialog
          getEditor={getEditor}
          onClose={() => setActiveModal(null)}
        />
      )}
      <ConflictDialog />
    </>
  );

  // 禅模式：仅渲染编辑器，隐藏所有 UI（侧边栏/大纲/标签页/工具栏/状态栏）；
  // 用户显式唤起的模态层除外（见上方注释）
  if (zenMode && currentFile) {
    return (
      <main className="app-shell zen-mode">
        <div className="editor-wrap">
          <EditorBody
            currentFile={currentFile}
            mainRevision={mainRevision}
            mainSourceMode={mainSourceMode}
            splitFile={null}
            splitSourceMode={false}
            splitRevision={0}
            editorZoom={editorZoom}
            searchOpen={false}
            searchShowReplace={false}
            getEditor={getEditor}
            setSearchOpen={setSearchOpen}
            setSearchShowReplace={setSearchShowReplace}
            onEditorReady={handleEditorReady}
            onOutlineChange={handleOutlineChange}
            onSplitEditorReady={handleSplitEditorReady}
          />
        </div>
        {modalLayer}
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="app-main">
      {sidebarVisible && <Sidebar />}
      <div className="editor-wrap">
        {currentFile ? (
          <>
            <TabsBar />
            <EditorTopbar
              currentFile={currentFile}
              sourceMode={mainSourceMode}
              onToggleSourceMode={() => useWorkspace.getState().toggleTabSourceMode()}
              onToggleZenMode={toggleZenMode}
              onToggleSidebar={toggleSidebar}
              onOpenShortcuts={() => requestModal("shortcutsHelp")}
              onOpenSettings={() => requestModal("settings")}
              getEditor={getEditor}
            />
            <EditorBody
              currentFile={currentFile}
              mainRevision={mainRevision}
              mainSourceMode={mainSourceMode}
              splitFile={splitFile}
              splitSourceMode={splitSourceMode}
              splitRevision={splitRevision}
              editorZoom={editorZoom}
              searchOpen={searchOpen}
              searchShowReplace={searchShowReplace}
              getEditor={getEditor}
              setSearchOpen={setSearchOpen}
              setSearchShowReplace={setSearchShowReplace}
              onEditorReady={handleEditorReady}
              onOutlineChange={handleOutlineChange}
              onSplitEditorReady={handleSplitEditorReady}
            />
          </>
        ) : (
          <div className="empty-state">
            <h2>InklingMD</h2>
            <p>从左侧侧边栏「打开」文件夹，或「打开文件」直接打开一个 .md 开始编辑</p>
            {!sidebarVisible && (
              <button
                className="empty-state-open-sidebar"
                onClick={toggleSidebar}
                title="打开侧边栏 (Ctrl/Cmd+\)"
              >
                <IconPanelLeft size={16} />
                打开侧边栏
              </button>
            )}
          </div>
        )}
      </div>
      {currentFile && outlineVisible && <OutlinePanel getEditor={getEditor} />}
      </div>
      {currentFile && <StatusBar />}
      {modalLayer}
    </main>
  );
}

export default App;

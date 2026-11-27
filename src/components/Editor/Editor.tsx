import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Milkdown, MilkdownProvider, useEditor, useInstance } from "@milkdown/react";
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  prosePluginsCtx,
  rootCtx,
  serializerCtx,
} from "@milkdown/kit/core";
import { commonmark, headingIdGenerator } from "@milkdown/kit/preset/commonmark";
import {
  gfm,
  columnResizingPlugin,
} from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { nord } from "@milkdown/theme-nord";
// G5/N2（#223/#224）：vendor CSS 由 vite 插件 themeBaseLayerPlugin 统一包入 @layer base
// （@import 类入口不能在源码侧整体包层；见 vite.config.ts）
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
// TableToolbar 已提升到 App.tsx 的 topbar 下方作为固定非滚动行，
// 此处不再内部渲染；inTable 状态通过 onInTableChange 回调外露。
import { codeBlockView } from "./code-block-view";
import { imageView } from "./image-node-view";
import { imageUploadPlugin } from "./image-upload";
import { smartPastePlugin } from "./smart-paste";
import { remoteImagePlugin } from "./remote-image";
import { linkClickPlugin, scrollToAnchorInView } from "./link-click";
import { outlineTrackerPlugin } from "./outline-tracker";
import {
  cancelPendingMarkdownPublish,
  flushAllMarkdownPublishers,
  markdownPublisherPlugin,
} from "./markdown-publisher";
import { normalizeListPlaceholders } from "./markdown-serialize";
import { formulaNumberingPlugin, formulaNumberingKey } from "./formula-numbering";
import { editorModesPlugin } from "./editor-modes";
import { blockDragPlugin } from "./block-drag";
import { searchPlugin } from "./search";
import { cursorSaverPlugin, flushCursorSaverForTabSwitch } from "./cursor-saver";
import { tableTrackerPlugin } from "./table-tracker";
import { selectAllPlugin } from "./select-all";
import { useSourceModeTransition } from "./useSourceModeTransition";
import { useCursorStateRestore } from "./useCursorStateRestore";
import { placeCursorForRootClick } from "./editor-root-click";
import {
  createTabEditorCache,
  flushActiveHydration,
  hydrationMetaKey,
  HYDRATION_CHUNK_SIZE_FIRST_OPEN,
  HYDRATION_CHUNK_SIZE_TAB_SWITCH,
  readHistoryState,
  startDocHydration,
  type HydrationMeta,
  type HydrationTask,
  type TabEditorCache,
} from "./tab-editor-cache";
import { useSettings } from "../../store/settings";
import { useWorkspace } from "../../store/workspace";
import type { EditorOutlineSnapshot } from "../../lib/outline";
import { slugify } from "../../lib/slug";
import { isSamePath } from "../../lib/path-utils";
import {
  cancelPendingAnchor,
  consumePendingAnchor,
  requestPendingAnchor,
} from "../../lib/pending-anchor";
import {
  registerWysiwygAnchorSampler,
  unregisterWysiwygAnchorSampler,
} from "../../lib/wysiwyg-anchor-sampler";
import {
  remarkMathPlugin,
  mathInlineSchema,
  mathDisplaySchema,
  mathInlineView,
  mathDisplayView,
} from "./math";
import {
  remarkFrontmatterPlugin,
  frontmatterSchema,
  frontmatterView,
} from "./frontmatter";
import { footnoteRefView, footnoteDefinitionView } from "./footnotes";
import { htmlView } from "./html-view";
import { tocPlugin, tocSchema, tocView, remarkTocPlugin } from "./toc";
import {
  calloutSchema,
  calloutView,
  remarkCalloutPlugin,
} from "./callout";
import { slashMenuPlugin } from "./slash-menu";
import { autoPairPlugin } from "./auto-pair";
import { SourceModeEditor } from "./SourceModeEditor";
import { useEditorFallback } from "./useEditorFallback";
import type { EditorView } from "@milkdown/kit/prose/view";

interface EditorProps {
  /** 当前 Markdown 文件完整路径，用于解析相对图片路径 */
  filePath: string;
  /** 同路径重载修订号（reloadFile 时自增，使同路径缓存失效） */
  revision?: number;
  /** 受控的 Markdown 文本。外部传入新值时会覆盖编辑器内容 */
  value: string;
  /** 内容变更回调，输出当前 Markdown 源码 */
  onChange?: (markdown: string) => void;
  /** 编辑器实例就绪回调；卸载时传 null，避免外部继续使用旧实例 */
  onReady?: (getEditor: (() => Editor | undefined) | null) => void;
  /** 主编辑器渲染标题或当前标题变化时发布大纲快照 */
  onOutlineChange?: (snapshot: EditorOutlineSnapshot) => void;
  /** 光标进入/离开表格时回调，供外部工具栏切换上下文按钮组 */
  onInTableChange?: (inTable: boolean) => void;
  /** 是否处于源代码模式 */
  sourceMode?: boolean;
}

/**
 * 内部组件：在 MilkdownProvider 内部使用 useEditor / useInstance。
 * 负责创建编辑器实例、跨 tab 缓存与分片水合、同步外部 value、对外抛出 markdown 变更。
 *
 * 注意：React 集成层会在 getEditor 返回后自行调用 editor.create()，
 * 所以这里不要调用 .create()，也不要调用 .container()（该方法不存在）。
 * 挂载点通过 config 里 ctx.set(rootCtx, container) 注入。
 */
function EditorInner({
  filePath,
  revision = 0,
  value,
  onChange,
  onReady,
  onOutlineChange,
  onInTableChange,
  sourceMode = false,
}: EditorProps) {
  // 动态路径/状态 ref：Milkdown 实例跨 tab 复用（#426），插件与 NodeView 通过 getter 读取当前活跃文件
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  const valueRef = useRef(value);
  valueRef.current = value;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const sourceModeRef = useRef(sourceMode);
  sourceModeRef.current = sourceMode;

  // 记录最近一次同步进编辑器的 value，避免 onChange 回写的值又触发覆盖，造成循环
  const lastSyncedRef = useRef(value);
  // 持续缓存富文本编辑器的滚动位置，避免在 display:none 或切换时现场读取被浏览器重排钳 0
  const wysiwygScrollTopRef = useRef(0);
  // 同理缓存 scrollHeight：进入源码模式的过渡读取它做比例映射，届时容器已
  // display:none 塌陷，现场读取 ≈ clientHeight，会让映射目标失真（issue #136）
  const wysiwygScrollHeightRef = useRef(0);
  // 缓存视口顶部内容对应的 PM 位置（内容锚点，#136）：切换进入源码模式的
  // 过渡读取它。采样时机（#212）：「切换指令触发时」（setTabSourceMode 内、
  // React 渲染塌陷容器之前，经 lib/wysiwyg-anchor-sampler 注册表触发）为主，
  // 滚动停歇后（150ms debounce）补采一次作防御性保鲜。滚动路径本身零几何
  // 读取——每帧 posAtCoords 强制同步布局是万行复杂文档滚动掉帧的根因。
  const wysiwygTopPosRef = useRef(0);
  // 标记初始 value 是否已完成同步。publisher 在 view 创建时会把 lastSynced
  // 基线重置为「解析后 doc 的序列化结果」，与原始 value 存在规范化差异，
  // 若不跳过，外部同步 effect 会在每次挂载时把 doc 冗余重灌一遍。
  const initialSyncDoneRef = useRef(false);
  // onChange 用 ref 持有，避免它变化导致编辑器重建；
  // 切换 tab 的 layout effect 先用旧 onChange 刷完旧 tab 待发编辑，再切换到新 onChange
  const onChangeRef = useRef(onChange);
  // 大纲回调用 ref 持有，避免回调变化导致编辑器重建；同步记录当前文件最近快照供切 tab 缓存
  const onOutlineChangeRef = useRef(onOutlineChange);
  onOutlineChangeRef.current = onOutlineChange;
  const lastOutlineRef = useRef<EditorOutlineSnapshot | null>(null);

  // 跨 tab 编辑器状态缓存（LRU）与在途分片水合句柄
  const tabCacheRef = useRef<TabEditorCache | null>(null);
  if (!tabCacheRef.current) {
    tabCacheRef.current = createTabEditorCache();
  }
  const hydrationTaskRef = useRef<HydrationTask | null>(null);
  const initialCreatePropsRef = useRef<{
    filePath: string;
    revision: number;
    value: string;
    sourceMode: boolean;
  } | null>(null);
  const mountedDocRef = useRef<{
    filePath: string;
    revision: number;
    value: string;
    sourceMode: boolean;
  } | null>(null);

  // 光标是否位于表格内，用于控制表格工具栏的上下文按钮组
  const [inTable, setInTable] = useState(false);
  const inTableRef = useRef(false);

  // 链接跟随失败提示（#298）：非阻塞，4s 自动消失（范式同 SearchPanel 的 role="status"）。
  // 插件在非 React 的点击回调里触发，因此用 ref 持有最新回调，避免保存/重建编辑器。
  const [linkNotice, setLinkNotice] = useState<{
    message: string;
    kind: "info" | "warning";
  } | null>(null);
  const linkNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifyLink = (message: string, kind: "info" | "warning") => {
    if (linkNoticeTimerRef.current !== null) clearTimeout(linkNoticeTimerRef.current);
    setLinkNotice({ message, kind });
    linkNoticeTimerRef.current = setTimeout(() => {
      linkNoticeTimerRef.current = null;
      setLinkNotice(null);
    }, 4000);
  };
  const notifyLinkRef = useRef(notifyLink);
  notifyLinkRef.current = notifyLink;
  useEffect(
    () => () => {
      if (linkNoticeTimerRef.current !== null) clearTimeout(linkNoticeTimerRef.current);
    },
    [],
  );
  // inTable 变化时通知外部（工具栏已提升到 App.tsx）
  const onInTableChangeRef = useRef(onInTableChange);
  onInTableChangeRef.current = onInTableChange;
  useEffect(() => {
    onInTableChangeRef.current?.(inTable);
  }, [inTable]);

  // 水合完成后重采一次视口锚点：首个 rAF 采样时可能只挂上了首个分片，
  // 用部分高度做源码模式映射会失真（#426 评审 N8）。
  const resampleAnchorRef = useRef<() => void>(() => {});
  const queueAnchorResample = () => {
    requestAnimationFrame(() => resampleAnchorRef.current());
  };

  // 编辑位置记忆：持有 store 方法，插件内部通过 ref 调用避免重建
  const saveCursorState = useWorkspace((s) => s.saveCursorState);
  const saveCursorStateRef = useRef(saveCursorState);
  saveCursorStateRef.current = saveCursorState;

  // #172 加载降级：区分「create 慢启动（终会就绪）」与「真失败（永不就绪）」
  const [loading, getEditor] = useInstance();
  const { fallback, slowStart, markFactoryFailed } = useEditorFallback(loading, getEditor);

  useEditor(
    (container) => {
      // 整个工厂包 try/catch：任何插件初始化抛错时返回 undefined，
      // 避免异常冒泡导致 React 卸载整棵树白屏。
      // 工厂返回 undefined 后 @milkdown/react 的 loading 永不结束（它只在
      // create() 的 finally 里翻 false），由 markFactoryFailed() 显式上报，
      // 降级检测立即切到只读 textarea（issue #172，原实现靠 3 秒超时误判）。
      initialCreatePropsRef.current = {
        filePath: filePathRef.current,
        revision: revisionRef.current,
        value: valueRef.current,
        sourceMode: sourceModeRef.current,
      };
      try {
        return Editor.make()
          .config((ctx) => {
            ctx.set(rootCtx, container);
            // 若首个打开的文件处于源码模式，先以空文档轻量化初始化 WYSIWYG
            ctx.set(defaultValueCtx, sourceModeRef.current ? "" : valueRef.current);
            // #297：标题 DOM id 与应用 slugify 统一口径。上游默认生成器只替换空白、
            // 保留标点（`Hello, World!` → `hello,-world!`），会让 TOC / 锚点 / 导出 HTML
            // 出现与 GitHub 生态不一致的 id。去重后缀仍由 syncHeadingIdPlugin 追加
            // （1-based 计数：第 2 处为 `-#2`），不 fork 上游实现（见设计文档 D2）。
            ctx.set(headingIdGenerator.key, (node) => slugify(node.textContent));
            ctx.update(prosePluginsCtx, (ps) => [
              ...ps,
              // 注入选区跟踪插件：光标进入/离开表格时更新 inTable 状态
              tableTrackerPlugin(inTableRef, (next) => setInTable(next)),
              // Markdown 源码发布：全文序列化防抖 150ms，避免每次按键
              // 都 O(n) 序列化整篇文档（万行文档输入掉帧的主因之一）
              markdownPublisherPlugin({
                // 写盘前的列表项规整（#268 / #272）：剔除首块是子列表的列表项的占位空段落、
                // 把空列表项改写成裸标记，否则两者都会把 `<br />` 写进用户源码
                serialize: (doc) => ctx.get(serializerCtx)(normalizeListPlaceholders(doc)),
                getLastSynced: () => lastSyncedRef.current,
                setLastSynced: (md) => {
                  lastSyncedRef.current = md;
                },
                onChange: (md) => {
                  if (mountedDocRef.current) {
                    mountedDocRef.current.value = md;
                  }
                  onChangeRef.current?.(md);
                },
              }),
              // 图片拖拽/粘贴上传：复制到当前文档的 assets/ 并插入相对路径
              // （须排在 Smart Paste 之前：剪贴板带图片文件时优先按文件落盘）
              imageUploadPlugin(() => filePathRef.current),
              // Smart Paste：网页 HTML / Markdown 源码粘贴解析为富文本（#219/#229）
              smartPastePlugin({ parseMarkdown: (md) => ctx.get(parserCtx)(md) }),
              // 粘贴进来的远程图片后台下载落盘到 assets/（#220）
              remoteImagePlugin({ documentPath: () => filePathRef.current }),
              // 链接跟随：Ctrl/Cmd+点击打开外部链接或跳转内部锚点。
              // #298：DOM 捕获层统一接管，link mark 与 html-view 的 <a> 走同一条通路。
              linkClickPlugin({
                documentPath: () => filePathRef.current,
                workspaceRoot: () => useWorkspace.getState().rootPath,
                notify: (message, kind) => notifyLinkRef.current(message, kind),
                // #296：workspace-file 臂依赖。全部走 getState 实时读取，避免闭包拿到旧 store。
                openWorkspaceFile: (path) => useWorkspace.getState().openFile(path),
                requestPendingAnchor,
                cancelPendingAnchor,
                isSamePath,
                getOpenError: (path) => useWorkspace.getState().fileOpenErrors.get(path),
              }),
              // 仅主编辑器发布大纲；分屏编辑器不传回调，避免覆盖主面板。
              ...(onOutlineChange
                ? [
                    outlineTrackerPlugin((snapshot) => {
                      lastOutlineRef.current = snapshot;
                      onOutlineChangeRef.current?.(snapshot);
                    }),
                  ]
                : []),
              // 公式自动编号：给 math_display 节点按顺序设置 number attr
              formulaNumberingPlugin(),
              // 专注模式 + 打字机模式
              editorModesPlugin(),
              blockDragPlugin(),
              // 查找替换：高亮匹配、导航、替换
              searchPlugin(),
              // [TOC] 目录自动生成：根据文档标题实时生成目录
              tocPlugin(),
              // 编辑位置记忆：选区/滚动变化时缓存到本地
              cursorSaverPlugin(() => filePathRef.current, () => saveCursorStateRef.current),
              // 斜杠菜单：输入 `/` 弹出块类型选择菜单
              slashMenuPlugin(),
              // 自动配对补全：输入括号/引号自动配对
              autoPairPlugin(),
              // Ctrl/Cmd+A 全选整个文档
              selectAllPlugin(),
            ]);
            // 注入主题
            nord(ctx);
          })
          .use(commonmark)
          .use(gfm)
          // 列宽拖拽调整（gfm 默认未启用，需单独引入）
          .use(columnResizingPlugin)
          // 代码块：CodeMirror 高亮 + 行号 + 语言切换
          .use(codeBlockView)
          // 图片：相对路径解析为可加载 URL（保持 markdown 源码为相对路径）
          .use(imageView(() => filePathRef.current))
          // 数学公式：remark-math 解析 + KaTeX 渲染（行内 $...$ 和块级 $$...$$）
          .use(remarkMathPlugin)
          .use(mathInlineSchema)
          .use(mathDisplaySchema)
          .use(mathInlineView)
          .use(mathDisplayView)
          // YAML Front Matter：remark-frontmatter 解析 + CodeMirror 编辑
          .use(remarkFrontmatterPlugin)
          .use(frontmatterSchema)
          .use(frontmatterView)
          // 脚注：GFM 预设已注册 schema，这里仅覆盖 NodeView 提供跳转交互
          .use(footnoteRefView)
          .use(footnoteDefinitionView)
          // HTML 嵌入：覆盖 commonmark htmlSchema 的 NodeView，白名单渲染真实 HTML 标签
          .use(htmlView)
          // [TOC] 目录块节点
          .use(remarkTocPlugin)
          .use(tocSchema)
          .use(tocView)
          // callout 提示框：> [!WARNING] 等 GFM 语法
          .use(remarkCalloutPlugin)
          .use(calloutSchema)
          .use(calloutView)
          .use(history);
      } catch (e) {
        console.error("Milkdown 编辑器初始化失败：", e);
        markFactoryFailed();
        return undefined;
      }
    },
    // 依赖数组为空，编辑器只在挂载时创建一次；tab 切换与重载通过内部状态缓存与水合处理
    [],
  );

  // 对外发布编辑器实例 getter（跨 tab 切换保持稳定，仅卸载时清除）
  useLayoutEffect(() => {
    if (loading || !getEditor()) return;
    onReady?.(getEditor);
    return () => {
      onReady?.(null);
    };
  }, [loading, getEditor, onReady]);

  // 跨 tab 切换 / 同文件重载时的状态缓存与渐进水合（#426）
  useLayoutEffect(() => {
    if (loading) return;
    const editor = getEditor();
    if (!editor) {
      onChangeRef.current = onChange;
      return;
    }

    const prev = mountedDocRef.current;
    if (!prev) {
      const created = initialCreatePropsRef.current;
      // 首次 create() 完成时若期间未发生切 tab/重载且模式一致，直接标记当前文档已挂载
      if (
        created &&
        created.filePath === filePath &&
        created.revision === revision &&
        created.sourceMode === sourceMode
      ) {
        mountedDocRef.current = {
          filePath,
          revision,
          value: created.value,
          sourceMode,
        };
        initialSyncDoneRef.current = true;
        onChangeRef.current = onChange;
        return;
      }
    } else if (prev.filePath === filePath && prev.revision === revision) {
      // 同文件模式翻转或回调更新：更新记录并同步 onChangeRef
      prev.sourceMode = sourceMode;
      prev.value = value;
      onChangeRef.current = onChange;
      return;
    }

    const cache = tabCacheRef.current!;

    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const serializer = ctx.get(serializerCtx);

        // 1. 切离旧 tab：先用旧 onChangeRef 刷完未发布编辑，再缓存其完整 doc/选区/历史/大纲
        if (prev) {
          if (prev.filePath === filePath && prev.revision !== revision) {
            hydrationTaskRef.current?.cancel();
            hydrationTaskRef.current = null;
            cache.delete(filePath);
          } else if (prev.filePath !== filePath) {
            const inflightTask = hydrationTaskRef.current;
            hydrationTaskRef.current = null;
            if (!prev.sourceMode) {
              // 若通过 Sidebar/QuickOpen 切 tab，store 入口未调 flush，在此补齐（仍在旧 onChangeRef 下）
              flushAllMarkdownPublishers();
              cancelPendingMarkdownPublish(view);
              flushCursorSaverForTabSwitch(view, prev.filePath);

              const wasHydrating = inflightTask?.isActive() ?? false;
              const fullDoc = wasHydrating ? inflightTask!.fullDoc : view.state.doc;
              const selection =
                wasHydrating && inflightTask?.selection
                  ? inflightTask.selection
                  : {
                      anchor: view.state.selection.anchor,
                      head: view.state.selection.head,
                    };
              const historyState = wasHydrating
                ? inflightTask!.historyState
                : readHistoryState(view.state);
              inflightTask?.cancel();

              // 切走时布局是干净的：这里读一次 scrollHeight 代价很低，
              // 供切回时分片水合期间撑住容器高度（#426）。若本 tab 的水合
              // 还没跑完，尺寸不完整，按已水合块的平均高度外推完整高度。
              const scrollEl =
                (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
                view.dom.closest<HTMLElement>(".editor-scroll");
              const totalHeight = wasHydrating
                ? inflightTask!.estimateFullHeight()
                : scrollEl
                  ? scrollEl.scrollHeight
                  : 0;

              // tab 已被关闭时不写缓存：closeTab 先更新 openTabs（触发 prune），
              // 本次 layout effect 是同一提交里的后手，若无条件写回，关闭的大文档
              // 会一直驻留到下一次 openTabs 变化（#426 评审 N16）。
              const stillOpen = useWorkspace
                .getState()
                .openTabs.some((t) => t.path === prev.filePath);
              if (stillOpen) {
                // 缓存内容必须取 **flush 之后** 的值（#431 评审 P2）：若用户在
                // 150ms 发布防抖窗口内切 tab，上面的 flush 已经把新内容写进 store，
                // 而 `prev.value` 还是 flush 前的 prop。用它写缓存会让下次打开时
                // `cachedContent !== value` → 缓存 miss → 重新解析并清空
                // ProseMirror history（Ctrl+Z 丢最近编辑）。
                const flushedContent =
                  useWorkspace
                    .getState()
                    .openTabs.find((t) => t.path === prev.filePath)?.content ??
                  prev.value;
                cache.set({
                  filePath: prev.filePath,
                  revision: prev.revision,
                  cachedContent: flushedContent,
                  fullDoc,
                  selection,
                  historyState,
                  lastSynced: lastSyncedRef.current,
                  outlineSnapshot: lastOutlineRef.current,
                  totalHeight,
                });
              }
            } else {
              inflightTask?.cancel();
            }
          }
        }

        // 旧 tab 收尾完成，切换 onChangeRef 到新 tab
        onChangeRef.current = onChange;
        inTableRef.current = false;
        setInTable(false);
        onInTableChangeRef.current?.(false);

        // 2. 切入新 tab
        if (sourceMode) {
          lastSyncedRef.current = value;
          lastOutlineRef.current = null;
          const emptyDoc = view.state.schema.nodes.doc.createAndFill();
          if (emptyDoc && view.state.doc.content.size > 0) {
            const tr = view.state.tr
              .replaceWith(0, view.state.doc.content.size, emptyDoc.content)
              .setMeta("addToHistory", false)
              .setMeta(hydrationMetaKey, {
                hydrating: true,
                done: true,
                fromCache: true,
                initialOutline: null,
              } satisfies HydrationMeta);
            view.dispatch(tr);
          }
          mountedDocRef.current = { filePath, revision, value, sourceMode: true };
          initialSyncDoneRef.current = true;
          return;
        }

        const cached = cache.get(filePath, revision, value);
        if (cached) {
          lastSyncedRef.current = cached.lastSynced;
          lastOutlineRef.current = cached.outlineSnapshot;
          mountedDocRef.current = { filePath, revision, value, sourceMode: false };
          initialSyncDoneRef.current = true;
          // 分片水合期间用切走时的高度撑住容器：否则滚动容器逐帧长高，
          // `switchMs`（等高度收敛）会把整个水合时长算进切换耗时（#426）。
          const wysiwygEl = view.dom.closest<HTMLElement>(".md-editor-wysiwyg");
          // 注意：onComplete 可能在水合函数内部**同步**触发（单分片路径），
          // 因此必须用 let + 赋值后比较，不能用 const（TDZ 会抛错并被外层 catch 吞掉）。
          let task: HydrationTask | null = null;
          task = startDocHydration({
            view,
            fullDoc: cached.fullDoc,
            fromCache: true,
            selection: cached.selection,
            historyState: cached.historyState,
            initialOutline: cached.outlineSnapshot,
            heightPlaceholder:
              wysiwygEl && cached.totalHeight > 0
                ? { el: wysiwygEl, height: cached.totalHeight }
                : null,
            chunkSize: HYDRATION_CHUNK_SIZE_TAB_SWITCH,
            onComplete: () => {
              if (hydrationTaskRef.current === task) {
                hydrationTaskRef.current = null;
              }
              queueAnchorResample();
            },
          });
          hydrationTaskRef.current = task.isActive() ? task : null;
          return;
        }

        // 缓存未命中：解析文档并按分片/单步水合
        let parsedDoc;
        try {
          parsedDoc = parser(value);
        } catch (e) {
          console.error("编辑器内容解析失败：", e);
          const schema = view.state.schema;
          const para = value
            ? schema.nodes.paragraph.create(null, schema.text(value))
            : schema.nodes.paragraph.create();
          parsedDoc = schema.nodes.doc.create(null, para);
        }

        lastSyncedRef.current = value;
        lastOutlineRef.current = null;
        mountedDocRef.current = { filePath, revision, value, sourceMode: false };
        initialSyncDoneRef.current = true;

        // 缓存未命中：解析文档并按分片/单步水合。
        // 选区用该 tab 记忆的编辑位置（夹紧到文档范围）：改前依赖 Editor 重挂后
        // `useCursorStateRestore` 恢复，现在实例复用、effect 不会重跑，必须在这里带上。
        const remembered = useWorkspace.getState().getCursorStateFor(filePath).pos;
        const docSize = parsedDoc.content.size;
        const restored = remembered == null ? 0 : Math.max(0, Math.min(remembered, docSize));

        let task: HydrationTask | null = null;
        task = startDocHydration({
          view,
          fullDoc: parsedDoc,
          fromCache: false,
          selection: { anchor: restored, head: restored },
          historyState: undefined,
          initialOutline: null,
          chunkSize: HYDRATION_CHUNK_SIZE_FIRST_OPEN,
          onComplete: () => {
            if (hydrationTaskRef.current === task) {
              hydrationTaskRef.current = null;
            }
            if (
              !view.isDestroyed &&
              mountedDocRef.current?.filePath === filePath &&
              parsedDoc.childCount <= HYDRATION_CHUNK_SIZE_FIRST_OPEN
            ) {
              try {
                lastSyncedRef.current = serializer(normalizeListPlaceholders(view.state.doc));
              } catch {
                // 保持原基线
              }
            }
            queueAnchorResample();
          },
        });
        hydrationTaskRef.current = task.isActive() ? task : null;
      });
    } catch (e) {
      // 不允许静默：水合/插件异常会让「已切 tab」与「已挂载 doc」长期不一致
      console.error("[editor] 切换 tab 的状态水合失败：", e);
      onChangeRef.current = onChange;
    }
  }, [loading, getEditor, filePath, revision, sourceMode, onChange]);

  // 订阅 openTabs：标签页关闭后立即释放对应缓存条目
  useEffect(() => {
    return useWorkspace.subscribe((state, prevState) => {
      if (state.openTabs === prevState.openTabs) return;
      const openPaths = new Set(state.openTabs.map((t) => t.path));
      tabCacheRef.current?.prune(openPaths);
    });
  }, []);

  // 组件销毁时取消任何在途分片水合与缓存
  useEffect(() => {
    return () => {
      hydrationTaskRef.current?.cancel();
      hydrationTaskRef.current = null;
      tabCacheRef.current?.clear();
    };
  }, []);

  // 锚点采样与滚动缓存：按 filePath 注册，初始采样延后至首帧绘制后，避免挂载同步重排（#426）
  useLayoutEffect(() => {
    if (loading || !getEditor()) return;
    const editor = getEditor();
    let cleanupScroll: (() => void) | undefined;
    if (editor) {
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const scrollEl =
            (view as EditorView & { scrollDOM?: HTMLElement }).scrollDOM ??
            view.dom.closest<HTMLElement>(".editor-scroll");
          if (scrollEl) {
            // 视口顶部块定位：posAtCoords 命中不透明 nodeview（内嵌 CM6 的
            // 代码块）时只能给出块边界位置（doc 根 depth=0），无法表达真实
            // 可见行。此时改用几何定位：在顶层块起始位置上二分（块顶坐标随
            // 位置单调不减），找渲染顶边最贴近视口顶的那块，取其起始位置。
            const blockStartAtTop = (targetY: number): number | null => {
              const doc = view.state.doc;
              const starts: number[] = [];
              doc.forEach((_node, offset) => {
                starts.push(offset);
              });
              if (starts.length === 0) return null;
              let lo = 0;
              let hi = starts.length - 1;
              let best = -1;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                let top = Number.NaN;
                try {
                  top = view.coordsAtPos(starts[mid], 1).top;
                } catch {
                  // 该位置无法取坐标：线性探测相邻块兜底
                  for (let k = mid; k < starts.length; k++) {
                    try {
                      top = view.coordsAtPos(starts[k], 1).top;
                      if (Number.isFinite(top)) break;
                    } catch {
                      top = Number.NaN;
                    }
                  }
                }
                if (!Number.isFinite(top)) break;
                if (top <= targetY) {
                  best = mid;
                  lo = mid + 1;
                } else {
                  hi = mid - 1;
                }
              }
              if (best < 0) return null;
              return starts[best];
            };
            const cacheTopPos = () => {
              try {
                const rect = scrollEl.getBoundingClientRect();
                const left = rect.left + Math.max(1, rect.width / 2);
                const hit = view.posAtCoords({ top: rect.top + 2, left });
                if (hit == null) return;
                const $pos = view.state.doc.resolve(hit.pos);
                if ($pos.depth === 0) {
                  const snapped = blockStartAtTop(rect.top + 2);
                  wysiwygTopPosRef.current = snapped ?? hit.pos;
                } else {
                  wysiwygTopPosRef.current = hit.pos;
                }
              } catch {
                // 失败保留上次缓存值
              }
            };
            // #212：锚点采样器——在「几何现场读可靠」的时机执行：
            // 1) 切换指令触发时（setTabSourceMode 内经注册表调用，编辑器
            //    仍可见）；2) 滚动停歇后（下方 debounce）；3) 首帧 rAF 兜底。
            // 容器已塌陷（源码模式激活中，clientHeight=0）时直接跳过，
            // 防止把缓存污染成塌陷读数（scrollTop=0/scrollHeight≈0）。
            const sampleAnchor = () => {
              if (!scrollEl.isConnected || scrollEl.clientHeight <= 0) return;
              wysiwygScrollTopRef.current = scrollEl.scrollTop;
              wysiwygScrollHeightRef.current = scrollEl.scrollHeight;
              cacheTopPos();
            };
            wysiwygScrollTopRef.current = 0;
            wysiwygScrollHeightRef.current = 0;
            wysiwygTopPosRef.current = 0;
            let initialAnchorFrame = requestAnimationFrame(() => {
              initialAnchorFrame = 0;
              sampleAnchor();
            });
            // 水合完成后再采一次（首帧可能只有第一片，见 queueAnchorResample 注释）
            resampleAnchorRef.current = sampleAnchor;
            registerWysiwygAnchorSampler(filePath, sampleAnchor);

            // 用户在分片水合期间交互时先同步补齐全文，确保编辑/点击落点准确。
            // 鼠标点击只在「点到尚未水合的尾部区域」时才补齐：命中已挂载内容时
            // 坐标映射是准确的，没必要为此付一次 O(剩余全文) 的同步插入。
            const flushOnInteraction = (event: Event) => {
              if (event.type === "mousedown") {
                const me = event as MouseEvent;
                const hit = view.posAtCoords({ left: me.clientX, top: me.clientY });
                const docSize = view.state.doc.content.size;
                if (hit && hit.pos < docSize - 2) return;
              }
              // 只补齐**触发事件的这个编辑器**（#431 评审）：无参调用会遍历所有
              // 活跃水合任务，分屏时在一个 pane 点一下就可能把另一个 pane 剩余的
              // O(n) 插入同步做完，重新造出长任务。
              flushActiveHydration(view);
            };
            view.dom.addEventListener("mousedown", flushOnInteraction, true);
            view.dom.addEventListener("keydown", flushOnInteraction, true);
            view.dom.addEventListener("beforeinput", flushOnInteraction, true);
            view.dom.addEventListener("paste", flushOnInteraction, true);
            view.dom.addEventListener("drop", flushOnInteraction, true);

            // #212：滚动路径不再做任何几何读取
            let settleTimer: ReturnType<typeof setTimeout> | null = null;
            const onScroll = () => {
              if (settleTimer !== null) clearTimeout(settleTimer);
              settleTimer = setTimeout(() => {
                settleTimer = null;
                sampleAnchor();
              }, 150);
            };
            scrollEl.addEventListener("scroll", onScroll, { passive: true });
            cleanupScroll = () => {
              if (initialAnchorFrame) cancelAnimationFrame(initialAnchorFrame);
              if (resampleAnchorRef.current === sampleAnchor) {
                resampleAnchorRef.current = () => {};
              }
              if (settleTimer !== null) clearTimeout(settleTimer);
              settleTimer = null;
              unregisterWysiwygAnchorSampler(filePath);
              scrollEl.removeEventListener("scroll", onScroll);
              view.dom.removeEventListener("mousedown", flushOnInteraction, true);
              view.dom.removeEventListener("keydown", flushOnInteraction, true);
              view.dom.removeEventListener("beforeinput", flushOnInteraction, true);
              view.dom.removeEventListener("paste", flushOnInteraction, true);
              view.dom.removeEventListener("drop", flushOnInteraction, true);
            };
          }
        });
      } catch {
        // ignore
      }
    }
    return () => {
      cleanupScroll?.();
    };
  }, [loading, getEditor, filePath]);

  // #296：消费「打开文件后滚到锚点」的一次性登记。必须等编辑器就绪再消费（doc 为空时
  // 锚点表匹配不到）；消费即删，切 tab 重挂不会重复滚动。同文件自链接不经过这里——打开臂
  // 会直接滚动（目标编辑器不会重挂，登记永远不会被消费）。
  //
  // 双 rAF 的原因：`useCursorStateRestore` 在挂载时会「立即 + 逐帧」把 scrollTop 写回 0
  // （新文件没有记忆值，issue #30）。若在 layout effect 里同步滚动，会被它随后的一帧覆盖。
  // 它的 settle 循环在目标值 0 达成后即停止，故延后两帧再滚动即可稳定生效。
  useLayoutEffect(() => {
    if (loading) return;
    const editor = getEditor();
    if (!editor) return;
    const fragment = consumePendingAnchor(filePath);
    if (!fragment) return;

    // 不做 cleanup 取消：登记已消费，effect 重跑不会重复滚动；若编辑器已销毁，
    // action 会抛错并被 catch，不会影响后续文件。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try {
          editor.action((ctx) => {
            const view = ctx.get(editorViewCtx);
            // 只补齐本文档自己的编辑器（#431 评审）：全局 flush 会顺带把分屏另一侧
            // 的大文档同步插完，把「打开文件定位」变成长任务。
            flushActiveHydration(view);
            scrollToAnchorInView(view, fragment);
          });
        } catch {
          // 滚动失败不影响文件已打开
        }
      });
    });
  }, [loading, getEditor, filePath]);

  // 公式自动编号 / 专注模式开关切换时，dispatch 空 tr 触发重算（appendTransaction + decorations）
  const getEditorRef = useRef(getEditor);
  getEditorRef.current = getEditor;

  useEffect(() => {
    if (sourceMode) {
      inTableRef.current = false;
      setInTable(false);
      onInTableChangeRef.current?.(false);
    }
  }, [sourceMode]);

  // 进入/退出源代码模式：采集光标、互斥专注/打字机、退出时灌回 PM
  const { enterSnapshot, exitSnapshotRef } = useSourceModeTransition({
    sourceMode,
    filePath,
    value,
    getEditor,
    lastSyncedRef,
    getWysiwygScrollTop: () => wysiwygScrollTopRef.current,
    getWysiwygScrollHeight: () => wysiwygScrollHeightRef.current,
    // 视口顶部内容锚点（#136/#212）：切换指令触发时 setTabSourceMode 已
    // 经同步采样过（编辑器仍可见），这里只读缓存值——无需也不应再做任何
    // 几何计算（此刻容器已 display:none）
    getWysiwygTopPos: () => wysiwygTopPosRef.current,
  });

  // 点击编辑器空白区域时的光标定位（详见 editor-root-click.ts）
  // 水合补齐已移进 `placeCursorForRootClick` 内部，按**被点击的那个 view** 作用域
  // 执行（#431 评审）：这里无参调用会把分屏另一侧的剩余分片同步插入完。
  const handleRootMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const editor = getEditorRef.current();
    if (editor) placeCursorForRootClick(editor, e);
  };

  useEffect(() => {
    let lastFormula = useSettings.getState().formulaAutoNumber;
    let lastFocus = useSettings.getState().focusMode;
    const unsub = useSettings.subscribe((s) => {
      if (s.formulaAutoNumber === lastFormula && s.focusMode === lastFocus) return;
      lastFormula = s.formulaAutoNumber;
      lastFocus = s.focusMode;
      const editor = getEditorRef.current();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        // 设置变更只影响本编辑器：按 view 补齐水合即可（#431 评审），
        // 无参调用会把分屏另一侧的大文档同步插完。
        flushActiveHydration(view);
        // 发送 recalc meta 触发公式编号重算（空 tr 本身不 docChanged，需 meta 显式触发）
        view.dispatch(view.state.tr.setMeta(formulaNumberingKey, { recalc: true }));
      });
    });
    return unsub;
  }, []);

  // 专注模式：给 root 加 class，CSS 弱化非聚焦块
  const focusMode = useSettings((s) => s.focusMode);
  // 拼写检查：通过 root div 的 spellCheck 属性，contentEditable 子节点（ProseMirror）继承此值
  const spellcheck = useSettings((s) => s.spellcheck);

  // 外部 value 变化时，覆盖编辑器内容（仅当与上次同步值不同时）
  useEffect(() => {
    if (loading || sourceMode) return;
    if (!initialSyncDoneRef.current) {
      // 编辑器刚以当前 value 完成初始化，跳过外部同步（避免冗余重灌 doc）
      initialSyncDoneRef.current = true;
      return;
    }
    if (
      mountedDocRef.current &&
      (mountedDocRef.current.filePath !== filePath ||
        mountedDocRef.current.revision !== revision)
    ) {
      return;
    }
    if (value === lastSyncedRef.current || value === mountedDocRef.current?.value) return;
    const editor = getEditor();
    if (!editor) return;
    hydrationTaskRef.current?.cancel();
    hydrationTaskRef.current = null;
    tabCacheRef.current?.delete(filePath);
    try {
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const parser = ctx.get(parserCtx);
        const newDoc = parser(value);
        view.dispatch(
          view.state.tr.replaceWith(0, view.state.doc.content.size, newDoc.content),
        );
      });
      lastSyncedRef.current = value;
      if (mountedDocRef.current) mountedDocRef.current.value = value;
    } catch (e) {
      // 解析失败时降级：清空编辑器并写入纯文本段落，避免异常冒泡导致白屏
      console.error("编辑器内容解析失败：", e);
      try {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const schema = view.state.schema;
          const textNode = schema.text(value);
          const para = schema.nodes.paragraph.create(null, textNode);
          view.dispatch(
            view.state.tr.replaceWith(0, view.state.doc.content.size, para),
          );
        });
        lastSyncedRef.current = value;
        if (mountedDocRef.current) mountedDocRef.current.value = value;
      } catch {
        // 连降级都失败，放弃同步，交由 ErrorBoundary 兜底
      }
    }
  }, [value, loading, getEditor, sourceMode, filePath, revision]);

  // 编辑位置记忆：切 tab/打开文件时按 filePath 恢复光标和滚动位置。
  // 必须按本实例的 filePath 读取，不能读 activeTabPath：切 tab 时它已指向新文件（issue #30）。
  // sourceMode 翻转的那一次让位给 useSourceModeTransition（单一写者，issue #136）
  useCursorStateRestore({ sourceMode, filePath, revision, loading, getEditor });

  // 降级模式：Milkdown 初始化失败，显示只读 textarea 展示原始 markdown
  if (fallback) {
    return (
      <div className="md-editor-root md-editor-fallback">
        <div className="md-editor-fallback-banner">
          ⚠️ 富文本编辑器加载失败，已切换到只读源码模式。内容未丢失，可正常保存。
        </div>
        <textarea
          className="md-editor-fallback-textarea"
          value={value}
          readOnly
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div
      className={`md-editor-root${focusMode && !sourceMode ? " focus-mode" : ""}${sourceMode ? " source-mode-active" : ""}`}
      spellCheck={spellcheck && !sourceMode}
      onMouseDown={sourceMode ? undefined : handleRootMouseDown}
    >
      <div
        className="md-editor-wysiwyg"
        style={{ display: sourceMode ? "none" : undefined }}
      >
        {slowStart && (
          <div className="md-editor-slow-hint" role="status">
            正在加载编辑器…（内容较大或设备较慢时首次渲染需要几秒）
          </div>
        )}
        <Milkdown />
      </div>
      {linkNotice && (
        <div
          className={`md-editor-link-notice md-editor-link-notice--${linkNotice.kind}`}
          role="status"
        >
          {linkNotice.message}
        </div>
      )}
      {sourceMode && enterSnapshot && (
        <SourceModeEditor
          key={filePath}
          filePath={filePath}
          value={value}
          onChange={(md) => {
            lastSyncedRef.current = md;
            if (mountedDocRef.current) mountedDocRef.current.value = md;
            onChangeRef.current?.(md);
          }}
          initialCursor={enterSnapshot.cursor}
          initialScrollTop={enterSnapshot.scrollTop}
          initialScrollHeight={enterSnapshot.scrollHeight ?? 0}
          initialAnchorOffset={enterSnapshot.anchorOffset}
          spellcheck={spellcheck}
          onUnmountSnapshot={(snap) => {
            exitSnapshotRef.current = snap;
          }}
          onOutlineChange={(snapshot) => {
            onOutlineChangeRef.current?.(snapshot);
          }}
        />
      )}
    </div>
  );
}

/**
 * 编辑器对外组件。
 * 阶段二任务6：在 commonmark 基础上集成 GFM（表格 + 任务列表 + 删除线），
 * 启用列宽拖拽，并提供插入表格、行列增删、对齐、删除表格的工具栏。
 */
export function MarkdownEditor({
  filePath,
  revision = 0,
  value,
  onChange,
  onReady,
  onOutlineChange,
  onInTableChange,
  sourceMode,
}: EditorProps) {
  return (
    <MilkdownProvider>
      <EditorInner
        filePath={filePath}
        revision={revision}
        value={value}
        onChange={onChange}
        onReady={onReady}
        onOutlineChange={onOutlineChange}
        onInTableChange={onInTableChange}
        sourceMode={sourceMode}
      />
    </MilkdownProvider>
  );
}

export default MarkdownEditor;

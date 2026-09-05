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
import { commonmark } from "@milkdown/kit/preset/commonmark";
import {
  gfm,
  columnResizingPlugin,
} from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { nord } from "@milkdown/theme-nord";
import "@milkdown/kit/prose/view/style/prosemirror.css";
import "@milkdown/kit/prose/tables/style/tables.css";
// TableToolbar 已提升到 App.tsx 的 topbar 下方作为固定非滚动行，
// 此处不再内部渲染；inTable 状态通过 onInTableChange 回调外露。
import { codeBlockView } from "./code-block-view";
import { imageView } from "./image-node-view";
import { imageUploadPlugin } from "./image-upload";
import { linkClickPlugin } from "./link-click";
import { outlineTrackerPlugin } from "./outline-tracker";
import { markdownPublisherPlugin } from "./markdown-publisher";
import { formulaNumberingPlugin, formulaNumberingKey } from "./formula-numbering";
import { editorModesPlugin } from "./editor-modes";
import { blockDragPlugin } from "./block-drag";
import { searchPlugin } from "./search";
import { cursorSaverPlugin } from "./cursor-saver";
import { tableTrackerPlugin } from "./table-tracker";
import { selectAllPlugin } from "./select-all";
import { useSourceModeTransition } from "./useSourceModeTransition";
import { useCursorStateRestore } from "./useCursorStateRestore";
import { placeCursorForRootClick } from "./editor-root-click";
import { useSettings } from "../../store/settings";
import { useWorkspace } from "../../store/workspace";
import type { EditorOutlineSnapshot } from "../../lib/outline";
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
 * 负责创建编辑器实例、同步外部 value、对外抛出 markdown 变更。
 *
 * 注意：React 集成层会在 getEditor 返回后自行调用 editor.create()，
 * 所以这里不要调用 .create()，也不要调用 .container()（该方法不存在）。
 * 挂载点通过 config 里 ctx.set(rootCtx, container) 注入。
 */
function EditorInner({
  filePath,
  value,
  onChange,
  onReady,
  onOutlineChange,
  onInTableChange,
  sourceMode = false,
}: EditorProps) {
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
  // onChange 用 ref 持有，避免它变化导致编辑器重建
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  // 大纲回调用 ref 持有，避免回调变化导致编辑器重建
  const onOutlineChangeRef = useRef(onOutlineChange);
  onOutlineChangeRef.current = onOutlineChange;

  // 光标是否位于表格内，用于控制表格工具栏的上下文按钮组
  const [inTable, setInTable] = useState(false);
  const inTableRef = useRef(false);
  // inTable 变化时通知外部（工具栏已提升到 App.tsx）
  const onInTableChangeRef = useRef(onInTableChange);
  onInTableChangeRef.current = onInTableChange;
  useEffect(() => {
    onInTableChangeRef.current?.(inTable);
  }, [inTable]);

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
      try {
        return Editor.make()
          .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, value);
            ctx.update(prosePluginsCtx, (ps) => [
              ...ps,
              // 注入选区跟踪插件：光标进入/离开表格时更新 inTable 状态
              tableTrackerPlugin(inTableRef, (next) => setInTable(next)),
              // Markdown 源码发布：全文序列化防抖 150ms，避免每次按键
              // 都 O(n) 序列化整篇文档（万行文档输入掉帧的主因之一）
              markdownPublisherPlugin({
                serialize: (doc) => ctx.get(serializerCtx)(doc),
                getLastSynced: () => lastSyncedRef.current,
                setLastSynced: (md) => {
                  lastSyncedRef.current = md;
                },
                onChange: (md) => onChangeRef.current?.(md),
              }),
              // 图片拖拽/粘贴上传：复制到当前文档的 assets/ 并插入相对路径
              imageUploadPlugin(filePath),
              // 链接跟随：Ctrl/Cmd+点击打开外部链接或跳转内部锚点
              linkClickPlugin(),
              // 仅主编辑器发布大纲；分屏编辑器不传回调，避免覆盖主面板。
              ...(onOutlineChange
                ? [
                    outlineTrackerPlugin((snapshot) =>
                      onOutlineChangeRef.current?.(snapshot),
                    ),
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
              cursorSaverPlugin(filePath, () => saveCursorStateRef.current),
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
          .use(imageView(filePath))
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
    // 依赖数组为空，编辑器只在挂载时创建一次；filePath 变化由外层 key 触发重建
    [],
  );

  // 在浏览器绘制可点击的大纲前发布实例；卸载时同步清除旧 getter。
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
            wysiwygScrollTopRef.current = scrollEl.scrollTop;
            wysiwygScrollHeightRef.current = scrollEl.scrollHeight;
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
            //    仍可见）；2) 滚动停歇后（下方 debounce）；3) 本 effect 挂载时。
            // 容器已塌陷（源码模式激活中，clientHeight=0）时直接跳过，
            // 防止把缓存污染成塌陷读数（scrollTop=0/scrollHeight≈0）。
            const sampleAnchor = () => {
              if (!scrollEl.isConnected || scrollEl.clientHeight <= 0) return;
              wysiwygScrollTopRef.current = scrollEl.scrollTop;
              wysiwygScrollHeightRef.current = scrollEl.scrollHeight;
              cacheTopPos();
            };
            sampleAnchor();
            registerWysiwygAnchorSampler(filePath, sampleAnchor);
            // #212：滚动路径不再做任何几何读取（旧实现每滚动帧跑一次
            // cacheTopPos：posAtCoords 内部 elementFromPoint 在懒挂载持续
            // 脏化布局时每帧强制同步重排整篇文档，万行文档单次 6~32ms，
            // 120Hz 预算 8.33ms 被吃满——正是本仓库 outline-tracker 在
            // v2.3.3 弃用 posAtCoords 的同一教训）。锚点正确性由「切换指令
            // 触发时同步采样」保证；滚动停歇后的补采仅作防御性保鲜——
            // 停歇时机一次强制布局无掉帧顾虑，也符合「重建安排在滚动停歇
            // 或 idle」的既定解法。
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
              if (settleTimer !== null) clearTimeout(settleTimer);
              settleTimer = null;
              unregisterWysiwygAnchorSampler(filePath);
              scrollEl.removeEventListener("scroll", onScroll);
            };
          }
        });
      } catch {
        // ignore
      }
    }
    onReady?.(getEditor);
    return () => {
      cleanupScroll?.();
      onReady?.(null);
    };
  }, [loading, getEditor, onReady]);

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
    if (value === lastSyncedRef.current) return;
    const editor = getEditor();
    if (!editor) return;
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
      } catch {
        // 连降级都失败，放弃同步，交由 ErrorBoundary 兜底
      }
    }
  }, [value, loading, getEditor, sourceMode]);

  // 编辑位置记忆：切 tab/打开文件时按 filePath 恢复光标和滚动位置。
  // 必须按本实例的 filePath 读取，不能读 activeTabPath：切 tab 时它已指向新文件（issue #30）。
  // sourceMode 翻转的那一次让位给 useSourceModeTransition（单一写者，issue #136）
  useCursorStateRestore({ sourceMode, filePath, loading, getEditor });

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
      {sourceMode && enterSnapshot && (
        <SourceModeEditor
          filePath={filePath}
          value={value}
          onChange={(md) => {
            lastSyncedRef.current = md;
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

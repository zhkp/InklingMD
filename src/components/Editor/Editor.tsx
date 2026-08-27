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
import { useCursorMemoryRestore } from "./useCursorMemoryRestore";
import { placeCursorForRootClick } from "./editor-root-click";
import { useSettings } from "../../store/settings";
import { useWorkspace } from "../../store/workspace";
import type { EditorOutlineSnapshot } from "../../lib/outline";
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
  // display:none 塌陷，现场读取 ≈ clientHeight，会把映射目标算成天文数字（issue #136 review）
  const wysiwygScrollHeightRef = useRef(0);
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

  useEditor(
    (container) => {
      // 整个工厂包 try/catch：任何插件初始化抛错时返回 undefined，
      // 避免异常冒泡导致 React 卸载整棵树白屏。
      // 返回 undefined 后 useInstance 的 loading 不会结束，
      // 下方的降级检测会在超时后切换到只读 textarea 显示原始内容。
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
        return undefined;
      }
    },
    // 依赖数组为空，编辑器只在挂载时创建一次；filePath 变化由外层 key 触发重建
    [],
  );

  const [loading, getEditor] = useInstance();

  // 降级检测：
  // 1) loading 持续超过 3 秒仍未就绪 → 工厂抛错返回 undefined
  // 2) loading 切到 false 后 getEditor() 仍为空 → editor.create() 异步阶段抛错
  //    （Milkdown React 集成层会 .catch(console.error) 吞掉错误，editorRef 不会赋值）
  // 两种情况都切换到只读 textarea 模式显示原始 markdown，避免白屏。
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    if (loading) {
      const timer = setTimeout(() => setFallback(true), 3000);
      return () => clearTimeout(timer);
    }
    // loading=false 后必须验证 editor 实例真的存在
    const editor = getEditor();
    setFallback(!editor);
  }, [loading, getEditor]);

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
            const onScroll = () => {
              wysiwygScrollTopRef.current = scrollEl.scrollTop;
              wysiwygScrollHeightRef.current = scrollEl.scrollHeight;
            };
            scrollEl.addEventListener("scroll", onScroll, { passive: true });
            cleanupScroll = () => scrollEl.removeEventListener("scroll", onScroll);
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

  // 编辑位置记忆：切 tab/打开文件时按 filePath 恢复光标和滚动位置；
  // 退出源码模式的那一次让位给 useSourceModeTransition（issue #136）
  useCursorMemoryRestore({ filePath, loading, sourceMode, getEditor });

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

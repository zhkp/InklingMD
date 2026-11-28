import { useEffect, useRef, useState } from "react";
import type { CmdKey, Editor } from "@milkdown/kit/core";
import type { EditorView } from "@milkdown/kit/prose/view";
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core";
import {
  insertTableCommand,
  addRowBeforeCommand,
  addRowAfterCommand,
  addColBeforeCommand,
  addColAfterCommand,
  deleteSelectedCellsCommand,
  setAlignCommand,
  selectTableCommand,
} from "@milkdown/kit/preset/gfm";
import { deleteColumn, deleteRow } from "@milkdown/kit/prose/tables";
import { flushActiveHydration } from "./tab-editor-cache";
import {
  turnIntoHeading,
  wrapBulletList,
  wrapOrderedList,
  wrapBlockquote,
  turnIntoCodeBlock,
  insertHr,
  insertMathBlock,
  insertInlineMath,
  turnIntoMermaid,
  insertCallout,
  insertToc,
  insertFrontmatter,
  deleteCurrentBlock,
  exitListIfNeeded,
} from "./block-commands";
import "./TableToolbar.css";

interface TableToolbarProps {
  getEditor: () => Editor | undefined;
  inTable: boolean;
}

/** 网格选择器最大尺寸 */
const GRID = 8;

type Align = "left" | "center" | "right";

export function TableToolbar({ getEditor, inTable }: TableToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hover, setHover] = useState({ row: 1, col: 1 });
  const pickerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭网格选择器
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [pickerOpen]);

  /** 调用 Milkdown 命令并重新聚焦编辑器 */
  const callCmd = <T,>(key: CmdKey<T>, payload?: T) => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      // 工具栏在 view.dom 之外，交互监听覆盖不到：命令前先补齐本编辑器水合，
      // 否则命令只改已挂载前缀，随后 publisher 会把截断文档发布出去（#431 评审）。
      flushActiveHydration(ctx.get(editorViewCtx));
      ctx.get(commandsCtx).call(key, payload as T);
      ctx.get(editorViewCtx).focus();
    });
  };

  /** 用 EditorView 执行块级插入/转换命令 */
  const withView = (fn: (view: EditorView) => void) => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      flushActiveHydration(view);
      fn(view);
    });
  };

  const insertTable = (row: number, col: number) => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      flushActiveHydration(view);
      // 在列表内时先退出：list_item 不允许 table 作为第一个子节点，
      // 否则 insertTableCommand 会抛 "invalid content for node list_item"
      exitListIfNeeded(view);
      const commands = ctx.get(commandsCtx);
      commands.call(insertTableCommand.key, { row, col });
      view.focus();
    });
    setPickerOpen(false);
  };

  // 删除整张表格：先全选表格再删除
  const deleteTable = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      flushActiveHydration(ctx.get(editorViewCtx));
      const commands = ctx.get(commandsCtx);
      commands.call(selectTableCommand.key);
      commands.call(deleteSelectedCellsCommand.key);
      ctx.get(editorViewCtx).focus();
    });
  };

  // 删除当前列：直接用 prosemirror-tables 的 deleteColumn
  // 无需先选中列（CellSelection），基于光标所在列位置删除
  const deleteCol = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      flushActiveHydration(view);
      deleteColumn(view.state, view.dispatch.bind(view));
      view.focus();
    });
  };

  // 删除当前行：直接用 prosemirror-tables 的 deleteRow
  // 无需先选中行（CellSelection），基于光标所在行位置删除
  const deleteRow_ = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      flushActiveHydration(view);
      deleteRow(view.state, view.dispatch.bind(view));
      view.focus();
    });
  };

  const setAlign = (a: Align) => callCmd(setAlignCommand.key, a);

  return (
    <div className="table-toolbar">
      {/* 块插入按钮组：与斜杠菜单支持的功能对应 */}
      <div className="tt-group">
        <button className="tt-btn" onClick={() => withView((v) => turnIntoHeading(v, 1))} title="标题 1">H1</button>
        <button className="tt-btn" onClick={() => withView((v) => turnIntoHeading(v, 2))} title="标题 2">H2</button>
        <button className="tt-btn" onClick={() => withView((v) => turnIntoHeading(v, 3))} title="标题 3">H3</button>
      </div>

      <span className="tt-sep" />

      <div className="tt-group">
        <button className="tt-btn" onClick={() => withView(wrapBulletList)} title="无序列表">• 列表</button>
        <button className="tt-btn" onClick={() => withView(wrapOrderedList)} title="有序列表">1. 列表</button>
        <button className="tt-btn" onClick={() => withView(wrapBlockquote)} title="引用块">❝ 引用</button>
        <button className="tt-btn" onClick={() => withView(turnIntoCodeBlock)} title="代码块">{"</>"} 代码</button>
      </div>

      <span className="tt-sep" />

      <div className="tt-group">
        <button className="tt-btn" onClick={() => withView(insertHr)} title="分割线">—</button>
        <div className="tt-group tt-has-picker">
          <button
            className="tt-btn"
            onClick={() => setPickerOpen((v) => !v)}
            title="插入表格"
          >
            <span className="tt-icon">▦</span> 表格
          </button>
          {pickerOpen && (
            <div className="table-picker" ref={pickerRef}>
              <div className="picker-grid">
                {Array.from({ length: GRID }).map((_, r) =>
                  Array.from({ length: GRID }).map((__, c) => (
                    <button
                      key={`${r}-${c}`}
                      className={`picker-cell ${r < hover.row && c < hover.col ? "active" : ""}`}
                      onMouseEnter={() => setHover({ row: r + 1, col: c + 1 })}
                      onClick={() => insertTable(r + 1, c + 1)}
                    />
                  ))
                )}
              </div>
              <div className="picker-label">
                {hover.row} 行 × {hover.col} 列
              </div>
            </div>
          )}
        </div>
        <button className="tt-btn" onClick={() => withView(insertMathBlock)} title="块级公式">∑ 公式</button>
        <button className="tt-btn" onClick={() => withView(insertInlineMath)} title="行内公式">$ 行内</button>
        <button className="tt-btn" onClick={() => withView(turnIntoMermaid)} title="Mermaid 图表">☿ Mermaid</button>
      </div>

      <span className="tt-sep" />

      <div className="tt-group">
        <button className="tt-btn" onClick={() => withView((v) => insertCallout(v, "note"))} title="提示框（注意）">! 提示框</button>
        <button className="tt-btn" onClick={() => withView(insertToc)} title="目录 [TOC]">☰ 目录</button>
        <button className="tt-btn" onClick={() => withView(insertFrontmatter)} title="YAML Front Matter">Y 元数据</button>
      </div>

      <span className="tt-sep" />

      <div className="tt-group">
        <button
          className="tt-btn tt-danger"
          // 阻止按钮抢占焦点：frontmatter 的 CodeMirror 获得焦点时，
          // deleteCurrentBlock 需要读 document.activeElement 反查所属 atom 块，
          // 若按钮抢走焦点，activeElement 会变成按钮本身，导致反查失败、误删别处。
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => withView(deleteCurrentBlock)}
          title="删除光标所在的整个块（引用/代码块/图表/提示框/元数据等）"
        >
          ✕ 删除块
        </button>
      </div>

      {inTable && (
        <>
          <span className="tt-sep" />

          <div className="tt-group">
            <button className="tt-btn" onClick={() => callCmd(addRowBeforeCommand.key)} title="在上方插入行">↕ 上行</button>
            <button className="tt-btn" onClick={() => callCmd(addRowAfterCommand.key)} title="在下方插入行">↕ 下行</button>
            <button className="tt-btn" onClick={deleteRow_} title="删除当前行">✕ 删行</button>
          </div>

          <span className="tt-sep" />

          <div className="tt-group">
            <button className="tt-btn" onClick={() => callCmd(addColBeforeCommand.key)} title="在左侧插入列">↔ 左列</button>
            <button className="tt-btn" onClick={() => callCmd(addColAfterCommand.key)} title="在右侧插入列">↔ 右列</button>
            <button className="tt-btn" onClick={deleteCol} title="删除当前列">✕ 删列</button>
          </div>

          <span className="tt-sep" />

          <div className="tt-group">
            <button className="tt-btn" onClick={() => setAlign("left")} title="左对齐">⬅</button>
            <button className="tt-btn" onClick={() => setAlign("center")} title="居中">⬌</button>
            <button className="tt-btn" onClick={() => setAlign("right")} title="右对齐">➡</button>
          </div>

          <span className="tt-sep" />

          <div className="tt-group">
            <button className="tt-btn tt-danger" onClick={deleteTable} title="删除整张表格">删除表格</button>
          </div>
        </>
      )}
    </div>
  );
}

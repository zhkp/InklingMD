// TableToolbar 组件测试
// 验证：
// 1. inTable=false 不渲染表格上下文按钮组（增删行列/对齐/删除表格）
// 2. inTable=true 渲染删行/删列按钮
// 3. 点击「删列」按钮调用 prosemirror-tables 的 deleteColumn（基于光标位置，不依赖 CellSelection）
// 4. 点击「删行」按钮调用 prosemirror-tables 的 deleteRow（基于光标位置，不依赖 CellSelection）
// 5. 点击「删除表格」按钮先 selectTableCommand 再 deleteSelectedCellsCommand
// 6. editor 不存在时按钮无操作（不抛错）
//
// 关键：v1.2.4 修复了删列/删行按钮无效问题（原依赖 CellSelection 但未先选中列），
// 改用 prosemirror-tables 的 deleteColumn/deleteRow 直接基于光标位置删除。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";
import { TableToolbar } from "../../src/components/Editor/TableToolbar";
import {
  hasActiveHydration,
  startDocHydration,
} from "../../src/components/Editor/tab-editor-cache";

// mock block-commands，避免引入完整 Milkdown 链
vi.mock("../../src/components/Editor/block-commands", () => ({
  turnIntoHeading: vi.fn(),
  wrapBulletList: vi.fn(),
  wrapOrderedList: vi.fn(),
  wrapBlockquote: vi.fn(),
  turnIntoCodeBlock: vi.fn(),
  insertHr: vi.fn(),
  insertMathBlock: vi.fn(),
  turnIntoMermaid: vi.fn(),
  insertCallout: vi.fn(),
  insertToc: vi.fn(),
  insertFrontmatter: vi.fn(),
  deleteCurrentBlock: vi.fn(),
}));

// mock @milkdown/kit/preset/gfm 的命令 key（避免引入实际 Milkdown runtime）
vi.mock("@milkdown/kit/preset/gfm", () => ({
  insertTableCommand: { key: "insertTable" },
  addRowBeforeCommand: { key: "addRowBefore" },
  addRowAfterCommand: { key: "addRowAfter" },
  addColBeforeCommand: { key: "addColBefore" },
  addColAfterCommand: { key: "addColAfter" },
  deleteSelectedCellsCommand: { key: "deleteSelectedCells" },
  setAlignCommand: { key: "setAlign" },
  selectTableCommand: { key: "selectTable" },
}));

// mock @milkdown/kit/prose/tables 的 deleteColumn / deleteRow，捕获调用
// vi.hoisted 保证 mock 工厂能访问到引用（vi.mock 会被提升到文件顶部）
const { deleteColumnMock, deleteRowMock } = vi.hoisted(() => ({
  deleteColumnMock: vi.fn(),
  deleteRowMock: vi.fn(),
}));
vi.mock("@milkdown/kit/prose/tables", () => ({
  deleteColumn: deleteColumnMock,
  deleteRow: deleteRowMock,
}));

// mock @milkdown/kit/core 的 commandsCtx / editorViewCtx 为可控引用，
// 这样 fake ctx.get 可以按引用比对，分别返回 commands 对象与 view 对象
const { commandsCtxMock, editorViewCtxMock } = vi.hoisted(() => ({
  commandsCtxMock: { __id: "commandsCtx" },
  editorViewCtxMock: { __id: "editorViewCtx" },
}));
vi.mock("@milkdown/kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@milkdown/kit/core")>();
  return {
    ...actual,
    commandsCtx: commandsCtxMock,
    editorViewCtx: editorViewCtxMock,
  };
});

// 构造假 editor：action 回调里捕获 view 引用，记录调用顺序
function makeFakeEditor(viewOverride?: unknown) {
  const view = (viewOverride ?? {
    state: { selection: { from: 0, to: 0 } },
    dispatch: vi.fn(),
    focus: vi.fn(),
  }) as {
    state: { selection: { from: number; to: number } };
    dispatch: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
  };
  const commandsCalls: string[] = [];
  const editor = {
    action: vi.fn((cb: (ctx: unknown) => void) => {
      // 注入伪 ctx：ctx.get(commandsCtx) 返回 commands，ctx.get(editorViewCtx) 返回 view
      cb({
        get: (key: unknown) => {
          if (key === commandsCtxMock) {
            // callCmd 传入的是 CmdKey<T>（即命令对象的 .key 字符串），直接记录
            return {
              call: (k: unknown) => commandsCalls.push(k as string),
            };
          }
          if (key === editorViewCtxMock) {
            return view;
          }
          return undefined;
        },
      });
    }),
  };
  return { editor, view, commandsCalls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TableToolbar", () => {
  it("inTable=false 不渲染表格上下文按钮（删行/删列/对齐/删除表格）", () => {
    const { editor } = makeFakeEditor();
    render(<TableToolbar getEditor={() => editor as any} inTable={false} />);
    expect(screen.queryByTitle("删除当前行")).toBeNull();
    expect(screen.queryByTitle("删除当前列")).toBeNull();
    expect(screen.queryByTitle("删除整张表格")).toBeNull();
  });

  it("inTable=true 渲染删行/删列/删除表格按钮", () => {
    const { editor } = makeFakeEditor();
    render(<TableToolbar getEditor={() => editor as any} inTable={true} />);
    expect(screen.getByTitle("删除当前行")).toBeInTheDocument();
    expect(screen.getByTitle("删除当前列")).toBeInTheDocument();
    expect(screen.getByTitle("删除整张表格")).toBeInTheDocument();
  });

  it("点击「删列」按钮调用 deleteColumn（基于光标位置，无需先选列）", () => {
    const { editor, view } = makeFakeEditor();
    render(<TableToolbar getEditor={() => editor as any} inTable={true} />);
    fireEvent.click(screen.getByTitle("删除当前列"));
    // deleteColumn 应被调用，第一参数是 state，第二是 dispatch
    expect(deleteColumnMock).toHaveBeenCalledTimes(1);
    expect(deleteColumnMock.mock.calls[0][0]).toBe(view.state);
    expect(typeof deleteColumnMock.mock.calls[0][1]).toBe("function");
    // 编辑器应重新聚焦
    expect(view.focus).toHaveBeenCalled();
  });

  it("点击「删行」按钮调用 deleteRow（基于光标位置，无需先选行）", () => {
    const { editor, view } = makeFakeEditor();
    render(<TableToolbar getEditor={() => editor as any} inTable={true} />);
    fireEvent.click(screen.getByTitle("删除当前行"));
    expect(deleteRowMock).toHaveBeenCalledTimes(1);
    expect(deleteRowMock.mock.calls[0][0]).toBe(view.state);
    expect(typeof deleteRowMock.mock.calls[0][1]).toBe("function");
    expect(view.focus).toHaveBeenCalled();
  });

  it("点击「删除表格」按钮先 selectTable 再 deleteSelectedCells", () => {
    const { editor, commandsCalls } = makeFakeEditor();
    render(<TableToolbar getEditor={() => editor as any} inTable={true} />);
    fireEvent.click(screen.getByTitle("删除整张表格"));
    // 顺序：先 selectTable，后 deleteSelectedCells
    expect(commandsCalls).toEqual(["selectTable", "deleteSelectedCells"]);
  });

  it("editor 不存在时点击删列按钮不抛错（无操作）", () => {
    render(
      <TableToolbar
        getEditor={() => undefined as any}
        inTable={true}
      />,
    );
    expect(() =>
      fireEvent.click(screen.getByTitle("删除当前列")),
    ).not.toThrow();
    expect(deleteColumnMock).not.toHaveBeenCalled();
  });

  it("editor 不存在时点击删行按钮不抛错（无操作）", () => {
    render(
      <TableToolbar
        getEditor={() => undefined as any}
        inTable={true}
      />,
    );
    expect(() =>
      fireEvent.click(screen.getByTitle("删除当前行")),
    ).not.toThrow();
    expect(deleteRowMock).not.toHaveBeenCalled();
  });

  it("对齐按钮调用 setAlignCommand", () => {
    const { editor, commandsCalls } = makeFakeEditor();
    render(<TableToolbar getEditor={() => editor as any} inTable={true} />);
    fireEvent.click(screen.getByTitle("居中"));
    expect(commandsCalls).toContain("setAlign");
  });

  it("增行/增列按钮调用对应命令", () => {
    const { editor, commandsCalls } = makeFakeEditor();
    render(<TableToolbar getEditor={() => editor as any} inTable={true} />);
    fireEvent.click(screen.getByTitle("在上方插入行"));
    fireEvent.click(screen.getByTitle("在下方插入行"));
    fireEvent.click(screen.getByTitle("在左侧插入列"));
    fireEvent.click(screen.getByTitle("在右侧插入列"));
    expect(commandsCalls).toEqual([
      "addRowBefore",
      "addRowAfter",
      "addColBefore",
      "addColAfter",
    ]);
  });
});

describe("TableToolbar × 分片水合（#431 评审）", () => {
  it("view 外的表格命令执行前补齐当前 view 的水合", () => {
    const schema = new Schema({
      nodes: {
        doc: { content: "block+" },
        paragraph: {
          group: "block",
          content: "text*",
          toDOM: () => ["p", 0],
          parseDOM: [{ tag: "p" }],
        },
        text: { group: "inline" },
      },
    });
    const fullDoc = schema.nodes.doc.create(
      null,
      Array.from({ length: 40 }, (_, i) =>
        schema.nodes.paragraph.create(null, schema.text(`block-${i}`)),
      ),
    );
    const root = document.createElement("div");
    document.body.append(root);
    const real = new EditorView(root, {
      state: EditorState.create({
        doc: fullDoc,
        selection: TextSelection.create(fullDoc, 1),
      }),
    });
    const task = startDocHydration({
      view: real,
      fullDoc,
      fromCache: true,
      chunkSize: 8,
    });
    expect(hasActiveHydration(real)).toBe(true);

    const { editor, commandsCalls } = makeFakeEditor(real);
    render(<TableToolbar getEditor={() => editor as never} inTable={true} />);
    fireEvent.click(screen.getByTitle("删除整张表格"));

    // 命令执行前已补齐：不会在截断文档上操作
    expect(hasActiveHydration(real)).toBe(false);
    expect(real.state.doc.childCount).toBe(40);
    expect(commandsCalls).toEqual(["selectTable", "deleteSelectedCells"]);

    task.cancel();
    real.destroy();
  });
});
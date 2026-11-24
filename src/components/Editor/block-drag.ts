// 块拖拽排序：段落/标题/列表/引用/代码块等顶层块节点左侧出现 ⋮⋮ 手柄，
// 按住手柄拖动可整块重排。基于 ProseMirror Decoration（widget 手柄）+ HTML5 DnD。
//
// 实现要点：
// - 每个顶层块节点用 Decoration.widget 在其起始位置插入一个手柄 span
// - 手柄 data-block-pos 记录块在文档中的起始位置（拖拽时读取）
// - dragstart：找到该位置所属的顶层块节点，设置 dataTransfer 携带块信息，
//   并构造该块的 DOM 副本作为拖拽预览
// - dragover：preventDefault 允许 drop，根据指针位置决定插入「之前」或「之后」，
//   用一个 drop-indicator 装饰高亮目标位置
// - drop：从源文档删除原块，在目标位置重新插入，单个 transaction 完成移动
//
// 性能：装饰集跨 transaction 用 DecorationSet.map 增量映射并缓存到 state，
// 手柄 widget 复用同一 toDOM 引用（WidgetType.eq 命中），ProseMirror 视图层
// 复用已有 DOM，避免每次按键销毁/重建全部手柄（万行文档输入掉帧主因）。

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import { hydrationMetaKey } from "./tab-editor-cache";

export const blockDragKey = new PluginKey("inkling-block-drag");

/** 创建手柄 DOM（位置由 dragstart 时 posAtDOM 反查，DOM 上不存 pos，
 *  以便所有 widget 共享同一 toDOM 引用、视图层可复用 DOM） */
function createHandle(): HTMLElement {
  const handle = document.createElement("span");
  handle.className = "inkling-block-handle";
  handle.contentEditable = "false";
  handle.draggable = true;
  handle.title = "拖拽排序";
  handle.textContent = "⋮⋮";
  return handle;
}
const handleToDOM = () => createHandle();

/** 创建 drop 指示器 DOM */
function createDropIndicator(): HTMLElement {
  const line = document.createElement("div");
  line.className = "inkling-drop-indicator";
  line.contentEditable = "false";
  return line;
}
const indicatorToDOM = () => createDropIndicator();

const handleDecoration = (pos: number) =>
  Decoration.widget(pos, handleToDOM, { side: -1, handle: true });
const indicatorDecoration = (pos: number) =>
  Decoration.widget(pos, indicatorToDOM, { side: -1, indicator: true });

/** 找到 pos 所在的顶层块节点（doc 的直接子节点） */
function topLevelBlockAt(view: EditorView, pos: number) {
  const { doc } = view.state;
  let startPos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const end = startPos + child.nodeSize;
    if (pos >= startPos && pos < end) {
      return { node: child, pos: startPos, index: i };
    }
    startPos = end;
  }
  return null;
}

/** 顶层块起始位置列表 */
function blockStarts(doc: Node): number[] {
  const starts: number[] = [];
  let pos = 0;
  doc.forEach((child) => {
    starts.push(pos);
    pos += child.nodeSize;
  });
  return starts;
}

/** 依据 doc 与 dropIndex 全量构建装饰集（仅初始化/必要时使用） */
function buildDecos(doc: Node, dropIndex: number | null): DecorationSet {
  const decos: Decoration[] = blockStarts(doc).map(handleDecoration);
  if (dropIndex != null && dropIndex >= 0 && dropIndex <= doc.childCount) {
    decos.push(indicatorDecoration(indicatorPos(doc, dropIndex)));
  }
  return DecorationSet.create(doc, decos);
}

/** dropIndex → 文档位置 */
function indicatorPos(doc: Node, dropIndex: number): number {
  const starts = blockStarts(doc);
  return dropIndex < starts.length ? starts[dropIndex] : doc.content.size;
}

interface BlockDragState {
  /** 当前拖拽中 drop 指示器的目标位置（块索引），null 表示无 */
  dropIndex: number | null;
  /** 缓存的装饰集，仅在 doc 结构或 dropIndex 变化时重建 */
  decos: DecorationSet;
  /** 缓存对应的 doc 引用，用于判断是否可复用 */
  doc: Node;
}

export const blockDragPlugin = () =>
  new Plugin({
    key: blockDragKey,
    state: {
      init: (_config, state): BlockDragState => ({
        dropIndex: null,
        decos: buildDecos(state.doc, null),
        doc: state.doc,
      }),
      apply: (tr, value, _oldState, newState): BlockDragState => {
        const hydration = tr.getMeta(hydrationMetaKey);
        if (hydration?.hydrating) {
          if (
            typeof hydration.appendFromIndex === "number" &&
            typeof hydration.appendFromPos === "number"
          ) {
            let decos = value.decos.map(tr.mapping, newState.doc);
            const adds: Decoration[] = [];
            let pos = hydration.appendFromPos;
            for (let i = hydration.appendFromIndex; i < newState.doc.childCount; i += 1) {
              adds.push(handleDecoration(pos));
              pos += newState.doc.child(i).nodeSize;
            }
            if (adds.length) decos = decos.add(newState.doc, adds);
            return { dropIndex: null, decos, doc: newState.doc };
          }
          return {
            dropIndex: null,
            decos: buildDecos(newState.doc, null),
            doc: newState.doc,
          };
        }

        const meta = tr.getMeta(blockDragKey);
        let nextDropIndex = value.dropIndex;
        if (meta && typeof meta.dropIndex === "number") {
          nextDropIndex = meta.dropIndex;
        } else if (meta && meta.clear) {
          nextDropIndex = null;
        }
        // 纯选区移动直接复用缓存
        if (newState.doc === value.doc && nextDropIndex === value.dropIndex) {
          return value;
        }

        let decos = value.decos;
        if (newState.doc !== value.doc) {
          // 增量映射：手柄 widget 实例不变，视图层复用已有 DOM
          decos = decos.map(tr.mapping, newState.doc);
          const starts = blockStarts(newState.doc);
          const startsSet = new Set(starts);
          const mappedHandles = decos.find(
            undefined,
            undefined,
            (spec) => (spec as { handle?: boolean }).handle === true,
          );
          // 结构事务（如块被包进列表/引用）会把旧手柄映射到非顶层位置，
          // 先清除这些 stale 手柄，避免重复手柄与拖拽解析到外层包裹块
          const stale = mappedHandles.filter((d) => !startsSet.has(d.from));
          if (stale.length) decos = decos.remove(stale);
          // 新增的顶层块补手柄
          const have = new Set(
            mappedHandles
              .filter((d) => startsSet.has(d.from))
              .map((d) => d.from),
          );
          const adds: Decoration[] = [];
          for (const start of starts) {
            if (!have.has(start)) adds.push(handleDecoration(start));
          }
          if (adds.length) decos = decos.add(newState.doc, adds);
        }

        // 指示器先移除旧的后按最新 doc 放置，保证位置正确
        const olds = decos.find(
          undefined,
          undefined,
          (spec) => (spec as { indicator?: boolean }).indicator === true,
        );
        if (olds.length) decos = decos.remove(olds);
        if (nextDropIndex != null) {
          decos = decos.add(newState.doc, [
            indicatorDecoration(indicatorPos(newState.doc, nextDropIndex)),
          ]);
        }

        return { dropIndex: nextDropIndex, decos, doc: newState.doc };
      },
    },
    props: {
      decorations: (state) => {
        const s = blockDragKey.getState(state) as BlockDragState;
        return s.decos;
      },
      // 手柄的拖拽事件在 handleDOMEvents 里统一处理
      handleDOMEvents: {
        dragstart: (view, event: Event) => {
          const e = event as DragEvent;
          const target = e.target as HTMLElement;
          if (!target?.classList.contains("inkling-block-handle")) return false;
          let pos: number;
          try {
            // 手柄 DOM 上不存 pos（widget DOM 会被复用），按 DOM 位置反查
            pos = view.posAtDOM(target, 0);
          } catch {
            return false;
          }
          const block = topLevelBlockAt(view, pos);
          if (!block) return false;
          // 携带块在文档中的起始位置和大小，drop 时用
          e.dataTransfer?.setData(
            "application/x-inkling-block",
            JSON.stringify({ pos: block.pos, size: block.node.nodeSize }),
          );
          // 拖拽预览：用该块的 DOM 副本
          try {
            const dom = view.nodeDOM(block.pos) as HTMLElement | null;
            if (dom && e.dataTransfer) {
              e.dataTransfer.setDragImage(dom, 0, 0);
            }
          } catch {
            // 忽略
          }
          return true;
        },
        dragover: (view, event: Event) => {
          const e = event as DragEvent;
          if (!e.dataTransfer?.types.includes("application/x-inkling-block")) {
            return false;
          }
          e.preventDefault();
          // 计算目标块索引：根据指针位置所在块及相对块中点决定前后
          const pos = view.posAtCoords({ left: e.clientX, top: e.clientY });
          if (!pos) return true;
          const block = topLevelBlockAt(view, pos.pos);
          if (!block) return true;
          let dropIndex = block.index;
          // 若指针在该块后半段，插到其后
          const blockMid = block.pos + block.node.nodeSize / 2;
          if (pos.pos > blockMid) dropIndex = block.index + 1;
          const cur = blockDragKey.getState(view.state) as BlockDragState;
          if (cur.dropIndex !== dropIndex) {
            view.dispatch(view.state.tr.setMeta(blockDragKey, { dropIndex }));
          }
          return true;
        },
        drop: (view, event: Event) => {
          const e = event as DragEvent;
          const data = e.dataTransfer?.getData("application/x-inkling-block");
          if (!data) return false;
          e.preventDefault();
          let src: { pos: number; size: number };
          try {
            src = JSON.parse(data);
          } catch {
            return false;
          }
          const cur = blockDragKey.getState(view.state) as BlockDragState;
          const dropIndex = cur.dropIndex ?? 0;

          // 计算目标位置（块索引 → 文档位置）：累加前 dropIndex 个块的大小
          let targetPos = 0;
          let idx = 0;
          view.state.doc.forEach((child) => {
            if (idx >= dropIndex) return;
            targetPos += child.nodeSize;
            idx++;
          });

          const { tr } = view.state;
          // 取出源块节点
          const srcNode = view.state.doc.nodeAt(src.pos);
          if (!srcNode) {
            view.dispatch(tr.setMeta(blockDragKey, { clear: true }));
            return true;
          }
          // 删除源块。删除会导致后续位置偏移，需重算目标位置。
          tr.delete(src.pos, src.pos + src.size);
          // 删除后目标位置修正
          let adjustedTarget = targetPos;
          if (src.pos < targetPos) adjustedTarget -= src.size;
          // 插入源块到目标位置
          tr.insert(adjustedTarget, srcNode);
          view.dispatch(tr.setMeta(blockDragKey, { clear: true }));
          return true;
        },
        dragend: (view) => {
          const cur = blockDragKey.getState(view.state) as BlockDragState;
          if (cur.dropIndex != null) {
            view.dispatch(view.state.tr.setMeta(blockDragKey, { clear: true }));
          }
          return false;
        },
      },
    },
  });

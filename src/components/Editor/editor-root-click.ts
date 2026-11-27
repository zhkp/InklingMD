// 点击编辑器空白区域（右侧 padding / 文档下方空白）时的光标定位：
// - 点击落在有效内容节点上：交给 ProseMirror 自行处理
// - 点击落在内容区之外（右侧 padding 等）：把 x 夹到编辑器内容区内再查一次
//   posAtCoords，让光标落在点击 y 对应的行附近，而不是直接跳到文档最底部
// - 点击 y 超出所有内容（真正的文档下方空白）：在末尾追加空段落并聚焦
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { flushActiveHydration } from "./tab-editor-cache";

/**
 * 该坐标是否落在尚未水合的尾部区域（需要先同步补齐全文）。
 *
 * 分片水合期间，命中已挂载前缀的点击坐标映射是准确的，不需要为一次常规点击
 * 付 O(剩余全文) 的同步插入；只有 `posAtCoords` 落空（内容区内边距/文档下方空白）
 * 或映射到已挂载文档末尾（点击已越过最后一个已挂载块）时才补齐。
 *
 * 交互捕获监听与根容器点击共用同一判据，避免两处口径漂移重造长任务（#431 评审）。
 */
export function pointerNeedsHydration(
  view: EditorView,
  left: number,
  top: number,
): boolean {
  const hit = view.posAtCoords({ left, top });
  if (!hit) return true;
  return hit.pos >= view.state.doc.content.size - 2;
}

export function placeCursorForRootClick(
  editor: Editor,
  e: React.MouseEvent<HTMLDivElement>,
) {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    // 命中已挂载内容：ProseMirror 自己会把光标放准，不补齐尾部（#431 评审）。
    if (!pointerNeedsHydration(view, e.clientX, e.clientY)) return;
    // 点击落在尚未挂载的尾部区域：先补齐这个编辑器的分片水合，坐标映射才完整。
    // 只作用于当前 view——无参 flush 会顺带把分屏另一侧的大文档同步插完，
    // 一次点击就能重建 0.6–0.8s 的长任务。
    flushActiveHydration(view);
    // 原始坐标落在可编辑内容上：交给 ProseMirror 自行处理光标定位
    const direct = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (direct != null) return;

    // 原始坐标落在内容区之外：把 x 夹到 view.dom 内再查一次
    let fallbackPos: number | null = null;
    const domRect = view.dom.getBoundingClientRect();
    if (domRect.width > 0) {
      const clampedX = Math.max(
        domRect.left + 1,
        Math.min(e.clientX, domRect.right - 1),
      );
      const hit = view.posAtCoords({ left: clampedX, top: e.clientY });
      if (hit != null) fallbackPos = hit.pos;
    }

    e.preventDefault();

    if (fallbackPos != null) {
      // 点击 y 对应到某一行：把光标放到该位置附近
      try {
        const $pos = view.state.doc.resolve(fallbackPos);
        const sel = TextSelection.near($pos);
        view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
        view.focus();
      } catch {
        // 忽略无效位置
      }
      return;
    }

    // 点击 y 超出所有内容（真正的文档下方空白）：在末尾追加空段落
    const { state } = view;
    const doc = state.doc;
    const lastChild = doc.lastChild;
    let tr = state.tr;
    let focusPos: number;
    if (!lastChild || lastChild.type.name !== "paragraph") {
      const para = state.schema.nodes.paragraph.create();
      const end = doc.content.size;
      tr = tr.insert(end, para);
      focusPos = end + 1; // 段落内容起始
    } else {
      focusPos = doc.content.size - 1; // 末尾段落内末尾
    }
    const sel = TextSelection.near(tr.doc.resolve(focusPos), -1);
    tr = tr.setSelection(sel).scrollIntoView();
    view.dispatch(tr);
    view.focus();
  });
}

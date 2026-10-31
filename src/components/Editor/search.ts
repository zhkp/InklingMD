// 查找替换插件
// 在 ProseMirror 文档中搜索匹配文本，用 Decoration 高亮，支持正则/大小写。
// 当前匹配用不同 class 标记，替换/全部替换通过 transaction 直接改文档。
// UI（SearchPanel）通过 setMeta 触发查找与导航，并通过 getState 读取结果计数。

import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";

export interface SearchOpts {
  find: string;
  caseSensitive: boolean;
  useRegex: boolean;
}

interface SearchState {
  opts: SearchOpts | null;
  matches: { from: number; to: number }[];
  current: number;
  /** 与 matches/current 同构的装饰集（issue #192：在 apply 内增量维护，
   * 因 apply 持有 tr 才能做 mapping 增量；props 直接返回） */
  deco: DecorationSet;
}

export const searchKey = new PluginKey<SearchState>("inkling-search");

type SearchMeta =
  | { type: "set"; opts: SearchOpts }
  | { type: "next" }
  | { type: "prev" }
  | { type: "clear" };

/** 根据选项构建正则，非法时返回 null */
function buildRegex(opts: SearchOpts): RegExp | null {
  if (!opts.find) return null;
  try {
    let pattern = opts.find;
    if (!opts.useRegex) {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    const flags = opts.caseSensitive ? "g" : "gi";
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** 遍历文档文本块，收集所有匹配区间 */
function computeMatches(doc: Node, regex: RegExp): { from: number; to: number }[] {
  return computeMatchesInRange(doc, regex, 0, doc.content.size);
}

/**
 * issue #371：把一个文本块内**相邻的文本节点**拼成一个 run 交给 visit。
 *
 * ProseMirror 按 mark 边界切分文本节点，`**Hello** world` 在文档里是两个节点，
 * 逐节点跑正则就搜不到视觉上连续的 `Hello world`。拼接后整段连续文字一次匹配。
 *
 * run 边界 = 非文本的行内子节点（图片、行内公式、硬换行等原子节点）：
 * 它们在视觉上把文字打断，不应被拼成一个可匹配的整体。当前 schema 里
 * 行内非文本节点都是原子；若将来出现可含文本的非原子行内节点，需改为下钻。
 * 同理，正则的 `^` / `$` 以 run 为单位：原子节点后的文字是新 run 的开头。
 *
 * 位置映射无需查表：文本节点的 nodeSize 恒等于字符数，run 内文档位置连续，
 * 故 docPos = runPos + flatIndex（runPos 为 run 首字符的文档位置）。
 */
function forEachTextRun(
  block: Node,
  blockPos: number,
  visit: (text: string, runPos: number) => void,
): void {
  let text = "";
  let runPos = -1;
  const flush = () => {
    if (runPos >= 0) visit(text, runPos);
    text = "";
    runPos = -1;
  };
  block.forEach((child, offset) => {
    if (child.isText) {
      if (runPos < 0) runPos = blockPos + 1 + offset;
      text += child.text;
    } else {
      flush();
    }
  });
  flush();
}

/** 遍历与 [from, to] 相交的文本块收集匹配（run 内可跨 mark，块级节点为匹配边界） */
function computeMatchesInRange(
  doc: Node,
  regex: RegExp,
  from: number,
  to: number,
): { from: number; to: number }[] {
  const matches: { from: number; to: number }[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    // 非文本块（引用/列表/表格/告警块等容器）继续下钻到其内部的文本块；
    // 文本块自身即匹配边界，不跨段落/标题/单元格产生匹配
    if (!node.isTextblock) return true;
    forEachTextRun(node, pos, (text, runPos) => {
      regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        if (m[0].length === 0) {
          regex.lastIndex++;
          continue;
        }
        matches.push({ from: runPos + m.index, to: runPos + m.index + m[0].length });
      }
    });
    return false;
  });
  return matches;
}

/** 由匹配集构建装饰集（current 索引用高亮类标记） */
function buildDecorations(
  doc: Node,
  matches: { from: number; to: number }[],
  current: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class: i === current ? "search-match-current" : "search-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

/**
 * issue #192：单步事务（每次按键输入的形态）的增量更新。
 * 1) 变更窗口外的旧匹配经 tr.mapping 平移到新文档位置；
 * 2) 仅对变更波及的文本块（窗口）重新搜索，局部增删匹配；
 * 3) 装饰集经 DecorationSet.map 平移后，移除窗口内旧装饰并补入新装饰。
 * 大文档连续输入不再有每键全文扫描开销。
 */
function updateIncrementally(
  value: SearchState,
  tr: Transaction,
  newState: { doc: Node },
  regex: RegExp,
): { matches: SearchState["matches"]; current: number; deco: DecorationSet } {
  // 唯一 step 的变更区间（map.forEach 给出的新坐标；单步即最终坐标）
  let newStart = Infinity;
  let newEnd = -Infinity;
  tr.mapping.maps[0].forEach((_oS, _oE, nS, nE) => {
    if (nS < newStart) newStart = nS;
    if (nE > newEnd) newEnd = nE;
  });
  if (!Number.isFinite(newStart)) {
    newStart = 0;
    newEnd = 0;
  }

  // 窗口扩展到完整覆盖变更触及的**文本块**（±1 覆盖纯插入的边界情形）。
  // issue #371 后匹配可跨同一文本块内的多个文本节点，窗口若只扩到文本节点，
  // 块内另一半的旧匹配会同时落进「窗外保留」和「窗内重扫」而重复计数。
  let windowFrom = newStart;
  let windowTo = newEnd;
  const scanFrom = Math.max(0, newStart - 1);
  const scanTo = Math.min(newState.doc.content.size, newEnd + 1);
  newState.doc.nodesBetween(scanFrom, scanTo, (node, pos) => {
    if (!node.isTextblock) return true;
    if (pos < windowFrom) windowFrom = pos;
    if (pos + node.nodeSize > windowTo) windowTo = pos + node.nodeSize;
    return false;
  });

  // 窗外：旧匹配区间经 mapping 平移保留；窗内：丢弃后重扫
  const keptBefore: { from: number; to: number }[] = [];
  const keptAfter: { from: number; to: number }[] = [];
  for (const m of value.matches) {
    const from2 = tr.mapping.map(m.from);
    const to2 = tr.mapping.map(m.to);
    // 匹配整体落入删除区间 → mapping 坍缩为空区间（from >= to），
    // 该匹配已消亡，直接丢弃；否则会留下 {n,n} 幽灵空匹配
    if (from2 >= to2) continue;
    if (to2 <= windowFrom) keptBefore.push({ from: from2, to: to2 });
    else if (from2 >= windowTo) keptAfter.push({ from: from2, to: to2 });
  }
  const windowMatches = computeMatchesInRange(newState.doc, regex, windowFrom, windowTo);
  const matches = [...keptBefore, ...windowMatches, ...keptAfter];

  // 当前匹配的目标区间（平移后）。窗口重扫会改变匹配数量，索引必须跟着**区间**走：
  // 若在当前匹配之前新增/消灭了一处，沿用旧下标会高亮到相邻的另一处命中。
  const prevCurrent = value.current >= 0 ? value.matches[value.current] : null;
  let current = value.current;
  if (prevCurrent) {
    const targetFrom = tr.mapping.map(prevCurrent.from);
    const targetTo = tr.mapping.map(prevCurrent.to);
    const at = matches.findIndex((m) => m.from === targetFrom && m.to === targetTo);
    if (at >= 0) current = at;
  }
  if (current >= matches.length) current = matches.length > 0 ? 0 : -1;

  // 当前匹配的目标区间（平移后）未变时增量修补装饰，否则全量重建
  // （当前高亮类只依附 current 区间，区间不变则窗外装饰类无需迁移）
  const newCurrent = current >= 0 ? matches[current] : null;
  let currentRangeUnchanged = false;
  if (prevCurrent && newCurrent) {
    currentRangeUnchanged =
      tr.mapping.map(prevCurrent.from) === newCurrent.from &&
      tr.mapping.map(prevCurrent.to) === newCurrent.to;
  } else if (!prevCurrent && !newCurrent) {
    currentRangeUnchanged = true;
  }

  let deco: DecorationSet;
  if (currentRangeUnchanged) {
    const mapped = value.deco.map(tr.mapping, newState.doc);
    const stale = mapped.find(windowFrom, windowTo);
    const fresh = windowMatches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class: keptBefore.length + i === current ? "search-match-current" : "search-match",
      }),
    );
    deco = mapped.remove(stale).add(newState.doc, fresh);
  } else {
    deco = buildDecorations(newState.doc, matches, current);
  }
  return { matches, current, deco };
}

export const searchPlugin = () => {
  return new Plugin<SearchState>({
    key: searchKey,
    state: {
      init: () => ({ opts: null, matches: [], current: -1, deco: DecorationSet.empty }),
      apply: (tr, value, _oldState, newState) => {
        const meta = tr.getMeta(searchKey) as SearchMeta | undefined;
        if (meta?.type === "clear") {
          return { opts: null, matches: [], current: -1, deco: DecorationSet.empty };
        }
        if (meta?.type === "set") {
          const regex = buildRegex(meta.opts);
          const matches = regex ? computeMatches(newState.doc, regex) : [];
          const current = matches.length > 0 ? 0 : -1;
          return {
            opts: meta.opts,
            matches,
            current,
            deco: buildDecorations(newState.doc, matches, current),
          };
        }
        if (meta?.type === "next") {
          const n = value.matches.length;
          if (n === 0) return value;
          const current = (value.current + 1) % n;
          return {
            ...value,
            current,
            deco: buildDecorations(newState.doc, value.matches, current),
          };
        }
        if (meta?.type === "prev") {
          const n = value.matches.length;
          if (n === 0) return value;
          const current = (value.current - 1 + n) % n;
          return {
            ...value,
            current,
            deco: buildDecorations(newState.doc, value.matches, current),
          };
        }
        // 文档变化时增量更新匹配与装饰（保持查找结果与编辑同步）。
        // issue #192：单步事务走增量路径；多步事务（如全部替换）回退全量重算
        if (tr.docChanged && value.opts) {
          const regex = buildRegex(value.opts);
          if (!regex) {
            return { ...value, matches: [], current: -1, deco: DecorationSet.empty };
          }
          if (tr.steps.length !== 1) {
            const matches = computeMatches(newState.doc, regex);
            let current = value.current;
            if (current >= matches.length) current = matches.length > 0 ? 0 : -1;
            return {
              ...value,
              matches,
              current,
              deco: buildDecorations(newState.doc, matches, current),
            };
          }
          const updated = updateIncrementally(value, tr, newState, regex);
          return { ...value, ...updated };
        }
        return value;
      },
    },
    props: {
      // 装饰集已在 state.apply 内增量维护，这里直接返回（同一实例引用稳定）
      decorations: (state) => {
        const s = searchKey.getState(state);
        return s?.deco ?? DecorationSet.empty;
      },
    },
  });
};

/** 滚动到当前匹配位置 */
export function scrollToCurrent(view: EditorView): void {
  const s = searchKey.getState(view.state);
  if (!s || s.current < 0) return;
  const m = s.matches[s.current];
  if (!m) return;
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.near(view.state.doc.resolve(m.from)))
      .scrollIntoView(),
  );
}

/**
 * 替换当前匹配；替换串为空表示删除匹配文本。
 *
 * mark 继承规则（#371）：替换串一律以**无 mark 文本**插入，`[from, to)` 之外
 * 的 mark 与文档结构不受影响（replaceWith 只作用于该区间）。
 * 即被替换掉的加粗/链接/斜体随原文一起消失，区间外的样式原样保留。
 * 跨 mark 的匹配（如 `**Hello** world` 命中 `Hello world`）同样适用：
 * 不再需要按文本节点拆分替换，一次 replaceWith 覆盖整个区间。
 */
export function replaceCurrent(view: EditorView, replacement: string): void {
  const s = searchKey.getState(view.state);
  if (!s || !s.opts || s.current < 0) return;
  const m = s.matches[s.current];
  if (!m) return;
  const tr = view.state.tr;
  // ProseMirror 禁止空文本节点，空串替换必须走 delete（#178）
  if (replacement === "") {
    tr.delete(m.from, m.to);
  } else {
    tr.replaceWith(m.from, m.to, view.state.schema.text(replacement));
  }
  view.dispatch(tr);
}

/** 替换全部匹配（从后往前，避免位置偏移）；替换串为空表示删除全部匹配文本 */
export function replaceAll(view: EditorView, replacement: string): number {
  const s = searchKey.getState(view.state);
  if (!s || !s.opts) return 0;
  const tr = view.state.tr;
  // 倒序：低位坐标不受高位替换影响，故可复用同一批 matches（不会用到过期下标）
  const sorted = [...s.matches].sort((a, b) => b.from - a.from);
  for (const m of sorted) {
    if (replacement === "") {
      tr.delete(m.from, m.to);
    } else {
      tr.replaceWith(m.from, m.to, view.state.schema.text(replacement));
    }
  }
  view.dispatch(tr);
  return sorted.length;
}

// 查找替换插件
// 在 ProseMirror 文档中搜索匹配文本，用 Decoration 高亮，支持正则/大小写。
// 当前匹配用不同 class 标记，替换/全部替换通过 transaction 直接改文档。
// UI（SearchPanel）通过 setMeta 触发查找与导航，并通过 getState 读取结果计数。

import { Plugin, PluginKey, TextSelection } from "@milkdown/kit/prose/state";
import type { Transaction } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import { expandReplacementReferences } from "../../lib/regex-replacement";

export interface SearchOpts {
  find: string;
  caseSensitive: boolean;
  useRegex: boolean;
}

interface SearchMatch {
  from: number;
  to: number;
  text: string;
  captures: (string | undefined)[];
  groups: Record<string, string | undefined>;
}

interface SearchState {
  opts: SearchOpts | null;
  matches: SearchMatch[];
  current: number;
  /** 覆盖 `decorated[i] === true` 的匹配装饰集；全部分批完成后才与
   *  matches/current 一一对应（#427）。issue #192：在 apply 内增量维护，
   *  因 apply 持有 tr 才能做 mapping 增量；props 直接返回。 */
  deco: DecorationSet;
  /** 已写入 deco 的匹配下标位图（#427 渐进高亮），长度与 matches 一致。
   *  用位图而不是「前缀已写到哪」：文档编辑触发的窗口重扫会让已装饰区间出现
   *  空洞（窗口之后、尚未补齐的匹配仍无装饰），前缀计数会把覆盖范围算错并
   *  重复写入同一区间。false 的条目由插件在后续任务中分批补入。 */
  decorated: boolean[];
}

export const searchKey = new PluginKey<SearchState>("inkling-search");

type SearchMeta =
  | { type: "set"; opts: SearchOpts }
  | { type: "next" }
  | { type: "prev" }
  | { type: "clear" }
  | { type: "decoChunk" };

/**
 * 渐进高亮每批写入的匹配数（#427）。
 *
 * 5k 行 / 1170 个匹配时，一次性 `DecorationSet.create` 会让首次写入 DOM 的
 * 任务达到 53–78ms（CDP 归因：6 个匹配时无长任务，1170 个时单次 53ms，热点是
 * 逐个 inline decoration 建立文本节点 span）。按 160 个一批分帧补齐，单任务
 * 稳定低于 Epic #387 的 50ms 上限；首批包含 current，当前命中立即可见。
 */
const DECORATION_CHUNK_SIZE = 160;

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

/** 遍历文档文本块，收集匹配区间及正则捕获信息 */
function computeMatches(doc: Node, regex: RegExp): SearchMatch[] {
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
): SearchMatch[] {
  const matches: SearchMatch[] = [];
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
        matches.push({
          from: runPos + m.index,
          to: runPos + m.index + m[0].length,
          text: m[0],
          captures: m.slice(1),
          groups: m.groups ?? {},
        });
      }
    });
    return false;
  });
  return matches;
}

/** 由匹配集构建装饰集（current 索引用高亮类标记） */
function buildDecorations(
  doc: Node,
  matches: SearchMatch[],
  current: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) => decorationFor(m, i, current)),
  );
}

function decorationFor(m: SearchMatch, index: number, current: number): Decoration {
  return Decoration.inline(m.from, m.to, {
    class: index === current ? "search-match-current" : "search-match",
  });
}

/**
 * 首次搜索只写入前一批装饰，剩余由插件调度分批补齐（#427）。
 * 首批包含 current=0，当前命中立即可见；高亮总数由搜索状态决定，不受此影响。
 */
function initialDecorations(
  doc: Node,
  matches: SearchMatch[],
): { deco: DecorationSet; decorated: boolean[] } {
  const decorated = matches.map((_, i) => i < DECORATION_CHUNK_SIZE);
  const decos = matches
    .map((m, i) => (decorated[i] ? decorationFor(m, i, 0) : null))
    .filter((d): d is Decoration => d !== null);
  return {
    deco: decos.length > 0 ? DecorationSet.create(doc, decos) : DecorationSet.empty,
    decorated,
  };
}

/**
 * 当前匹配移动时只换两个高亮类（#427）。
 *
 * 旧实现为 next/prev 重建全部 decoration：1170 个匹配时每次导航都新建 1170 个
 * Decoration 对象。装饰集本身可增量移除/追加，只需摘掉旧 current、补上新 current；
 * 尚未写入的匹配（decorated[i] === false）等分批补齐时再按当时的 current 上色。
 */
function patchCurrentDecoration(
  value: SearchState,
  doc: Node,
  nextCurrent: number,
): DecorationSet {
  if (value.current === nextCurrent) return value.deco;
  // #427 评审：find(from, to) 是「含边界相交」语义，会让 "####" 搜 "#" 这类
  // 相邻匹配互相命中；只摘除**区间完全相同**的那条，不能按区间整片删除。
  // 用区间而不是匹配下标做身份：增量编辑会平移 matches 下标，下标会失效；
  // 文档内匹配区间互不重叠，精确区间在编辑后仍唯一。
  const replaceClass = (
    deco: DecorationSet,
    m: SearchMatch,
    cls: string,
  ): DecorationSet =>
    deco
      .remove(
        deco.find(m.from, m.to).filter((d) => d.from === m.from && d.to === m.to),
      )
      .add(doc, [Decoration.inline(m.from, m.to, { class: cls })]);

  let deco = value.deco;
  const prev = value.current >= 0 ? value.matches[value.current] : null;
  if (prev && value.decorated[value.current]) {
    // 旧 current 不是「取消高亮」：它仍是普通命中，换成普通类
    deco = replaceClass(deco, prev, "search-match");
  }
  const next = nextCurrent >= 0 ? value.matches[nextCurrent] : null;
  if (next && value.decorated[nextCurrent]) {
    deco = replaceClass(deco, next, "search-match-current");
  }
  return deco;
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
): {
  matches: SearchState["matches"];
  current: number;
  deco: DecorationSet;
  decorated: boolean[];
} {
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
  const keptBefore: SearchMatch[] = [];
  const keptAfter: SearchMatch[] = [];
  const keptBeforeDecorated: boolean[] = [];
  const keptAfterDecorated: boolean[] = [];
  for (let i = 0; i < value.matches.length; i += 1) {
    const m = value.matches[i];
    const from2 = tr.mapping.map(m.from);
    const to2 = tr.mapping.map(m.to);
    // 匹配整体落入删除区间 → mapping 坍缩为空区间（from >= to），
    // 该匹配已消亡，直接丢弃；否则会留下 {n,n} 幽灵空匹配
    if (from2 >= to2) continue;
    if (to2 <= windowFrom) {
      keptBefore.push({ ...m, from: from2, to: to2 });
      keptBeforeDecorated.push(value.decorated[i] ?? false);
    } else if (from2 >= windowTo) {
      keptAfter.push({ ...m, from: from2, to: to2 });
      keptAfterDecorated.push(value.decorated[i] ?? false);
    }
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
  let decorated: boolean[];
  if (currentRangeUnchanged) {
    const mapped = value.deco.map(tr.mapping, newState.doc);
    const stale = mapped.find(windowFrom, windowTo);
    const fresh = windowMatches.map((m, i) =>
      decorationFor(m, keptBefore.length + i, current),
    );
    deco = mapped.remove(stale).add(newState.doc, fresh);
    // 窗口内重扫的匹配随 fresh 一起写入装饰（标记已装饰）；窗外匹配沿用旧位图。
    // 位图不要求是前缀：#427 分批补齐尚未写入的区间，窗口外可能仍有空洞。
    decorated = [
      ...keptBeforeDecorated,
      ...windowMatches.map(() => true),
      ...keptAfterDecorated,
    ];
  } else {
    deco = buildDecorations(newState.doc, matches, current);
    decorated = matches.map(() => true);
  }
  return { matches, current, deco, decorated };
}

export const searchPlugin = () => {
  return new Plugin<SearchState>({
    key: searchKey,
    state: {
      init: () => ({
        opts: null,
        matches: [],
        current: -1,
        deco: DecorationSet.empty,
        decorated: [],
      }),
      apply: (tr, value, _oldState, newState) => {
        const meta = tr.getMeta(searchKey) as SearchMeta | undefined;
        if (meta?.type === "clear") {
          return {
            opts: null,
            matches: [],
            current: -1,
            deco: DecorationSet.empty,
            decorated: [],
          };
        }
        if (meta?.type === "set") {
          const regex = buildRegex(meta.opts);
          const matches = regex ? computeMatches(newState.doc, regex) : [];
          const current = matches.length > 0 ? 0 : -1;
          return {
            opts: meta.opts,
            matches,
            current,
            ...initialDecorations(newState.doc, matches),
          };
        }
        if (meta?.type === "decoChunk") {
          // #427：把下一批尚未写入的匹配装饰补进 deco（不改文档、不改匹配）
          const pending: number[] = [];
          for (let i = 0; i < value.matches.length; i += 1) {
            if (value.decorated[i]) continue;
            pending.push(i);
            if (pending.length >= DECORATION_CHUNK_SIZE) break;
          }
          if (pending.length === 0) return value;
          const decorated = value.decorated.slice();
          for (const i of pending) decorated[i] = true;
          return {
            ...value,
            decorated,
            deco: value.deco.add(
              newState.doc,
              pending.map((i) => decorationFor(value.matches[i], i, value.current)),
            ),
          };
        }
        if (meta?.type === "next") {
          const n = value.matches.length;
          if (n === 0) return value;
          const current = (value.current + 1) % n;
          return {
            ...value,
            current,
            deco: patchCurrentDecoration(value, newState.doc, current),
          };
        }
        if (meta?.type === "prev") {
          const n = value.matches.length;
          if (n === 0) return value;
          const current = (value.current - 1 + n) % n;
          return {
            ...value,
            current,
            deco: patchCurrentDecoration(value, newState.doc, current),
          };
        }
        // 文档变化时增量更新匹配与装饰（保持查找结果与编辑同步）。
        // issue #192：单步事务走增量路径；多步事务（如全部替换）回退全量重算
        if (tr.docChanged && value.opts) {
          const regex = buildRegex(value.opts);
          if (!regex) {
            return {
              ...value,
              matches: [],
              current: -1,
              deco: DecorationSet.empty,
              decorated: [],
            };
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
              decorated: matches.map(() => true),
            };
          }
          const updated = updateIncrementally(value, tr, newState, regex);
          return { ...value, ...updated };
        }
        return value;
      },
    },
    view: (view) => {
      // #427：渐进高亮的分批调度。每次 update 检查是否还有未写入的匹配；
      // 有则用 0ms 定时器把补齐拆到独立任务，单任务不会重新顶出长任务。
      let chunkTimer: ReturnType<typeof setTimeout> | null = null;
      const cancelChunk = () => {
        if (chunkTimer !== null) {
          clearTimeout(chunkTimer);
          chunkTimer = null;
        }
      };
      const scheduleChunk = () => {
        if (chunkTimer !== null || view.isDestroyed) return;
        const state = searchKey.getState(view.state);
        if (!state || !state.decorated.some((done) => !done)) return;
        chunkTimer = setTimeout(() => {
          chunkTimer = null;
          if (view.isDestroyed) return;
          view.dispatch(view.state.tr.setMeta(searchKey, { type: "decoChunk" }));
        }, 0);
      };
      return {
        update: () => {
          if (view.isDestroyed) return;
          const state = searchKey.getState(view.state);
          if (state && state.decorated.some((done) => !done)) scheduleChunk();
          else cancelChunk();
        },
        destroy: cancelChunk,
      };
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

function applyReplacement(
  view: EditorView,
  tr: Transaction,
  match: SearchMatch,
  replacement: string,
  useRegex: boolean,
): void {
  const text = useRegex ? expandReplacementReferences(replacement, match) : replacement;
  // ProseMirror 禁止空文本节点，空串替换必须走 delete（#178）
  if (text === "") {
    tr.delete(match.from, match.to);
  } else {
    tr.replaceWith(match.from, match.to, view.state.schema.text(text));
  }
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
  applyReplacement(view, tr, m, replacement, s.opts.useRegex);
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
    applyReplacement(view, tr, m, replacement, s.opts.useRegex);
  }
  view.dispatch(tr);
  return sorted.length;
}

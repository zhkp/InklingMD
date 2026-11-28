// 大纲标题解析
// 从 Markdown / ProseMirror 文档中提取带层级的标题。
// 源码模式和导出共用 Markdown 解析器；普通编辑器面板读取 ProseMirror 节点。

import type { Node as ProseMirrorNode } from "@milkdown/kit/prose/model";
import { perfProbeEnd, perfProbeStart } from "./perf-probe";
import { slugify } from "./slug";

export { slugify };

export interface EditorOutlineHeading {
  /** 标题在渲染文档中的顺序 */
  index: number;
  /** 标题层级 1-6 */
  level: number;
  /** ProseMirror 渲染后的可见文本或 Markdown 纯文本 */
  text: string;
  /** 标题节点在 ProseMirror 文档中的位置或 Markdown 字符 offset */
  pos: number;
  /** Milkdown 为标题生成的节点 id（Markdown 模式下为 null） */
  nodeId: string | null;
  /** React 列表使用的唯一标识 */
  id: string;
  /** 在 Markdown 源文本中的行号（1-based，源码模式可用） */
  line?: number;
}

export interface EditorOutlineSnapshot {
  headings: EditorOutlineHeading[];
  activeIndex: number | null;
}

export const EMPTY_EDITOR_OUTLINE: EditorOutlineSnapshot = {
  headings: [],
  activeIndex: null,
};

export interface OutlineHeading {
  /** 标题层级 1-6 */
  level: number;
  /** 标题的可见文本（去除 Markdown 行内语法、# 前缀和尾部标记） */
  text: string;
  /** 在原文中的字符偏移（用于定位） */
  offset: number;
  /** 唯一 id（用于跳转匹配） */
  id: string;
}

/** 提取标题在编辑器中呈现的文字；图片节点使用 alt 作为大纲文本。 */
function getEditorHeadingText(node: ProseMirrorNode): string {
  let text = "";
  node.descendants((child) => {
    if (child.isText) {
      text += child.text ?? "";
      return false;
    }
    if (child.type.name === "image") {
      if (typeof child.attrs.alt === "string") text += child.attrs.alt;
      return false;
    }
    if (child.type.name === "hardbreak") {
      text += " ";
      return false;
    }
    return true;
  });
  return text.trim();
}

/**
 * 从 ProseMirror 文档提取渲染后的标题。
 *
 * 面板、跳转和高亮必须共用该数据源，避免 `[Foo](bar)` 等 Markdown
 * 原文与渲染文本不同，导致 slug 与重复次数错位。
 */
export function extractEditorOutline(
  doc: ProseMirrorNode,
): EditorOutlineHeading[] {
  const headings: EditorOutlineHeading[] = [];

  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;

    const text = getEditorHeadingText(node);
    if (!text) return false;

    const rawLevel = Number(node.attrs.level);
    const level =
      Number.isInteger(rawLevel) && rawLevel >= 1 && rawLevel <= 6
        ? rawLevel
        : 1;
    const nodeId =
      typeof node.attrs.id === "string" && node.attrs.id
        ? node.attrs.id
        : null;
    const index = headings.length;
    headings.push({
      index,
      level,
      text,
      pos,
      nodeId,
      id: `h-${index}-${nodeId ?? slugify(text)}`,
    });

    return false;
  });

  return headings;
}

/** 根据标题节点 id 定位；文档刚更新、id 变化时回退到渲染顺序。 */
export function findEditorHeadingPos(
  doc: ProseMirrorNode,
  target: EditorOutlineHeading,
): number | null {
  const currentNode = doc.nodeAt(target.pos);
  if (currentNode?.type.name === "heading") {
    const currentId =
      typeof currentNode.attrs.id === "string" && currentNode.attrs.id
        ? currentNode.attrs.id
        : null;
    if (
      (target.nodeId && currentId === target.nodeId) ||
      (!target.nodeId &&
        getEditorHeadingText(currentNode) === target.text &&
        Number(currentNode.attrs.level) === target.level)
    ) {
      return target.pos;
    }
  }

  const headings = extractEditorOutline(doc);
  if (target.nodeId) {
    const matched = headings.find(
      (heading) => heading.nodeId === target.nodeId,
    );
    if (matched) return matched.pos;
  }
  return headings[target.index]?.pos ?? null;
}

/**
 * 查找选区之前最近的标题序号。
 * 用二分查找定位最后一个 pos <= selectionHead 的标题，O(log n)。
 * 输入 headings 必须按 pos 升序（extractEditorOutline 自然保证）。
 */
export function findActiveHeadingIndex(
  headings: readonly EditorOutlineHeading[],
  selectionHead: number,
): number | null {
  const n = headings.length;
  if (n === 0) return null;
  // 快速短路：选区已超过最后一个标题
  if (selectionHead >= headings[n - 1].pos) return headings[n - 1].index;
  // 选区在第一个标题之前
  if (selectionHead < headings[0].pos) return null;
  // 二分：找最大的 i 使 headings[i].pos <= selectionHead
  let lo = 0;
  let hi = n - 1;
  let activeIndex = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid].pos <= selectionHead) {
      activeIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return headings[activeIndex].index;
}

/**
 * 根据当前可见行号（1-based）确定当前大纲激活项的 index。
 * 二分查找最大的 i 使 headings[i].line <= targetLine。
 */
export function findActiveMarkdownHeadingIndexByLine(
  headings: EditorOutlineHeading[],
  targetLine: number,
): number | null {
  const n = headings.length;
  if (n === 0) return null;
  const firstLine = headings[0].line ?? 1;
  if (targetLine < firstLine) return null;
  const lastLine = headings[n - 1].line ?? 1;
  if (targetLine >= lastLine) return headings[n - 1].index;

  let lo = 0;
  let hi = n - 1;
  let activeIndex = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = headings[mid].line ?? 1;
    if (line <= targetLine) {
      activeIndex = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return headings[activeIndex].index;
}


/**
 * 判断两份源码大纲的可见结构是否一致（忽略 pos/id 等派生字段）。
 *
 * 源码模式防抖重算后用它决定是否向 store 发布：结构没变时复用旧数组，
 * OutlinePanel 的 OutlineItem memo 才不会因每键新建标题对象而整表重渲染。
 */
export function isSameMarkdownOutline(
  a: readonly EditorOutlineHeading[],
  b: readonly EditorOutlineHeading[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.level !== right.level ||
      left.text !== right.text ||
      (left.line ?? 1) !== (right.line ?? 1)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 在 Markdown 源文本中寻找对应大纲标题的字符 offset。
 * 支持按 index、level、text 精确匹配，自动排除代码块与 frontmatter。
 */
export function findSourceModeHeadingOffset(
  markdown: string,
  target: EditorOutlineHeading,
): number | null {
  const headings = extractMarkdownOutline(markdown);
  if (headings.length === 0) return null;

  // 1. 尝试完全匹配 index + text + level
  if (
    target.index < headings.length &&
    headings[target.index].text === target.text &&
    headings[target.index].level === target.level
  ) {
    return headings[target.index].pos;
  }

  // 2. 若索引发生变动（例如编辑中），按 text + level 寻找匹配项
  const match = headings.find(
    (h) => h.text === target.text && h.level === target.level,
  );
  if (match) return match.pos;

  // 3. 兜底：仅按 text 匹配
  const textMatch = headings.find((h) => h.text === target.text);
  if (textMatch) return textMatch.pos;

  return null;
}

/**
 * 行内代码 / 转义字符的占位哨兵：先整体摘出、末尾还原，避免其中的 `*` / `~` / `_`
 * 被后续强调规则二次清理（`` `a*` 和 `b*` `` 不能配成一对斜体，`\*` 是字面量）。
 */
const INLINE_TEXT_SENTINEL = "\u0000";

const WHITESPACE_PATTERN = /\s/u;

/**
 * 强调的「标点」判定，必须与渲染器一致：micromark 的实现是
 * `unicodePunctuation = /\p{P}|\p{S}/u`（**含符号 `\p{S}`**，与 CommonMark 规范正文里
 * 只列 `\p{P}` 不同，micromark 自己的注释也没提符号）。
 * 因此 `a*©*b`、`a*+*b` 在 Milkdown 里不成强调、`*` 原样保留；改成纯 `\p{P}` 会与渲染口径相反。
 */
const PUNCTUATION_PATTERN = /[\p{P}\p{S}]/u;

interface DelimiterRun {
  /** 定界符字符：`*` / `_` / `~` */
  char: string;
  /** 该 run 在文本中的起始下标 */
  start: number;
  /** 该 run 的总长度 */
  length: number;
  /** 还能被消耗的长度 */
  remaining: number;
  /** 已作为开定界符消耗的长度（从 run 末尾往左吃） */
  openUsed: number;
  /** 已作为闭定界符消耗的长度（从 run 头部往右吃） */
  closeUsed: number;
  canOpen: boolean;
  canClose: boolean;
}

function isWhitespaceChar(ch: string | undefined): boolean {
  return ch === undefined || WHITESPACE_PATTERN.test(ch);
}

function isPunctuationChar(ch: string | undefined): boolean {
  return ch !== undefined && PUNCTUATION_PATTERN.test(ch);
}

/**
 * 扫描同名定界符串（run）的长度。
 */
function countRun(raw: string, start: number, char: string): number {
  let end = start;
  while (end < raw.length && raw[end] === char) end += 1;
  return end - start;
}

/**
 * 扫描强调/删除线定界符串，按 CommonMark 的 left/right-flanking 规则判定能否开/闭。
 *
 * 定界符串不完整（`2 ** 3 ** 4`）、两侧有空白（`2 * 3 * 4 = 24`、`A ~~ x ~~ B`）
 * 或词内下划线（`foo_bar_baz`）都不构成「可配对」的定界符，字符必须原样保留。
 *
 * 另需跟随 `micromark-core-commonmark` 的 attentionMarkers 规则（GFM 把 `~` 注册进
 * attentionMarkers）：`*` 紧邻 `~` 时可以无条件开/闭，`a*~~b~~*c` 才渲染成斜体套删除线。
 */
function collectDelimiterRuns(raw: string): DelimiterRun[] {
  const runs: DelimiterRun[] = [];
  let i = 0;
  while (i < raw.length) {
    const char = raw[i];
    if (char !== "*" && char !== "_" && char !== "~") {
      i += 1;
      continue;
    }
    const length = countRun(raw, i, char);
    const end = i + length;
    const before = i > 0 ? raw[i - 1] : undefined;
    const after = end < raw.length ? raw[end] : undefined;
    const leftFlanking =
      !isWhitespaceChar(after) &&
      (!isPunctuationChar(after) || isWhitespaceChar(before) || isPunctuationChar(before));
    const rightFlanking =
      !isWhitespaceChar(before) &&
      (!isPunctuationChar(before) || isWhitespaceChar(after) || isPunctuationChar(after));
    const openFlanking = leftFlanking || after === "~";
    const closeFlanking = rightFlanking || before === "~";
    // GFM 删除线只认 1~2 个波浪线，3 个及以上按字面量处理
    const supported = char !== "~" || length <= 2;
    if (supported) {
      const canOpen =
        char === "_"
          ? openFlanking && (!rightFlanking || isPunctuationChar(before))
          : openFlanking;
      const canClose =
        char === "_"
          ? closeFlanking && (!leftFlanking || isPunctuationChar(after))
          : closeFlanking;
      if (canOpen || canClose) {
        runs.push({
          char,
          start: i,
          length,
          remaining: length,
          openUsed: 0,
          closeUsed: 0,
          canOpen,
          canClose,
        });
      }
    }
    i = end;
  }
  return runs;
}

/**
 * 判断这对开/闭定界符串是否必须跳过（继续向更早的开串回溯），按渲染器的两条规则：
 *
 * - CommonMark「rule of three」：可开可闭的串参与配对，且两者剩余长度之和是 3 的倍数、
 *   闭串长度不是 3 的倍数时不成对（`**a*b**` 的 `*b*` 只能当字面量）；
 * - GFM 删除线：开、闭定界符串长度必须完全相等，`~a~~` 这类不等的按字面量保留。
 */
function shouldSkipPair(opener: DelimiterRun, closer: DelimiterRun): boolean {
  if (closer.char === "~" && opener.length !== closer.length) return true;
  if (!opener.canClose && !closer.canOpen) return false;
  if (closer.remaining % 3 === 0) return false;
  return (opener.remaining + closer.remaining) % 3 === 0;
}

/**
 * 摘掉强调/删除线的定界符，只保留可见文本。
 *
 * 按定界符串（delimiter run）配对：闭合优先、就近匹配开定界符，每次只消费 run 的一部分
 * ——这样 `**bold *italic***` 里共享的三连星号也能按「内层先闭合、剩余交给外层」正确拆开。
 */
function stripEmphasisDelimiters(raw: string): string {
  const runs = collectDelimiterRuns(raw);
  if (runs.length === 0) return raw;

  const removed = new Array<boolean>(raw.length).fill(false);
  const openers: Record<string, number[]> = { "*": [], "_": [], "~": [] };

  runs.forEach((run, index) => {
    if (run.canClose) {
      const stack = openers[run.char];
      let cursor = stack.length - 1;
      while (run.remaining > 0 && cursor >= 0) {
        const opener = runs[stack[cursor]];
        if (shouldSkipPair(opener, run)) {
          // 换更早的开串：被跳过的保留在栈里，可能配给别的闭串
          cursor -= 1;
          continue;
        }
        // 两侧都够 2 个按粗体/删除线消费，否则按斜体消费
        const use = opener.remaining >= 2 && run.remaining >= 2 ? 2 : 1;
        for (let k = 0; k < use; k += 1) {
          removed[opener.start + opener.length - opener.openUsed - k - 1] = true;
          removed[run.start + run.closeUsed + k] = true;
        }
        opener.openUsed += use;
        run.closeUsed += use;
        opener.remaining -= use;
        run.remaining -= use;
        if (opener.remaining <= 0) {
          stack.splice(cursor, 1);
          cursor -= 1;
        }
      }
    }
    if (run.canOpen && run.remaining > 0) openers[run.char].push(index);
  });

  let stripped = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (!removed[i]) stripped += raw[i];
  }
  return stripped;
}

/**
 * 摘出行内代码段：定界符必须是等长的反引号串（`` ``a*b`` `` 用两个反引号），
 * 内容按 CommonMark 规则「首尾各有一个空格时各去掉一个」后按字面量保留。
 */
function protectInlineCode(raw: string, protect: (value: string) => string): string {
  let result = "";
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "`") {
      result += raw[index];
      index += 1;
      continue;
    }
    const fenceLength = countRun(raw, index, "`");
    const contentStart = index + fenceLength;

    let search = contentStart;
    let closeStart = -1;
    while (search < raw.length) {
      if (raw[search] === "`") {
        const run = countRun(raw, search, "`");
        if (run === fenceLength) {
          closeStart = search;
          break;
        }
        search += run;
        continue;
      }
      search += 1;
    }

    if (closeStart < 0) {
      // 没有等长闭合串：反引号按字面量保留
      result += raw.slice(index, contentStart);
      index = contentStart;
      continue;
    }

    let content = raw.slice(contentStart, closeStart);
    if (
      content.length > 1 &&
      content.startsWith(" ") &&
      content.endsWith(" ") &&
      content.trim() !== ""
    ) {
      content = content.slice(1, -1);
    }
    result += protect(content);
    index = closeStart + fenceLength;
  }
  return result;
}

/**
 * 从 `open` 位置起找配对的结束定界符，支持嵌套（链接文本里再嵌图片时 `[...]` 会嵌套）。
 */
function findMatchingPair(raw: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = open; i < raw.length; i += 1) {
    if (raw[i] === openChar) {
      depth += 1;
    } else if (raw[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 找到行内链接目标地址的收尾 `)`：目标可以是 `<...>`、可含成对括号的裸地址，
 * 后面还可跟 `"title"` / `'title'` / `(title)`。
 */
function findInlineDestinationEnd(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && isWhitespaceChar(raw[index])) index += 1;

  if (raw[index] === "<") {
    const closeAngle = raw.indexOf(">", index + 1);
    if (closeAngle < 0) return -1;
    index = closeAngle + 1;
  } else {
    let depth = 0;
    while (index < raw.length) {
      const char = raw[index];
      if (isWhitespaceChar(char)) break;
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        if (depth === 0) return index;
        depth -= 1;
      }
      index += 1;
    }
  }

  while (index < raw.length && isWhitespaceChar(raw[index])) index += 1;
  if (raw[index] === ")") return index;

  const quote = raw[index];
  if (quote !== '"' && quote !== "'" && quote !== "(") return -1;
  const closeQuote = raw.indexOf(quote === "(" ? ")" : quote, index + 1);
  if (closeQuote < 0) return -1;
  index = closeQuote + 1;
  while (index < raw.length && isWhitespaceChar(raw[index])) index += 1;
  return raw[index] === ")" ? index : -1;
}

/**
 * 摘掉链接/图片语法，只留可见文本。目标地址按 Markdown 语法扫描（不是 `[^)]*`），
 * 否则 `[guide](https://example.com/path_(part))` 会在内层 `)` 处截断、多留一个 `)`。
 */
function stripLinkSyntax(raw: string): string {
  let result = "";
  let index = 0;
  while (index < raw.length) {
    if (raw[index] !== "[") {
      result += raw[index];
      index += 1;
      continue;
    }
    const textEnd = findMatchingPair(raw, index, "[", "]");
    const destEnd =
      textEnd >= 0 && raw[textEnd + 1] === "(" ? findInlineDestinationEnd(raw, textEnd + 2) : -1;
    if (textEnd < 0 || destEnd < 0) {
      // 不是完整的行内链接/图片：方括号按字面量保留
      result += raw[index];
      index += 1;
      continue;
    }
    const isImage = index > 0 && raw[index - 1] === "!" && result.endsWith("!");
    if (isImage) result = result.slice(0, -1);
    // 链接文本里可能还有语法（`[![alt](img.png)](url)`），递归清洗
    result += stripLinkSyntax(raw.slice(index + 1, textEnd));
    index = destEnd + 1;
  }
  return result;
}

/**
 * 保留纯文本，与富文本 ProseMirror 渲染的标题文本一致。
 */
function cleanMarkdownText(raw: string): string {
  const placeholders: string[] = [];
  const protect = (value: string): string => {
    placeholders.push(value);
    return `${INLINE_TEXT_SENTINEL}${placeholders.length - 1}${INLINE_TEXT_SENTINEL}`;
  };

  // 先摘出行内代码（内容按字面量渲染），再摘转义字符，最后才处理链接/图片，
  // 这样 `\*`、`\[`、代码里的 `[a](b)` 都不会被当成语法。
  const withoutProtected = stripLinkSyntax(
    protectInlineCode(raw, protect).replace(
      /\\([\\`*_{}[\]()#+\-.!~>|])/g,
      (_match, ch: string) => protect(ch), // 转义 -> 字面量
    ),
  );

  const cleaned = stripEmphasisDelimiters(withoutProtected)
    .replace(/\s+/g, " ") // 合并多余空格
    .trim();

  // 占位符不是空白字符，所以还原后要再 trim 一次：内容只有空白的标题不算可见标题。
  return cleaned
    .replace(
      new RegExp(`${INLINE_TEXT_SENTINEL}(\\d+)${INLINE_TEXT_SENTINEL}`, "g"),
      (_match, index: string) => placeholders[Number(index)],
    )
    .trim();
}

/**
 * frontmatter 最大扫描行数上限（防止用户首行写了 `---` 却未闭合时导致整篇文档所有标题被吞）。
 * 真实 YAML frontmatter 通常远小于 100 行。
 */
export const MAX_FRONTMATTER_SCAN_LINES = 100;

interface ParsedMarkdownHeading {
  level: number;
  text: string;
  offset: number;
  line: number;
}

/**
 * Markdown 源码大纲的唯一解析入口，统一 frontmatter、围栏和标题文本口径。
 * 返回干净的可见文本，供源码侧栏与导出大纲共同使用。
 */
function parseMarkdownHeadings(markdown: string): ParsedMarkdownHeading[] {
  const headings: ParsedMarkdownHeading[] = [];
  const lines = markdown.split("\n");
  let offset = 0;
  let inFence: string | null = null;
  let inFrontmatter = false;
  let frontmatterStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // 文档首部 frontmatter 区域检测
    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      frontmatterStartLine = 0;
      offset += line.length + 1;
      continue;
    }
    if (inFrontmatter) {
      if (trimmed === "---" || trimmed === "...") {
        inFrontmatter = false;
        offset += line.length + 1;
        continue;
      }
      if (i - frontmatterStartLine <= MAX_FRONTMATTER_SCAN_LINES) {
        offset += line.length + 1;
        continue;
      }

      // 未闭合 frontmatter 超限时，当前行按普通 Markdown 继续解析。
      inFrontmatter = false;
    }

    // 围栏代码块检测
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      if (inFence === null) {
        inFence = fence[0].repeat(fence.length);
      } else if (fence[0] === inFence[0] && fence.length >= inFence.length) {
        inFence = null;
      }
      offset += line.length + 1;
      continue;
    }

    if (inFence === null) {
      const match = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (match) {
        const text = cleanMarkdownText(match[2].trim());
        if (text) {
          headings.push({
            level: match[1].length,
            text,
            offset,
            line: i + 1,
          });
        }
      }
    }

    offset += line.length + 1;
  }

  return headings;
}

/**
 * 从 Markdown 文本中提取大纲条目（包含 offset、行号 line 等元数据）
 * 供源码模式（Source Mode）下的 OutlinePanel 渲染及同步。
 */
export function extractMarkdownOutline(
  markdown: string,
): EditorOutlineHeading[] {
  const probeStart = perfProbeStart();
  const headings = parseMarkdownHeadings(markdown).map((heading, index) => ({
    index,
    level: heading.level,
    text: heading.text,
    pos: heading.offset,
    nodeId: null,
    id: `h-${index}-${slugify(heading.text)}`,
    line: heading.line,
  }));
  perfProbeEnd("outlineExtract", probeStart);
  return headings;
}

/**
 * 适配为导出使用的偏移字段，解析规则和可见文本与源码侧栏保持一致。
 */
export function parseOutline(markdown: string): OutlineHeading[] {
  return parseMarkdownHeadings(markdown).map((heading, index) => ({
    level: heading.level,
    text: heading.text,
    offset: heading.offset,
    id: `h-${index}-${slugify(heading.text)}`,
  }));
}

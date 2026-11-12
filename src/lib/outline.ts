// 大纲标题解析
// 从 markdown 文本中解析标题，生成带层级的树结构。
// Markdown 源文本解析用于导出；编辑器面板使用 ProseMirror 渲染节点。

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
  /** 标题文本（去除 # 前缀和尾部标记） */
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

// 保留纯文本，与富文本 ProseMirror 渲染的标题文本一致。
function cleanMarkdownText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片 -> alt 文本
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接 -> 链接文本
    .replace(/`([^`]+)`/g, "$1") // 行内代码 -> 代码内容
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // 粗体 -> 内容
    .replace(/(\*|_)(.*?)\1/g, "$2") // 斜体 -> 内容
    .replace(/~~(.*?)~~/g, "$1") // 删除线 -> 内容
    .replace(/\s+/g, " ") // 合并多余空格
    .trim();
}

/**
 * frontmatter 最大扫描行数上限（防止用户首行写了 `---` 却未闭合时导致整篇文档所有标题被吞）。
 * 真实 YAML frontmatter 通常远小于 100 行。
 */
export const MAX_FRONTMATTER_SCAN_LINES = 100;

/**
 * 从 Markdown 文本中提取大纲条目（包含 offset、行号 line 等元数据）
 * 供源码模式（Source Mode）下的 OutlinePanel 渲染及同步。
 */
export function extractMarkdownOutline(
  markdown: string,
): EditorOutlineHeading[] {
  const probeStart = perfProbeStart();
  const headings: EditorOutlineHeading[] = [];
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
      } else if (i - frontmatterStartLine > MAX_FRONTMATTER_SCAN_LINES) {
        // 超出合理行数上限视作未闭合 frontmatter，退出 frontmatter 状态回退为普通文本
        inFrontmatter = false;
      }
      offset += line.length + 1;
      continue;
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
      const m = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) {
        const level = m[1].length;
        const rawContent = m[2].trim();
        const text = cleanMarkdownText(rawContent);
        if (text) {
          const index = headings.length;
          headings.push({
            index,
            level,
            text,
            pos: offset,
            nodeId: null,
            id: `h-${index}-${slugify(text)}`,
            line: i + 1,
          });
        }
      }
    }

    offset += line.length + 1;
  }

  perfProbeEnd("outlineExtract", probeStart);
  return headings;
}

/**
 * 解析 markdown 文本中的标题。
 * - 支持 ATX 风格 # ~ ######
 * - 跳过代码块内的 # 行（用 ``` 和 ~~~ 围栏判断）
 * - 跳过空标题（# 后无内容）
 * - setext 风格（下划 === / ---）暂不支持，保持简单
 */
export function parseOutline(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const lines = markdown.split("\n");
  let offset = 0;
  let inFence: string | null = null; // 当前围栏标记（``` 或 ~~~）
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
      } else if (i - frontmatterStartLine > MAX_FRONTMATTER_SCAN_LINES) {
        // 超出合理行数上限视作未闭合 frontmatter，退出 frontmatter 状态回退为普通文本
        inFrontmatter = false;
      }
      offset += line.length + 1;
      continue;
    }

    // 围栏代码块开闭检测
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
      const m = trimmed.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) {
        const level = m[1].length;
        const text = m[2].trim();
        if (text) {
          headings.push({
            level,
            text,
            offset,
            id: `h-${headings.length}-${slugify(text)}`,
          });
        }
      }
    }

    offset += line.length + 1; // +1 for \n
  }

  return headings;
}

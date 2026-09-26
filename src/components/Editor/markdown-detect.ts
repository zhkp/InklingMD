// Markdown 源码特征判定（Smart Paste，#229）
//
// 用于区分剪贴板纯文本是「Markdown 源码」（从 VS Code / GitHub / 另一份 .md 复制）
// 还是「无 Markdown 语义的普通文本」。判定标准：命中 **至少 2 类独立信号** 才认定为
// Markdown；只命中一类（如几行 `- ` 开头的文字、一个 `**`）按普通文本处理，宁可
// 漏判也不误判——误判会把用户的纯文本悄悄改写成富文本结构。

export type MarkdownSignal =
  | "heading"
  | "fence"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "blockquote"
  | "table"
  | "hr"
  | "mathBlock"
  | "bold"
  | "strike"
  | "inlineCode"
  | "link"
  | "image";

/** 判定所需的最少独立信号数 */
export const MIN_MARKDOWN_SIGNALS = 2;

/**
 * 只扫描开头这么多字符（UTF-16 码元数）：信号判定不需要读完超大文本。
 * smart-paste 也以它作为 Markdown 解析的长度上限（主线程保护）。
 */
export const SCAN_LIMIT = 64 * 1024;

const SIGNAL_PATTERNS: [MarkdownSignal, RegExp][] = [
  ["heading", /^ {0,3}#{1,6}[ \t]+\S/m],
  ["fence", /^ {0,3}(?:`{3,}|~{3,})[^\n`]*$/m],
  // 任务列表单独成类，避免一行 `- [ ] x` 同时计入无序列表凑成两个信号
  // 同理排除 `* * *` 这类分隔线
  ["bulletList", /^ {0,3}[-*+][ \t]+(?!\[[ xX]\][ \t])(?!(?:[-*_][ \t]*)+$)\S/m],
  ["taskList", /^ {0,3}[-*+][ \t]+\[[ xX]\][ \t]+\S/m],
  ["orderedList", /^ {0,3}\d{1,9}[.)][ \t]+\S/m],
  ["blockquote", /^ {0,3}>[ \t]?\S/m],
  // 表格必须有分隔行（`| --- | :-: |`），单独的竖线行不算
  ["table", /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$|^ {0,3}\|[ \t]*:?-+:?[ \t]*\|[ \t]*$/m],
  ["hr", /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/m],
  ["mathBlock", /^ {0,3}\$\$[ \t]*$/m],
  ["bold", /(\*\*|__)(?=\S)[^\n]*?\S\1/],
  ["strike", /~~(?=\S)[^\n]*?\S~~/],
  ["inlineCode", /`[^`\n]+`/],
  // 图片的 `[alt](src)` 部分不能再算一次链接
  ["link", /(?:^|[^!\]])\[[^\]\n]+\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/],
  ["image", /!\[[^\]\n]*\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/],
];

/** 返回文本命中的全部信号类别 */
export function detectMarkdownSignals(text: string): Set<MarkdownSignal> {
  const sample = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
  const normalized = sample.replace(/\r\n?/g, "\n");
  const hits = new Set<MarkdownSignal>();
  for (const [signal, re] of SIGNAL_PATTERNS) {
    if (re.test(normalized)) hits.add(signal);
  }
  return hits;
}

/** 是否「看起来像 Markdown 源码」：至少 2 类独立信号 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim()) return false;
  return detectMarkdownSignals(text).size >= MIN_MARKDOWN_SIGNALS;
}

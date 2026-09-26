// HTML → Markdown 结构转换（Smart Paste，#219）
//
// 输入必须是已经过 sanitizeHTML(..., { mode: "paste" }) 清洗的 DOM——本模块只做
// 「结构映射」，不做任何安全判断（清洗必须在映射之前，见 smart-paste.ts）。
// 纯函数、只读 DOM，可对 fixture 做「输入 HTML → 期望 Markdown」快照测试。
//
// 输出是**中间态** Markdown 文本：随后交给与「粘贴 Markdown 源码」（#229）同一条
// 解析链路转成 ProseMirror Slice，最终写盘的 Markdown 由 Milkdown serializer 重新
// 生成。因此这里的转义宁多勿少（`\_` 与 `_` 解析结果相同，不会泄漏到文件里）。
//
// 降级规则（#219）：
// - colspan/rowspan > 1：降级为普通单元格，合并信息丢弃（GFM 表格不支持合并）
// - 嵌套列表 > 6 层：截断——更深的列表项提升为第 6 层的兄弟项（内容不丢）
// - 无语言标识的 <pre>：无语言围栏；code/pre 的 language-x / lang-x class 做语言识别
// - 相对链接：保留原样，不做补全
// - 无法映射的块级容器：递归取子节点
// - 布局表格（单元格内嵌表格/标题/列表/代码块，或仅一个单元格）：不转 GFM 表格，按块展开

/** 嵌套列表最大层数，超出部分提升为该层兄弟项 */
export const MAX_LIST_DEPTH = 6;

const BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
  "pre", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr", "details", "summary",
]);
const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).join(",");
/** 单元格内出现这些结构即判定为布局表格 */
const LAYOUT_TABLE_SELECTOR = "table,h1,h2,h3,h4,h5,h6,ul,ol,pre,blockquote,hr";

// 行内构建期用私有区字符做占位，最终按实际左右邻居决定如何落成 Markdown：
// - BR：硬换行（单个）或段落分隔（连续两个及以上）
// - 强调定界符：先占位，等拿到真实邻居字符后再处理 CommonMark 的 flanking 规则
const BR = "\uE000";
const STRONG_OPEN = "\uE001";
const STRONG_CLOSE = "\uE002";
const EM_OPEN = "\uE003";
const EM_CLOSE = "\uE004";
const DEL_OPEN = "\uE005";
const DEL_CLOSE = "\uE006";
const DELIMS: Record<string, { md: string; open: boolean }> = {
  [STRONG_OPEN]: { md: "**", open: true },
  [STRONG_CLOSE]: { md: "**", open: false },
  [EM_OPEN]: { md: "*", open: true },
  [EM_CLOSE]: { md: "*", open: false },
  [DEL_OPEN]: { md: "~~", open: true },
  [DEL_CLOSE]: { md: "~~", open: false },
};
const SENTINEL_RE = /[\uE000-\uE006]/g;

/**
 * 粘贴内容本身也可能含这些码位（图标字体、Nerd Fonts 等把图标放在私有区）。
 * 所有来自页面的字符串进入行内构建之前都要先「去哨兵化」，否则会被当成占位符：
 * `前\uE001后` 会变成 `前**后`、`前\uE000后` 会变成硬换行。
 * - 文本、alt、title、链接地址：编码为字符引用 `&#xE001;`，Markdown 解析后还原为原字符
 * - 行内代码：CommonMark 不解码代码 span 内的字符引用，只能替换为 U+FFFD
 * （代码块不经过行内构建，原样保留，无需处理）
 */
function encodeSentinels(text: string): string {
  return text.replace(SENTINEL_RE, (c) => `&#x${c.codePointAt(0)!.toString(16).toUpperCase()};`);
}

interface InlineCtx {
  strong: boolean;
  em: boolean;
  del: boolean;
  link: boolean;
  /** 表格单元格内：代码 span 内的 `|` 也必须转义，否则会被当成列分隔 */
  inTable: boolean;
}

const ROOT_INLINE: InlineCtx = { strong: false, em: false, del: false, link: false, inTable: false };

interface BlockCtx {
  /** 当前列表嵌套层数（列表外为 0） */
  listDepth: number;
  /** 超过最大层数的嵌套列表项收集到这里，由外层作为兄弟项输出 */
  overflow?: ListItemMd[];
}

interface ListItemMd {
  blocks: string[];
  /** null：普通列表项；true/false：任务列表勾选态 */
  task: boolean | null;
}

function tagOf(node: Node): string {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName.toLowerCase() : "";
}

function isBlockElement(node: Node): boolean {
  return BLOCK_TAGS.has(tagOf(node));
}

/** 行内元素内部嵌了块级元素（如 Google Docs 用 <b> 包住整篇）时按块容器处理 */
function containsBlock(el: Element): boolean {
  return el.querySelector(BLOCK_SELECTOR) !== null;
}

function styleOf(el: Element): string {
  return (el.getAttribute("style") ?? "").toLowerCase();
}

function styleValue(style: string, prop: string): string | null {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(style);
  return m ? m[1].trim() : null;
}

function isBoldWeight(v: string | null): boolean {
  if (!v) return false;
  if (v === "bold" || v === "bolder") return true;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 600;
}

function isNormalWeight(v: string | null): boolean {
  if (!v) return false;
  if (v === "normal" || v === "lighter") return true;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n < 600;
}

// ---------------------------------------------------------------------------
// 文本转义
// ---------------------------------------------------------------------------

/** 行内任意位置都可能被解析成语法的字符（CommonMark 允许反斜杠转义任意 ASCII 标点） */
function escapeInlineText(text: string): string {
  return text.replace(/[\\`*_[\]<~$|&]/g, "\\$&");
}

/** 行首才有语义的字符：标题、引用、列表、setext 下划线 */
function escapeLineStart(line: string): string {
  if (/^[#>+=-]/.test(line)) return `\\${line}`;
  return line.replace(/^(\d{1,9})([.)])/, "$1\\$2");
}

/** 空白折叠（按 HTML 渲染语义），不间断空格归一为普通空格 */
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f\u00A0]+/g, " ");
}

function formatDestination(url: string): string {
  const safe = encodeSentinels(url.replace(/[<>\n\r]/g, (c) => encodeURIComponent(c)));
  return /[\s()\\]/.test(safe) ? `<${safe}>` : safe;
}

function formatTitle(title: string | null): string {
  const t = title?.trim();
  if (!t) return "";
  return ` "${encodeSentinels(t.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " "))}"`;
}

function codeSpan(raw: string, inTable: boolean): string {
  let text = collapseWhitespace(raw).replace(SENTINEL_RE, "\uFFFD");
  if (!text.trim()) return "";
  if (inTable) text = text.replace(/\|/g, "\\|");
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

// ---------------------------------------------------------------------------
// 行内转换
// ---------------------------------------------------------------------------

/** 用占位定界符包裹：首尾空白移到定界符外（`** x**` 不是合法强调） */
function wrap(inner: string, open: string, close: string): string {
  const m = /^([ \uE000]*)([\s\S]*?)([ \uE000]*)$/.exec(inner);
  if (!m || !m[2].replace(SENTINEL_RE, "").trim()) return inner;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function inlineChildren(el: Node, ctx: InlineCtx): string {
  let out = "";
  el.childNodes.forEach((child) => {
    out += inlineOf(child, ctx);
  });
  return out;
}

function inlineOf(node: Node, ctx: InlineCtx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return encodeSentinels(escapeInlineText(collapseWhitespace(node.textContent ?? "")));
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = tagOf(el);
  switch (tag) {
    case "br":
      return BR;
    case "img": {
      const src = el.getAttribute("src");
      if (!src) return "";
      const alt = encodeSentinels(
        collapseWhitespace(el.getAttribute("alt") ?? "").trim().replace(/[\\[\]]/g, "\\$&"),
      );
      return `![${alt}](${formatDestination(src)}${formatTitle(el.getAttribute("title"))})`;
    }
    case "input":
      // 任务列表复选框由列表项处理；其余位置无 Markdown 语义
      return "";
    case "code":
    case "kbd":
    case "samp":
    case "tt":
      return codeSpan(el.textContent ?? "", ctx.inTable);
    case "a": {
      const inner = inlineChildren(el, { ...ctx, link: true });
      const href = el.getAttribute("href");
      if (ctx.link || !href) return inner;
      // 无可见内容的锚点（GitHub 标题旁的 permalink 图标）直接丢弃
      if (!inner.replace(SENTINEL_RE, "").trim()) return "";
      const m = /^([ \uE000]*)([\s\S]*?)([ \uE000]*)$/.exec(inner)!;
      return `${m[1]}[${m[2]}](${formatDestination(href)}${formatTitle(el.getAttribute("title"))})${m[3]}`;
    }
    default:
      break;
  }

  // 强调类：语义标签 + 内联样式（Google Docs / Word 用 span style 表达加粗斜体）
  const style = styleOf(el);
  const weight = styleValue(style, "font-weight");
  const fontStyle = styleValue(style, "font-style");
  const decoration = styleValue(style, "text-decoration") ?? "";
  let strong = (tag === "b" || tag === "strong") && !isNormalWeight(weight);
  strong ||= isBoldWeight(weight);
  let em = tag === "i" || tag === "em" || (fontStyle !== null && /italic|oblique/.test(fontStyle));
  let del = tag === "s" || tag === "del" || tag === "strike" || decoration.includes("line-through");
  strong &&= !ctx.strong;
  em &&= !ctx.em;
  del &&= !ctx.del;

  let inner = inlineChildren(el, {
    ...ctx,
    strong: ctx.strong || strong,
    em: ctx.em || em,
    del: ctx.del || del,
  });
  if (del) inner = wrap(inner, DEL_OPEN, DEL_CLOSE);
  if (em) inner = wrap(inner, EM_OPEN, EM_CLOSE);
  if (strong) inner = wrap(inner, STRONG_OPEN, STRONG_CLOSE);
  // 块级元素被压成单行时（表格单元格、标题）以空格分隔
  if (isBlockElement(el)) return ` ${inner} `;
  return inner;
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
const SPACE_RE = /\s/u;

function charClass(ch: string | undefined): "space" | "punct" | "other" {
  if (ch === undefined || SPACE_RE.test(ch)) return "space";
  return PUNCT_RE.test(ch) ? "punct" : "other";
}

function charRef(ch: string): string {
  return `&#x${ch.codePointAt(0)!.toString(16).toUpperCase()};`;
}

/**
 * 把占位定界符落成 Markdown，并修正 CommonMark flanking 规则导致的失效：
 * 例如 `<b>注意：</b>这是` → `**注意：**这是` 中收尾 `**` 前是标点、后是文字，
 * 不构成 right-flanking，会被当成字面星号。做法与 mdast-util-to-markdown 相同：
 * 把定界符外侧紧邻的那个字符编码为字符引用（`&#x8FD9;`），渲染结果不变但定界符生效。
 */
function resolveDelimiters(line: string): string {
  // 相邻同类强调合并（`<b>a</b><b>b</b>`、Word 碎片化的 span）：
  // 否则会生成 `**a****b**`，四连星号受「3 的倍数规则」约束无法配对
  const merged = line
    .replaceAll(STRONG_CLOSE + STRONG_OPEN, "")
    .replaceAll(EM_CLOSE + EM_OPEN, "")
    .replaceAll(DEL_CLOSE + DEL_OPEN, "");
  const chars = Array.from(merged);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (!DELIMS[chars[i]]) {
      out += chars[i];
      i++;
      continue;
    }
    let j = i;
    let hasOpen = false;
    let hasClose = false;
    let md = "";
    while (j < chars.length && DELIMS[chars[j]]) {
      const d = DELIMS[chars[j]];
      md += d.md;
      if (d.open) hasOpen = true;
      else hasClose = true;
      j++;
    }
    const prevChar = out.length ? Array.from(out).pop() : undefined;
    const nextChar = chars[j];
    const prev = charClass(prevChar);
    const next = charClass(nextChar);
    // 开定界符：后接标点且前面是普通字符 → 不是 left-flanking，编码前一个字符
    if (hasOpen && next === "punct" && prev === "other" && prevChar !== undefined) {
      out = out.slice(0, out.length - prevChar.length) + charRef(prevChar);
    }
    out += md;
    // 闭定界符：前面是标点且后接普通字符 → 不是 right-flanking，编码后一个字符
    if (hasClose && prev === "punct" && next === "other" && nextChar !== undefined) {
      out += charRef(nextChar);
      j++;
    }
    i = j;
  }
  return out;
}

/** 行内片段 → 段落列表（连续两个及以上 <br> 视为段落分隔，单个为硬换行） */
function paragraphsFromInline(raw: string): string[] {
  const paragraphs: string[] = [];
  for (const para of raw.split(new RegExp(`${BR}(?:[ ]*${BR})+`))) {
    // 相邻文本节点各自折叠空白后可能拼出双空格，这里再收一次
    const kept = para
      .split(BR)
      .map((l) => resolveDelimiters(l).replace(/ {2,}/g, " ").trim())
      .filter((l) => l !== "");
    if (kept.length === 0) continue;
    paragraphs.push(kept.map(escapeLineStart).join("\\\n"));
  }
  return paragraphs;
}

/** 压成单行（标题、表格单元格）：换行与块边界都变空格 */
function singleLine(el: Element, ctx: InlineCtx): string {
  const raw = inlineChildren(el, ctx).split(BR).join(" ");
  return resolveDelimiters(raw).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 块级转换
// ---------------------------------------------------------------------------

const WORD_LIST_CLASS = /\bMsoListParagraph/i;
const WORD_LIST_MARKER = /^\s*(?:[·•▪◦§Øo•·\uF0B7-]|(\d{1,9}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)])\s+/;

function isWordListParagraph(node: Node): boolean {
  return tagOf(node) === "p" && WORD_LIST_CLASS.test((node as Element).getAttribute("class") ?? "");
}

function blocksOf(parent: Node, ctx: BlockCtx): string[] {
  const out: string[] = [];
  let inlineBuf = "";
  const flushInline = () => {
    if (inlineBuf) out.push(...paragraphsFromInline(inlineBuf));
    inlineBuf = "";
  };
  const children = Array.from(parent.childNodes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isWordListParagraph(child)) {
      flushInline();
      // Word 用 CxSpFirst / CxSpMiddle / CxSpLast 标记一组列表的首/中/尾；
      // 没有 CxSp 后缀的 MsoListParagraph 是单项列表
      let group: Element[] = [];
      while (i < children.length && (isWordListParagraph(children[i]) || isBlankText(children[i]))) {
        const node = children[i];
        if (isWordListParagraph(node)) {
          const cls = (node as Element).getAttribute("class") ?? "";
          if (group.length > 0 && !/CxSp(?:Middle|Last)/i.test(cls)) {
            out.push(wordList(group));
            group = [];
          }
          group.push(node as Element);
        }
        i++;
      }
      i--;
      if (group.length > 0) out.push(wordList(group));
      continue;
    }
    const block =
      isBlockElement(child) ||
      (child.nodeType === Node.ELEMENT_NODE && containsBlock(child as Element));
    if (!block) {
      inlineBuf += inlineOf(child, ROOT_INLINE);
      continue;
    }
    flushInline();
    out.push(...blockOf(child as Element, ctx));
  }
  flushInline();
  return out.filter((b) => b.trim() !== "");
}

function isBlankText(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? "").trim();
}

function blockOf(el: Element, ctx: BlockCtx): string[] {
  const tag = tagOf(el);
  switch (tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = singleLine(el, ROOT_INLINE);
      return text ? [`${"#".repeat(Number(tag[1]))} ${text}`] : [];
    }
    case "hr":
      // 不用 `---`：文档首块是 `---` 时会被 remark-frontmatter 误吞为 Front Matter
      return ["***"];
    case "pre":
      return [codeBlock(el)];
    case "blockquote": {
      const inner = blocksOf(el, ctx).join("\n\n");
      if (!inner) return [];
      return [inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")];
    }
    case "ul":
    case "ol": {
      const ordered = tag === "ol";
      if (ctx.listDepth >= MAX_LIST_DEPTH && ctx.overflow) {
        ctx.overflow.push(...collectItems(el, ctx.listDepth));
        return [];
      }
      return [formatList(collectItems(el, ctx.listDepth + 1), ordered, listStart(el))];
    }
    case "li":
      // 游离在列表外的 li：按无序列表单项处理
      return [formatList([listItem(el, ctx.listDepth + 1, [])], false, 1)];
    case "table":
      return table(el, ctx);
    default: {
      // 行内元素包了块级内容（Google Docs 的 <b id="docs-internal-guid">）：
      // 透明容器，递归取子节点
      return blocksOf(el, ctx);
    }
  }
}

function listStart(el: Element): number {
  const n = Number.parseInt(el.getAttribute("start") ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

function collectItems(listEl: Element, depth: number): ListItemMd[] {
  const items: ListItemMd[] = [];
  let loose = "";
  const flushLoose = () => {
    if (loose.trim()) items.push({ blocks: paragraphsFromInline(loose), task: null });
    loose = "";
  };
  for (const child of Array.from(listEl.childNodes)) {
    const tag = tagOf(child);
    if (tag === "li") {
      flushLoose();
      const overflow: ListItemMd[] = [];
      items.push(listItem(child as Element, depth, overflow), ...overflow);
    } else if (tag === "ul" || tag === "ol") {
      // 不规范但常见：<ul><li>a</li><ul>…</ul></ul>——归到上一项作为子列表
      flushLoose();
      const prev = items[items.length - 1];
      if (prev && depth < MAX_LIST_DEPTH) {
        prev.blocks.push(
          formatList(collectItems(child as Element, depth + 1), tag === "ol", listStart(child as Element)),
        );
      } else {
        items.push(...collectItems(child as Element, depth));
      }
    } else if (isBlockElement(child)) {
      flushLoose();
      items.push({ blocks: blockOf(child as Element, { listDepth: depth }), task: null });
    } else {
      loose += inlineOf(child, ROOT_INLINE);
    }
  }
  flushLoose();
  return items;
}

function listItem(li: Element, depth: number, overflow: ListItemMd[]): ListItemMd {
  let task: boolean | null = null;
  const box = Array.from(li.querySelectorAll("input")).find((b) => b.closest("li") === li);
  if (box && (box.getAttribute("type") ?? "").toLowerCase() === "checkbox") {
    task = box.hasAttribute("checked");
  }
  return { blocks: blocksOf(li, { listDepth: depth, overflow }), task };
}

function formatList(items: ListItemMd[], ordered: boolean, start: number): string {
  return items
    .map((item, idx) => {
      const marker = ordered ? `${start + idx}. ` : "- ";
      const task = item.task === null ? "" : item.task ? "[x] " : "[ ] ";
      const indent = " ".repeat(marker.length);
      if (item.blocks.length === 0) return `${marker}${task}`.trimEnd();
      let body = "";
      item.blocks.forEach((block, bi) => {
        if (bi > 0) {
          // 子列表紧跟上一块（紧凑列表），其余块之间空一行
          body += /^(?:[-*+]|\d+[.)])(?: |$)/.test(block) ? "\n" : "\n\n";
        }
        body += block;
      });
      const lines = body.split("\n");
      return lines
        .map((line, li) => (li === 0 ? `${marker}${task}${line}` : line ? `${indent}${line}` : ""))
        .join("\n");
    })
    .join("\n");
}

function wordList(paragraphs: Element[]): string {
  let ordered = false;
  const items = paragraphs.map((p, idx) => {
    const raw = paragraphsFromInline(inlineChildren(p, ROOT_INLINE)).join(" ");
    // 标记已被转义（`1\.`、`\-`），先还原再匹配
    const plain = raw.replace(/^(\d{1,9})\\([.)])/, "$1$2").replace(/^\\-/, "-");
    const m = WORD_LIST_MARKER.exec(plain);
    if (idx === 0) ordered = !!m?.[1];
    const text = m ? plain.slice(m[0].length) : raw;
    return { blocks: text ? [escapeLineStart(text)] : [], task: null };
  });
  return formatList(items, ordered, 1);
}

const LANG_CLASS_RE = /(?:^|\s)(?:language|lang|highlight-source)-([\w+#.-]+)/i;

function codeLanguage(pre: Element): string {
  const candidates: Element[] = [pre];
  const code = pre.querySelector("code");
  if (code) candidates.unshift(code);
  if (pre.parentElement) candidates.push(pre.parentElement);
  for (const el of candidates) {
    const m = LANG_CLASS_RE.exec(el.getAttribute("class") ?? "");
    if (m) return m[1].toLowerCase();
    const lang = el.getAttribute("lang");
    if (lang && /^[\w+#.-]+$/.test(lang) && el !== pre.parentElement) return lang.toLowerCase();
  }
  return "";
}

/** 代码块文本：保留原始空白，<br> 与逐行块元素（部分高亮器一行一个 div）转为换行 */
function preText(node: Node): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += (child.textContent ?? "").replace(/\u00A0/g, " ");
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = tagOf(child);
      if (tag === "br") {
        out += "\n";
      } else {
        out += preText(child);
        if ((tag === "div" || tag === "p" || tag === "li") && !out.endsWith("\n")) out += "\n";
      }
    }
  });
  return out;
}

function codeBlock(pre: Element): string {
  const code = preText(pre).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const longest = Math.max(0, ...Array.from(code.matchAll(/^`+/gm), (m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${codeLanguage(pre)}\n${code}\n${fence}`;
}

function tableRows(tableEl: Element): Element[] {
  const rows: Element[] = [];
  for (const child of Array.from(tableEl.children)) {
    const tag = tagOf(child);
    if (tag === "tr") rows.push(child);
    else if (tag === "thead" || tag === "tbody" || tag === "tfoot") {
      for (const tr of Array.from(child.children)) if (tagOf(tr) === "tr") rows.push(tr);
    }
  }
  return rows;
}

function rowCells(tr: Element): Element[] {
  return Array.from(tr.children).filter((c) => {
    const t = tagOf(c);
    return t === "td" || t === "th";
  });
}

function cellAlign(cell: Element | undefined): string {
  const align = cell ? styleValue(styleOf(cell), "text-align") : null;
  switch (align) {
    case "center":
      return ":---:";
    case "right":
    case "end":
      return "---:";
    case "left":
    case "start":
      return ":---";
    default:
      return "---";
  }
}

function table(tableEl: Element, ctx: BlockCtx): string[] {
  const rows = tableRows(tableEl);
  const cells = rows.map(rowCells);
  const cols = Math.max(0, ...cells.map((r) => r.length));
  const isLayout =
    cols === 0 ||
    (rows.length === 1 && cols === 1) ||
    cells.some((r) => r.some((c) => c.querySelector(LAYOUT_TABLE_SELECTOR) !== null));
  if (isLayout) {
    // 布局表格：不是数据表，按单元格顺序展开为普通块
    return cells.flatMap((r) => r.flatMap((c) => blocksOf(c, ctx)));
  }
  const caption = Array.from(tableEl.children)
    .filter((c) => tagOf(c) === "div")
    .flatMap((c) => blocksOf(c, ctx));
  const cellCtx: InlineCtx = { ...ROOT_INLINE, inTable: true };
  const lines = cells.map((r) => {
    const texts = r.map((c) => singleLine(c, cellCtx));
    while (texts.length < cols) texts.push("");
    return `| ${texts.join(" | ")} |`;
  });
  const header = cells[0];
  const delimiter = `| ${Array.from({ length: cols }, (_, i) => cellAlign(header[i])).join(" | ")} |`;
  lines.splice(1, 0, delimiter);
  return [...caption, lines.join("\n")];
}

/**
 * 把清洗后的 DOM 转成 Markdown 文本。
 * @param root sanitizeHTML(html, { mode: "paste" }) 的返回值（DocumentFragment）或任意元素
 */
export function htmlToMarkdown(root: Node): string {
  return blocksOf(root, { listDepth: 0 }).join("\n\n");
}

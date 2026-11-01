// 内存缓冲搜索（issue #370）
//
// 全局搜索的内存侧数据源：对「未保存的已打开 tab」与「未命名草稿」的
// tab.content 执行与 Rust 侧 search_in_workspace 相同语义的逐行匹配，
// 产出带 unsaved 标记的命中，供面板与磁盘结果按文件去重合并。
//
// 与 src-tauri/src/commands/search.rs 的契约对齐（修改任一侧须同步）：
// - 纯文本查询转义正则元字符；正则模式直接编译；
// - 大小写不敏感用 "i" 标志（对应 Rust 的 (?i) 前缀）；
// - 列号按「命中前的字符数 + 1」计；
// - 预览为命中点前后各 PREVIEW_CONTEXT_CHARS 字符的窗口，命中片段本身
//   上限 PREVIEW_MAX_MATCH_CHARS，两侧截断以 … 标记；
// - 命中数达到 maxHits 后继续探测是否还有更多（exceeded），供上层标 truncated；
// - 行切分与 Rust `BufRead::lines()` 一致：只按 \n 分行并剥行尾 \r，末尾换行
//   不产生额外空行。
// 差异（有意为之，且**不得**改回静默空结果）：JS 无法正确表达的 Rust 正则语法
// （内联标志 (?i) 编译失败、\p{…} / POSIX 类 / 集合运算 / 类首 ] / 非 ASCII 内容上
// 的 \w \d \b 等语义偏移）统一返回 `unsupported: true`，由上层（GlobalSearchPanel）
// 渲染可见提示「该正则在未保存内容中不受支持」。绝不能退化为「返回空结果且不提示」
// ——那会让 #370 要消除的「刚写下的文本搜不到」静默复发。

import type { SearchHit, SearchResult } from "./fs";

/** 命中点前后各保留的字符数（与 Rust 侧 PREVIEW_CONTEXT_CHARS 一致） */
const PREVIEW_CONTEXT_CHARS = 120;
/** 命中片段本身最多保留的字符数（与 Rust 侧 PREVIEW_MAX_MATCH_CHARS 一致） */
const PREVIEW_MAX_MATCH_CHARS = 200;

export interface BufferSearchOptions {
  /** 搜索词或正则 */
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  /** 最多收录的命中条数（超出只置 exceeded 不再存储） */
  maxHits: number;
}

export interface BufferSearchResult {
  hits: SearchHit[];
  /** 本缓冲真实命中数超过 maxHits（存在未收录的第 maxHits+1 条） */
  exceeded: boolean;
  /**
   * 查询使用了 JS 正则引擎无法正确表达的 Rust 语法，本缓冲的命中**未被检索**
   *
   * 与「无命中」必须区分：Rust regex 支持 JS 不支持的语法，磁盘扫描会正常
   * 返回命中，而内存侧要么编译失败（`(?i)needle` 内联标志直接抛 Invalid group），
   * 要么被 JS 当作字面/普通字符类而语义偏移（`\p{Han}` 非 u 模式是恒等转义、
   * `[[:alpha:]]` 被当作字符集、`\A`/`\Z`/`\z` 被当作字面字母）。
   * 两种情况都会让未保存内容的命中静默丢失（#370 要消除的症状），
   * 因此统一由 `unsupported` 向上层透传，并给出可见提示。
   */
  unsupported: boolean;
}

/**
 * 查询是否使用了「Rust regex 有、JS 无法正确表达」的构造
 *
 * 与编译失败（try/catch）互补：下面这些构造在 JS 里**不抛错**，只是含义
 * 完全不同，必须靠语法探测拦下，否则未保存内容的命中会被静默丢弃或错配：
 * - Unicode 属性类 `\p{…}` / `\P{…}`：JS 无 u 标志时是恒等转义（匹配字面 "p{Han}"）；
 * - POSIX 字符类 `[[:alpha:]]`（含 `[^[:alpha:]]`、`[0-9[:digit:]]` 等非首位形态）：
 *   JS 当作普通字符集；
 * - 字符类集合运算 `&&` / `--` / `~~` / `||` 与嵌套类 `[[…]]`：Rust 是交集/差集/
 *   对称差/并集与嵌套，JS 全部当字面字符；
 * - 文本锚点 `\A` / `\Z` / `\z`、词边界别名 `\<` / `\>` / `\b{start}` 等、码点转义
 *   `\x{…}` / `\u{…}`：JS 当作字面字母或完全不同的量词语义；
 * - ASCII-only 类 `\w` / `\W` / `\d` / `\D`（**字符类内外皆是**）与词边界
 *   `\b` / `\B`（仅类外；类内不是 Rust 合法转义）：Rust 默认 Unicode 语义
 *   （中文也算词字符/可命中边界），JS 非 u 模式只认 ASCII。仅在**内容含非 ASCII**
 *   时判不支持——纯 ASCII 内容上这些构造两侧语义一致，不得一刀切误伤常见查询；
 * - 字符类首的 `]`（`[]]` 匹配 `]`、`[^]]` 除 `]` 外任意）：JS 把它当空类/
 *   任意字符，语义被完全改写。
 *
 * 只认**未转义**的反斜杠（连续反斜杠为奇数个才是转义起点），因此想匹配字面
 * `\p{Han}` 的查询（写作 `\\p{Han}`）不会被误判。字符类上下文由扫描器跟踪，
 * 类内与类外的语义按 Rust 语法分别判定。
 */
function isUnsupportedRegex(pattern: string, contentHasNonAscii: boolean): boolean {
  let inClass = false;
  /**
   * 刚进入字符类、尚未出现任何内容字符（可先有一个 `^`）
   *
   * Rust 规定类首的 `]` 是字面量（`[]]` = 匹配 `]`，`[^]]` = 除 `]` 外任意），
   * 而 JS 把 `[]` 当空类、`[^]` 当「任意字符」——两者都编译成功却语义完全
   * 不同，必须在此状态遇到 `]` 时判 unsupported。
   */
  let classAtStart = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];

    if (ch === "\\") {
      let backslashes = 0;
      while (i + backslashes < pattern.length && pattern[i + backslashes] === "\\") {
        backslashes++;
      }
      // 偶数个反斜杠 = 整段都是字面反斜杠，后面不构成转义
      if (backslashes % 2 === 1) {
        const next = pattern[i + backslashes];
        const rest = pattern.slice(i + backslashes + 1);
        if (next === "p" || next === "P") return true; // Unicode 属性类
        if (next === "A" || next === "Z" || next === "z") return true; // 文本锚点
        if (next === "<" || next === ">") return true; // 词边界别名
        if (next === "b" && rest.startsWith("{")) return true; // \b{start} 等
        if (next === "x" && rest.startsWith("{")) return true; // \x{…}
        if (next === "u" && rest.startsWith("{")) return true; // \u{…}（JS 非 u 模式为字面）
        if (
          contentHasNonAscii &&
          (next === "w" ||
            next === "W" ||
            next === "d" ||
            next === "D" ||
            // \b / \B 在字符类内不是 Rust 合法转义（磁盘侧会报错），只判类外
            (!inClass && (next === "b" || next === "B")))
        ) {
          // Rust 的 Unicode 词字符/数字/词边界 vs JS 的 ASCII-only：
          // 类内外的 \w / \d 在 Rust 都是 Unicode 语义，故不限字符类上下文
          return true;
        }
      }
      // 转义序列是字符类内容，类首状态随之结束（如 `[\]]` 的 `\]`）
      if (inClass) classAtStart = false;
      // 跳过整段编译单元：奇数个反斜杠还要吞掉被转义的那个字符
      // （如 `[\[]` 的 `\[` 是字面 `[`，不得被当成嵌套类起点）
      i += backslashes % 2 === 1 ? backslashes : backslashes - 1;
      continue;
    }

    if (inClass) {
      // 类首的 `^` 是否定符，仍处于类首状态
      if (ch === "^" && classAtStart) continue;
      if (ch === "]") {
        // 类首 `]` 是字面量（Rust）vs 空类/任意字符（JS）：语义不同
        if (classAtStart) return true;
        inClass = false;
        continue;
      }
      classAtStart = false;
      // POSIX 类 `[:name:]` 可出现在类内任意位置（含 `[^[:alpha:]]`）
      if (ch === "[" && pattern[i + 1] === ":") return true;
      // 嵌套类 `[[…]]`（Rust 支持，JS 当字面 `[`）
      if (ch === "[") return true;
      // 集合运算
      const next = pattern[i + 1];
      if ((ch === "&" && next === "&") || (ch === "-" && next === "-")) return true;
      if ((ch === "~" && next === "~") || (ch === "|" && next === "|")) return true;
      continue;
    }

    if (ch === "[") {
      inClass = true;
      classAtStart = true;
    }
  }
  return false;
}

/** 高代理项（UTF-16 代理对高位） */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 低代理项（UTF-16 代理对低位） */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 命中点附近的预览窗口（与 Rust 侧 preview_window 同语义）
 *
 * 窗口按 UTF-16 码元偏移截取（BMP 内字符与 Rust 的字符计数口径一致），
 * 边界落在代理对中间时向安全侧退一位，避免预览出现半个字符。
 */
function previewWindow(line: string, start: number, end: number): string {
  let from = start > PREVIEW_CONTEXT_CHARS ? start - PREVIEW_CONTEXT_CHARS : 0;
  if (isLowSurrogate(line.charCodeAt(from))) from -= 1;

  let matchEnd =
    end - start > PREVIEW_MAX_MATCH_CHARS ? start + PREVIEW_MAX_MATCH_CHARS : end;
  if (matchEnd < line.length && isLowSurrogate(line.charCodeAt(matchEnd))) matchEnd += 1;

  let to = Math.min(line.length, matchEnd + PREVIEW_CONTEXT_CHARS);
  if (isHighSurrogate(line.charCodeAt(to - 1))) to -= 1;

  let preview = "";
  if (from > 0) preview += "…";
  preview += line.slice(from, to);
  if (to < line.length) preview += "…";
  return preview;
}

/**
 * 在单个内存缓冲中搜索
 *
 * content 先按 LF 归一（编辑器内部表示已是 LF，防御性处理极端情况下
 * 残留的 CRLF，保证行号与列号与编辑器所见一致）。
 */
export function searchBuffer(
  path: string,
  content: string,
  options: BufferSearchOptions,
): BufferSearchResult {
  const { query, caseSensitive, useRegex, maxHits } = options;
  const hits: SearchHit[] = [];
  if (!query || maxHits <= 0) return { hits, exceeded: false, unsupported: false };

  const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    useRegex &&
    isUnsupportedRegex(pattern, /[^\x00-\x7F]/.test(content))
  ) {
    // Rust 合法但 JS 语义偏移/不支持的构造：不抛错却含义不同，必须显式标记未检索
    return { hits, exceeded: false, unsupported: true };
  }
  let re: RegExp;
  try {
    re = new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch {
    // 编译失败（如 (?i) 内联标志）：同样显式标记未检索，不静默当空结果
    return { hits, exceeded: false, unsupported: true };
  }

  // 与 Rust BufRead::lines() 的行切分口径对齐：
  // - 只折叠 CRLF（`\r\n` → `\n`），**孤立 `\r` 保留在行内**——Rust `lines()`
  //   只按 `\n` 分行并剥掉行尾 `\r`，经典 Mac 的纯 `\r` 文件在两侧都算 1 行；
  // - 末尾换行不产生额外空行（"a\nb\n" 是 2 行而非 3 行，空内容是 0 行）。
  // 序列化结果恒以 \n 结尾，不修剪会让零宽/空行正则（^、$、^\s*$）多出
  // 不存在行号的幻影命中，点击跳转会落到文档开头。
  const lf = content.replace(/\r\n/g, "\n");
  const lines = lf === "" ? [] : lf.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let exceeded = false;
  outer: for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(line);
      if (m === null) break;
      if (hits.length >= maxHits) {
        // 与 Rust 侧一致：确认存在多余命中才标记 exceeded，之后停止本缓冲
        exceeded = true;
        break outer;
      }
      hits.push({
        path,
        line: i + 1,
        // 列号按命中前的字符数 + 1（与 Rust 侧 UTF-8 字符计数口径一致）
        column: [...line.slice(0, m.index)].length + 1,
        preview: previewWindow(line, m.index, m.index + m[0].length),
        unsaved: true,
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return { hits, exceeded, unsupported: false };
}

/** 合并结果：在磁盘结果基础上带上「内存侧正则不受支持」的信号（#370 评审 P3） */
export interface MergedSearchResult extends SearchResult {
  /**
   * 存在未保存来源的正则无法在 JS 引擎编译（Rust 侧可能合法），
   * 这些文件的命中未被检索——上层必须给出可见提示，不得静默丢弃。
   */
  unsupportedBufferRegex: boolean;
}

/**
 * 合并磁盘搜索结果与未保存内存缓冲命中（#370）
 *
 * - 未保存来源（dirty tab / 未命名草稿）的文件级去重：磁盘上这些文件的
 *   命中是旧版本，整体排除，由内存命中替换；
 * - 磁盘结果保持既有顺序（Epic 非目标：不改变排序规则），内存命中按
 *   tab 顺序追加，共用 maxTotalHits 总预算；
 * - 任一侧超预算（磁盘 truncated / 内存 exceeded / 预算耗尽后仍有命中）都置
 *   truncated，保证「有命中未收录」对调用方可见（#160）；
 * - 内存侧正则编译失败时置 `unsupportedBufferRegex`，上层据此提示用户
 *   结果未覆盖未保存内容（避免「刚写下的文本搜不到」静默复发）。
 */
export function mergeSearchResults(
  disk: SearchResult,
  unsavedTabs: Array<{ path: string; content: string }>,
  options: { query: string; caseSensitive: boolean; useRegex: boolean },
  maxTotalHits: number,
): MergedSearchResult {
  const unsavedPaths = new Set(unsavedTabs.map((t) => t.path));
  const diskHits = disk.hits.filter((h) => !unsavedPaths.has(h.path));
  const merged: SearchHit[] = [...diskHits];
  let truncated = disk.truncated;
  let unsupportedBufferRegex = false;
  let remaining = maxTotalHits - diskHits.length;
  for (const tab of unsavedTabs) {
    if (remaining <= 0) {
      // 预算已耗尽（磁盘占满，或前面的 tab 用掉了最后额度）但仍有未保存来源
      // 未检索。Rust 侧的「恰好 5000 不误报」只证明**磁盘**没有第 5001 条，
      // 不能推广到内存侧——这些 tab 是已知存在的额外命中源。用 maxHits=1 做
      // 最小探测：确有余量命中才置 truncated（有命中未收录必须可见，#160），
      // 全部无命中则不误报（等价「恰好占满」）。
      const probe = searchBuffer(tab.path, tab.content, { ...options, maxHits: 1 });
      if (probe.unsupported) unsupportedBufferRegex = true;
      if (probe.hits.length > 0) {
        truncated = true;
        break;
      }
      continue;
    }
    const { hits, exceeded, unsupported } = searchBuffer(tab.path, tab.content, {
      ...options,
      maxHits: remaining,
    });
    if (unsupported) unsupportedBufferRegex = true;
    merged.push(...hits);
    remaining -= hits.length;
    if (exceeded) truncated = true;
  }
  return { hits: merged, truncated, unsupportedBufferRegex };
}

// 内存缓冲搜索单测（issue #370）
//
// 覆盖对象：src/lib/bufferSearch.ts 的 searchBuffer。
// 语义与 Rust 侧 search_in_workspace 对齐（修改任一侧须同步）：
// 逐行匹配、列号按命中前字符数 + 1、预览窗口 120/200/…、maxHits 收录上限
// 与 exceeded 探测、纯文本转义、大小写开关、非法正则静默返回空。

import { describe, expect, it } from "vitest";
import { mergeSearchResults, searchBuffer } from "../../src/lib/bufferSearch";
import type { SearchHit, SearchResult } from "../../src/lib/fs";

const OPTS = {
  query: "needle",
  caseSensitive: false,
  useRegex: false,
  maxHits: 5000,
};

describe("searchBuffer", () => {
  it("基础命中：行号 / 列号 / 预览 / unsaved 标记", () => {
    const content = "# 标题\n\n正文 needle here。\n";
    const { hits, exceeded } = searchBuffer("/w/a.md", content, OPTS);
    expect(exceeded).toBe(false);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({
      path: "/w/a.md",
      line: 3,
      // 「正文 」占 3 个字符（正、文、空格）→ 列号 4
      column: 4,
      preview: "正文 needle here。",
      unsaved: true,
    });
  });

  it("多行多命中：按行序返回，同一行内多处命中都收录", () => {
    const content = "needle one\nplain\nneedle two needle three\n";
    const { hits } = searchBuffer("/w/a.md", content, OPTS);
    expect(hits.map((h) => h.line)).toEqual([1, 3, 3]);
    expect(hits.map((h) => h.column)).toEqual([1, 1, 12]);
  });

  it("列号按字符计数：中文 / emoji 命中前列数正确", () => {
    const content = "你好😀needle\n";
    const { hits } = searchBuffer("/w/a.md", content, OPTS);
    expect(hits[0].column).toBe(4);
  });

  it("大小写开关：默认不敏感，caseSensitive 只命中小写", () => {
    const content = "Hello\nhello\nHELLO\n";
    const insensitive = searchBuffer("/w/a.md", content, { ...OPTS, query: "hello" });
    expect(insensitive.hits).toHaveLength(3);
    const sensitive = searchBuffer("/w/a.md", content, {
      ...OPTS,
      query: "hello",
      caseSensitive: true,
    });
    expect(sensitive.hits).toHaveLength(1);
    expect(sensitive.hits[0].line).toBe(2);
  });

  it("纯文本模式转义正则元字符：5.99 不匹配 X99", () => {
    const content = "cost is 5.99\ncost is X99\n";
    const { hits } = searchBuffer("/w/a.md", content, { ...OPTS, query: "5.99" });
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
  });

  it("正则模式：按模式匹配", () => {
    const content = "foo123bar\nfoo456bar\nplain\n";
    const { hits } = searchBuffer("/w/a.md", content, {
      ...OPTS,
      query: "foo\\d+bar",
      useRegex: true,
    });
    expect(hits).toHaveLength(2);
  });

  it("maxHits 收录上限：超出置 exceeded；恰好达到不误报", () => {
    const content = "needle\n".repeat(6);
    const capped = searchBuffer("/w/a.md", content, { ...OPTS, maxHits: 3 });
    expect(capped.hits).toHaveLength(3);
    expect(capped.exceeded).toBe(true);
    const exact = searchBuffer("/w/a.md", content, { ...OPTS, maxHits: 6 });
    expect(exact.hits).toHaveLength(6);
    expect(exact.exceeded).toBe(false);
  });

  it("空查询 / maxHits=0：无命中不报错", () => {
    expect(searchBuffer("/w/a.md", "needle\n", { ...OPTS, query: "" }).hits).toEqual([]);
    expect(searchBuffer("/w/a.md", "needle\n", { ...OPTS, maxHits: 0 }).hits).toEqual([]);
  });

  it("非法正则：显式标记 unsupported（不得静默当无命中）", () => {
    const { hits, exceeded, unsupported } = searchBuffer("/w/a.md", "needle\n", {
      ...OPTS,
      query: "(",
      useRegex: true,
    });
    expect(hits).toEqual([]);
    expect(exceeded).toBe(false);
    expect(unsupported).toBe(true);
  });

  it("Rust 合法但 JS 不支持的内联标志（(?i)needle）：标记 unsupported 而非空结果", () => {
    // Rust regex 接受 (?i) 前缀；JS RegExp 抛 Invalid group（#370 评审 P3）
    const { hits, unsupported } = searchBuffer("/w/a.md", "NEEDLE\n", {
      ...OPTS,
      query: "(?i)needle",
      useRegex: true,
      caseSensitive: true,
    });
    expect(hits).toEqual([]);
    expect(unsupported).toBe(true);
  });

  it("Rust 合法但 JS 编译成功却语义偏移的构造：全部标记 unsupported", () => {
    // 这些构造在 JS 中不抛错，只是含义不同（非 u 模式恒等转义 / 普通字符集 /
    // 字面字母 / 集合运算当字面），必须靠语法探测拦下，否则未保存内容的命中
    // 会被静默丢弃或被错误匹配
    const queries = [
      // Unicode 属性类（JS 非 u 模式为恒等转义）
      "\\p{Han}",
      "\\P{Han}",
      // POSIX 类（含非首位与取反形态：JS 当作普通字符集）
      "[[:alpha:]]",
      "[^[:alpha:]]",
      "[0-9[:digit:]]",
      // 文本锚点 / 词边界别名 / 码点转义（JS 当作字面字母或量词）
      "\\Aabc",
      "abc\\Z",
      "abc\\z",
      "\\<needle",
      "needle\\>",
      "\\b{start}needle",
      "\\x{4e2d}",
      "\\u{4e2d}",
      // 字符类集合运算与嵌套类（Rust 交集/差集/对称差/嵌套 vs JS 字面）
      "[a-z&&b]",
      "[a-z--b]",
      "[[abc]]",
      // 类首 `]` 字面量：Rust `[]]` 匹配 `]`、`[^]]` 除 `]` 外任意；
      // JS 把 `[]` 当空类、`[^]` 当任意字符——语义被完全改写
      "[]]",
      "[^]]",
    ];
    for (const query of queries) {
      const result = searchBuffer("/w/a.md", "中文内容 <needle needle> [ ] abc\n", {
        ...OPTS,
        query,
        useRegex: true,
        caseSensitive: true,
      });
      expect(result.hits, query).toEqual([]);
      expect(result.unsupported, query).toBe(true);
    }
  });

  it("Rust Unicode 语义（\\w/\\d/\\b）在非 ASCII 内容上标记 unsupported，纯 ASCII 内容上照常可用", () => {
    // Rust regex 默认 Unicode：\w 含中文、\d 含非 ASCII 数字、\b 是 Unicode 词边界；
    // JS 非 u 模式只认 ASCII → 非 ASCII 内容上语义不一致，必须提示
    for (const query of ["\\w+", "\\W", "\\d+", "\\D", "\\b中文", "\\B中文"]) {
      const result = searchBuffer("untitled-1", "中文needle\n", {
        ...OPTS,
        query,
        useRegex: true,
        caseSensitive: true,
      });
      expect(result.unsupported, query).toBe(true);
    }
    // 字符类内的 \w / \d 同上（Rust 类内外都是 Unicode 语义）：`[\w-]+`
    // 是最常见的标识符写法，不能因为包在类里就漏判
    for (const query of ["[\\w-]+", "[^\\w]", "[\\d.]+", "[\\D]"] ) {
      const result = searchBuffer("untitled-1", "中文标识符１２３\n", {
        ...OPTS,
        query,
        useRegex: true,
        caseSensitive: true,
      });
      expect(result.unsupported, query).toBe(true);
    }
    // 纯 ASCII 内容：两侧语义一致，不得一刀切误伤常见查询
    const ascii = searchBuffer("untitled-1", "needle 123\n", {
      ...OPTS,
      query: "\\bneedle\\s+\\d+",
      useRegex: true,
      caseSensitive: true,
    });
    expect(ascii.unsupported).toBe(false);
    expect(ascii.hits).toHaveLength(1);
    const asciiClass = searchBuffer("untitled-1", "id-123\n", {
      ...OPTS,
      query: "[\\w-]+",
      useRegex: true,
      caseSensitive: true,
    });
    expect(asciiClass.unsupported).toBe(false);
    expect(asciiClass.hits).toHaveLength(1);
  });

  it("反向护栏：普通字符类 / 转义字面 / 交替 / ASCII 码点转义不得被误判", () => {
    // `[\]]`（类首转义的 `]`）与 `[\[]` 是合法字面字符类，两侧语义一致
    const queries = ["[abc]", "[\\[]", "[\\]]", "a||b", "\\x41", "\\u0041", "\\d+"];
    for (const query of queries) {
      const result = searchBuffer("/w/a.md", "abc 123 A\n", {
        ...OPTS,
        query,
        useRegex: true,
        caseSensitive: true,
      });
      expect(result.unsupported, query).toBe(false);
    }
  });

  it("转义后的字面 \\p{…}（写作 \\\\p{…}）不被误判为 Rust 独有语法", () => {
    // 想匹配字面 "\p{Han}" 时用户写 \\p{Han}，JS 中即字面反斜杠 + p{Han}
    const result = searchBuffer("/w/a.md", "literal \\p{Han} here\n", {
      ...OPTS,
      query: "\\\\p\\{Han\\}",
      useRegex: true,
      caseSensitive: true,
    });
    expect(result.unsupported).toBe(false);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].line).toBe(1);
  });

  it("行切分口径与 Rust BufRead::lines() 对齐：末尾换行无幻影行、孤立 CR 不切行", () => {
    // "a\nb\n" 是 2 行（不是 3 行），空内容是 0 行
    expect(
      searchBuffer("untitled-1", "a\nb\n", { ...OPTS, query: "^", useRegex: true }).hits.map(
        (h) => h.line,
      ),
    ).toEqual([1, 2]);
    expect(
      searchBuffer("untitled-1", "", { ...OPTS, query: "^", useRegex: true }).hits,
    ).toEqual([]);
    // 中间的空行仍是真实行（"a\n\nb\n" 是 3 行）
    expect(
      searchBuffer("untitled-1", "a\n\nb\n", { ...OPTS, query: "^", useRegex: true }).hits.map(
        (h) => h.line,
      ),
    ).toEqual([1, 2, 3]);
    // 孤立 \r（经典 Mac）不切行：Rust lines() 只按 \n 分行
    expect(
      searchBuffer("untitled-1", "a\rb", { ...OPTS, query: "^", useRegex: true }).hits.map(
        (h) => h.line,
      ),
    ).toEqual([1]);
    expect(
      searchBuffer("untitled-1", "a\rb\nc", { ...OPTS, query: "^", useRegex: true }).hits.map(
        (h) => h.line,
      ),
    ).toEqual([1, 2]);
  });

  it("CRLF 内容先归一为 LF：行号 / 列号与编辑器所见一致", () => {
    const content = "first\r\nsecond needle\r\n";
    const { hits } = searchBuffer("/w/a.md", content, OPTS);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].column).toBe(8);
  });

  it("超长行预览为窗口而非整行：两侧以 … 截断", () => {
    const huge = "x".repeat(200) + "needle" + "y".repeat(200);
    const { hits } = searchBuffer("/w/a.md", `${huge}\n`, OPTS);
    expect(hits).toHaveLength(1);
    const preview = hits[0].preview;
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview).toContain("needle");
    expect(preview.length).toBeLessThanOrEqual(120 * 2 + 6 + 2);
  });

  it("短行预览完整保留，不加省略号", () => {
    const { hits } = searchBuffer("/w/a.md", "hello needle world\n", OPTS);
    expect(hits[0].preview).toBe("hello needle world");
  });
});

describe("mergeSearchResults（磁盘 + 内存合并）", () => {
  const MAX = 5000;

  function diskHit(path: string): SearchHit {
    return { path, line: 1, column: 1, preview: "needle" };
  }

  it("未保存来源的磁盘旧命中被排除，由内存命中替换；干净文件保留磁盘命中", () => {
    const disk: SearchResult = {
      hits: [
        diskHit("/w/dirty.md"), // 旧版本，应被排除
        diskHit("/w/clean.md"),
      ],
      truncated: false,
    };
    const merged = mergeSearchResults(
      disk,
      [{ path: "/w/dirty.md", content: "内存新版 needle\n" }],
      { query: "needle", caseSensitive: false, useRegex: false },
      MAX,
    );
    expect(merged.truncated).toBe(false);
    expect(merged.hits).toHaveLength(2);
    // 顺序：干净文件的磁盘命中在前（不带 unsaved），内存命中追加在后
    expect(merged.hits[0].path).toBe("/w/clean.md");
    expect(merged.hits[0].unsaved).toBeUndefined();
    expect(merged.hits[1].path).toBe("/w/dirty.md");
    expect(merged.hits[1].unsaved).toBe(true);
  });

  it("多个未命名草稿按 tab 顺序追加，各自命中", () => {
    const merged = mergeSearchResults(
      { hits: [], truncated: false },
      [
        { path: "untitled-1", content: "needle one\n" },
        { path: "untitled-2", content: "needle two\n" },
      ],
      { query: "needle", caseSensitive: false, useRegex: false },
      MAX,
    );
    expect(merged.hits.map((h) => h.path)).toEqual(["untitled-1", "untitled-2"]);
    expect(merged.hits.every((h) => h.unsaved)).toBe(true);
  });

  it("磁盘占满总预算（5000）时内存命中不再追加，但确有命中 → 截断可见", () => {
    const diskHits = Array.from({ length: MAX }, (_, i) => diskHit(`/w/disk-${i}.md`));
    const merged = mergeSearchResults(
      { hits: diskHits, truncated: true },
      [{ path: "untitled-1", content: "needle\n" }],
      { query: "needle", caseSensitive: false, useRegex: false },
      MAX,
    );
    expect(merged.hits).toHaveLength(MAX);
    expect(merged.hits.some((h) => h.path === "untitled-1")).toBe(false);
    expect(merged.truncated).toBe(true);
  });

  it("磁盘恰好占满且未截断、草稿仍有命中 → 必须标截断（预算拒绝检索≠没有命中）", () => {
    const diskHits = Array.from({ length: MAX }, (_, i) => diskHit(`/w/disk-${i}.md`));
    const merged = mergeSearchResults(
      { hits: diskHits, truncated: false },
      [{ path: "untitled-1", content: "needle\n" }],
      { query: "needle", caseSensitive: false, useRegex: false },
      MAX,
    );
    expect(merged.hits).toHaveLength(MAX);
    // 有命中未收录必须对调用方可见（#160）——磁盘未截断不能证明内存侧也没有
    expect(merged.truncated).toBe(true);
  });

  it("磁盘恰好占满、草稿无匹配 → 不误报截断（等价「恰好上限」）", () => {
    const diskHits = Array.from({ length: MAX }, (_, i) => diskHit(`/w/disk-${i}.md`));
    const merged = mergeSearchResults(
      { hits: diskHits, truncated: false },
      [{ path: "untitled-1", content: "完全无关的内容\n" }],
      { query: "needle", caseSensitive: false, useRegex: false },
      MAX,
    );
    expect(merged.hits).toHaveLength(MAX);
    expect(merged.truncated).toBe(false);
  });

  it("前面的 tab 用掉最后额度、后续 tab 仍有命中 → 标截断", () => {
    const diskHits = Array.from({ length: MAX - 1 }, (_, i) => diskHit(`/w/disk-${i}.md`));
    const merged = mergeSearchResults(
      { hits: diskHits, truncated: false },
      [
        // 草稿 A 恰好用掉最后 1 个预算
        { path: "untitled-1", content: "needle\n" },
        // 草稿 B 仍有命中，被预算拒绝 → 必须可见
        { path: "untitled-2", content: "needle 另一处\n" },
      ],
      { query: "needle", caseSensitive: false, useRegex: false },
      MAX,
    );
    expect(merged.hits).toHaveLength(MAX);
    expect(merged.hits.some((h) => h.path === "untitled-2")).toBe(false);
    expect(merged.truncated).toBe(true);
  });

  it("剩余预算不足时内存命中按预算截断并置 exceeded → truncated", () => {
    const diskHits = Array.from({ length: MAX - 1 }, (_, i) => diskHit(`/w/disk-${i}.md`));
    const merged = mergeSearchResults(
      { hits: diskHits, truncated: false },
      // 草稿里 5 处命中，预算只剩 1
      [{ path: "untitled-1", content: "needle\n".repeat(5) }],
      { query: "needle", caseSensitive: false, useRegex: false },
      MAX,
    );
    expect(merged.hits).toHaveLength(MAX);
    expect(merged.hits[merged.hits.length - 1].path).toBe("untitled-1");
    expect(merged.truncated).toBe(true);
  });

  it("空查询：无未保存来源时原样返回；内存侧不产出命中", () => {
    const disk: SearchResult = { hits: [diskHit("/w/a.md")], truncated: false };
    expect(
      mergeSearchResults(disk, [], { query: "", caseSensitive: false, useRegex: false }, MAX),
    ).toEqual({ hits: [diskHit("/w/a.md")], truncated: false, unsupportedBufferRegex: false });
    // 文件级去重与查询无关：磁盘旧命中仍被排除，空查询内存侧无命中补充
    expect(
      mergeSearchResults(
        disk,
        [{ path: "/w/a.md", content: "whatever\n" }],
        { query: "", caseSensitive: false, useRegex: false },
        MAX,
      ),
    ).toEqual({ hits: [], truncated: false, unsupportedBufferRegex: false });
  });

  it("内存侧正则不受支持时透传 unsupportedBufferRegex（上层必须提示）", () => {
    const merged = mergeSearchResults(
      { hits: [diskHit("/w/clean.md")], truncated: false },
      [{ path: "/w/dirty.md", content: "NEEDLE\n" }],
      { query: "(?i)needle", caseSensitive: true, useRegex: true },
      MAX,
    );
    expect(merged.hits).toHaveLength(1);
    expect(merged.hits[0].path).toBe("/w/clean.md");
    expect(merged.unsupportedBufferRegex).toBe(true);
  });

  it("预算耗尽时仍在探测中透传 unsupportedBufferRegex", () => {
    const diskHits = Array.from({ length: MAX }, (_, i) => diskHit(`/w/disk-${i}.md`));
    const merged = mergeSearchResults(
      { hits: diskHits, truncated: false },
      [{ path: "untitled-1", content: "NEEDLE\n" }],
      { query: "(?i)needle", caseSensitive: true, useRegex: true },
      MAX,
    );
    expect(merged.unsupportedBufferRegex).toBe(true);
  });

  it("正则两端都合法时 unsupportedBufferRegex 为 false", () => {
    const merged = mergeSearchResults(
      { hits: [], truncated: false },
      [{ path: "untitled-1", content: "needle\n" }],
      { query: "needle\\d+", caseSensitive: false, useRegex: true },
      MAX,
    );
    expect(merged.unsupportedBufferRegex).toBe(false);
    expect(merged.hits).toHaveLength(0);
  });
});

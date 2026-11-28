// 大纲解析单元测试
// 覆盖 parseOutline（Markdown 标题解析 + 围栏代码块跳过）
// 和 findActiveHeadingIndex（二分查找定位当前激活标题）

import { describe, it, expect } from "vitest";
import {
  parseOutline,
  extractMarkdownOutline,
  findActiveHeadingIndex,
  isSameMarkdownOutline,
  MAX_FRONTMATTER_SCAN_LINES,
  type EditorOutlineHeading,
} from "../../src/lib/outline";
import { ISSUE_382_OUTLINE_MARKDOWN } from "../fixtures/issue382Outline";

describe("parseOutline", () => {
  it("解析 ATX 风格标题 # ~ ######", () => {
    const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
    const hs = parseOutline(md);
    expect(hs).toHaveLength(6);
    expect(hs.map((h) => h.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("提取标题文本（去除 # 前缀）", () => {
    const hs = parseOutline("# 标题一\n## 标题二");
    expect(hs[0].text).toBe("标题一");
    expect(hs[1].text).toBe("标题二");
  });

  it("去除尾部 # 标记", () => {
    const hs = parseOutline("# 标题 ##\n## 副标题 ###");
    expect(hs[0].text).toBe("标题");
    expect(hs[1].text).toBe("副标题");
  });

  it("跳过围栏代码块内的 # 行（``` 围栏）", () => {
    const md = "# 真标题\n```\n# 这是代码注释\n## 也是代码\n```\n## 真副标题";
    const hs = parseOutline(md);
    expect(hs).toHaveLength(2);
    expect(hs[0].text).toBe("真标题");
    expect(hs[1].text).toBe("真副标题");
  });

  it("跳过波浪线围栏代码块内的 # 行（~~~ 围栏）", () => {
    const md = "# 真标题\n~~~\n# 代码内标题\n~~~\n## 真副标题";
    const hs = parseOutline(md);
    expect(hs).toHaveLength(2);
  });

  it("不同围栏标记互不干扰（``` 不闭合 ~~~）", () => {
    const md = "```\n~~~\n# 仍在代码块内\n```\n# 真标题";
    const hs = parseOutline(md);
    expect(hs).toHaveLength(1);
    expect(hs[0].text).toBe("真标题");
  });

  it("跳过空标题（# 后无内容）", () => {
    const md = "# \n## 真标题\n###   ";
    const hs = parseOutline(md);
    expect(hs).toHaveLength(1);
    expect(hs[0].text).toBe("真标题");
  });

  it("level 超过 6 的不匹配（# 7 个不算是标题）", () => {
    const md = "####### 七个井号不是标题\n# 真标题";
    const hs = parseOutline(md);
    expect(hs).toHaveLength(1);
    expect(hs[0].text).toBe("真标题");
  });

  it("要求 # 后有空格", () => {
    const md = "#无空格不是标题\n# 有空格是标题";
    const hs = parseOutline(md);
    expect(hs).toHaveLength(1);
    expect(hs[0].text).toBe("有空格是标题");
  });

  it("计算标题在原文中的字符偏移", () => {
    const md = "前言\n\n# 标题";
    const hs = parseOutline(md);
    expect(hs[0].offset).toBe(4); // "前言\n\n" = 4 字符
  });

  it("为每个标题生成 id（含序号和 slug）", () => {
    const hs = parseOutline("# Hello World\n## Foo Bar");
    expect(hs[0].id).toBe("h-0-hello-world");
    expect(hs[1].id).toBe("h-1-foo-bar");
  });

  it("空文本返回空数组", () => {
    expect(parseOutline("")).toEqual([]);
  });

  it("无标题的纯文本返回空数组", () => {
    expect(parseOutline("这是一段普通文本\n没有标题")).toEqual([]);
  });

  it("支持中文标题", () => {
    const hs = parseOutline("# 第一章 引言\n## 1.1 背景");
    expect(hs[0].text).toBe("第一章 引言");
    expect(hs[1].text).toBe("1.1 背景");
  });

  it("preserves underscores inside words in sidebar and exported headings", () => {
    const md =
      "# foo_bar_baz\n## foo__bar__baz\n### _foo_bar_baz_\n#### __foo_bar_baz__";
    const sidebar = extractMarkdownOutline(md);
    const exported = parseOutline(md);
    const expected = [
      { level: 1, text: "foo_bar_baz" },
      { level: 2, text: "foo__bar__baz" },
      { level: 3, text: "foo_bar_baz" },
      { level: 4, text: "foo_bar_baz" },
    ];

    expect(sidebar[0].text).toBe("foo_bar_baz");
    expect(exported[0].text).toBe("foo_bar_baz");
    expect(sidebar.map(({ level, text }) => ({ level, text }))).toEqual(expected);
    expect(exported.map(({ level, text }) => ({ level, text }))).toEqual(expected);
    expect(exported.map(({ id }) => id)).toEqual(sidebar.map(({ id }) => id));
    expect(exported.map(({ offset }) => offset)).toEqual(
      sidebar.map(({ pos }) => pos),
    );
  });

  it("缩进的 # 不算标题", () => {
    const md = "  # 缩进标题\n# 真标题";
    const hs = parseOutline(md);
    // 缩进 2 空格或制表符的不算 ATX 标题（CommonMark 规范允许最多 3 空格，但 trim() 会匹配）
    expect(hs).toHaveLength(2);
  });

  it("extractMarkdownOutline 返回与 EditorOutlineHeading 一致的结构", () => {
    const md = "# 标题一\n内容\n## 标题二\n更多内容";
    const hs = extractMarkdownOutline(md);
    expect(hs).toHaveLength(2);
    expect(hs[0]).toMatchObject({
      index: 0,
      level: 1,
      text: "标题一",
      pos: 0,
      id: "h-0-标题一",
    });
    expect(hs[1]).toMatchObject({
      index: 1,
      level: 2,
      text: "标题二",
      id: "h-1-标题二",
    });
    expect(hs[1].pos).toBeGreaterThan(0);
  });

  it("frontmatter 超限触发的当前行继续解析，并保持两种 API 的原文位置", () => {
    const md = `---\n${"metadata: value\n".repeat(MAX_FRONTMATTER_SCAN_LINES)}# **Cutoff title**`;
    const expectedOffset = md.indexOf("# **Cutoff title**");
    const sidebar = extractMarkdownOutline(md);
    const exported = parseOutline(md);

    expect(sidebar).toHaveLength(1);
    expect(sidebar[0]).toMatchObject({
      level: 1,
      text: "Cutoff title",
      pos: expectedOffset,
      line: MAX_FRONTMATTER_SCAN_LINES + 2,
    });
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      level: sidebar[0].level,
      text: sidebar[0].text,
      offset: expectedOffset,
      id: sidebar[0].id,
    });
  });

  it("未闭合 frontmatter 超过行数上限自动退出，不影响后续标题解析", () => {
    const md =
      "---\ntitle: 未闭合\n" +
      "line\n".repeat(110) +
      "# 正常标题\n正文内容";
    const hs = extractMarkdownOutline(md);
    expect(hs.length).toBeGreaterThan(0);
    expect(hs[0].text).toBe("正常标题");
    const exported = parseOutline(md);
    expect(exported.map(({ level, text, offset }) => [level, text, offset])).toEqual(
      hs.map(({ level, text, pos }) => [level, text, pos]),
    );
  });
});

describe("Issue #382 outline parser consistency", () => {
  it("keeps sidebar and export headings aligned while preserving source locations", () => {
    const sidebar = extractMarkdownOutline(ISSUE_382_OUTLINE_MARKDOWN);
    const exported = parseOutline(ISSUE_382_OUTLINE_MARKDOWN);
    const expected = [
      { level: 1, text: "Title 1 guide code" },
      { level: 2, text: "Title 2 diagram" },
    ];

    expect(sidebar.map(({ level, text }) => ({ level, text }))).toEqual(expected);
    expect(exported.map(({ level, text }) => ({ level, text }))).toEqual(expected);
    expect(exported.map(({ id }) => id)).toEqual(sidebar.map(({ id }) => id));
    expect(exported.map(({ offset }) => offset)).toEqual(
      sidebar.map(({ pos }) => pos),
    );
    expect(sidebar.map(({ line }) => line)).toEqual([4, 10]);
    expect(sidebar.map(({ pos }) => pos)).toEqual([
      ISSUE_382_OUTLINE_MARKDOWN.indexOf("# **Title 1**"),
      ISSUE_382_OUTLINE_MARKDOWN.indexOf("## ~~Title 2~~"),
    ]);
  });
});

describe("Issue #382 outline inline text cleanup", () => {
  it("保留字面量 * / ~~ 与行内代码内的字符（与渲染口径一致）", () => {
    const md = [
      "# 2 * 3 * 4 = 24",
      "# A ~~ x ~~ B",
      "# 使用 `a*` 和 `b*` 通配",
      "# 5*3*2",
      "# **Title 1** [guide](guide.md) `code`",
      "# 2 ** 3 ** 4",
      "# 填空：___",
      "# a\\*b\\*c",
      "# ***both***",
      "# **bold *italic***",
      "# *italic **bold***",
      "# ***a* b**",
      "# **a*b**",
      "# *a**b*",
      "# ~a~~",
      "# ~~a~",
      "# 1~2~~3",
      "# a*~~b~~*c",
      "# X*~~a~~*",
      "# 使用 ``a*b`` 通配",
    ].join("\n");
    const expected = [
      "2 * 3 * 4 = 24",
      "A ~~ x ~~ B",
      "使用 a* 和 b* 通配",
      "532",
      "Title 1 guide code",
      "2 ** 3 ** 4",
      "填空：___",
      "a*b*c",
      "both",
      "bold italic",
      "italic bold",
      "a b",
      "a*b",
      "a**b",
      "~a~~",
      "~~a~",
      "1~2~~3",
      "abc",
      "Xa",
      "使用 a*b 通配",
    ];

    // 渲染口径由 mdast-util-from-markdown 实测给出：两侧有空白的定界符不能开/闭，
    // 行内代码内容按字面量渲染。侧栏与导出必须与之一致，且互不漂移。
    expect(extractMarkdownOutline(md).map(({ text }) => text)).toEqual(expected);
    expect(parseOutline(md).map(({ text }) => text)).toEqual(expected);
  });

  it("字面量分隔符不改变 id 与索引，两种 API 仍一一对应", () => {
    const md = "# 2 * 3 * 4 = 24\n## A ~~ x ~~ B";
    const sidebar = extractMarkdownOutline(md);
    const exported = parseOutline(md);

    expect(exported.map(({ id }) => id)).toEqual(sidebar.map(({ id }) => id));
    expect(exported.map(({ offset }) => offset)).toEqual(
      sidebar.map(({ pos }) => pos),
    );
    expect(sidebar.map(({ index }) => index)).toEqual([0, 1]);
  });
});

describe("findActiveHeadingIndex", () => {
  // 构造测试用 headings 数组（pos 按升序，模拟真实文档）
  function makeHeadings(positions: number[]): EditorOutlineHeading[] {
    return positions.map((pos, i) => ({
      index: i,
      level: i + 1,
      text: `标题${i}`,
      pos,
      nodeId: null,
      id: `h-${i}`,
    }));
  }

  it("空数组返回 null", () => {
    expect(findActiveHeadingIndex([], 100)).toBeNull();
  });

  it("选区在第一个标题之前返回 null", () => {
    const hs = makeHeadings([50, 100, 200]);
    expect(findActiveHeadingIndex(hs, 30)).toBeNull();
  });

  it("选区正好在标题位置返回该标题", () => {
    const hs = makeHeadings([50, 100, 200]);
    expect(findActiveHeadingIndex(hs, 100)).toBe(1);
  });

  it("选区在两个标题之间返回前一个", () => {
    const hs = makeHeadings([50, 100, 200]);
    expect(findActiveHeadingIndex(hs, 150)).toBe(1);
  });

  it("选区超过最后一个标题返回最后一个", () => {
    const hs = makeHeadings([50, 100, 200]);
    expect(findActiveHeadingIndex(hs, 500)).toBe(2);
  });

  it("短路：选区等于最后一个标题位置", () => {
    const hs = makeHeadings([50, 100, 200]);
    expect(findActiveHeadingIndex(hs, 200)).toBe(2);
  });

  it("大量标题时二分查找正确", () => {
    const positions = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    const hs = makeHeadings(positions);
    // 选区在 pos=550 处，应落在第 55 个标题（index 54，pos=550）
    expect(findActiveHeadingIndex(hs, 555)).toBe(54);
    expect(findActiveHeadingIndex(hs, 555)).toBe(54);
    // 边界
    expect(findActiveHeadingIndex(hs, 10)).toBe(0);
    expect(findActiveHeadingIndex(hs, 1000)).toBe(99);
  });

  it("单个标题", () => {
    const hs = makeHeadings([100]);
    expect(findActiveHeadingIndex(hs, 50)).toBeNull();
    expect(findActiveHeadingIndex(hs, 100)).toBe(0);
    expect(findActiveHeadingIndex(hs, 200)).toBe(0);
  });
});

describe("isSameMarkdownOutline（#375 源码模式发布去重）", () => {
  const md = "# 章节 1\n\n正文。\n\n## 小节 1.1\n\n内容。\n";

  it("重新解析但结构未变时判定相同", () => {
    expect(
      isSameMarkdownOutline(
        extractMarkdownOutline(md),
        extractMarkdownOutline(md),
      ),
    ).toBe(true);
  });

  it("仅修改标题后的正文：标题集合不变", () => {
    const edited = `${md}新增正文段落。\n`;
    expect(
      isSameMarkdownOutline(
        extractMarkdownOutline(md),
        extractMarkdownOutline(edited),
      ),
    ).toBe(true);
  });

  it("标题文本、层级或数量变化时判定不同", () => {
    const base = extractMarkdownOutline(md);
    expect(
      isSameMarkdownOutline(base, extractMarkdownOutline(md.replace("小节 1.1", "小节 1.2"))),
    ).toBe(false);
    expect(
      isSameMarkdownOutline(base, extractMarkdownOutline(md.replace("## 小节 1.1", "### 小节 1.1"))),
    ).toBe(false);
    expect(
      isSameMarkdownOutline(base, extractMarkdownOutline(`${md}\n# 章节 2\n`)),
    ).toBe(false);
  });

  it("在标题上方插入内容导致行号变化时判定不同", () => {
    const shifted = `前言段落。\n\n${md}`;
    expect(
      isSameMarkdownOutline(
        extractMarkdownOutline(md),
        extractMarkdownOutline(shifted),
      ),
    ).toBe(false);
  });

  it("空大纲相同、与有标题不同", () => {
    const empty = extractMarkdownOutline("纯文本");
    expect(isSameMarkdownOutline(empty, extractMarkdownOutline("另一段纯文本"))).toBe(true);
    expect(isSameMarkdownOutline(empty, extractMarkdownOutline(md))).toBe(false);
  });
});

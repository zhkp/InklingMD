// Markdown 源码特征判定单测（Smart Paste，#229）
//
// 判定标准：至少 2 类独立信号。这里分三组锁定：
// 1. 每类信号能被单独识别（且只计一类，不会一行凑两个信号）
// 2. 典型 Markdown 源码（VS Code / GitHub / .md 文件）判定为真
// 3. 无 Markdown 语义的普通文本（中文段落、代码、邮件、单一信号）判定为假——不误判

import { describe, expect, it } from "vitest";
import {
  detectMarkdownSignals,
  looksLikeMarkdown,
  MIN_MARKDOWN_SIGNALS,
  type MarkdownSignal,
} from "../../src/components/Editor/markdown-detect";

const signals = (text: string) => [...detectMarkdownSignals(text)].sort();

describe("detectMarkdownSignals：单类信号识别", () => {
  const cases: [MarkdownSignal, string][] = [
    ["heading", "## 安装"],
    ["fence", "```ts"],
    ["fence", "~~~"],
    ["bulletList", "- 第一项"],
    ["bulletList", "* 第一项"],
    ["orderedList", "1. 第一步"],
    ["orderedList", "2) 第二步"],
    ["taskList", "- [ ] 待办"],
    ["taskList", "* [x] 完成"],
    ["blockquote", "> 引用"],
    ["table", "| a | b |\n| --- | :-: |"],
    ["table", "a | b\n--- | ---"],
    ["hr", "---"],
    ["hr", "* * *"],
    ["mathBlock", "$$"],
    ["bold", "这是 **重点** 内容"],
    ["bold", "__重点__"],
    ["strike", "~~删除~~"],
    ["inlineCode", "运行 `pnpm dev`"],
    ["link", "见 [文档](https://a.com)"],
    ["image", "![图](a.png)"],
  ];
  for (const [signal, text] of cases) {
    it(`${signal}: ${JSON.stringify(text)}`, () => {
      expect(signals(text)).toEqual([signal]);
    });
  }

  it("图片不会同时计为链接", () => {
    expect(signals('![alt](https://x/a.png "t")')).toEqual(["image"]);
  });

  it("任务列表行不会同时计为无序列表（一行凑不出两个信号）", () => {
    expect(looksLikeMarkdown("- [ ] 只有一行待办")).toBe(false);
  });

  it("同类信号重复出现只算一类", () => {
    expect(signals("- a\n- b\n- c\n+ d")).toEqual(["bulletList"]);
    expect(looksLikeMarkdown("- a\n- b\n- c")).toBe(false);
  });

  it("# 后没有空格不是标题（#tag、C#）", () => {
    expect(signals("#hashtag 与 C# 语言")).toEqual([]);
  });

  it("4 个空格以上缩进的标记不计（那是缩进代码块的内容）", () => {
    expect(signals("    # not heading\n    - not list")).toEqual([]);
  });

  it("CRLF 换行同样识别", () => {
    expect(looksLikeMarkdown("# 标题\r\n\r\n- 列表\r\n")).toBe(true);
  });
});

describe("looksLikeMarkdown：典型 Markdown 源码判定为真", () => {
  it(`阈值为 ${MIN_MARKDOWN_SIGNALS} 类独立信号`, () => {
    expect(MIN_MARKDOWN_SIGNALS).toBe(2);
  });

  it("从 VS Code 复制的 README 片段（标题 + 列表 + 代码块）", () => {
    const text = "# InklingMD\n\n一个所见即所得编辑器。\n\n- 实时预览\n- 数学公式\n\n```bash\npnpm install\n```\n";
    expect(looksLikeMarkdown(text)).toBe(true);
    expect(signals(text)).toEqual(["bulletList", "fence", "heading"]);
  });

  it("单行但含两类行内标记（粗体 + 行内代码）", () => {
    expect(looksLikeMarkdown("用 **Ctrl+V** 粘贴，或者 `mod+shift+v` 粘贴纯文本")).toBe(true);
  });

  it("GitHub issue 模板（标题 + 任务列表）", () => {
    expect(looksLikeMarkdown("### 验收标准\n\n- [ ] 快照测试\n- [x] 安全测试")).toBe(true);
  });

  it("表格 + 链接", () => {
    expect(looksLikeMarkdown("| 名称 | 链接 |\n| --- | --- |\n| 文档 | [link](https://x) |")).toBe(true);
  });

  it("引用 + 有序列表", () => {
    expect(looksLikeMarkdown("> 注意\n\n1. 第一步\n2. 第二步")).toBe(true);
  });

  it("公式块 + 标题", () => {
    expect(looksLikeMarkdown("## 推导\n\n$$\na^2+b^2=c^2\n$$")).toBe(true);
  });
});

describe("looksLikeMarkdown：普通文本不误判", () => {
  it("普通中文段落", () => {
    expect(
      looksLikeMarkdown(
        "今天天气很好，我们去公园散步。公园里有很多人，有的在跑步，有的在下棋。\n\n傍晚回家，吃了一碗面。",
      ),
    ).toBe(false);
  });

  it("空串与纯空白", () => {
    expect(looksLikeMarkdown("")).toBe(false);
    expect(looksLikeMarkdown("  \n\t ")).toBe(false);
  });

  it("单一信号：一个加粗", () => {
    expect(looksLikeMarkdown("这是 **唯一** 的标记")).toBe(false);
  });

  it("单一信号：一个链接", () => {
    expect(looksLikeMarkdown("参考 [这里](https://example.com) 的说明")).toBe(false);
  });

  it("URL、邮箱、路径", () => {
    expect(looksLikeMarkdown("https://github.com/zhkp/InklingMD/issues/229")).toBe(false);
    expect(looksLikeMarkdown("联系 pm@example.com 或查看 C:\\Users\\docs\\a_b_c.md")).toBe(false);
  });

  it("算式与单个星号（乘号、脚注标记）", () => {
    expect(looksLikeMarkdown("面积 = 长 * 宽 * 高，结果约 3*4*5 = 60")).toBe(false);
  });

  it("程序代码（没有 Markdown 结构）", () => {
    const code = "function add(a, b) {\n  // sum\n  return a + b;\n}\nconst x = arr[0];";
    expect(looksLikeMarkdown(code)).toBe(false);
  });

  it("日期与版本号开头的行", () => {
    expect(looksLikeMarkdown("2026.09.25 发布 v3.2.0\n修复若干问题")).toBe(false);
  });

  it("超大文本只扫描开头，判定仍然成立且不超时", () => {
    const big = "# 标题\n\n- 列表\n\n" + "普通文字。".repeat(200_000);
    const t0 = performance.now();
    expect(looksLikeMarkdown(big)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

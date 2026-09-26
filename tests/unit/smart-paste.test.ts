// Smart Paste 插件集成单测（#219 / #229）
//
// 驱动：无头 Milkdown（与 Editor.tsx 同款 schema）+ 真实 smartPastePlugin，在 view.dom 上派发
// paste 事件走完整的 ProseMirror 粘贴链路。「行为与现在一致」类断言一律与**未装配插件的
// 基线编辑器**对照，而不是手写期望——这样锁定的是「没有改变默认行为」本身。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  smartPastePlugin,
  MAX_PASTE_HTML_ELEMENTS,
  MAX_MARKDOWN_PASTE_CHARS,
  routeHtmlPaste,
  countHtmlElements,
  isParsableMarkdownSource,
} from "../../src/components/Editor/smart-paste";
import { useShortcuts } from "../../src/store/shortcuts";
import {
  countNodes,
  createHarness,
  findNode,
  structure,
  type Harness,
} from "../fixtures/smartPasteHarness";

const withSmartPaste = (markdown = "") =>
  createHarness({ markdown, plugins: (parse) => [smartPastePlugin({ parseMarkdown: parse })] });

const open: Harness[] = [];
async function make(markdown = "", smart = true): Promise<Harness> {
  const h = smart ? await withSmartPaste(markdown) : await createHarness({ markdown });
  open.push(h);
  return h;
}

afterEach(async () => {
  while (open.length) await open.pop()!.destroy();
  useShortcuts.getState().resetAll();
});

/** 在基线编辑器（无 Smart Paste）与 Smart Paste 编辑器上各粘贴一次，返回两者的文档 JSON */
async function pasteBoth(data: Record<string, string>, markdown = "起点") {
  const base = await make(markdown, false);
  const smart = await make(markdown, true);
  for (const h of [base, smart]) {
    h.cursorToEnd();
    h.paste(data);
  }
  return { base: base.view.state.doc.toJSON(), smart: smart.view.state.doc.toJSON(), smartHarness: smart };
}

const VSCODE_SOURCE = [
  "# 安装指南",
  "",
  "按以下步骤操作：",
  "",
  "- 克隆仓库",
  "- 安装依赖",
  "  - 需要 **pnpm**",
  "",
  "```bash",
  "pnpm install",
  "```",
  "",
  "> 注意：需要 Node 22",
  "",
  "| 命令 | 说明 |",
  "| --- | --- |",
  "| `pnpm dev` | 启动 |",
  "",
].join("\n");

describe("#229 粘贴 Markdown 源码 → 富文本", () => {
  it("VS Code 复制的源码（仅 text/plain）渲染为对应节点，而非字面文本", async () => {
    const h = await make();
    expect(h.paste({ "text/plain": VSCODE_SOURCE })).toBe(true);
    const doc = h.view.state.doc;
    expect(findNode(doc, "heading")?.attrs.level).toBe(1);
    expect(findNode(doc, "heading")?.textContent).toBe("安装指南");
    expect(countNodes(doc, "bullet_list")).toBe(2);
    expect(findNode(doc, "code_block")?.attrs.language).toBe("bash");
    expect(findNode(doc, "code_block")?.textContent).toBe("pnpm install");
    expect(countNodes(doc, "blockquote")).toBe(1);
    expect(countNodes(doc, "table")).toBe(1);
    // 没有任何一段以字面 "# " / "- " / "```" 开头
    expect(doc.textContent).not.toMatch(/#\s安装|```|\|\s---/);
  });

  it("VS Code 真实剪贴板（vscode-editor-data + 着色 span 的 text/html）按 text/plain 解析", async () => {
    const html =
      '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas;">' +
      '<div><span style="color: #569cd6;font-weight: bold;"># 安装指南</span></div><br>' +
      '<div><span style="color: #6796e6;">-</span><span> 克隆仓库</span></div></div>';
    const h = await make();
    h.paste({
      "text/plain": "# 安装指南\n\n- 克隆仓库\n",
      "text/html": html,
      "vscode-editor-data": '{"version":1,"mode":"markdown"}',
    });
    expect(findNode(h.view.state.doc, "heading")?.textContent).toBe("安装指南");
    expect(findNode(h.view.state.doc, "bullet_list")).toBeTruthy();
  });

  it("其他编辑器的无结构着色 HTML（只有 div/span/pre）同样按 text/plain 的 Markdown 解析", async () => {
    const h = await make();
    h.paste({
      "text/plain": "## 标题\n\n1. 步骤一\n2. 步骤二",
      "text/html": '<pre style="color:#a9b7c6"><span style="color:#cc7832">## 标题</span>\n\n1. 步骤一\n2. 步骤二</pre>',
    });
    expect(findNode(h.view.state.doc, "heading")?.attrs.level).toBe(2);
    expect(findNode(h.view.state.doc, "ordered_list")).toBeTruthy();
  });

  it("普通中文段落（无 Markdown 特征）：与未装配 Smart Paste 的行为完全一致", async () => {
    const text = "今天天气很好，我们去公园散步。\n公园里有很多人，有的在跑步，有的在下棋。";
    const { base, smart } = await pasteBoth({ "text/plain": text });
    expect(smart).toEqual(base);
  });

  it("只有一类信号的文本（几行 `- `）不误判，与基线一致", async () => {
    const { base, smart } = await pasteBoth({ "text/plain": "- 买菜\n- 做饭\n- 洗碗" });
    expect(smart).toEqual(base);
  });

  it("单行行内 Markdown 粘进段落中间：与所在段落合并，不另起块", async () => {
    const h = await make("前后");
    h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)));
    h.paste({ "text/plain": "**粗体** 与 `代码`" });
    const doc = h.view.state.doc;
    expect(doc.childCount).toBe(1);
    expect(doc.textContent).toBe("前粗体 与 代码后");
    expect(structure(doc)).toEqual(["paragraph", "text", "text[strong]", "text", "text[inlineCode]", "text"]);
  });

  it("块级内容粘在非空段落末尾：标题保持标题，不被并进当前段落", async () => {
    const h = await make("已有内容");
    h.cursorToEnd();
    h.paste({ "text/plain": "## 新章节\n\n- 要点" });
    const doc = h.view.state.doc;
    expect(doc.child(0).textContent).toBe("已有内容");
    expect(doc.child(1).type.name).toBe("heading");
    expect(doc.child(1).textContent).toBe("新章节");
  });

  it("空文档中粘贴：标题替换空段落，不留多余空行", async () => {
    const h = await make("");
    h.paste({ "text/plain": "# 标题\n\n正文 **粗**" });
    expect(h.view.state.doc.child(0).type.name).toBe("heading");
  });

  it("往返保真：粘贴结果 serialize 后再 parse，结构与源 Markdown 语义等价", async () => {
    const h = await make();
    h.paste({ "text/plain": VSCODE_SOURCE });
    const pasted = h.view.state.doc;
    const md = h.markdown();
    expect(structure(h.parse(md))).toEqual(structure(pasted));
    // 与直接打开这份 Markdown 文件的解析结果结构一致
    expect(structure(pasted)).toEqual(structure(h.parse(VSCODE_SOURCE)));
    // 二次序列化幂等
    expect(h.serialize(h.parse(md))).toBe(md);
  });

  it("光标在代码块内：保持纯文本插入，不解析 Markdown", async () => {
    const h = await make("```js\nconst a = 1;\n```");
    h.cursorToEnd();
    h.paste({ "text/plain": "# 不是标题\n\n- 不是列表" });
    expect(countNodes(h.view.state.doc, "code_block")).toBe(1);
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    expect(findNode(h.view.state.doc, "code_block")?.textContent).toContain("# 不是标题");
  });

  it("光标在表格单元格内：不做 Markdown 转换（交给表格自身的粘贴逻辑）", async () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const base = await make(md, false);
    const smart = await make(md, true);
    for (const h of [base, smart]) {
      // 光标放进第一个数据单元格
      let cellPos = -1;
      h.view.state.doc.descendants((n, pos) => {
        if (cellPos < 0 && n.type.name === "table_cell") cellPos = pos + 2;
        return cellPos < 0;
      });
      h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, cellPos)));
      h.paste({ "text/plain": "**x** 和 `y`" });
    }
    expect(smart.view.state.doc.toJSON()).toEqual(base.view.state.doc.toJSON());
  });

  it("「粘贴为纯文本」路径（plainText=true）：即使是 Markdown 也按字面插入", async () => {
    const h = await make();
    h.view.pasteText("# 字面标题\n\n- 字面列表");
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    expect(h.view.state.doc.textContent).toContain("# 字面标题");
  });

  it("Markdown 里的危险链接被剥掉链接、保留文字", async () => {
    const h = await make();
    h.paste({ "text/plain": "**危险** [点我](javascript:alert(1)) 与 [安全](docs/a.md)" });
    const hrefs: string[] = [];
    h.view.state.doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === "link") hrefs.push(m.attrs.href);
      return true;
    });
    expect(hrefs).toEqual(["docs/a.md"]);
    expect(h.view.state.doc.textContent).toContain("点我");
  });
  it("Markdown 粘贴：输入 → 粘贴 → 输入，撤销依次回退，粘贴整体一步撤销、可重做", async () => {
    const h = await make("开头");
    h.cursorToEnd();
    h.type("A");
    h.paste({ "text/plain": "# 标题\n\n- 一\n- 二" });
    const afterPaste = h.view.state.doc.toJSON();
    h.type("Z");
    h.undo(); // 撤掉 Z
    expect(h.view.state.doc.toJSON()).toEqual(afterPaste);
    h.undo(); // 一步撤掉整个粘贴
    expect(h.view.state.doc.textContent).toBe("开头A");
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    h.redo();
    expect(h.view.state.doc.toJSON()).toEqual(afterPaste);
  });
});

describe("Markdown 源码解析的长度上限（主线程保护，#245 review）", () => {
  /** 构造恰好 n 个字符、命中多类信号的 Markdown 源码 */
  function markdownOfLength(n: number): string {
    const unit = "## 小节\n\n正文 **粗体** 与 `代码`。\n\n- 列表项\n\n";
    const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
    return text;
  }

  // 以下三例处理 64K~200K 字符的文本：隔离运行约 0.5~1.7s，全量套件并行负载下会被放大
  // 数倍而越过 vitest 默认 5s 超时（#245 复审实测 6.7s / 7.3s），显式给出预算，
  // 与 smart-paste-fixtures.test.ts 的 beforeAll(..., 30_000) 惯例一致
  const HEAVY_TIMEOUT = 30_000;

  it(`上限为 ${MAX_MARKDOWN_PASTE_CHARS} 字符，与特征判定的扫描上限一致`, () => {
    expect(MAX_MARKDOWN_PASTE_CHARS).toBe(64 * 1024);
    expect(isParsableMarkdownSource(markdownOfLength(MAX_MARKDOWN_PASTE_CHARS))).toBe(true);
    expect(isParsableMarkdownSource(markdownOfLength(MAX_MARKDOWN_PASTE_CHARS + 1))).toBe(false);
  });

  it("恰好等于上限：仍按 Markdown 解析", async () => {
    const h = await make("");
    h.paste({ "text/plain": markdownOfLength(MAX_MARKDOWN_PASTE_CHARS) });
    expect(countNodes(h.view.state.doc, "heading")).toBeGreaterThan(0);
  }, HEAVY_TIMEOUT);

  it("超过上限：整体降级为纯文本，与未装配 Smart Paste 的行为完全一致", async () => {
    const { base, smart } = await pasteBoth({ "text/plain": markdownOfLength(MAX_MARKDOWN_PASTE_CHARS + 1) });
    expect(smart).toEqual(base);
  }, HEAVY_TIMEOUT);

  it("超大文本：Markdown 解析器根本不被调用（真实耗时见 E2E SP9）", async () => {
    const parseCalls: number[] = [];
    const h = await createHarness({
      plugins: (parse) => [
        smartPastePlugin({
          parseMarkdown: (md) => {
            parseCalls.push(md.length);
            return parse(md);
          },
        }),
      ],
    });
    open.push(h);
    h.paste({ "text/plain": markdownOfLength(200_000) });
    expect(parseCalls).toEqual([]);
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    // 对照：上限内的同类文本会调用解析器
    h.paste({ "text/plain": markdownOfLength(1024) });
    expect(parseCalls).toEqual([1024]);
  }, HEAVY_TIMEOUT);

  it("VS Code / IDE 着色 HTML 路由同样受上限约束", () => {
    const over = markdownOfLength(MAX_MARKDOWN_PASTE_CHARS + 1);
    expect(routeHtmlPaste("<div>x</div>", over, ["vscode-editor-data"]).kind).toBe("default");
    expect(routeHtmlPaste("<div><span>x</span></div>", over).kind).toBe("default");
    const within = markdownOfLength(1024);
    expect(routeHtmlPaste("<div>x</div>", within, ["vscode-editor-data"]).kind).toBe("markdown-text");
  });
});

describe("不改变既有行为", () => {
  it("无 Markdown 特征的纯文本：与未装配 Smart Paste 的行为完全一致", async () => {
    for (const text of ["今天天气很好，我们去公园散步。\n公园里有很多人。", "function add(a, b) {\n  return a + b;\n}"]) {
      const { base, smart } = await pasteBoth({ "text/plain": text });
      expect(smart).toEqual(base);
    }
  });

  it("代码编辑器复制的无结构着色 HTML，且 text/plain 不是 Markdown：交还默认处理，与基线一致", async () => {
    const html =
      '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas;">' +
      '<div><span style="color: #569cd6;">const</span><span> a = 1;</span></div></div>';
    const { base, smart } = await pasteBoth({ "text/html": html, "text/plain": "const a = 1;" });
    expect(smart).toEqual(base);
  });

  it("光标在代码块内：保持纯文本插入，不做 HTML 转换", async () => {
    const h = await make("```js\nconst a = 1;\n```");
    h.cursorToEnd();
    h.paste({ "text/html": "<h1>不是标题</h1>", "text/plain": "# 不是标题" });
    expect(countNodes(h.view.state.doc, "code_block")).toBe(1);
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    expect(findNode(h.view.state.doc, "code_block")?.textContent).toContain("# 不是标题");
  });

  it("光标在表格单元格内：不做 HTML 转换（交给表格自身的粘贴逻辑），与基线一致", async () => {
    const md = "| a | b |\n| --- | --- |\n| 1 | 2 |\n";
    const base = await make(md, false);
    const smart = await make(md, true);
    for (const h of [base, smart]) {
      let cellPos = -1;
      h.view.state.doc.descendants((n, pos) => {
        if (cellPos < 0 && n.type.name === "table_cell") cellPos = pos + 2;
        return cellPos < 0;
      });
      h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, cellPos)));
      h.paste({ "text/html": "<b>x</b> 和 <code>y</code>", "text/plain": "x 和 y" });
    }
    expect(smart.view.state.doc.toJSON()).toEqual(base.view.state.doc.toJSON());
  });
});

describe("块边界与撤销", () => {
  it("行内 HTML 粘进段落中间：与所在段落合并，不另起块", async () => {
    const h = await make("前后");
    h.view.dispatch(h.view.state.tr.setSelection(TextSelection.create(h.view.state.doc, 2)));
    h.paste({ "text/html": "<b>粗体</b> 与 <code>代码</code>", "text/plain": "粗体 与 代码" });
    const doc = h.view.state.doc;
    expect(doc.childCount).toBe(1);
    expect(doc.textContent).toBe("前粗体 与 代码后");
    expect(structure(doc)).toEqual(["paragraph", "text", "text[strong]", "text", "text[inlineCode]", "text"]);
  });

  it("块级内容粘在非空段落末尾：标题保持标题，不被并进当前段落", async () => {
    const h = await make("已有内容");
    h.cursorToEnd();
    h.paste({ "text/html": "<h2>新章节</h2><ul><li>要点</li></ul>", "text/plain": "新章节 要点" });
    const doc = h.view.state.doc;
    expect(doc.child(0).textContent).toBe("已有内容");
    expect(doc.child(1).type.name).toBe("heading");
    expect(doc.child(1).textContent).toBe("新章节");
  });

  it("空文档中粘贴：标题替换空段落，不留多余空行", async () => {
    const h = await make("");
    h.paste({ "text/html": "<h1>标题</h1><p>正文</p>", "text/plain": "标题 正文" });
    expect(h.view.state.doc.child(0).type.name).toBe("heading");
  });

  it("一次粘贴 = 一个撤销步：输入 → 粘贴 → 输入，撤销依次回退，粘贴整体一步撤销、可重做", async () => {
    const h = await make("开头");
    h.cursorToEnd();
    h.type("A");
    h.paste({ "text/html": "<h2>标题</h2><ul><li>甲</li><li>乙</li></ul><pre>code</pre>", "text/plain": "标题" });
    const afterPaste = h.view.state.doc.toJSON();
    h.type("Z");
    h.undo(); // 撤掉 Z
    expect(h.view.state.doc.toJSON()).toEqual(afterPaste);
    h.undo(); // 一步撤掉整个粘贴
    expect(h.view.state.doc.textContent).toBe("开头A");
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    h.redo();
    expect(h.view.state.doc.toJSON()).toEqual(afterPaste);
  });

  it("往返保真：粘贴结果 serialize 后再 parse，结构不变且二次序列化幂等", async () => {
    const h = await make();
    h.paste({
      "text/html": "<h2>章节</h2><p>正文 <b>粗</b></p><ol><li>一<ul><li>子</li></ul></li></ol><blockquote><p>引用</p></blockquote>",
      "text/plain": "x",
    });
    const md = h.markdown();
    expect(structure(h.parse(md))).toEqual(structure(h.view.state.doc));
    expect(h.serialize(h.parse(md))).toBe(md);
  });
});

describe("#219 网页富文本 HTML → Markdown 结构", () => {
  it("网页 HTML 粘贴得到对应节点，脚本与事件处理器不进入文档", async () => {
    const h = await make();
    h.paste({
      "text/html":
        '<h2 onclick="evil()">章节</h2><p>正文 <b>粗</b> <a href="https://a.com">链接</a></p>' +
        "<script>window.__pasted = 1</script><table><tr><th>a</th></tr><tr><td>1</td></tr></table>",
      "text/plain": "章节 正文",
    });
    const doc = h.view.state.doc;
    expect(findNode(doc, "heading")?.textContent).toBe("章节");
    expect(countNodes(doc, "table")).toBe(1);
    expect(doc.textContent).not.toContain("__pasted");
    expect(countNodes(doc, "html")).toBe(0);
  });

  it("编辑器内部复制（data-pm-slice）不做二次转换：与默认行为一致", async () => {
    const html =
      '<meta charset="utf-8"><h2 data-pm-slice="1 1 []">内部</h2><p>复制 <strong>内容</strong></p>';
    const { base, smart } = await pasteBoth({ "text/html": html, "text/plain": "内部 复制 内容" });
    expect(smart).toEqual(base);
  });

  it(`元素超过 ${MAX_PASTE_HTML_ELEMENTS}：整体降级为纯文本段落，且不做结构映射`, async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `<p><b>行${i}</b></p>`).join("");
    expect(countHtmlElements(rows)).toBeGreaterThan(MAX_PASTE_HTML_ELEMENTS);
    const text = Array.from({ length: 3000 }, (_, i) => `行${i}`).join("\n");
    const h = await make("");
    const t0 = performance.now();
    h.paste({ "text/html": rows, "text/plain": text });
    const elapsed = performance.now() - t0;
    const doc = h.view.state.doc;
    expect(doc.childCount).toBe(3000);
    let hasStrong = false;
    doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === "strong")) hasStrong = true;
      return true;
    });
    expect(hasStrong).toBe(false);
    // 主线程保护：跳过清洗与映射，远快于逐元素转换（宽松上限，只防退化）
    expect(elapsed).toBeLessThan(3000);
  });

  it("超限且没有 text/plain 时从 HTML 提取纯文本", async () => {
    const html = Array.from({ length: MAX_PASTE_HTML_ELEMENTS + 1 }, (_, i) => `<span>${i % 10}</span>`).join("");
    const h = await make("");
    h.paste({ "text/html": html });
    expect(h.view.state.doc.textContent.length).toBe(MAX_PASTE_HTML_ELEMENTS + 1);
  });

  it("转换结果为空（只有被清洗掉的内容）时回退默认行为", () => {
    expect(routeHtmlPaste("<script>void 0</script><style>p{}</style>", "")).toEqual({ kind: "default" });
  });

  it("路由判定：内部复制 / VS Code / 超限 / 无结构 / 转换", () => {
    expect(routeHtmlPaste('<p data-pm-slice="0 0 []">x</p>', "x").kind).toBe("default");
    expect(routeHtmlPaste("<div>x</div>", "# a\n\n- b", ["text/plain", "text/html", "vscode-editor-data"]).kind).toBe(
      "markdown-text",
    );
    expect(routeHtmlPaste("<div>x</div>", "普通文字", ["vscode-editor-data"]).kind).toBe("default");
    expect(routeHtmlPaste("<span>x</span>".repeat(MAX_PASTE_HTML_ELEMENTS + 1), "").kind).toBe("plain-text");
    expect(routeHtmlPaste("<div><span>普通</span></div>", "普通").kind).toBe("default");
    expect(routeHtmlPaste("<h1>标题</h1>", "标题")).toEqual({ kind: "convert", markdown: "# 标题" });
  });
});

describe("粘贴为纯文本（mod+shift+v，可自定义）", () => {
  const keydown = (h: Harness, init: KeyboardEventInit) =>
    h.view.dom.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

  let readText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    readText = vi.fn().mockResolvedValue("# 剪贴板标题\n\n- 剪贴板列表");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText } });
  });

  it("默认组合：随后的原生 paste 事件按纯文本插入（HTML 与 Markdown 都不转换）", async () => {
    const h = await make();
    keydown(h, { key: "V", ctrlKey: true, shiftKey: true });
    h.paste({ "text/html": "<h1>富文本标题</h1>", "text/plain": "# 纯文本\n\n- 列表" });
    const doc = h.view.state.doc;
    expect(countNodes(doc, "heading")).toBe(0);
    expect(countNodes(doc, "bullet_list")).toBe(0);
    expect(doc.textContent).toContain("# 纯文本");
    // 原生 paste 已处理，兜底计时器不应再读剪贴板
    await new Promise((r) => setTimeout(r, 80));
    expect(readText).not.toHaveBeenCalled();
  });

  it("默认组合但平台不派发 paste 事件（macOS）：兜底读剪贴板按纯文本插入，且吞掉迟到的原生 paste", async () => {
    const h = await make();
    keydown(h, { key: "V", ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.view.state.doc.textContent).toContain("# 剪贴板标题"));
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    // 迟到的原生 paste 不得造成重复粘贴
    const before = h.view.state.doc.textContent;
    h.paste({ "text/plain": "# 迟到" });
    expect(h.view.state.doc.textContent).toBe(before);
  });

  it("自定义绑定（mod+alt+v）：直接读剪贴板按纯文本插入", async () => {
    useShortcuts.getState().setBinding("pastePlainText", "mod+alt+v");
    const h = await make();
    keydown(h, { key: "v", ctrlKey: true, altKey: true });
    await vi.waitFor(() => expect(h.view.state.doc.textContent).toContain("# 剪贴板标题"));
    expect(countNodes(h.view.state.doc, "heading")).toBe(0);
    // 原默认组合不再触发
    readText.mockClear();
    keydown(h, { key: "V", ctrlKey: true, shiftKey: true });
    await new Promise((r) => setTimeout(r, 80));
    expect(readText).not.toHaveBeenCalled();
  });

  it("普通 Ctrl+V 不受影响：仍然走 Smart Paste", async () => {
    const h = await make();
    keydown(h, { key: "v", ctrlKey: true });
    h.paste({ "text/html": "<h2>标题</h2><ul><li>列表</li></ul>", "text/plain": "标题 列表" });
    expect(countNodes(h.view.state.doc, "heading")).toBe(1);
  });
});

describe("页面自带的私有区字符（U+E000~U+E006）经完整链路原样保留（#244 review）", () => {
  const raw = Array.from({ length: 7 }, (_, i) => String.fromCodePoint(0xe000 + i)).join("");
  const refs = Array.from({ length: 7 }, (_, i) => `&#x${(0xe000 + i).toString(16)};`).join("");

  it("正文/标题/表格中的图标字符原样进入文档，不产生加粗、斜体、删除线或硬换行", async () => {
    const h = await make("");
    h.paste({
      "text/html":
        `<h2>标题${refs}</h2><p>图标${refs}结尾 <b>真粗</b></p>` +
        `<table><tr><th>h${refs}</th></tr><tr><td>c</td></tr></table>`,
      "text/plain": "x",
    });
    const doc = h.view.state.doc;
    expect(findNode(doc, "heading")?.textContent).toBe(`标题${raw}`);
    expect(findNode(doc, "paragraph")?.textContent).toBe(`图标${raw}结尾 真粗`);
    expect(findNode(doc, "table_header")?.textContent).toBe(`h${raw}`);
    expect(countNodes(doc, "hardbreak")).toBe(0);
    const marked: string[] = [];
    doc.descendants((n) => {
      if (n.isText && n.marks.length) marked.push(`${n.marks.map((m) => m.type.name).join("+")}:${n.text}`);
      return true;
    });
    expect(marked).toEqual(["strong:真粗"]);
  });

  it("图片 alt / 链接地址中的图标字符原样保留", async () => {
    const h = await make("");
    h.paste({ "text/html": `<p><a href="https://a/${refs}">链${refs}</a><img src="https://b/${refs}.png" alt="图${refs}"></p>`, "text/plain": "x" });
    const img = findNode(h.view.state.doc, "image")!;
    expect(img.attrs.alt).toBe(`图${raw}`);
    expect(img.attrs.src).toBe(`https://b/${raw}.png`);
    let href = "";
    h.view.state.doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === "link") href = m.attrs.href;
      return true;
    });
    expect(href).toBe(`https://a/${raw}`);
  });

  it("保存后重新打开（serialize → parse）字符依然在、结构不变", async () => {
    const h = await make("");
    h.paste({ "text/html": `<p>图标${refs}结尾 <b>粗${refs}</b>后</p>`, "text/plain": "x" });
    const reparsed = h.parse(h.markdown());
    expect(reparsed.textContent).toBe(h.view.state.doc.textContent);
    expect(reparsed.textContent).toContain(raw);
    expect(structure(reparsed)).toEqual(structure(h.view.state.doc));
  });
});

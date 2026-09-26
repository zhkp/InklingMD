// Smart Paste 插件集成单测（#219）
//
// 驱动：无头 Milkdown（与 Editor.tsx 同款 schema）+ 真实 smartPastePlugin，在 view.dom 上派发
// paste 事件走完整的 ProseMirror 粘贴链路。「行为与现在一致」类断言一律与**未装配插件的
// 基线编辑器**对照，而不是手写期望——这样锁定的是「没有改变默认行为」本身。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TextSelection } from "@milkdown/kit/prose/state";
import { smartPastePlugin, MAX_PASTE_HTML_ELEMENTS, routeHtmlPaste, countHtmlElements } from "../../src/components/Editor/smart-paste";
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

describe("不改变既有行为", () => {
  it("纯文本粘贴（即使内容像 Markdown）：与未装配 Smart Paste 的行为完全一致", async () => {
    for (const text of ["今天天气很好，我们去公园散步。\n公园里有很多人。", "# 标题\n\n- 列表\n\n```js\nx\n```"]) {
      const { base, smart } = await pasteBoth({ "text/plain": text });
      expect(smart).toEqual(base);
    }
  });

  it("代码编辑器复制的无结构着色 HTML（VS Code）：交还默认处理，与基线一致", async () => {
    const html =
      '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas;">' +
      '<div><span style="color: #569cd6;"># 安装指南</span></div><div><span>- 克隆仓库</span></div></div>';
    const { base, smart } = await pasteBoth({ "text/html": html, "text/plain": "# 安装指南\n- 克隆仓库" });
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
    expect(routeHtmlPaste("<script>void 0</script><style>p{}</style>")).toEqual({ kind: "default" });
  });

  it("路由判定：内部复制 / VS Code / 超限 / 无结构 / 转换", () => {
    expect(routeHtmlPaste('<p data-pm-slice="0 0 []">x</p>').kind).toBe("default");
    expect(routeHtmlPaste("<h1>x</h1>", ["text/plain", "text/html", "vscode-editor-data"]).kind).toBe("default");
    expect(routeHtmlPaste("<span>x</span>".repeat(MAX_PASTE_HTML_ELEMENTS + 1)).kind).toBe("plain-text");
    expect(routeHtmlPaste("<div><span>普通</span></div>").kind).toBe("default");
    expect(routeHtmlPaste("<h1>标题</h1>")).toEqual({ kind: "convert", markdown: "# 标题" });
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

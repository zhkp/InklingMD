// #373 回归：导出 / 富文本复制的 DOM 快照必须**结构性**清掉编辑态控件，
// 且控件承载的内容要以 ProseMirror 文档为准重建（克隆 DOM 不完整）。
//
// 用例直接复刻 issue 里点名的每一个症状：语言下拉、CodeMirror 行号栏与
// contenteditable、Mermaid 工具栏、图片缩放手柄、未渲染占位块。

import { describe, it, expect, vi } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import type { Node } from "@milkdown/kit/prose/model";
import {
  buildExportSnapshot,
  type ExportSnapshotInput,
} from "../../src/lib/exportSnapshot";

// 默认渲染器（不注入 renderMermaid 时）必须真实走 mermaid-view 的缓存渲染 + 安全清洗。
// 只 mock 这一层：`defaultRenderMermaid` 本身是被测代码，动态 import 由 vi.mock 接管。
const { renderWithSeqMock, sanitizeMock } = vi.hoisted(() => ({
  renderWithSeqMock:
    vi.fn<(code: string, seq: number, getCurrentSeq: () => number) => Promise<string | null>>(),
  sanitizeMock: vi.fn<(svgHtml: string) => globalThis.Node>(),
}));
vi.mock("../../src/components/Editor/mermaid-view", () => ({
  renderMermaidWithSeq: renderWithSeqMock,
  sanitizeMermaidSvg: sanitizeMock,
}));

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      attrs: { language: { default: "" } },
      toDOM: () => ["pre", 0],
    },
    frontmatter: {
      group: "block",
      atom: true,
      attrs: { value: { default: "" } },
      toDOM: () => ["div", { "data-frontmatter": "" }],
    },
  },
});

/** 顶层子节点的起始位置（`doc.forEach` 顺序即 `descendants` 报告顶层节点的顺序） */
function topLevelPositions(doc: Node): number[] {
  const out: number[] = [];
  let pos = 0;
  doc.forEach((child) => {
    out.push(pos);
    pos += child.nodeSize;
  });
  return out;
}

/**
 * 复刻 CodeMirror 挂载后的真实 DOM 形状：行号栏 + **虚拟化**的 `.cm-content`。
 * `mountedLines` 只给视口内那几行——这正是「直接克隆会静默截断长代码块」的根因。
 */
function mountedCodeBlockDOM(language: string, mountedLines: string[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "code-block";
  root.setAttribute("data-code-theme", "oneDark");

  const toolbar = document.createElement("div");
  toolbar.className = "code-block-toolbar";
  const select = document.createElement("select");
  select.className = "code-block-lang";
  for (const name of ["text", language]) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  toolbar.appendChild(select);
  root.appendChild(toolbar);

  const host = document.createElement("div");
  host.className = "code-block-cm";
  const cm = document.createElement("div");
  cm.className = "cm-editor";
  const gutters = document.createElement("div");
  gutters.className = "cm-gutters";
  gutters.setAttribute("aria-hidden", "true");
  const gutterLine = document.createElement("div");
  gutterLine.className = "cm-gutterElement";
  gutterLine.textContent = "1";
  gutters.appendChild(gutterLine);
  const content = document.createElement("div");
  content.className = "cm-content";
  content.setAttribute("contenteditable", "true");
  content.setAttribute("role", "textbox");
  for (const line of mountedLines) {
    const el = document.createElement("div");
    el.className = "cm-line";
    el.textContent = line;
    content.appendChild(el);
  }
  cm.append(gutters, content);
  host.appendChild(cm);
  root.appendChild(host);
  return root;
}

/** 复刻懒挂载（视口外）代码块：只有纯文本占位，没有 CodeMirror */
function unmountedCodeBlockDOM(fullText: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "code-block";
  root.setAttribute("data-code-theme", "oneDark");
  const toolbar = document.createElement("div");
  toolbar.className = "code-block-toolbar";
  toolbar.appendChild(document.createElement("select"));
  root.appendChild(toolbar);
  const host = document.createElement("div");
  host.className = "code-block-cm";
  const pre = document.createElement("pre");
  pre.className = "code-block-placeholder";
  pre.textContent = fullText;
  host.appendChild(pre);
  root.appendChild(host);
  return root;
}

function frontmatterDOM(value: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "frontmatter-block";
  root.setAttribute("data-frontmatter", "");
  root.setAttribute("data-value", value);
  const label = document.createElement("div");
  label.className = "frontmatter-label";
  label.textContent = "YAML Front Matter";
  const host = document.createElement("div");
  host.className = "frontmatter-cm";
  const cm = document.createElement("div");
  cm.className = "cm-editor";
  const content = document.createElement("div");
  content.className = "cm-content";
  content.setAttribute("contenteditable", "true");
  cm.appendChild(content);
  host.appendChild(cm);
  root.append(label, host);
  return root;
}

function mermaidDOM(opts: {
  svg?: string;
  transform?: string;
  minHeight?: string;
  hasError?: boolean;
  placeholder?: string;
  /** 这份 SVG 对应的源码（生产侧渲染成功时写入 data-source） */
  source?: string;
  /** 编辑态：图表被 display:none 隐藏 */
  hidden?: boolean;
}): HTMLElement {
  const root = document.createElement("div");
  root.className = "mermaid-block";
  root.setAttribute("data-mermaid", "");
  const diagram = document.createElement("div");
  diagram.className = "mermaid-render";
  if (opts.hasError) diagram.classList.add("has-error");
  if (opts.minHeight) diagram.style.minHeight = opts.minHeight;
  if (opts.placeholder) diagram.setAttribute("data-placeholder", opts.placeholder);
  if (opts.source !== undefined) diagram.dataset.source = opts.source;
  if (opts.hidden) diagram.style.display = "none";
  if (opts.svg) {
    const holder = document.createElement("div");
    // 用 innerHTML 只为构造夹具（不是被测代码路径）
    holder.innerHTML = opts.svg;
    const svg = holder.firstElementChild!;
    if (opts.transform) {
      (svg as HTMLElement).style.transform = opts.transform;
      (svg as HTMLElement).style.transformOrigin = "center";
    }
    diagram.appendChild(svg);
  } else if (opts.hasError) {
    const pre = document.createElement("pre");
    pre.className = "mermaid-error";
    pre.textContent = "Mermaid 语法错误，点击「编辑」修改";
    diagram.appendChild(pre);
  }
  root.appendChild(diagram);

  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-toolbar";
  toolbar.setAttribute("contenteditable", "false");
  for (const label of ["编辑", "下载"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = label;
    toolbar.appendChild(btn);
  }
  root.appendChild(toolbar);

  const editor = document.createElement("textarea");
  editor.className = "mermaid-editor";
  editor.style.display = "none";
  root.appendChild(editor);
  return root;
}

function imageDOM(src: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "milkdown-image-wrap";
  wrap.setAttribute("data-image-wrap", "");
  wrap.style.display = "inline-block";
  const img = document.createElement("img");
  img.className = "milkdown-image";
  img.setAttribute("src", src);
  img.setAttribute("alt", "示意图");
  img.setAttribute("loading", "lazy");
  img.setAttribute("referrerpolicy", "no-referrer");
  const handle = document.createElement("span");
  handle.className = "image-resize-handle";
  handle.setAttribute("contenteditable", "false");
  handle.title = "拖拽缩放";
  wrap.append(img, handle);
  return wrap;
}

/** 把「文档 + 每个顶层块对应的 NodeView DOM」组装成 buildExportSnapshot 的输入 */
function makeInput(doc: Node, doms: HTMLElement[]): ExportSnapshotInput {
  const liveRoot = document.createElement("div");
  liveRoot.className = "milkdown ProseMirror";
  liveRoot.setAttribute("contenteditable", "true");
  liveRoot.setAttribute("role", "textbox");
  for (const dom of doms) liveRoot.appendChild(dom);

  const positions = topLevelPositions(doc);
  return {
    liveRoot,
    doc,
    nodeDOM: (pos) => {
      const i = positions.indexOf(pos);
      return i >= 0 ? doms[i] : null;
    },
  };
}

const LONG_CODE = Array.from({ length: 120 }, (_, i) => `const line${i + 1} = ${i + 1};`).join(
  "\n",
);

describe("#373 代码块：源码取自文档，编辑态控件结构性删除", () => {
  function fixture(mounted: boolean) {
    const para = schema.node("paragraph", null, [schema.text("正文段落")]);
    const code = schema.node("code_block", { language: "typescript" }, [schema.text(LONG_CODE)]);
    const doc = schema.node("doc", null, [para, code]);
    const paragraphDOM = document.createElement("p");
    paragraphDOM.textContent = "正文段落";
    const codeDOM = mounted
      ? mountedCodeBlockDOM("typescript", LONG_CODE.split("\n").slice(0, 3))
      : unmountedCodeBlockDOM(LONG_CODE);
    return { input: makeInput(doc, [paragraphDOM, codeDOM]), codeDOM, paragraphDOM };
  }

  it("已挂载的 CodeMirror 块导出完整源码（克隆 DOM 只有视口内 3 行 → 原实现的静默截断）", async () => {
    const { input } = fixture(true);
    const { root } = await buildExportSnapshot(input);
    const exported = root.querySelector("pre.code-block-export code");
    expect(exported, "应重建为 <pre class=code-block-export><code>").not.toBeNull();
    expect(exported!.textContent).toBe(LONG_CODE);
    expect(exported!.textContent!.split("\n")).toHaveLength(120);
  });

  it("语言写到 code 的 class 上（原来只存在于被删掉的下拉框里）", async () => {
    const { input } = fixture(true);
    const { root } = await buildExportSnapshot(input);
    expect(root.querySelector("code")!.className).toBe("language-typescript");
  });

  it("围栏 info 带附加参数时只取语言 token，且非法字符不进 class", async () => {
    const code = schema.node("code_block", { language: 'js title="a b" onclick=x' }, [
      schema.text("var a = 1;"),
    ]);
    const doc = schema.node("doc", null, [code]);
    const { root } = await buildExportSnapshot(
      makeInput(doc, [mountedCodeBlockDOM("js", ["var a = 1;"])]),
    );
    expect(root.querySelector("code")!.className).toBe("language-js");
  });

  it("语言为空时不写 language- class", async () => {
    const code = schema.node("code_block", { language: "" }, [schema.text("plain")]);
    const doc = schema.node("doc", null, [code]);
    const { root } = await buildExportSnapshot(
      makeInput(doc, [mountedCodeBlockDOM("", ["plain"])]),
    );
    expect(root.querySelector("code")!.className).toBe("");
  });

  it("未挂载（视口外）的块同样导出完整源码，占位 <pre> 不残留", async () => {
    const { input } = fixture(false);
    const { root } = await buildExportSnapshot(input);
    expect(root.querySelector("pre.code-block-export code")!.textContent).toBe(LONG_CODE);
    expect(root.querySelector(".code-block-placeholder")).toBeNull();
  });

  it("编辑态控件全部消失：语言下拉 / 行号栏 / cm-content / contenteditable / 占位", async () => {
    for (const mounted of [true, false]) {
      const { root } = await buildExportSnapshot(fixture(mounted).input);
      expect(root.querySelector(".code-block-toolbar")).toBeNull();
      expect(root.querySelector("select")).toBeNull();
      expect(root.querySelector(".code-block-cm")).toBeNull();
      expect(root.querySelector(".cm-gutters")).toBeNull();
      expect(root.querySelector(".cm-content")).toBeNull();
      expect(root.querySelector(".cm-line")).toBeNull();
      expect(root.querySelector("[contenteditable]"), "产物里不得残留任何 contenteditable").toBeNull();
      expect(root.querySelector("[role='textbox']")).toBeNull();
    }
  });

  it("保留代码块主题锚点 data-code-theme（#226 主题一致性）与正文内容", async () => {
    const { input } = fixture(true);
    const { root } = await buildExportSnapshot(input);
    expect(root.querySelector(".code-block")!.getAttribute("data-code-theme")).toBe("oneDark");
    expect(root.querySelector("p")!.textContent).toBe("正文段落");
    expect(root.classList.contains("ProseMirror")).toBe(false);
    expect(root.getAttribute("contenteditable")).toBeNull();
    expect(root.getAttribute("role")).toBeNull();
  });

  it("不修改用户正在编辑的 DOM（克隆口径）", async () => {
    const { input, codeDOM } = fixture(true);
    const before = input.liveRoot.innerHTML;
    const handleBefore = codeDOM.innerHTML;
    await buildExportSnapshot(input);
    expect(input.liveRoot.innerHTML).toBe(before);
    expect(codeDOM.innerHTML).toBe(handleBefore);
    expect(input.liveRoot.getAttribute("contenteditable")).toBe("true");
    expect(codeDOM.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe("true");
  });
});

describe("#373 frontmatter：保留标签，CodeMirror 宿主换成完整 YAML", () => {
  const YAML = "title: 演示文档\ndraft: true\ntags:\n  - a\n  - b";

  function fixture(domValue = YAML) {
    const fm = schema.node("frontmatter", { value: YAML });
    const para = schema.node("paragraph", null, [schema.text("正文")]);
    const doc = schema.node("doc", null, [fm, para]);
    return makeInput(doc, [frontmatterDOM(domValue), Object.assign(document.createElement("p"), { textContent: "正文" })]);
  }

  it("完整 YAML 进产物，行号栏与 contenteditable 消失", async () => {
    const { root } = await buildExportSnapshot(fixture());
    const block = root.querySelector(".frontmatter-block")!;
    expect(block.querySelector("pre.code-block-export code")!.textContent).toBe(YAML);
    expect(block.querySelector(".frontmatter-cm")).toBeNull();
    expect(block.querySelector(".cm-content")).toBeNull();
    expect(block.querySelector("[contenteditable]")).toBeNull();
    // 标签是可见内容，不是控件
    expect(block.querySelector(".frontmatter-label")!.textContent).toBe("YAML Front Matter");
    expect(block.getAttribute("data-value")).toBe(YAML);
  });

  it("内容以文档为准：DOM 上的 data-value / 宿主内容陈旧也不影响产物", async () => {
    // 模拟 DOM 快照落后于文档（改名后未刷新、或 CodeMirror 只挂了部分内容）
    const { root } = await buildExportSnapshot(fixture("title: 旧标题"));
    expect(root.querySelector(".frontmatter-block pre.code-block-export code")!.textContent).toBe(
      YAML,
    );
  });

  it("DOM 里没有 frontmatter 的 CM 宿主：保持原样、不抛错、不产生告警", async () => {
    const fm = schema.node("frontmatter", { value: "a: 1" });
    const doc = schema.node("doc", null, [fm]);
    const liveRoot = document.createElement("div");
    liveRoot.className = "milkdown ProseMirror";
    const el = document.createElement("div");
    el.className = "frontmatter-block";
    el.textContent = "（外部渲染的 YAML）";
    liveRoot.appendChild(el);
    const { root, notes } = await buildExportSnapshot({
      liveRoot,
      doc,
      nodeDOM: () => el,
    });
    expect(root.querySelector(".frontmatter-block")!.textContent).toBe("（外部渲染的 YAML）");
    expect(notes).toEqual([]);
  });

  it("定位不到 NodeView 的代码块：给出可见 note，而不是静默少一块", async () => {
    const block = schema.node("code_block", { language: "typescript" }, [
      schema.text("const a = 1;"),
    ]);
    const doc = schema.node("doc", null, [block]);
    const liveRoot = document.createElement("div");
    liveRoot.className = "milkdown ProseMirror";
    const { notes } = await buildExportSnapshot({ liveRoot, doc, nodeDOM: () => null });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("无法在导出产物中定位");
  });
});

describe("#373 Mermaid：已渲染复用、未渲染限时补渲染、失败导出源码", () => {
  const CODE = "graph TD;\n  A-->B;";

  function fixture(dom: HTMLElement, code = CODE) {
    const block = schema.node("code_block", { language: "mermaid" }, [schema.text(code)]);
    const doc = schema.node("doc", null, [block]);
    return makeInput(doc, [dom]);
  }

  function fakeSvgElement(id: string): SVGElement {
    const holder = document.createElement("div");
    holder.innerHTML = `<svg id="${id}" xmlns="http://www.w3.org/2000/svg"><rect/></svg>`;
    return holder.firstElementChild! as unknown as SVGElement;
  }

  it("已渲染的图表直接复用克隆里的 SVG（零渲染成本，与编辑器所见一致）", async () => {
    const dom = mermaidDOM({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      transform: "translate(10px, 20px) scale(1.5)",
      minHeight: "640px",
      source: CODE,
    });
    let calls = 0;
    const { root, notes } = await buildExportSnapshot(fixture(dom), {
      renderMermaid: async () => {
        calls++;
        return fakeSvgElement("new");
      },
    });
    expect(calls, "已渲染的图表不该再渲染一次").toBe(0);
    const svg = root.querySelector(".mermaid-render svg")!;
    expect(svg).not.toBeNull();
    // 缩放/平移是编辑态，占位高度是渲染前的脚手架，都不该进产物
    expect((svg as unknown as HTMLElement).style.transform).toBe("");
    expect((svg as unknown as HTMLElement).style.transformOrigin).toBe("");
    expect(root.querySelector(".mermaid-render")!.getAttribute("style")).toBeNull();
    // data-source 是复用前的核对元数据，不必带进产物（会重复整份图表源码）
    expect(root.querySelector(".mermaid-render")!.getAttribute("data-source")).toBeNull();
    expect(notes).toEqual([]);
  });

  it("编辑态（图表被 display:none 隐藏）不复用：按文档源码重渲染并清掉隐藏", async () => {
    const dom = mermaidDOM({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      source: CODE,
      hidden: true,
    });
    const seen: string[] = [];
    const { root } = await buildExportSnapshot(fixture(dom), {
      renderMermaid: async (code) => {
        seen.push(code);
        return fakeSvgElement("fresh");
      },
    });
    expect(seen, "隐藏的图表必须按文档源码重渲染，否则产物里是一块看不见的图").toEqual([CODE]);
    const diagram = root.querySelector<HTMLElement>(".mermaid-render")!;
    expect(diagram.style.display).toBe("");
    expect(diagram.querySelector("svg")!.getAttribute("id")).toBe("fresh");
  });

  it("克隆里的 SVG 与文档源码不一致（重渲染未完成）时按文档源码重渲染", async () => {
    const dom = mermaidDOM({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      source: "graph TD;\n  OLD-->STALE;",
    });
    const seen: string[] = [];
    const { root } = await buildExportSnapshot(fixture(dom), {
      renderMermaid: async (code) => {
        seen.push(code);
        return fakeSvgElement("fresh");
      },
    });
    expect(seen, "过期的 svg 不能复用").toEqual([CODE]);
    expect(root.querySelector(".mermaid-render svg")!.getAttribute("id")).toBe("fresh");
  });

  it("视口外未渲染的图表按文档源码主动补渲染", async () => {
    const dom = mermaidDOM({ minHeight: "184px" });
    const seen: string[] = [];
    const { root } = await buildExportSnapshot(fixture(dom), {
      renderMermaid: async (code) => {
        seen.push(code);
        return fakeSvgElement("rendered");
      },
    });
    expect(seen).toEqual([CODE]);
    expect(root.querySelector(".mermaid-render svg")!.getAttribute("id")).toBe("rendered");
    expect(root.querySelector(".mermaid-export-fallback")).toBeNull();
  });

  it("渲染失败时导出**完整源码**兜底，并给出可读告知（绝不静默留空块）", async () => {
    const dom = mermaidDOM({ hasError: true });
    const { root, notes } = await buildExportSnapshot(fixture(dom), {
      renderMermaid: async () => null,
    });
    const fallback = root.querySelector("pre.mermaid-export-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toBe(CODE);
    expect(root.querySelector(".mermaid-error")).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Mermaid");
  });

  it("渲染超时（有界等待）同样落到源码兜底，不会无限挂住导出", async () => {
    const dom = mermaidDOM({});
    const started = Date.now();
    const { root, notes } = await buildExportSnapshot(fixture(dom), {
      perMermaidMs: 60,
      renderMermaid: () => new Promise((resolve) => setTimeout(() => resolve(fakeSvgElement("late")), 5000)),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(root.querySelector("pre.mermaid-export-fallback")!.textContent).toBe(CODE);
    expect(notes).toHaveLength(1);
  });

  it("总预算耗尽后剩余图表直接降级，不再逐张等待", async () => {
    const doms = [mermaidDOM({}), mermaidDOM({}), mermaidDOM({})];
    const blocks = doms.map(() => schema.node("code_block", { language: "mermaid" }, [schema.text(CODE)]));
    const doc = schema.node("doc", null, blocks);
    const input = makeInput(doc, doms);
    const started = Date.now();
    const { root, notes } = await buildExportSnapshot(input, {
      perMermaidMs: 500,
      totalMermaidMs: 120,
      renderMermaid: () => new Promise((resolve) => setTimeout(() => resolve(null), 500)),
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(root.querySelectorAll("pre.mermaid-export-fallback")).toHaveLength(3);
    expect(notes).toHaveLength(3);
  });

  it("工具栏、源码 textarea、按钮全部消失", async () => {
    const dom = mermaidDOM({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' });
    const { root } = await buildExportSnapshot(fixture(dom), {
      renderMermaid: async () => null,
    });
    expect(root.querySelector(".mermaid-toolbar")).toBeNull();
    expect(root.querySelector(".mermaid-editor")).toBeNull();
    expect(root.querySelector("button")).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    expect(root.querySelector("[contenteditable]")).toBeNull();
  });

  it("空图表导出中性说明而不是编辑提示或空白", async () => {
    const dom = mermaidDOM({ placeholder: "输入 Mermaid 图表代码" });
    let calls = 0;
    const { root } = await buildExportSnapshot(fixture(dom, "   "), {
      renderMermaid: async () => {
        calls++;
        return fakeSvgElement("x");
      },
    });
    expect(calls).toBe(0);
    const diagram = root.querySelector(".mermaid-render")!;
    expect(diagram.textContent).toBe("（空的 Mermaid 图表）");
    expect(diagram.getAttribute("data-placeholder")).toBeNull();
  });

  it("不注入渲染器时走默认实现：复用 mermaid-view 缓存渲染，产物过安全清洗", async () => {
    renderWithSeqMock.mockReset();
    sanitizeMock.mockReset();
    const svgHtml = '<svg id="cached" xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    renderWithSeqMock.mockResolvedValue(svgHtml);
    const sanitized = fakeSvgElement("sanitized");
    sanitizeMock.mockReturnValue(sanitized);

    const { root, notes } = await buildExportSnapshot(fixture(mermaidDOM({})));

    expect(renderWithSeqMock).toHaveBeenCalledTimes(1);
    const [code, seq, getCurrentSeq] = renderWithSeqMock.mock.calls[0];
    expect(code).toBe(CODE);
    // 导出是一次性快照：seq 传恒等值，过期判定恒为「未过期」（#168 缓存可直接命中）
    expect(seq).toBe(0);
    expect(getCurrentSeq()).toBe(0);
    expect(sanitizeMock).toHaveBeenCalledWith(svgHtml);
    // 进产物的是清洗后的节点，而不是渲染器原文
    expect(root.querySelector(".mermaid-render svg")!.getAttribute("id")).toBe("sanitized");
    expect(root.querySelector(".mermaid-export-fallback")).toBeNull();
    expect(notes).toEqual([]);
  });

  it("默认实现返回 null 时导出完整源码并告知（不静默留空）", async () => {
    renderWithSeqMock.mockReset();
    sanitizeMock.mockReset();
    renderWithSeqMock.mockResolvedValue(null);

    const { root, notes } = await buildExportSnapshot(fixture(mermaidDOM({})));

    expect(sanitizeMock).not.toHaveBeenCalled();
    expect(root.querySelector("pre.mermaid-export-fallback")!.textContent).toBe(CODE);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Mermaid");
  });
});

describe("#373 其余编辑态控件", () => {
  function chromeFixture(): ExportSnapshotInput {
    const para = schema.node("paragraph", null, [schema.text("带图段落")]);
    const doc = schema.node("doc", null, [para]);

    const liveRoot = document.createElement("div");
    liveRoot.className = "milkdown ProseMirror ProseMirror-focused";
    liveRoot.setAttribute("contenteditable", "true");
    liveRoot.setAttribute("role", "textbox");

    const p = document.createElement("p");
    p.className = "inkling-focused";
    // 块拖拽手柄：每个顶层块前都有一个，原来会整片进产物
    const handle = document.createElement("span");
    handle.className = "inkling-block-handle";
    handle.setAttribute("contenteditable", "false");
    handle.textContent = "⋮⋮";
    const searchHit = document.createElement("span");
    searchHit.className = "search-match-current";
    searchHit.textContent = "带图段落";
    p.append(handle, searchHit, imageDOM("http://asset.localhost/E%3A%5Cnotes%5Ca.png"));
    liveRoot.appendChild(p);

    return { liveRoot, doc, nodeDOM: () => null };
  }

  it("拖拽手柄 / 缩放手柄删除，查找高亮与编辑态 class 摘掉，正文与图片保留", async () => {
    const input = chromeFixture();
    const { root } = await buildExportSnapshot(input);
    expect(root.querySelector(".inkling-block-handle")).toBeNull();
    expect(root.querySelector(".image-resize-handle")).toBeNull();
    expect(root.textContent).not.toContain("⋮⋮");
    // 查找高亮是瞬时 UI：class 摘掉，文字必须留下
    const hit = root.querySelector(".search-match-current");
    expect(hit).toBeNull();
    expect(root.querySelector("p")!.textContent).toContain("带图段落");
    expect(root.classList.contains("inkling-focused") || root.querySelector(".inkling-focused")).toBeFalsy();
    expect(root.classList.contains("ProseMirror-focused")).toBe(false);
    // 图片是内容：src / alt 保留，懒加载属性去掉（PNG 离屏容器里 lazy 图片不会加载）
    const img = root.querySelector("img")!;
    expect(img.getAttribute("alt")).toBe("示意图");
    expect(img.getAttribute("loading")).toBeNull();
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});

describe("#373 数学公式：等 KaTeX 渲染，等不到就用 LaTeX 源码兜底", () => {
  function mathFixture(opts: { value: string; rendered: boolean; display: boolean }) {
    const para = schema.node("paragraph", null, [schema.text("公式段落")]);
    const doc = schema.node("doc", null, [para]);
    const liveRoot = document.createElement("div");
    liveRoot.className = "milkdown ProseMirror";
    const p = document.createElement("p");
    p.textContent = "公式段落";
    const math = document.createElement(opts.display ? "div" : "span");
    math.className = opts.display ? "math-display" : "math-inline";
    math.setAttribute(opts.display ? "data-math-display" : "data-math-inline", "");
    math.setAttribute("data-value", opts.value);
    math.title = "双击编辑公式";
    if (opts.rendered) {
      const katex = document.createElement("span");
      katex.className = "katex";
      katex.textContent = "a2+b2=c2";
      math.appendChild(katex);
    } else {
      const ph = document.createElement("span");
      ph.className = "math-placeholder";
      ph.textContent = opts.display ? "双击编辑公式" : "公式";
      math.appendChild(ph);
    }
    p.appendChild(math);
    liveRoot.appendChild(p);
    return { input: { liveRoot, doc, nodeDOM: () => null } as ExportSnapshotInput, math };
  }

  it("已渲染的公式原样保留，只摘掉「双击编辑」提示", async () => {
    const { input } = mathFixture({ value: "a^2 + b^2 = c^2", rendered: true, display: false });
    const { root, notes } = await buildExportSnapshot(input, { mathWaitMs: 0 });
    expect(root.querySelector(".katex")!.textContent).toBe("a2+b2=c2");
    expect(root.querySelector(".math-inline")!.getAttribute("title")).toBeNull();
    expect(notes).toEqual([]);
  });

  it("KaTeX 尚在加载时**有界等待**，渲染完成后导出真实公式", async () => {
    const { input, math } = mathFixture({ value: "e^{i\\pi}+1=0", rendered: false, display: true });
    // 模拟 katex 的 .then() 在 60ms 后落地
    setTimeout(() => {
      math.replaceChildren(Object.assign(document.createElement("span"), { className: "katex", textContent: " " }));
    }, 60);
    const { root, notes } = await buildExportSnapshot(input, { mathWaitMs: 800 });
    expect(root.querySelector(".katex")).not.toBeNull();
    expect(root.querySelector(".math-placeholder")).toBeNull();
    expect(notes).toEqual([]);
  });

  it("等不到渲染时导出 LaTeX 源码并告知，不留「双击编辑公式」这类编辑提示", async () => {
    const { input } = mathFixture({ value: "\\int_0^1 x dx", rendered: false, display: true });
    const { root, notes } = await buildExportSnapshot(input, { mathWaitMs: 60 });
    expect(root.querySelector(".math-placeholder")!.textContent).toBe("\\int_0^1 x dx");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("LaTeX");
    expect(root.textContent).not.toContain("双击编辑公式");
  });

  it("空公式清空占位（本来就没有内容可显示）", async () => {
    const { input } = mathFixture({ value: "", rendered: false, display: false });
    const { root, notes } = await buildExportSnapshot(input, { mathWaitMs: 0 });
    expect(root.querySelector(".math-placeholder")).toBeNull();
    expect(root.querySelector(".math-inline")!.textContent).toBe("");
    expect(notes).toEqual([]);
  });

  it("导出时正处于内联编辑：用 textarea 的内容兜底，绝不导出空块", async () => {
    const { input, math } = mathFixture({ value: "x^2", rendered: true, display: false });
    // startEdit 的真实形态：host 被清空、只剩 textarea；data-value 仍是旧值
    const editor = document.createElement("textarea");
    editor.className = "math-editor";
    editor.value = "x^3 + 1";
    math.replaceChildren(editor);

    const { root, notes } = await buildExportSnapshot(input, { mathWaitMs: 0 });
    const host = root.querySelector(".math-inline")!;
    expect(host.textContent).toBe("x^3 + 1");
    expect(root.querySelector(".math-editor")).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("编辑");
  });

  it("编辑中的空公式：产物里也不留空白编辑态", async () => {
    const { input, math } = mathFixture({ value: "x^2", rendered: true, display: false });
    const editor = document.createElement("textarea");
    editor.className = "math-editor";
    editor.value = "";
    math.replaceChildren(editor);

    const { root, notes } = await buildExportSnapshot(input, { mathWaitMs: 0 });
    expect(root.querySelector(".math-inline")!.textContent).toBe("");
    expect(root.querySelector("textarea")).toBeNull();
    expect(notes).toEqual([]);
  });
});

describe("#373 等待渲染后重新取文档：异步窗口里的编辑不会错配块内容", () => {
  it("KaTeX 等待结束后的克隆按最新文档重建（不是调用前捕获的旧文档）", async () => {
    const codeDOM = mountedCodeBlockDOM("typescript", ["OLD"]);
    const math = document.createElement("span");
    math.setAttribute("data-math-inline", "");
    math.setAttribute("data-value", "x");
    math.innerHTML = '<span class="math-placeholder">公式</span>';

    const liveRoot = document.createElement("div");
    liveRoot.className = "milkdown ProseMirror";
    liveRoot.append(codeDOM, math);

    const oldDoc = schema.node("doc", null, [schema.node("code_block", { language: "typescript" }, [schema.text("OLD")])]);
    const newDoc = schema.node("doc", null, [schema.node("code_block", { language: "typescript" }, [schema.text("NEW")])]);
    const input: ExportSnapshotInput = {
      liveRoot,
      doc: oldDoc,
      nodeDOM: () => codeDOM,
      getState: () => ({ doc: newDoc, nodeDOM: () => codeDOM }),
    };
    // 占位在 30ms 后才消失，确保 getState 在等待之后才被调用
    setTimeout(() => math.replaceChildren(document.createElement("span")), 30);

    const { root } = await buildExportSnapshot(input, { mathWaitMs: 800 });
    expect(root.querySelector("pre.code-block-export code")!.textContent).toBe("NEW");
  });
});

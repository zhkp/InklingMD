import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/kit/prose/model";
import type { Node } from "@milkdown/kit/prose/model";

const { html2canvasMock } = vi.hoisted(() => ({ html2canvasMock: vi.fn() }));
vi.mock("html2canvas", () => ({ default: html2canvasMock }));

import { exportPNG } from "../../src/lib/exporter";
import { useWorkspace } from "../../src/store/workspace";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
    code_block: {
      group: "block",
      content: "text*",
      marks: "",
      attrs: { language: { default: "" } },
      toDOM: () => ["pre", 0],
    },
  },
});

function editorWith(html: string, doc?: Node, nodeDOM: (pos: number) => globalThis.Node | null = () => null): any {
  const dom = document.createElement("div");
  dom.className = "ProseMirror";
  dom.setAttribute("contenteditable", "true");
  dom.setAttribute("role", "textbox");
  dom.innerHTML = html;
  // 真实 EditorView 恒有 state.doc 与 nodeDOM：#373 的导出快照按文档重建
  // 代码块/frontmatter/Mermaid，缺了这两个成员 mock 就不忠实于生产契约。
  const view = {
    dom,
    state: { doc: doc ?? schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Body")])]) },
    nodeDOM,
  };
  return {
    action: (fn: (ctx: any) => unknown) => fn({
      get: (key: any) => key === editorViewCtx ? view : null,
    }),
  };
}

describe("exportPNG", () => {
  beforeEach(() => {
    html2canvasMock.mockReset();
    useWorkspace.setState({ currentFile: "/notes/report.md" });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    html2canvasMock.mockResolvedValue({
      toBlob: (callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" })),
    });
  });

  it("renders the real three-level editor structure and always removes it", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    await exportPNG(() =>
      editorWith('<h1>Report</h1><p><span contenteditable="true">Body</span></p>'),
    );

    expect(html2canvasMock).toHaveBeenCalledTimes(1);
    const root = html2canvasMock.mock.calls[0][0] as HTMLElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    const scroll = root.firstElementChild as HTMLElement;
    const milkdown = scroll.firstElementChild as HTMLElement;
    expect(scroll.className).toBe("editor-scroll");
    expect(milkdown.className).toBe("milkdown");
    expect(milkdown.querySelector("h1")?.textContent).toBe("Report");
    // #373：内容里的 contenteditable 必须已摘除（截图源是清理后的快照，
    // 不是带编辑态属性的原 DOM）。断言嵌套元素才有意义——外层 wrapper 是
    // exportPNG 现建的，本来就不带这些属性。
    expect(root.querySelector("[contenteditable]")).toBeNull();
    expect(root.querySelector("span")?.textContent).toBe("Body");
    expect(root.isConnected).toBe(false);
    expect(document.body.contains(root)).toBe(false);
  });

  it("html2canvas 必须带 useCORS 且不得开 allowTaint（#348：asset 背景图进画布的充要参数）", async () => {
    await exportPNG(() => editorWith("<p>Body</p>"));
    const options = html2canvasMock.mock.calls[0][1] as Record<string, unknown>;
    // 关掉 useCORS ⇒ 跨源图（#306 改写后的 asset URL、远程图）会被 html2canvas **静默跳过**：
    // 不报错、导出图里少图（「应用里正常、导出里丢图」，真机探针 scripts/probe-asset-bg-export.mjs 的对照 B 实测过该形态）。
    expect(options.useCORS).toBe(true);
    // 开 allowTaint ⇒ 跨源图直接画进画布但**污染**它，`canvas.toBlob` 抛 SecurityError，整个导出失败。
    expect(options.allowTaint).toBeFalsy();
  });

  it("cleans the off-screen clone when html2canvas rejects", async () => {
    html2canvasMock.mockRejectedValueOnce(new Error("canvas failed"));
    await expect(exportPNG(() => editorWith("<p>Body</p>"))).rejects.toThrow("canvas failed");
    expect(document.querySelector('[style*="left: -99999px"]')).toBeNull();
  });

  it("html2canvas 捕获的是清理后的快照：代码块源码完整、无控件、Mermaid 不空", async () => {
    const fullCode = "const line001 = 1;\nconst line002 = 2;\nconst line003 = 3;";
    // 复刻挂载后的 CodeMirror 块：虚拟化后 DOM 里只有首行，下拉框/行号栏仍在
    const codeEl = document.createElement("div");
    codeEl.className = "code-block";
    codeEl.innerHTML =
      `<div class="code-block-toolbar"><select><option>typescript</option></select></div>` +
      `<div class="code-block-cm"><div class="cm-editor">` +
      `<div class="cm-gutters"><div class="cm-gutterElement">1</div></div>` +
      `<div class="cm-content" contenteditable="true"><div class="cm-line">const line001 = 1;</div></div>` +
      `</div></div>`;
    // 已渲染的 Mermaid：工具栏与源码 textarea 属于编辑态
    const mermaidEl = document.createElement("div");
    mermaidEl.className = "mermaid-block";
    mermaidEl.innerHTML =
      `<div class="mermaid-render"><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg></div>` +
      `<div class="mermaid-toolbar"><button type="button">编辑</button></div>` +
      `<textarea class="mermaid-editor"></textarea>`;

    const doc = schema.node("doc", null, [
      schema.node("code_block", { language: "typescript" }, [schema.text(fullCode)]),
      schema.node("code_block", { language: "mermaid" }, [schema.text("graph TD;\n  A-->B;")]),
    ]);
    const secondPos = doc.child(0).nodeSize;

    const dom = document.createElement("div");
    dom.className = "ProseMirror";
    dom.append(codeEl, mermaidEl);
    const view = {
      dom,
      state: { doc },
      nodeDOM: (pos: number) => (pos === 0 ? codeEl : pos === secondPos ? mermaidEl : null),
    };
    await exportPNG(() => ({
      action: <T,>(fn: (ctx: any) => T): T =>
        fn({ get: (key: any) => (key === editorViewCtx ? view : null) }),
    }) as any);

    const root = html2canvasMock.mock.calls[0][0] as HTMLElement;
    // 源码取文档：CM 里只有一行，截图源里必须是完整三行
    expect(root.querySelector("pre.code-block-export code.language-typescript")?.textContent).toBe(
      fullCode,
    );
    expect(root.querySelector(".code-block-toolbar")).toBeNull();
    expect(root.querySelector(".cm-gutters")).toBeNull();
    expect(root.querySelector(".cm-content")).toBeNull();
    expect(root.querySelector("[contenteditable]")).toBeNull();
    expect(root.querySelector(".mermaid-render svg")).not.toBeNull();
    expect(root.querySelector(".mermaid-toolbar")).toBeNull();
    expect(root.querySelector("textarea")).toBeNull();
  });
});

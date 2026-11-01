/**
 * 复制富文本的剪贴板语义：成功的富文本写入不能被后续「降级告知」失败反噬。
 *
 * 回归场景：告知弹窗抛错时曾落进剪贴板写入的 catch，走纯文本回退，
 * 把已经写好的 text/html 覆盖成 text/plain，调用方还拿到 true。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/kit/prose/model";

const { showMessageMock } = vi.hoisted(() => ({ showMessageMock: vi.fn() }));

vi.mock("../../src/lib/dialogs", () => ({ showMessage: showMessageMock }));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));

import { copyRichText } from "../../src/lib/exporter";
import { useWorkspace } from "../../src/store/workspace";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});

/** 带一个 `background` 属性残留的编辑器：processDomResources 不处理它，兜底探针会命中并触发告知 */
function editorWithResidualAsset() {
  const dom = document.createElement("div");
  dom.className = "ProseMirror";
  dom.setAttribute("contenteditable", "true");
  const stale = document.createElement("div");
  stale.setAttribute("background", "asset://localhost/stale.png");
  dom.appendChild(stale);
  const p = document.createElement("p");
  p.textContent = "正文";
  dom.appendChild(p);
  const view = {
    dom,
    state: {
      doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("正文")])]),
    },
    nodeDOM: () => null,
  };
  return {
    action: (fn: (ctx: any) => unknown) =>
      fn({ get: (key: any) => (key === editorViewCtx ? view : null) }),
  } as any;
}

describe("copyRichText：降级告知失败不覆盖已写好的富文本", () => {
  const writeMock = vi.fn();
  const writeTextMock = vi.fn();

  beforeEach(() => {
    showMessageMock.mockReset();
    writeMock.mockReset();
    writeTextMock.mockReset();
    writeMock.mockResolvedValue(undefined);
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { write: writeMock, writeText: writeTextMock },
      configurable: true,
      writable: true,
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public items: Record<string, Blob>) {}
      },
    );
    useWorkspace.setState({ currentContent: "正文", currentFile: "/notes/a.md" });
  });

  it("showMessage 抛错时仍算复制成功，且不调用 writeText 覆盖剪贴板", async () => {
    showMessageMock.mockRejectedValue(new Error("dialog IPC failed"));

    await expect(copyRichText(() => editorWithResidualAsset())).resolves.toBe(true);

    expect(showMessageMock, "残留地址应触发一次降级告知").toHaveBeenCalledTimes(1);
    expect(writeMock, "富文本写入一次").toHaveBeenCalledTimes(1);
    expect(writeTextMock, "不得用纯文本覆盖已写好的富文本").not.toHaveBeenCalled();
  });
});

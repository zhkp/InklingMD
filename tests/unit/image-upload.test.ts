// 图片拖拽/粘贴上传插件测试（v2.3.8 修复 #60）
// 验证：未命名草稿（untitled-N 虚拟路径）粘贴图片不落盘，以 Data URL 内联插入；
// 普通文档粘贴图片写入 assets/ 并插入相对路径。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import { EditorView } from "@milkdown/kit/prose/view";

const { resolvePathFromDocumentMock, writeBinaryFileMock, showMessageMock } = vi.hoisted(() => ({
  resolvePathFromDocumentMock: vi.fn(),
  writeBinaryFileMock: vi.fn(),
  showMessageMock: vi.fn(),
}));

vi.mock("../../src/lib/fs", () => ({
  resolvePathFromDocument: resolvePathFromDocumentMock,
  writeBinaryFile: writeBinaryFileMock,
  // #392：复用既有资源前要确认文档仍在原处；本文件只测粘贴插入链路，
  // 给一个「文档存在 + 查重未命中」的固定前提，锚点语义在 assetStore 单测里覆盖
  findAssetByHash: async () => null,
  fileStat: async () => ({ mtimeUs: 1, size: 1 }),
}));

vi.mock("../../src/lib/dialogs", () => ({
  showMessage: showMessageMock,
}));

import { imageUploadPlugin } from "../../src/components/Editor/image-upload";
import { useWorkspace } from "../../src/store/workspace";

function makeSchema() {
  return new Schema({
    nodes: {
      doc: { content: "paragraph+" },
      paragraph: {
        content: "(text | image)*",
        toDOM: () => ["p", 0],
        parseDOM: [{ tag: "p" }],
      },
      text: { group: "inline" },
      image: {
        group: "inline",
        inline: true,
        atom: true,
        attrs: { src: { default: "" }, alt: { default: null } },
        toDOM: (node: any) => ["img", { src: node.attrs.src }],
        parseDOM: [{ tag: "img" }],
      },
    },
  });
}

function makeView() {
  const schema = makeSchema();
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, [schema.text("光标在这")]),
  ]);
  const state = EditorState.create({
    doc,
    selection: TextSelection.create(doc, 1),
  });
  const root = document.createElement("div");
  document.body.appendChild(root);
  return new EditorView(root, { state });
}

function makePasteEvent(file: File) {
  return {
    clipboardData: { files: [file] },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

async function flushAsync() {
  // FileReader / await 链需要多轮微任务+宏任务冲刷
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe("imageUploadPlugin 粘贴图片", () => {
  let view: EditorView;

  beforeEach(() => {
    view = makeView();
    resolvePathFromDocumentMock.mockReset();
    writeBinaryFileMock.mockReset();
    resolvePathFromDocumentMock.mockResolvedValue("/docs/assets/x.png");
    writeBinaryFileMock.mockResolvedValue(undefined);
    // 真实前提：编辑器挂载时对应 tab 已在 openTabs 里（上传护栏按 docId 判身份）
    useWorkspace.setState({
      openTabs: [
        { path: "/docs/note.md", docId: "doc-note", content: "", dirty: false, revision: 0 },
        { path: "/docs/other.md", docId: "doc-other", content: "", dirty: false, revision: 0 },
        { path: "untitled-1", docId: "doc-untitled-1", content: "", dirty: false, revision: 0 },
      ] as never,
    });
  });

  afterEach(() => {
    view.destroy();
  });

  it("普通文档：写入 assets/ 并插入相对路径图片", async () => {
    const plugin = imageUploadPlugin("/docs/note.md");
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", {
      type: "image/png",
    });
    const handled = (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    expect(handled).toBe(true);
    await flushAsync();

    expect(writeBinaryFileMock).toHaveBeenCalledTimes(1);
    const inserted = view.state.doc.firstChild?.content.firstChild;
    expect(inserted?.type.name).toBe("image");
    expect(inserted?.attrs.src).toMatch(/^assets\/.+\.png$/);
  });

  it("未命名草稿（untitled-N）：不落盘，插入 data URL", async () => {
    const plugin = imageUploadPlugin("untitled-1");
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", {
      type: "image/png",
    });
    const handled = (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    expect(handled).toBe(true);
    await flushAsync();

    // 虚拟路径不得进入目录解析/磁盘写入（此前会按 CWD 解析出错误路径导致 IO 报错）
    expect(resolvePathFromDocumentMock).not.toHaveBeenCalled();
    expect(writeBinaryFileMock).not.toHaveBeenCalled();
    const inserted = view.state.doc.firstChild?.content.firstChild;
    expect(inserted?.type.name).toBe("image");
    expect(inserted?.attrs.src).toMatch(/^data:image\/png;base64,/);
  });

  it("空路径同样走 Data URL 兜底", async () => {
    const plugin = imageUploadPlugin("");
    const file = new File([new Uint8Array([9])], "pic.jpg", {
      type: "image/jpeg",
    });
    (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    await flushAsync();

    expect(writeBinaryFileMock).not.toHaveBeenCalled();
    const inserted = view.state.doc.firstChild?.content.firstChild;
    expect(inserted?.attrs.src).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("写入失败时调用 showMessage 报错 (#131)", async () => {
    writeBinaryFileMock.mockRejectedValueOnce(new Error("Permission denied"));
    const plugin = imageUploadPlugin("/docs/note.md");
    const file = new File([new Uint8Array([1, 2])], "denied.png", {
      type: "image/png",
    });
    (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    await flushAsync();

    expect(showMessageMock).toHaveBeenCalledWith(
      expect.stringContaining("图片插入失败：denied.png"),
      { kind: "error" },
    );
  });

  it("文档已不在原处：提示图片未插入，编辑区不留下图片节点（#392）", async () => {
    // Rust 侧锚点校验的 wire 形态：文档被删除/卷卸载后拒绝落盘
    writeBinaryFileMock.mockRejectedValueOnce("TARGET_MISSING: 目标文件已不存在: /docs/note.md");
    const plugin = imageUploadPlugin("/docs/note.md");
    const file = new File([new Uint8Array([1, 2])], "gone.png", {
      type: "image/png",
    });
    (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    await flushAsync();

    expect(showMessageMock).toHaveBeenCalledWith(
      expect.stringContaining("文档已不在原处，图片未插入"),
      { kind: "error" },
    );
    // 直接拒绝并保留编辑器内容：不插入指向不存在文件的图片节点
    expect(view.state.doc.firstChild?.content.firstChild?.type.name).toBe("text");
  });

  it("未保存草稿粘贴超过 512KB 大图给出提示 (#134)", async () => {
    const largeBuffer = new Uint8Array(600 * 1024);
    const file = new File([largeBuffer], "big.png", {
      type: "image/png",
    });
    const plugin = imageUploadPlugin("untitled-1");
    (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    await flushAsync();

    expect(showMessageMock).toHaveBeenCalledWith(
      expect.stringContaining("未保存草稿中内联了大图（>512KB）"),
      { kind: "info" },
    );
  });

  it("落盘期间切走 tab（文档路径变化）不再把图片插进新 tab（#426 评审 B2）", async () => {
    // 编辑器实例跨 tab 复用后，异步上传必须复核「还是同一份文档」：
    // 这里让写盘 promise 挂起，期间把 getter 指向新 tab，再放行。
    let releaseWrite: (() => void) | null = null;
    writeBinaryFileMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    let currentPath = "/docs/note.md";
    const plugin = imageUploadPlugin(() => currentPath);
    const file = new File([new Uint8Array([1, 2, 3])], "late.png", {
      type: "image/png",
    });
    (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    await flushAsync();

    // 写盘尚未返回：此时切到另一个 tab
    expect(releaseWrite).not.toBeNull();
    const docBefore = view.state.doc;
    currentPath = "/docs/other.md";
    releaseWrite!();
    await flushAsync();

    // 文档未被改写（没有图片节点、doc 引用不变），也不会有「插入失败」误报
    expect(view.state.doc).toBe(docBefore);
    expect(view.state.doc.firstChild?.content.firstChild?.type.name).toBe("text");
    expect(showMessageMock).not.toHaveBeenCalled();
  });

  it("落盘期间草稿另存为（路径变化、docId 不变）仍把图片插入同一份文档（#431 评审）", async () => {
    // 身份必须在第一个 await 之前捕获：另存为后旧路径已不在 openTabs，
    // 若在 await 之后按旧路径重取身份会得到 null，把已 preventDefault 的粘贴丢弃
    let releaseWrite: (() => void) | null = null;
    writeBinaryFileMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    let currentPath = "/docs/note.md";
    const plugin = imageUploadPlugin(() => currentPath);
    const file = new File([new Uint8Array([1, 2, 3])], "keep.png", {
      type: "image/png",
    });
    (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    await flushAsync();
    expect(releaseWrite).not.toBeNull();

    // 另存为：store 把 tab 迁到新路径，docId/revision 原样保留
    useWorkspace.setState({
      openTabs: [
        {
          path: "/docs/other.md",
          docId: "doc-note",
          content: "",
          dirty: false,
          revision: 0,
        },
      ] as never,
    });
    currentPath = "/docs/other.md";
    releaseWrite!();
    await flushAsync();

    // 同一份文档：图片照常插入
    const inserted = view.state.doc.firstChild?.content.firstChild;
    expect(inserted?.type.name).toBe("image");
    expect(inserted?.attrs.src).toMatch(/^assets\/.+\.png$/);
    expect(showMessageMock).not.toHaveBeenCalled();
  });

  it("落盘期间另存为到新路径：资源按新路径重新落盘，不产生失效相对路径（#431 评审）", async () => {
    let releaseWrite: (() => void) | null = null;
    writeBinaryFileMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        releaseWrite = resolve;
      }),
    );
    let currentPath = "/docs/note.md";
    const plugin = imageUploadPlugin(() => currentPath);
    const file = new File([new Uint8Array([1, 2, 3])], "move.png", {
      type: "image/png",
    });
    (plugin.props.handlePaste as any)(view, makePasteEvent(file));
    await flushAsync();
    expect(releaseWrite).not.toBeNull();

    // 另存为：docId/revision 不变，路径换到 other.md（资源相对路径基准随之改变）
    useWorkspace.setState({
      openTabs: [
        {
          path: "/docs/other.md",
          docId: "doc-note",
          content: "",
          dirty: false,
          revision: 0,
        },
      ] as never,
    });
    currentPath = "/docs/other.md";
    releaseWrite!();
    await flushAsync();

    // 旧目录写了一次；检测到路径迁移后按新路径再写一次
    expect(writeBinaryFileMock).toHaveBeenCalledTimes(2);
    const anchors = writeBinaryFileMock.mock.calls.map(
      (call) => (call[2] as { anchorPath?: string } | undefined)?.anchorPath,
    );
    expect(anchors).toEqual(["/docs/note.md", "/docs/other.md"]);
    const inserted = view.state.doc.firstChild?.content.firstChild;
    expect(inserted?.type.name).toBe("image");
    expect(inserted?.attrs.src).toMatch(/^assets\/.+\.png$/);
    expect(showMessageMock).not.toHaveBeenCalled();
  });
});

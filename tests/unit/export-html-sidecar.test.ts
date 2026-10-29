/**
 * #372 桌面端 HTML 导出的**落盘**分支。
 *
 * 为什么单独锁这一条：浏览器 E2E 跑的是 `isTauri() === false`，只能覆盖 inline 模式；
 * 而用户实际运行的桌面端，大资源是旁挂到 `<name>_assets/` 的——目录建在哪、相对地址
 * 锚在谁身上、写失败怎么告知、取消保存会不会留下半个文件，全在这一支里。
 * 这些都是纯副作用，用注入的 fs/对话框替身断言调用参数即可（E2E 负责真实字节）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorViewCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/kit/prose/model";

const {
  saveMock,
  invokeMock,
  createDirMock,
  writeBinaryMock,
  readBinaryMock,
  showMessageMock,
  resolvePathMock,
} = vi.hoisted(() => ({
  saveMock: vi.fn(),
  invokeMock: vi.fn(),
  createDirMock: vi.fn(),
  writeBinaryMock: vi.fn(),
  readBinaryMock: vi.fn(),
  showMessageMock: vi.fn(),
  resolvePathMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: saveMock }));
vi.mock("../../src/lib/dialogs", () => ({ showMessage: showMessageMock }));
vi.mock("../../src/components/Editor/markdown-publisher", () => ({
  flushAllMarkdownPublishers: vi.fn(),
}));
vi.mock("../../src/lib/exportTheme", () => ({
  collectDocumentCss: async () => ({ sheets: [], skipped: [] }),
  currentThemeDescriptor: () => ({ id: "builtin:light", mode: "light" }),
  buildThemedStandaloneHTML: (body: string, title: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`,
}));
vi.mock("../../src/lib/fs", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/fs")>("../../src/lib/fs");
  return {
    ...actual,
    // 只替换真正碰磁盘/系统的那几个；其余保持原样
    createDir: createDirMock,
    writeBinaryFile: writeBinaryMock,
    readBinaryFile: readBinaryMock,
    // 与 Tauri 原生实现同口径：相对路径按**基准文件所在目录**解析
    resolvePathFromDocument: (base: string, ...parts: string[]) => resolvePathMock(base, ...parts),
    isTauri: () => true,
  };
});

import { exportHTML } from "../../src/lib/exporter";
import { useWorkspace } from "../../src/store/workspace";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});

/** 2MB + 1 字节的真 PNG 前缀大图：超过 inline 预算，桌面端必须旁挂 */
const BIG_PNG = (() => {
  const out = new Uint8Array(2 * 1024 * 1024 + 1);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  out[16] = 0x42;
  return out;
})();

/** 全量内容指纹：比 toEqual 快得多，又能证明写出去的**正是**读进来的那 2MB */
function digest(bytes: Uint8Array): string {
  let h = 0;
  for (let i = 0; i < bytes.length; i += 1) h = (h * 31 + bytes[i]) | 0;
  return `${bytes.length}:${h}`;
}

function editorWithImage(src: string) {
  const dom = document.createElement("div");
  dom.className = "ProseMirror";
  dom.setAttribute("contenteditable", "true");
  const p = document.createElement("p");
  const img = document.createElement("img");
  img.setAttribute("src", src);
  img.setAttribute("alt", "大图");
  p.appendChild(img);
  dom.appendChild(p);
  const view = {
    dom,
    state: { doc: schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Body")])]) },
    nodeDOM: () => null,
  };
  return {
    action: (fn: (ctx: any) => unknown) =>
      fn({ get: (key: any) => (key === editorViewCtx ? view : null) }),
  } as any;
}

describe("#372 桌面端 HTML 导出：旁挂目录与写入", () => {
  beforeEach(() => {
    saveMock.mockReset();
    invokeMock.mockReset();
    createDirMock.mockReset();
    writeBinaryMock.mockReset();
    readBinaryMock.mockReset();
    showMessageMock.mockReset();
    resolvePathMock.mockReset();
    resolvePathMock.mockImplementation(async (base: string, ...parts: string[]) =>
      [base.replace(/[\\/][^\\/]*$/, ""), ...parts].join("/"),
    );
    invokeMock.mockResolvedValue(undefined);
    saveMock.mockResolvedValue("E:/out/report.html");
    createDirMock.mockResolvedValue(undefined);
    writeBinaryMock.mockResolvedValue(undefined);
    readBinaryMock.mockResolvedValue(BIG_PNG);
    useWorkspace.setState({ currentFile: "E:/notes/report.md" });
  });

  it("先问落点再读资源：取消保存时一个字节都不读、一个文件都不写", async () => {
    saveMock.mockResolvedValue(null);
    await exportHTML(() => editorWithImage("assets/big.png"));

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(readBinaryMock, "用户取消时不该白读一遍图片").not.toHaveBeenCalled();
    expect(invokeMock, "取消不应写 HTML").not.toHaveBeenCalled();
    expect(writeBinaryMock).not.toHaveBeenCalled();
    expect(createDirMock).not.toHaveBeenCalled();
    expect(showMessageMock).not.toHaveBeenCalled();
  });

  it("大资源写到 HTML 旁的 <name>_assets/，HTML 里是相对地址；小资源仍内联", async () => {
    readBinaryMock.mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await exportHTML(() => editorWithImage("assets/small.png"));

    expect(createDirMock, "小资源不该建旁挂目录").not.toHaveBeenCalled();
    expect(writeBinaryMock).not.toHaveBeenCalled();
    const written = invokeMock.mock.calls.find((c) => c[0] === "write_text_file")?.[1] as {
      filePath: string;
      content: string;
    };
    expect(written.filePath).toBe("E:/out/report.html");
    expect(written.content).toContain("data:image/png;base64,");
  });

  it("大资源：目录相对 HTML 建、文件名保留原名、产物里是百分号编码的相对地址", async () => {
    await exportHTML(() => editorWithImage("assets/big.png"));

    expect(createDirMock).toHaveBeenCalledWith("E:/out/report_assets");
    expect(writeBinaryMock).toHaveBeenCalledTimes(1);
    const [target, data] = writeBinaryMock.mock.calls[0];
    expect(target).toBe("E:/out/report_assets/big.png");
    expect(digest(data as Uint8Array)).toBe(digest(BIG_PNG));

    const written = invokeMock.mock.calls.find((c) => c[0] === "write_text_file")?.[1] as {
      content: string;
    };
    expect(written.content).toContain("report_assets/big.png");
    expect(written.content, "大资源不该被 base64 进 HTML").not.toContain("data:image/png;base64,");
  });

  it("对话框里改名：旁挂目录跟随最终文件名，而不是文档名", async () => {
    saveMock.mockResolvedValue("E:/out/final-name.html");
    await exportHTML(() => editorWithImage("assets/big.png"));

    expect(createDirMock).toHaveBeenCalledWith("E:/out/final-name_assets");
    expect(writeBinaryMock).toHaveBeenCalledTimes(1);
    expect(writeBinaryMock.mock.calls[0][0]).toBe("E:/out/final-name_assets/big.png");
    const written = invokeMock.mock.calls.find((c) => c[0] === "write_text_file")?.[1] as {
      content: string;
    };
    expect(written.content).toContain("final-name_assets/big.png");
    // 目录名若仍取文档名（report），HTML 与旁挂资源就会错配
    expect(written.content).not.toContain("report_assets");
  });

  it("保存名含空格/#：磁盘用原名，HTML 地址逐段编码（否则 # 会被当成片段）", async () => {
    saveMock.mockResolvedValue("E:/out/report #1.html");
    await exportHTML(() => editorWithImage("assets/big.png"));

    expect(createDirMock).toHaveBeenCalledWith("E:/out/report #1_assets");
    expect(writeBinaryMock.mock.calls[0][0]).toBe("E:/out/report #1_assets/big.png");
    const written = invokeMock.mock.calls.find((c) => c[0] === "write_text_file")?.[1] as {
      content: string;
    };
    expect(written.content).toContain("report%20%231_assets/big.png");
    expect(written.content, "URL 里不得出现裸 #（会被浏览器当片段）").not.toContain(
      'src="report #1_assets',
    );
  });

  it("写旁挂文件失败不丢产物：HTML 照写，同时给出可定位的告警", async () => {
    writeBinaryMock.mockRejectedValue(new Error("EACCES: permission denied"));
    await exportHTML(() => editorWithImage("assets/big.png"));

    expect(invokeMock.mock.calls.some((c) => c[0] === "write_text_file"), "HTML 本身仍要写出").toBe(
      true,
    );
    expect(showMessageMock).toHaveBeenCalledTimes(1);
    const [message] = showMessageMock.mock.calls[0];
    expect(message).toContain("未能完整导出");
    expect(message).toContain("report_assets/big.png");
    expect(message).toContain("写入旁挂资源失败");
    expect(message).toContain("EACCES");
  });

  it("旁挂路径解析失败不丢产物：HTML 照写，逐条告警而不是整次导出抛错", async () => {
    // 资源本身按文档目录解析正常读取；只有落盘目录（E:/out/…）的解析失败
    resolvePathMock.mockImplementation(async (base: string, ...parts: string[]) => {
      if (base.startsWith("E:/out/")) throw new Error("IPC unavailable");
      return [base.replace(/[\\/][^\\/]*$/, ""), ...parts].join("/");
    });
    await exportHTML(() => editorWithImage("assets/big.png"));

    expect(invokeMock.mock.calls.some((c) => c[0] === "write_text_file"), "HTML 本身仍要写出").toBe(
      true,
    );
    expect(writeBinaryMock).not.toHaveBeenCalled();
    expect(showMessageMock).toHaveBeenCalledTimes(1);
    const [message] = showMessageMock.mock.calls[0];
    expect(message).toContain("report_assets/big.png");
    expect(message).toContain("旁挂资源目录路径解析失败");
    expect(message).toContain("IPC unavailable");
  });

  it("单个旁挂文件的路径解析失败：只告警该文件，HTML 照写且整体不抛错", async () => {
    // 目录解析（1 段）正常，文件目标（2 段）解析失败
    resolvePathMock.mockImplementation(async (base: string, ...parts: string[]) => {
      if (base.startsWith("E:/out/") && parts.length === 2) throw new Error("bad segment");
      return [base.replace(/[\\/][^\\/]*$/, ""), ...parts].join("/");
    });
    await exportHTML(() => editorWithImage("assets/big.png"));

    expect(createDirMock).toHaveBeenCalledWith("E:/out/report_assets");
    expect(invokeMock.mock.calls.some((c) => c[0] === "write_text_file")).toBe(true);
    expect(writeBinaryMock).not.toHaveBeenCalled();
    expect(showMessageMock).toHaveBeenCalledTimes(1);
    const [message] = showMessageMock.mock.calls[0];
    expect(message).toContain("report_assets/big.png");
    expect(message).toContain("旁挂资源路径解析失败");
    expect(message).toContain("bad segment");
  });

  it("资源读取失败同样可见：产物里留占位图，并弹一次降级告知", async () => {
    readBinaryMock.mockRejectedValue(new Error("文件不存在"));
    await exportHTML(() => editorWithImage("assets/gone.png"));

    const written = invokeMock.mock.calls.find((c) => c[0] === "write_text_file")?.[1] as {
      content: string;
    };
    expect(written.content).toContain("data:image/svg+xml");
    expect(showMessageMock).toHaveBeenCalledTimes(1);
    expect(showMessageMock.mock.calls[0][0]).toContain("assets/gone.png");
  });
});

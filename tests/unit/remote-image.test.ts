// 远程图片粘贴落盘单测（Smart Paste，#220）
//
// 驱动方式与验收标准一致：构造只带 text/html（含 <img src>）、没有 files 的 paste 事件——
// 这正是 macOS / 部分浏览器复制图片时的真实剪贴板形态（此前 handlePaste 对
// files.length === 0 直接 return false，图片永不落盘）。
//
// lib/fs 用内存实现替身：resolvePathFromDocument / findAssetByHash / writeBinaryFile 行为与
// 桌面端一致（按目录 + 内容哈希查重），downloadRemoteImage 由各用例控制。
// 这样 assetStore（查重 + 写盘）、remote-image（位置跟踪 + 替换）、smart-paste（接线）都跑真实代码。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { files, downloadMock, showMessageMock } = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  downloadMock: vi.fn(),
  showMessageMock: vi.fn(),
}));

vi.mock("../../src/lib/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/fs")>();
  const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
  const sha = async (data: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  return {
    ...actual,
    resolvePathFromDocument: vi.fn(async (doc: string, ...paths: string[]) =>
      join(doc.slice(0, doc.lastIndexOf("/")), ...paths),
    ),
    writeBinaryFile: vi.fn(async (path: string, data: Uint8Array) => {
      files.set(path, data.slice());
    }),
    findAssetByHash: vi.fn(async (dir: string, size: number, hash: string) => {
      for (const [path, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
        if (!path.startsWith(`${dir}/`) || path.slice(dir.length + 1).includes("/")) continue;
        if (data.byteLength === size && (await sha(data)) === hash) return path.slice(dir.length + 1);
      }
      return null;
    }),
    downloadRemoteImage: downloadMock,
  };
});

vi.mock("../../src/lib/dialogs", () => ({ showMessage: showMessageMock }));

import { RemoteImageError, writeBinaryFile } from "../../src/lib/fs";
import { smartPastePlugin } from "../../src/components/Editor/smart-paste";
import { imageUploadPlugin } from "../../src/components/Editor/image-upload";
import {
  MAX_REMOTE_IMAGES_PER_PASTE,
  remoteImagePlugin,
  type RemoteImageDeps,
} from "../../src/components/Editor/remote-image";
import { createHarness, type Harness } from "../fixtures/smartPasteHarness";

const DOC = "/docs/note.md";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9]);

let h: Harness;

async function setup(documentPath = DOC, deps: Partial<RemoteImageDeps> = {}) {
  h = await createHarness({
    plugins: (parse) => [
      imageUploadPlugin(documentPath),
      smartPastePlugin({ parseMarkdown: parse }),
      remoteImagePlugin({ documentPath, ...deps }),
    ],
  });
  return h;
}

function imageSrcs(): string[] {
  const out: string[] = [];
  h.view.state.doc.descendants((n) => {
    if (n.type.name === "image") out.push(n.attrs.src);
    return true;
  });
  return out;
}

const pasteHtml = (html: string) => h.paste({ "text/html": html, "text/plain": "" });

/** 等后台下载 / 写盘 / 替换全部结束 */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  files.clear();
  downloadMock.mockReset();
  showMessageMock.mockReset();
  vi.mocked(writeBinaryFile).mockClear();
});

afterEach(async () => {
  await h?.destroy();
});

describe("远程图片落盘：成功路径", () => {
  it("无 files、只有 text/html 的 <img src>：下载落盘到文档同目录 assets/ 并改为相对路径", async () => {
    downloadMock.mockResolvedValue({ data: PNG, mime: "image/png" });
    await setup();
    expect(pasteHtml('<p>截图：<img src="https://cdn.example.com/a.png" alt="截图"></p>')).toBe(true);
    // 粘贴即时可见：先以远程地址插入
    expect(imageSrcs()).toEqual(["https://cdn.example.com/a.png"]);
    await vi.waitFor(() => expect(imageSrcs()[0]).toMatch(/^assets\/\d+-[a-z0-9]+\.png$/));
    expect(downloadMock).toHaveBeenCalledWith("https://cdn.example.com/a.png");
    const [path, data] = [...files][0];
    expect(path).toBe(`/docs/${imageSrcs()[0]}`);
    expect(data).toEqual(PNG);
    // Markdown 源码里是相对路径
    expect(h.markdown()).toContain(`![截图](${imageSrcs()[0]})`);
    expect(showMessageMock).not.toHaveBeenCalled();
  });

  it("扩展名按下载内容的 MIME 决定（URL 没有扩展名 / 扩展名不符）", async () => {
    downloadMock.mockResolvedValue({ data: JPG, mime: "image/jpeg" });
    await setup();
    pasteHtml('<img src="https://img.example.com/photo?id=1&w=800">');
    await vi.waitFor(() => expect(imageSrcs()[0]).toMatch(/\.jpg$/));
  });

  it("一次粘贴里同一 URL 出现多次：只下载一次，所有引用都替换", async () => {
    downloadMock.mockResolvedValue({ data: PNG, mime: "image/png" });
    await setup();
    pasteHtml('<p><img src="https://a.example/x.png"></p><p><img src="https://a.example/x.png"></p>');
    await vi.waitFor(() => expect(imageSrcs().every((s) => s.startsWith("assets/"))).toBe(true));
    expect(downloadMock).toHaveBeenCalledTimes(1);
    expect(new Set(imageSrcs()).size).toBe(1);
    expect(files.size).toBe(1);
  });

  it("重复粘贴同一张图：第二次复用已有文件，不产生第二份副本", async () => {
    downloadMock.mockResolvedValue({ data: PNG, mime: "image/png" });
    await setup();
    pasteHtml('<p><img src="https://a.example/x.png"></p>');
    await vi.waitFor(() => expect(imageSrcs()[0]).toMatch(/^assets\//));
    h.cursorToEnd();
    // 不同 URL、相同内容（CDN 换了域名/参数）同样命中
    pasteHtml('<p><img src="https://mirror.example/x.png?v=2"></p>');
    await vi.waitFor(() => expect(imageSrcs().every((s) => s.startsWith("assets/"))).toBe(true));
    expect(imageSrcs()[1]).toBe(imageSrcs()[0]);
    expect(files.size).toBe(1);
    expect(writeBinaryFile).toHaveBeenCalledTimes(1);
  });

  it("下载期间用户在图片前输入文字：位置随编辑映射，仍替换到正确节点", async () => {
    let release!: (v: unknown) => void;
    downloadMock.mockReturnValue(new Promise((r) => (release = r)));
    await setup();
    pasteHtml('<p>尾<img src="https://a.example/x.png"></p>');
    // 在文档最前面插入文字，图片位置整体后移
    h.view.dispatch(h.view.state.tr.insertText("前面插入了很多字", 1));
    release({ data: PNG, mime: "image/png" });
    await vi.waitFor(() => expect(imageSrcs()[0]).toMatch(/^assets\//));
    expect(h.view.state.doc.textContent).toBe("前面插入了很多字尾");
  });

  it("下载期间图片被删除：不报错、不误改其他内容，文件仍可落盘", async () => {
    let release!: (v: unknown) => void;
    downloadMock.mockReturnValue(new Promise((r) => (release = r)));
    await setup();
    pasteHtml('<p>保留<img src="https://a.example/x.png">文字</p>');
    // 删掉图片节点
    let imgPos = -1;
    h.view.state.doc.descendants((n, pos) => {
      if (n.type.name === "image") imgPos = pos;
      return true;
    });
    h.view.dispatch(h.view.state.tr.delete(imgPos, imgPos + 1));
    const before = h.view.state.doc.toJSON();
    release({ data: PNG, mime: "image/png" });
    await settle();
    expect(h.view.state.doc.toJSON()).toEqual(before);
    expect(showMessageMock).not.toHaveBeenCalled();
  });

  it("src 替换不进撤销历史：一次撤销移除整个粘贴（不会先「撤回成远程地址」）", async () => {
    downloadMock.mockResolvedValue({ data: PNG, mime: "image/png" });
    await setup();
    h.view.dispatch(h.view.state.tr.insertText("原文", 1));
    pasteHtml('<p><img src="https://a.example/x.png"></p>');
    await vi.waitFor(() => expect(imageSrcs()[0]).toMatch(/^assets\//));
    h.undo();
    expect(imageSrcs()).toEqual([]);
    expect(h.view.state.doc.textContent).toBe("原文");
  });
});

describe("远程图片落盘：降级路径（保留远程 URL + 明确提示，不产生空引用）", () => {
  const failures: [string, unknown, RegExp][] = [
    ["网络错误", new RemoteImageError("network", "REMOTE_IMAGE_NETWORK: dns"), /网络错误/],
    ["超时", new RemoteImageError("timeout", "REMOTE_IMAGE_TIMEOUT"), /下载超时/],
    ["超限", new RemoteImageError("too-large", "REMOTE_IMAGE_TOO_LARGE"), /10MB/],
    ["403 防盗链", new RemoteImageError("forbidden", "REMOTE_IMAGE_FORBIDDEN: HTTP 403"), /403.*no-referrer/],
    ["其他 HTTP 状态", new RemoteImageError("http-status", "REMOTE_IMAGE_HTTP_STATUS: HTTP 404"), /HTTP 404/],
    ["不是图片", new RemoteImageError("not-image", "REMOTE_IMAGE_NOT_IMAGE"), /不是可识别的图片/],
    ["后端原始错误串", "REMOTE_IMAGE_TIMEOUT: operation timed out", /下载超时/],
    ["写盘失败（与下载失败区分提示）", null, /保存到 assets\/ 失败（Permission denied）/],
  ];

  for (const [label, error, message] of failures) {
    it(label, async () => {
      if (error === null) {
        downloadMock.mockResolvedValue({ data: PNG, mime: "image/png" });
        vi.mocked(writeBinaryFile).mockRejectedValueOnce(new Error("Permission denied"));
      } else {
        downloadMock.mockRejectedValue(error);
      }
      await setup();
      pasteHtml('<p><img src="https://a.example/x.png" alt="x"></p>');
      await vi.waitFor(() => expect(showMessageMock).toHaveBeenCalledTimes(1));
      expect(imageSrcs()).toEqual(["https://a.example/x.png"]);
      const [text, opts] = showMessageMock.mock.calls[0];
      expect(text).toContain("https://a.example/x.png");
      expect(text).toContain("已保留远程链接");
      expect(text).toMatch(message);
      expect(opts).toEqual({ kind: "warning" });
      expect(h.markdown()).toContain("](https://a.example/x.png)");
      expect(h.markdown()).not.toMatch(/!\[[^\]]*\]\(\s*\)/);
    });
  }

  it("多张失败只提示一次，并逐条列出", async () => {
    downloadMock.mockRejectedValue(new RemoteImageError("timeout", "t"));
    await setup();
    pasteHtml('<img src="https://a.example/1.png"><img src="https://a.example/2.png"><img src="https://a.example/3.png">');
    await vi.waitFor(() => expect(showMessageMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(showMessageMock).toHaveBeenCalledTimes(1);
    expect(showMessageMock.mock.calls[0][0]).toMatch(/^3 张远程图片/);
  });

  it("部分成功部分失败：成功的替换、失败的保留", async () => {
    downloadMock.mockImplementation(async (url: string) => {
      if (url.includes("bad")) throw new RemoteImageError("forbidden", "403");
      return { data: PNG, mime: "image/png" };
    });
    await setup();
    pasteHtml('<img src="https://a.example/good.png"><img src="https://a.example/bad.png">');
    await vi.waitFor(() => expect(showMessageMock).toHaveBeenCalledTimes(1));
    expect(imageSrcs()[0]).toMatch(/^assets\//);
    expect(imageSrcs()[1]).toBe("https://a.example/bad.png");
  });
});

describe("远程图片落盘：不下载的情形", () => {
  it("SVG（按 URL）不下载，保持远程引用且不提示", async () => {
    await setup();
    pasteHtml('<img src="https://a.example/logo.svg"><img src="https://a.example/icon.SVG?x=1">');
    await settle();
    expect(downloadMock).not.toHaveBeenCalled();
    expect(imageSrcs()).toEqual(["https://a.example/logo.svg", "https://a.example/icon.SVG?x=1"]);
    expect(showMessageMock).not.toHaveBeenCalled();
  });

  it("SVG（按内容，后端拒绝）保持远程引用且不算失败", async () => {
    downloadMock.mockRejectedValue(new RemoteImageError("svg", "REMOTE_IMAGE_SVG"));
    await setup();
    pasteHtml('<img src="https://a.example/render?format=auto">');
    await settle();
    expect(imageSrcs()).toEqual(["https://a.example/render?format=auto"]);
    expect(showMessageMock).not.toHaveBeenCalled();
  });

  it("data: / 相对路径图片不下载", async () => {
    await setup();
    pasteHtml('<img src="data:image/png;base64,iVBORw0KGgo="><img src="images/local.png">');
    await settle();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("未保存草稿（untitled-N）没有 assets 目录：保持远程引用，不下载", async () => {
    await setup("untitled-1");
    pasteHtml('<img src="https://a.example/x.png">');
    await settle();
    expect(downloadMock).not.toHaveBeenCalled();
    expect(imageSrcs()).toEqual(["https://a.example/x.png"]);
  });

  it(`单次粘贴最多下载 ${MAX_REMOTE_IMAGES_PER_PASTE} 张，其余保留远程引用`, async () => {
    downloadMock.mockResolvedValue({ data: PNG, mime: "image/png" });
    await setup();
    const n = MAX_REMOTE_IMAGES_PER_PASTE + 5;
    pasteHtml(Array.from({ length: n }, (_, i) => `<p><img src="https://a.example/${i}.png"></p>`).join(""));
    await vi.waitFor(() => expect(imageSrcs().filter((s) => s.startsWith("assets/"))).toHaveLength(MAX_REMOTE_IMAGES_PER_PASTE));
    expect(downloadMock).toHaveBeenCalledTimes(MAX_REMOTE_IMAGES_PER_PASTE);
    expect(imageSrcs().filter((s) => s.startsWith("https://"))).toHaveLength(5);
  });

  it("Markdown 源码粘贴里的远程图片不自动下载（用户显式写的 URL）", async () => {
    await setup();
    h.paste({ "text/plain": "# 标题\n\n![图](https://a.example/x.png)" });
    await settle();
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("编辑器销毁后下载才完成：不再派发事务", async () => {
    let release!: (v: unknown) => void;
    downloadMock.mockReturnValue(new Promise((r) => (release = r)));
    await setup();
    pasteHtml('<img src="https://a.example/x.png">');
    await h.destroy();
    release({ data: PNG, mime: "image/png" });
    await settle();
    expect(files.size).toBe(0);
    h = await createHarness(); // 供 afterEach 销毁
  });
});

describe("文件型图片粘贴（既有能力）不受影响", () => {
  it("剪贴板同时有图片文件与 text/html：优先按文件落盘，不走远程下载", async () => {
    await setup();
    const file = new File([PNG], "shot.png", { type: "image/png" });
    h.paste({ "text/html": '<img src="https://a.example/shot.png">', "text/plain": "" }, [file]);
    await vi.waitFor(() => expect(files.size).toBe(1));
    expect(downloadMock).not.toHaveBeenCalled();
    expect(imageSrcs()).toHaveLength(1);
    expect(imageSrcs()[0]).toMatch(/^assets\/.+\.png$/);
  });

  it("文件型粘贴重复同一张图：复用已有文件（#220 缺口 3）", async () => {
    await setup();
    const paste = () => h.paste({}, [new File([PNG], "shot.png", { type: "image/png" })]);
    paste();
    await vi.waitFor(() => expect(imageSrcs()).toHaveLength(1));
    paste();
    await vi.waitFor(() => expect(imageSrcs()).toHaveLength(2));
    expect(imageSrcs()[1]).toBe(imageSrcs()[0]);
    expect(files.size).toBe(1);
  });
});

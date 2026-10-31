/**
 * #372 桌面端 HTML 导出的**真实文件系统**验证（PR #397 复审阻塞 3）。
 *
 * 与 `export-html-sidecar.test.ts` 的分工：
 * - 那边用注入替身断言「调用参数」，锁取消、预算、降级分支的组合；
 * - 这里不替换 fs 层，也不替换 Tauri path 客户端：`@tauri-apps/api/path` 的
 *   `resolve(...)` 会真实执行并发出 `plugin:path|resolve` IPC，由 Node 的
 *   `path.resolve` 按同一语义承接；读写命令由 Node fs 真写、真读。于是
 *   `fs.ts` 的 `resolvePathFromDocument`（`documentPath` 判定 + `..` 语义）
 *   真实执行，HTML 与旁挂文件的字节、目录布局、`file://` 下的相对地址落点
 *   都在真实磁盘上验证。
 *
 * 证据边界：Tauri IPC 命令本体（Rust `write_binary_file` / `read_binary_file` 的
 * asset scope 校验、兜底上限、fsync 细节，以及 path 插件的 Rust 实现）不在本测试内。
 * Rust 单测只覆盖 `check_binary_read_target` 的**判定顺序**，真实 Scope 与真机导出
 * 均未验证。本测试证明的是「原生路径语义下，导出的磁盘布局与相对链接正确」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as nodeResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { editorViewCtx } from "@milkdown/kit/core";
import { Schema } from "@milkdown/kit/prose/model";

const { saveMock, showMessageMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  showMessageMock: vi.fn(),
}));

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

import { exportHTML } from "../../src/lib/exporter";
import { useWorkspace } from "../../src/store/workspace";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});

function editorWithImages(srcs: string[]) {
  const dom = document.createElement("div");
  dom.className = "ProseMirror";
  dom.setAttribute("contenteditable", "true");
  for (const src of srcs) {
    const p = document.createElement("p");
    const img = document.createElement("img");
    img.setAttribute("src", src);
    p.appendChild(img);
    dom.appendChild(p);
  }
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

/** convertFileSrc 在 Windows 打包端的输出形态 */
const assetSrc = (absPath: string) => `http://asset.localhost/${encodeURIComponent(absPath)}`;

// ---------- 真实 PNG 夹具（可被解码，而不是只有魔数的填充字节） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const tag = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([len, tag, data, crc]);
}

/** 生成真实 8bit RGB PNG；level 0 保证体积接近原始像素，用于超过 2MB 内联预算 */
function makePng(width: number, height: number, seed: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < raw.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    raw[i] = s & 0xff;
  }
  for (let y = 0; y < height; y++) raw[y * stride] = 0; // filter: none
  const idat = deflateSync(raw, { level: 0 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 解析 PNG：校验 chunk CRC 并解压 IDAT，证明字节是真正可解码的图片 */
function decodePng(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  let offset = 8;
  let ihdr: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + len);
    expect(bytes.readUInt32BE(offset + 8 + len), `${type} chunk CRC`).toBe(
      crc32(bytes.subarray(offset + 4, offset + 8 + len)),
    );
    if (type === "IHDR") ihdr = data;
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") break;
    offset += 12 + len;
  }
  expect(ihdr, "缺少 IHDR").not.toBeNull();
  const width = ihdr!.readUInt32BE(0);
  const height = ihdr!.readUInt32BE(4);
  const pixels = inflateSync(Buffer.concat(idat));
  expect(pixels.length, "IDAT 解压后的扫描线长度").toBe((1 + width * 3) * height);
  return { width, height };
}

// ---------- 真实磁盘的 Tauri 命令替身：只做「IPC 传输」，字节全部走 Node fs ----------

async function realFilesystemIpc(cmd: string, args: Record<string, any> = {}): Promise<unknown> {
  switch (cmd) {
    case "plugin:path|resolve":
      // 真实 @tauri-apps/api/path 的 resolve() 就是发这条 IPC；语义按原生路径归一
      return nodeResolve(...(args.paths as string[]));
    case "plugin:path|resolve_directory":
      return join(tmpdir(), "inkling-appdata");
    case "read_binary_file":
      return readFileSync(args.filePath).toString("base64");
    case "write_text_file":
      writeFileSync(args.filePath, args.content, "utf8");
      return undefined;
    case "create_dir":
      mkdirSync(args.dirPath, { recursive: true });
      return undefined;
    case "write_binary_file":
      writeFileSync(args.filePath, Buffer.from(args.data, "base64"));
      return undefined;
    default:
      throw new Error(`unexpected tauri command: ${cmd}`);
  }
}

let root: string;
let bigPng: Buffer;
let smallPng: Buffer;

/** 真实 @tauri-apps/api 客户端调用的 IPC 桥；只在这里替换边界，客户端与 fs 层都真实执行 */
function installTauriIpc(): void {
  const g = globalThis as unknown as { isTauri?: boolean; __TAURI_INTERNALS__?: unknown };
  // 与注入脚本同形：isTauri() 读 globalThis.isTauri，invoke() 走 __TAURI_INTERNALS__
  g.isTauri = true;
  g.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: Record<string, any>) => realFilesystemIpc(cmd, args ?? {}),
  };
}

function uninstallTauriIpc(): void {
  const g = globalThis as unknown as { isTauri?: boolean; __TAURI_INTERNALS__?: unknown };
  delete g.isTauri;
  delete g.__TAURI_INTERNALS__;
}

beforeEach(() => {
  installTauriIpc();
  root = mkdtempSync(join(tmpdir(), "inkling-export-"));
  mkdirSync(join(root, "assets"));
  bigPng = makePng(900, 900, 0x1234);
  smallPng = makePng(16, 16, 0x5678);
  writeFileSync(join(root, "assets", "大图.png"), bigPng);
  writeFileSync(join(root, "assets", "小图.png"), smallPng);
  const docPath = join(root, "笔记 #1.md");
  writeFileSync(docPath, "# doc\n");
  useWorkspace.setState({ currentFile: docPath });

  saveMock.mockReset();
  showMessageMock.mockReset();
});

afterEach(() => {
  uninstallTauriIpc();
  rmSync(root, { recursive: true, force: true });
});

describe("#372 桌面端 HTML 导出：真实文件系统落盘", () => {
  it("对话框改名 + 空格/中文/#：目录与文件按最终名落盘，HTML 里是编码后的相对地址", async () => {
    const htmlPath = join(root, "最终 报告 #1.html");
    saveMock.mockResolvedValue(htmlPath);
    await exportHTML(() =>
      editorWithImages([
        assetSrc(join(root, "assets", "大图.png")),
        assetSrc(join(root, "assets", "小图.png")),
      ]),
    );

    expect(bigPng.length, "大图夹具必须超过 2MB 内联预算").toBeGreaterThan(2 * 1024 * 1024);

    const html = readFileSync(htmlPath, "utf8");
    const sidecarDir = join(root, "最终 报告 #1_assets");
    const sidecarPath = join(sidecarDir, "大图.png");

    expect(existsSync(sidecarPath), "改名后的旁挂目录/文件必须真实存在").toBe(true);
    expect(readdirSync(sidecarDir), "只有大资源旁挂").toEqual(["大图.png"]);
    expect(
      Buffer.compare(readFileSync(sidecarPath), bigPng),
      "落盘字节必须与源文件逐字节一致",
    ).toBe(0);
    expect(decodePng(readFileSync(sidecarPath))).toEqual({ width: 900, height: 900 });

    const expectedUrl = `${encodeURIComponent("最终 报告 #1_assets")}/${encodeURIComponent("大图.png")}`;
    expect(html).toContain(`src="${expectedUrl}"`);
    expect(html, "地址里不得出现未编码的 #（会被当作片段）").not.toContain(
      'src="最终 报告 #1_assets/',
    );
    expect(html).not.toContain("asset.localhost");

    const smallData = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(html);
    expect(smallData, "小资源仍应内联").not.toBeNull();
    expect(Buffer.compare(Buffer.from(smallData![1], "base64"), smallPng)).toBe(0);
    expect(existsSync(join(sidecarDir, "小图.png"))).toBe(false);

    expect(showMessageMock, "完整成功的导出不弹降级提示").not.toHaveBeenCalled();
  });

  it("把导出目录整体挪走后，HTML 里的相对地址在 file:// 下仍指向真实可解码的图片", async () => {
    const htmlName = "报告 #1.html";
    const htmlPath = join(root, htmlName);
    saveMock.mockResolvedValue(htmlPath);
    await exportHTML(() =>
      editorWithImages([assetSrc(join(root, "assets", "大图.png"))]),
    );

    const movedDir = join(root, "分发", "另一台机器");
    mkdirSync(join(movedDir, "报告 #1_assets"), { recursive: true });
    const movedHtml = join(movedDir, htmlName);
    copyFileSync(htmlPath, movedHtml);
    copyFileSync(
      join(root, "报告 #1_assets", "大图.png"),
      join(movedDir, "报告 #1_assets", "大图.png"),
    );

    const html = readFileSync(movedHtml, "utf8");
    const relative = /src="([^"]+_assets\/[^"]+)"/.exec(html)?.[1];
    expect(relative, "HTML 里应有旁挂资源的相对地址").toBeTruthy();

    const fileUrl = new URL(relative!, pathToFileURL(movedHtml));
    expect(fileUrl.protocol, "产物挪走后应能用 file:// 打开").toBe("file:");
    const resolved = fileURLToPath(fileUrl);
    expect(existsSync(resolved), `file:// 解析到的文件不存在: ${resolved}`).toBe(true);
    expect(decodePng(readFileSync(resolved)).width).toBe(900);

    // 原地那份同样成立：相对地址只依赖 HTML 所在目录
    expect(existsSync(fileURLToPath(new URL(relative!, pathToFileURL(htmlPath))))).toBe(true);
  });

  it("真实写入失败（目标被同名目录占用）：HTML 照写，告警可定位到具体资源", async () => {
    const htmlPath = join(root, "失败 #1.html");
    saveMock.mockResolvedValue(htmlPath);
    const blocked = join(root, "失败 #1_assets", "大图.png");
    mkdirSync(blocked, { recursive: true });

    await exportHTML(() =>
      editorWithImages([assetSrc(join(root, "assets", "大图.png"))]),
    );

    expect(existsSync(htmlPath), "旁挂失败不能连累 HTML 产物").toBe(true);
    expect(readFileSync(htmlPath, "utf8")).toContain("_assets/");
    expect(statSync(blocked).isDirectory()).toBe(true);

    expect(showMessageMock).toHaveBeenCalledTimes(1);
    const [message] = showMessageMock.mock.calls[0] as [string];
    expect(message).toContain("未能完整导出");
    expect(message).toContain("写入旁挂资源失败");
    expect(decodeURIComponent(message)).toContain("大图.png");
  });
});

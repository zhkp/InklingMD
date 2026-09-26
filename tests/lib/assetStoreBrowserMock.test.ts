// 浏览器 mock 分支（pnpm dev / E2E）的图片落盘与远程下载（#220）
// 与桌面端同语义：写入记录到内存二进制表、按目录 + 内容哈希查重、fetch 结果按 Rust 端规则判定。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
  convertFileSrc: (p: string) => p,
}));

import { downloadRemoteImage, RemoteImageError, writeBinaryFile } from "../../src/lib/fs";
import { MOCK_BINARY_FILES, findMockBinaryByHash } from "../../src/lib/mockFs";
import { saveImageAsset, sha256Hex } from "../../src/lib/assetStore";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7]);

beforeEach(() => MOCK_BINARY_FILES.clear());
afterEach(() => vi.unstubAllGlobals());

describe("mock 二进制表", () => {
  it("writeBinaryFile 记录副本（调用方后续改写原数组不影响已写入内容）", async () => {
    const data = PNG.slice();
    await writeBinaryFile("assets/a.png", data);
    data[0] = 0;
    expect(MOCK_BINARY_FILES.get("assets/a.png")?.[0]).toBe(0x89);
  });

  it("findMockBinaryByHash：只看目录直接子文件，先比大小再比哈希", async () => {
    MOCK_BINARY_FILES.set("assets/b.png", PNG);
    MOCK_BINARY_FILES.set("assets/sub/c.png", PNG);
    MOCK_BINARY_FILES.set("other/d.png", PNG);
    const hash = await sha256Hex(PNG);
    await expect(findMockBinaryByHash("assets", PNG.byteLength, hash)).resolves.toBe("b.png");
    await expect(findMockBinaryByHash("assets", PNG.byteLength + 1, hash)).resolves.toBeNull();
    await expect(findMockBinaryByHash("assets/", PNG.byteLength, hash.toUpperCase())).resolves.toBe("b.png");
  });

  it("saveImageAsset 在浏览器模式同样去重", async () => {
    const first = await saveImageAsset("/mock-workspace/notes/readme.md", PNG, "1.png");
    const second = await saveImageAsset("/mock-workspace/notes/readme.md", PNG, "2.png");
    expect(first).toBe("assets/1.png");
    expect(second).toBe("assets/1.png");
    expect(MOCK_BINARY_FILES.size).toBe(1);
  });
});

describe("mock 远程下载（fetch，no-referrer）", () => {
  const respond = (status: number, type: string, body: Uint8Array = PNG) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(status === 204 ? null : body, { status, headers: { "content-type": type } })),
    );

  it("成功：返回字节与 MIME，请求不带 referrer 与凭据", async () => {
    respond(200, "image/png");
    const img = await downloadRemoteImage("https://a.example/x.png");
    expect(img.mime).toBe("image/png");
    expect(Array.from(img.data)).toEqual(Array.from(PNG));
    expect(fetch).toHaveBeenCalledWith("https://a.example/x.png", { referrerPolicy: "no-referrer", credentials: "omit" });
  });

  const failures: [string, () => void, string][] = [
    ["403", () => respond(403, "text/html"), "forbidden"],
    ["404", () => respond(404, "text/html"), "http-status"],
    ["SVG", () => respond(200, "image/svg+xml"), "svg"],
    ["非图片", () => respond(200, "text/html"), "not-image"],
    ["网络错误", () => vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); })), "network"],
  ];
  for (const [label, arrange, kind] of failures) {
    it(label, async () => {
      arrange();
      const err = await downloadRemoteImage("https://a.example/x.png").catch((e) => e);
      expect(err).toBeInstanceOf(RemoteImageError);
      expect(err.kind).toBe(kind);
    });
  }

  it("非 http(s) 地址直接拒绝，不发请求", async () => {
    respond(200, "image/png");
    const err = await downloadRemoteImage("file:///etc/passwd").catch((e) => e);
    expect(err.kind).toBe("bad-url");
    expect(fetch).not.toHaveBeenCalled();
  });
});

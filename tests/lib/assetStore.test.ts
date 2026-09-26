// 图片资源落盘 / 远程下载的前端 IO 层单测（#220）
//
// - assetStore.saveImageAsset：内容哈希查重命中复用、未命中写入、查重失败不阻断
// - lib/fs 桌面分支：download_remote_image / find_asset_by_hash 的 IPC 契约与错误映射
// - 动态 asset ACL：落盘后的 assets/ 相对路径在渲染时会触发 allow_asset_dir 放行该目录
//   （#64 的运行时白名单在下载场景下同样生效，#220「放行确认」）

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, resolveMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  resolveMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: invokeMock,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));
// 与 Tauri path.resolve 同语义的最小实现：处理 ".."
vi.mock("@tauri-apps/api/path", () => ({
  resolve: (...parts: string[]) => {
    const out: string[] = [];
    for (const seg of parts.join("/").split("/")) {
      if (seg === "..") out.pop();
      else if (seg && seg !== ".") out.push(seg);
    }
    return Promise.resolve(`/${out.join("/")}`);
  },
}));

import {
  downloadRemoteImage,
  findAssetByHash,
  mapRemoteImageError,
  RemoteImageError,
  resolveImageSrc,
} from "../../src/lib/fs";
import { extensionForMime, genAssetName, saveImageAsset, sha256Hex } from "../../src/lib/assetStore";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

beforeEach(() => {
  invokeMock.mockReset();
  resolveMock.mockReset();
});

describe("assetStore 工具函数", () => {
  it("MIME → 扩展名，未知类型回落 .png", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/webp; charset=binary")).toBe(".webp");
    expect(extensionForMime("IMAGE/GIF")).toBe(".gif");
    expect(extensionForMime("application/octet-stream")).toBe(".png");
  });

  it("文件名沿用既有 assets 命名规则：时间戳-随机串.扩展名", () => {
    expect(genAssetName(".PNG")).toMatch(/^\d{13}-[a-z0-9]{1,6}\.png$/);
    expect(genAssetName("jpg")).toMatch(/\.jpg$/);
  });

  it("sha256Hex 与标准测试向量一致", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("saveImageAsset：落盘前按内容查重", () => {
  it("命中：复用已有文件名，不写入", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "find_asset_by_hash" ? "old-shot.png" : undefined));
    await expect(saveImageAsset("/docs/note.md", PNG, "new.png")).resolves.toBe("assets/old-shot.png");
    expect(invokeMock).toHaveBeenCalledWith("find_asset_by_hash", {
      dirPath: "/docs/assets",
      size: PNG.byteLength,
      sha256: await sha256Hex(PNG),
    });
    expect(invokeMock).not.toHaveBeenCalledWith("write_binary_file", expect.anything());
  });

  it("未命中：写入 assets/<新文件名>", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(saveImageAsset("/docs/sub/note.md", PNG, "new.png")).resolves.toBe("assets/new.png");
    expect(invokeMock).toHaveBeenCalledWith("write_binary_file", {
      filePath: "/docs/sub/assets/new.png",
      data: expect.any(String),
    });
  });

  it("查重失败（IPC 异常）不阻断：按新文件写入", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "find_asset_by_hash") throw new Error("permission denied");
      return undefined;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(saveImageAsset("/docs/note.md", PNG, "n.png")).resolves.toBe("assets/n.png");
    expect(invokeMock).toHaveBeenCalledWith("write_binary_file", expect.anything());
  });

  it("写入失败向上抛出（由调用方提示）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "write_binary_file") throw new Error("disk full");
      return null;
    });
    await expect(saveImageAsset("/docs/note.md", PNG, "n.png")).rejects.toThrow("disk full");
  });
});

describe("lib/fs 桌面分支：远程图片 IPC 契约", () => {
  it("downloadRemoteImage：调用 download_remote_image 并把 base64 解码为字节", async () => {
    invokeMock.mockResolvedValue({ data: btoa(String.fromCharCode(...PNG)), mime: "image/png" });
    const img = await downloadRemoteImage("https://a.example/x.png");
    expect(invokeMock).toHaveBeenCalledWith("download_remote_image", { url: "https://a.example/x.png" });
    expect(img.mime).toBe("image/png");
    expect(Array.from(img.data)).toEqual(Array.from(PNG));
  });

  it("downloadRemoteImage：后端错误标记映射为 RemoteImageError.kind", async () => {
    const cases: [string, string][] = [
      ["REMOTE_IMAGE_BAD_URL: x", "bad-url"],
      ["REMOTE_IMAGE_FORBIDDEN: HTTP 403", "forbidden"],
      ["REMOTE_IMAGE_HTTP_STATUS: HTTP 500", "http-status"],
      ["REMOTE_IMAGE_TIMEOUT: t", "timeout"],
      ["REMOTE_IMAGE_TOO_LARGE: 1", "too-large"],
      ["REMOTE_IMAGE_NOT_IMAGE: html", "not-image"],
      ["REMOTE_IMAGE_SVG: svg", "svg"],
      ["REMOTE_IMAGE_NETWORK: dns", "network"],
      ["something unexpected", "network"],
    ];
    for (const [raw, kind] of cases) {
      invokeMock.mockRejectedValueOnce(raw);
      const err = await downloadRemoteImage("https://a.example/x.png").catch((e) => e);
      expect(err).toBeInstanceOf(RemoteImageError);
      expect(err.kind, raw).toBe(kind);
    }
  });

  it("mapRemoteImageError 只认前缀：消息中间含标记串的普通错误不被误映射", () => {
    expect(mapRemoteImageError(new Error("failed at /tmp/REMOTE_IMAGE_TIMEOUT/a.png")).kind).toBe("network");
    const original = new RemoteImageError("svg", "x");
    expect(mapRemoteImageError(original)).toBe(original);
  });

  it("findAssetByHash：参数原样透传，undefined 归一为 null", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await expect(findAssetByHash("/d/assets", 3, "ab")).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("find_asset_by_hash", { dirPath: "/d/assets", size: 3, sha256: "ab" });
    invokeMock.mockResolvedValueOnce("hit.png");
    await expect(findAssetByHash("/d/assets", 3, "ab")).resolves.toBe("hit.png");
  });
});

describe("动态 asset ACL 放行确认（#64 × #220）", () => {
  it("落盘得到的 assets/ 相对路径渲染时放行 assets 目录并转换为 asset 协议 URL", async () => {
    invokeMock.mockResolvedValue(null);
    const rel = await saveImageAsset("/work/e-drive/note.md", PNG, "1700000000000-abc.png");
    invokeMock.mockClear();
    const url = await resolveImageSrc(rel, "/work/e-drive/note.md");
    expect(invokeMock).toHaveBeenCalledWith("allow_asset_dir", { path: "/work/e-drive/assets" });
    expect(url).toBe("asset://localhost//work/e-drive/assets/1700000000000-abc.png");
  });

  it("远程图片地址本身不走 asset 协议、不放行任何目录", async () => {
    await expect(resolveImageSrc("https://a.example/x.png", "/work/note.md")).resolves.toBe("https://a.example/x.png");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

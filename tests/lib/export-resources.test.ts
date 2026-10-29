/**
 * #372 导出资源可移植化：把编辑器 DOM 里的运行时 asset 地址换成**自包含**形式。
 *
 * 这里锁的是资源处理器自身的契约（分类 / 内联 / 旁挂 / 预算 / 降级 / CSS 通道），
 * IO 走注入的内存夹具；「产物搬走仍能加载」由 E2E 用真实文件验证。
 */
import { describe, expect, it, vi } from "vitest";
import {
  ExportResourceProcessor,
  classifyResource,
  declarationBounds,
  extensionOf,
  findRuntimeUrls,
  formatResourceWarnings,
  mimeForResource,
  missingResourcePlaceholder,
  processDomResources,
  toDataUrl,
} from "../../src/lib/exportResources";

const APP_ORIGIN = "http://localhost:3000/";
const DOC = "/notes/doc.md";

/** 8x8 单色 PNG 的真实字节（含 PNG 魔数） */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x08, 0x08, 0x02, 0x00, 0x00, 0x00, 0x4b, 0x6d, 0x29,
  0xdc, 0x00, 0x00, 0x00, 0x1a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xfc, 0xff, 0x9f, 0x81,
  0x01, 0x14, 0x33, 0x0e, 0x05, 0x00, 0x9a, 0x8c, 0x18, 0x00, 0x1b, 0x4c, 0x61, 0x00, 0x00, 0x00,
  0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const SVG_TEXT = `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#f00"/></svg>`;
const enc = new TextEncoder();

/**
 * 造「大图」夹具：以真实 PNG 魔数开头再填充到目标字节数。
 * 导出管线会校验内容与扩展名是否相符（防止把服务器回落的 index.html 当图片），
 * 所以「大资源」夹具不能是任意填充字节——那样测的就不是真实路径了。
 */
function pngOfSize(size: number, fill = 0): Uint8Array {
  const out = new Uint8Array(Math.max(size, PNG_BYTES.length));
  out.set(PNG_BYTES);
  if (fill) out.fill(fill, PNG_BYTES.length);
  return out;
}

/** asset:// 形态的运行时地址（非 Windows 平台 convertFileSrc 的输出） */
const assetUrl = (p: string) => `asset://localhost/${encodeURIComponent(p)}`;
/** http://asset.localhost 形态（Windows 平台） */
const assetLocalhostUrl = (p: string) => `http://asset.localhost/${encodeURIComponent(p)}`;

/** 内存文件系统夹具：absPath → bytes */
function makeFs(files: Record<string, Uint8Array | string>) {
  const read = vi.fn(async (absPath: string): Promise<Uint8Array> => {
    const hit = Object.entries(files).find(
      ([k]) => k === absPath || k.replace(/\\/g, "/").toLowerCase() === absPath.replace(/\\/g, "/").toLowerCase(),
    );
    if (!hit) throw new Error(`file not found: ${absPath}`);
    return typeof hit[1] === "string" ? enc.encode(hit[1] as string) : (hit[1] as Uint8Array);
  });
  return read;
}

/** 相对引用解析夹具：按文档所在目录归一（与 resolvePathFromDocument 同口径） */
async function fakeResolveRelative(docPath: string, ref: string): Promise<string> {
  if (ref.startsWith("/")) return ref;
  const dir = docPath.replace(/[\\/][^\\/]*$/, "").split("/");
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") dir.pop();
    else dir.push(seg);
  }
  return dir.join("/");
}

function processor(files: Record<string, Uint8Array | string>, opts: Partial<ConstructorParameters<typeof ExportResourceProcessor>[0]> = {}) {
  return new ExportResourceProcessor({
    mode: "inline",
    documentPath: DOC,
    appOrigin: APP_ORIGIN,
    readFile: makeFs(files),
    resolveRelative: fakeResolveRelative,
    fetchUrl: async () => {
      throw new Error("fetch disabled in this test");
    },
    ...opts,
  });
}

describe("#372 classifyResource：引用分类是纯函数", () => {
  it("asset:// 与 http://asset.localhost 两种形态都解出已解码的绝对路径", () => {
    expect(classifyResource(assetUrl("/notes/img/a b.png"))).toEqual({
      kind: "local",
      absPath: "/notes/img/a b.png",
    });
    expect(classifyResource(assetLocalhostUrl("E:\\notes\\图片\\a.png"))).toEqual({
      kind: "local",
      absPath: "E:\\notes\\图片\\a.png",
    });
  });

  it("file: URL 三种写法都还原成可直接读的绝对路径（含 Windows 盘符）", () => {
    // WHATWG 规范会给盘符路径加前导斜杠，必须去掉，否则后端读到 `//E:/…` 直接失败
    expect(classifyResource("file:///E:/notes/a.png")).toEqual({ kind: "local", absPath: "E:/notes/a.png" });
    expect(classifyResource("file:///E:\\notes\\a.png")).toEqual({ kind: "local", absPath: "E:/notes/a.png" });
    expect(classifyResource("file:///home/u/a.png")).toEqual({ kind: "local", absPath: "/home/u/a.png" });
    // host 段非空（file://localhost/…）也不把 host 当路径
    expect(classifyResource("file://localhost/home/u/a.png")).toEqual({
      kind: "local",
      absPath: "/home/u/a.png",
    });
    // UNC：host 是共享主机，丢了会读成本机上的同名路径
    expect(classifyResource("file://server/share/a.png")).toEqual({
      kind: "local",
      absPath: "//server/share/a.png",
    });
  });

  it("query / hash 是噪声，路径里的裸 % 不因解码失败而丢字", () => {
    expect(classifyResource(assetUrl("/notes/a.png") + "?v=2#frag")).toEqual({
      kind: "local",
      absPath: "/notes/a.png",
    });
    // 裸 % 让 decodeURIComponent 抛；按原串使用而不是整体失败
    expect(classifyResource("asset://localhost/notes/100%25.png").kind).toBe("local");
    expect((classifyResource("asset://localhost/notes/100%.png") as { absPath: string }).absPath).toBe(
      "notes/100%.png",
    );
  });

  it("data: / blob: 视为已自包含，远程与协议相对保持原语义", () => {
    expect(classifyResource("data:image/png;base64,AAA")).toEqual({ kind: "self-contained" });
    expect(classifyResource("blob:http://localhost/xyz")).toEqual({ kind: "self-contained" });
    expect(classifyResource("https://cdn.example.com/a.png")).toEqual({
      kind: "remote",
      url: "https://cdn.example.com/a.png",
    });
    expect(classifyResource("//cdn.example.com/a.png").kind).toBe("remote");
  });

  it("无 scheme 的相对引用交给文档目录解析；空串不炸", () => {
    expect(classifyResource("images/a.png")).toEqual({ kind: "relative", ref: "images/a.png" });
    expect(classifyResource("  ./images/a.png  ")).toEqual({ kind: "relative", ref: "./images/a.png" });
    expect(classifyResource("")).toEqual({ kind: "self-contained" });
  });

  it("Windows 盘符绝对路径按本地文件处理（单字母不是协议）", () => {
    // `E:` 会被通用 scheme 正则命中；但单字母 scheme 在 URL 语法里不存在，
    // 原样当远程写进产物就是一条离开本机即失效、且不告警的死链。
    expect(classifyResource("E:/notes/a.png")).toEqual({ kind: "local", absPath: "E:/notes/a.png" });
    expect(classifyResource("e:\\notes\\a.png")).toEqual({ kind: "local", absPath: "e:\\notes\\a.png" });
    // 真正的协议不受影响
    expect(classifyResource("https://cdn.example.com/a.png").kind).toBe("remote");
    expect(classifyResource("mailto:x@example.com").kind).toBe("remote");
  });
});

describe("#372 MIME 判定：魔数优先于扩展名", () => {
  it("PNG / JPEG 魔数胜出，扩展名说谎也不误判", () => {
    expect(mimeForResource("/a.png", PNG_BYTES)).toBe("image/png");
    expect(mimeForResource("/a.txt", PNG_BYTES)).toBe("image/png");
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(mimeForResource("/misnamed.bin", jpeg)).toBe("image/jpeg");
  });

  it("SVG 文本按内容嗅探（无魔数），BOM 与前导空白不影响", () => {
    expect(mimeForResource("/a", enc.encode(SVG_TEXT))).toBe("image/svg+xml");
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("\n  " + SVG_TEXT)]);
    expect(mimeForResource("/a", bom)).toBe("image/svg+xml");
    expect(mimeForResource("/a.svg", enc.encode("<svg/>"))).toBe("image/svg+xml");
    // 合法 SVG 常带序言：DOCTYPE / 注释先行的不能被判成「内容与扩展名不符」
    const doctype = enc.encode(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n${SVG_TEXT}`);
    expect(mimeForResource("/a", doctype)).toBe("image/svg+xml");
    expect(mimeForResource("/a", enc.encode(`<!-- icon -->\n${SVG_TEXT}`))).toBe("image/svg+xml");
  });

  it("字体与未知类型回落扩展名 / octet-stream", () => {
    expect(mimeForResource("/fonts/x.woff2", enc.encode("wOF2"))).toBe("font/woff2");
    expect(mimeForResource("/a.unknownext", enc.encode("zzzzzzzzzzzzz"))).toBe("application/octet-stream");
    expect(extensionOf("C:\\notes\\图片\\A.PNG")).toBe(".png");
    expect(extensionOf("/notes/noext")).toBe("");
  });

  it("toDataUrl 分块编码，大字节数组不爆栈且可还原", () => {
    const big = new Uint8Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const url = toDataUrl("application/octet-stream", big);
    expect(url.startsWith("data:application/octet-stream;base64,")).toBe(true);
    const back = Buffer.from(url.split(",")[1], "base64");
    expect(back.length).toBe(big.length);
    expect(back[199_999]).toBe(199_999 % 251);
  });

  it("占位图是自包含 data URL，且把资源名与原因带进产物（转义 XML 特殊字符）", () => {
    const ph = missingResourcePlaceholder("/a<b>&c.png", "读取失败");
    expect(ph.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    const svg = decodeURIComponent(ph.split(",")[1]);
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).toContain("&amp;c");
    expect(svg).toContain("读取失败");
    expect(svg).not.toContain("<b>");
  });
});

describe("#372 inline 模式：一律内联为 data URL", () => {
  const files = { "/notes/img/a.png": PNG_BYTES, "/notes/img/图 片.svg": SVG_TEXT };

  it("asset 协议地址换成 data URL，产物里再无运行时地址", async () => {
    const p = processor(files);
    const out = await p.resolve(assetUrl("/notes/img/a.png"));
    expect(out.startsWith("data:image/png;base64,")).toBe(true);
    expect(out).not.toContain("asset");
    expect(p.warnings).toEqual([]);
  });

  it("Windows 形态与含空格/中文的路径同样可解析", async () => {
    const p = processor(files);
    const out = await p.resolve(assetLocalhostUrl("/notes/img/图 片.svg"));
    expect(out.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(p.warnings).toEqual([]);
  });

  it("Markdown 相对路径按文档目录解析（./images 与 images 同口径）", async () => {
    const p = processor({ "/notes/images/b.png": PNG_BYTES });
    expect((await p.resolve("images/b.png")).startsWith("data:image/png")).toBe(true);
    const p2 = processor({ "/notes/images/b.png": PNG_BYTES });
    expect((await p2.resolve("./images/b.png")).startsWith("data:image/png")).toBe(true);
    const p3 = processor({ "/img/b.png": PNG_BYTES });
    expect((await p3.resolve("../img/b.png")).startsWith("data:image/png")).toBe(true);
  });

  it("远程图片与 data:/blob: 原样保留，不发起任何读取", async () => {
    const read = makeFs(files);
    const p = new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile: read,
      resolveRelative: fakeResolveRelative,
      fetchUrl: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(await p.resolve("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(await p.resolve("data:image/png;base64,AAA")).toBe("data:image/png;base64,AAA");
    expect(read).not.toHaveBeenCalled();
  });

  it("同一资源被引用多次只读一次（去重）", async () => {
    const read = makeFs(files);
    const p = new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile: read,
      resolveRelative: fakeResolveRelative,
    });
    const a = await p.resolve(assetUrl("/notes/img/a.png"));
    const b = await p.resolve(assetLocalhostUrl("/notes/img/a.png"));
    expect(a).toBe(b);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("#372 sidecar 模式：大资源落旁挂目录，小资源仍内联", () => {
  const big = pngOfSize(5000, 7);
  const files = {
    "/notes/img/small.png": PNG_BYTES,
    "/notes/img/big.png": big,
    "/notes/img/big 名.png": big,
  };

  it("超过内联上限的资源写成旁挂文件，产物里是编码后的相对地址", async () => {
    const p = processor(files, { mode: "sidecar", sidecarDir: "doc_assets", inlineMaxBytes: 1000 });
    const small = await p.resolve(assetUrl("/notes/img/small.png"));
    const large = await p.resolve(assetUrl("/notes/img/big.png"));
    expect(small.startsWith("data:image/png;base64,")).toBe(true);
    expect(large).toBe("doc_assets/big.png");
    expect(p.sidecars).toHaveLength(1);
    expect(p.sidecars[0]).toMatchObject({
      relativeUrl: "doc_assets/big.png",
      relativePath: "doc_assets/big.png",
      data: big,
    });
  });

  it("文件名含空格/中文：地址侧百分号编码，磁盘侧保留原名", async () => {
    const p = processor(files, { mode: "sidecar", sidecarDir: "doc_assets", inlineMaxBytes: 1000 });
    const value = await p.resolve(assetUrl("/notes/img/big 名.png"));
    expect(value).toBe(`doc_assets/${encodeURIComponent("big 名.png")}`);
    expect(p.sidecars[0].relativeUrl).toBe(`doc_assets/${encodeURIComponent("big 名.png")}`);
    expect(p.sidecars[0].relativePath).toBe("doc_assets/big 名.png");
    // 磁盘段可安全交给 resolvePath：不含路径分隔符
    expect(p.sidecars[0].relativePath.split("/")).toHaveLength(2);
  });

  it("仅大小写不同的同名资源也加序号（Windows 落盘会互相覆盖）", async () => {
    const p = processor(
      { "/notes/a/Logo.PNG": pngOfSize(2000, 1), "/notes/b/logo.png": pngOfSize(2000, 2) },
      { mode: "sidecar", sidecarDir: "assets", inlineMaxBytes: 100 },
    );
    expect(await p.resolve(assetUrl("/notes/a/Logo.PNG"))).toBe("assets/Logo.PNG");
    expect(await p.resolve(assetUrl("/notes/b/logo.png"))).toBe("assets/logo-1.png");
    expect(p.sidecars).toHaveLength(2);
    // 大小写不敏感地去重：两个文件名的小写形式必须不同
    const keys = p.sidecars.map((s) => s.relativePath.toLowerCase());
    expect(new Set(keys).size).toBe(2);
  });

  it("同名不同内容加序号，绝不互相覆盖", async () => {
    const p = processor(
      { "/notes/a/big.png": pngOfSize(2000, 1), "/notes/b/big.png": pngOfSize(2000, 2) },
      { mode: "sidecar", sidecarDir: "assets", inlineMaxBytes: 100 },
    );
    const first = await p.resolve(assetUrl("/notes/a/big.png"));
    const second = await p.resolve(assetUrl("/notes/b/big.png"));
    expect(first).toBe("assets/big.png");
    expect(second).toBe("assets/big-1.png");
    expect(p.sidecars.map((s) => s.relativePath)).toEqual(["assets/big.png", "assets/big-1.png"]);
    expect(p.sidecars[0].data).toEqual(pngOfSize(2000, 1));
    expect(p.sidecars[1].data).toEqual(pngOfSize(2000, 2));
  });

  it("旁挂目录名含空格/#/%：地址侧逐段编码，磁盘侧保留原名", async () => {
    // 目录名来自用户保存的文件名（`report #1.html`）：不编码时 `#1_assets` 会被浏览器当片段
    const p = processor(files, {
      mode: "sidecar",
      sidecarDir: "report #1_assets",
      inlineMaxBytes: 1000,
    });
    const value = await p.resolve(assetUrl("/notes/img/big.png"));
    expect(value).toBe("report%20%231_assets/big.png");
    expect(p.sidecars[0].relativeUrl).toBe("report%20%231_assets/big.png");
    expect(p.sidecars[0].relativePath).toBe("report #1_assets/big.png");
  });

  it("同一资源被引用两次只登记一个旁挂文件", async () => {
    const p = processor(files, { mode: "sidecar", sidecarDir: "assets", inlineMaxBytes: 1000 });
    await p.resolve(assetUrl("/notes/img/big.png"));
    await p.resolve(assetLocalhostUrl("/notes/img/big.png"));
    expect(p.sidecars).toHaveLength(1);
  });

  it("inline 模式没有磁盘落点：大资源也必须内联，不得静默丢弃", async () => {
    const p = processor(files, { mode: "inline", inlineMaxBytes: 1000 });
    const value = await p.resolve(assetUrl("/notes/img/big.png"));
    expect(value.startsWith("data:image/png;base64,")).toBe(true);
    expect(p.sidecars).toHaveLength(0);
  });
});

describe("#372 预算与降级：失败要可见，不能伪装成导出成功", () => {
  it("资源缺失/读取失败 → 可见占位图 + 告警，其余资源照常导出", async () => {
    const p = processor({ "/notes/img/a.png": PNG_BYTES });
    const ok = await p.resolveRef(assetUrl("/notes/img/a.png"));
    const bad = await p.resolveRef(assetUrl("/notes/img/missing.png"));
    expect(ok.ok).toBe(true);
    expect(bad.ok).toBe(false);
    expect(bad.value.startsWith("data:image/svg+xml")).toBe(true);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0].ref).toBe(assetUrl("/notes/img/missing.png"));
    expect(p.warnings[0].reason).toContain("file not found");
  });

  it("占位图只写文件名：绝对路径（用户目录结构）不得随产物外泄", async () => {
    const p = processor({});
    const r = await p.resolveRef(assetUrl("/Users/alice/secret/img/a.png"));
    expect(r.ok).toBe(false);
    const decoded = decodeURIComponent(r.value);
    expect(decoded).toContain("a.png");
    expect(decoded).not.toContain("/Users/alice");
    expect(decoded).not.toContain("asset.localhost");
    // 完整路径仍留在本机告警里，便于排查
    expect(p.warnings[0].ref).toBe(assetUrl("/Users/alice/secret/img/a.png"));
    expect(p.warnings[0].reason).toContain("/Users/alice/secret/img/a.png");
  });

  it("blob: 无法内联，但要在告警里明确告知（不静默留死链）", async () => {
    const p = processor({});
    const r = await p.resolveRef("blob:http://localhost/xyz");
    expect(r).toEqual({ value: "blob:http://localhost/xyz", ok: true });
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0].reason).toContain("blob:");
  });

  it("同一失败资源重复引用只告警一次，也不重复尝试读取", async () => {
    const read = makeFs({});
    const p = new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile: read,
      resolveRelative: fakeResolveRelative,
    });
    await p.resolve(assetUrl("/notes/x.png"));
    await p.resolve(assetUrl("/notes/x.png"));
    expect(read).toHaveBeenCalledTimes(1);
    expect(p.warnings).toHaveLength(1);
  });

  it("超出总预算的资源降级为占位图，已成功的资源不受影响", async () => {
    const p = processor(
      { "/notes/a.png": PNG_BYTES, "/notes/big.png": pngOfSize(3000, 9) },
      { totalMaxBytes: 2000 },
    );
    const first = await p.resolveRef(assetUrl("/notes/a.png"));
    const second = await p.resolveRef(assetUrl("/notes/big.png"));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(p.warnings[0].reason).toContain("总预算");
  });

  it("无法解析为本地路径时也降级，而不是把原始串写进产物", async () => {
    const p = new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile: makeFs({}),
      resolveRelative: async () => "",
    });
    const r = await p.resolveRef("images/a.png");
    expect(r.ok).toBe(false);
    expect(p.warnings[0].reason).toBe("无法解析为本地路径");
  });

  it("路径解析本身抛错同样按降级处理：一次异常不能吞掉整份导出", async () => {
    const p = new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile: makeFs({}),
      resolveRelative: async () => {
        throw new Error("IPC unavailable: /Users/alice/secret");
      },
    });
    const r = await p.resolveRef("images/a.png");
    expect(r.ok).toBe(false);
    expect(r.value.startsWith("data:image/svg+xml")).toBe(true);
    // 占位图会随产物分享：只能有文件名与稳定文案，错误细节留在本机告警
    const placeholder = decodeURIComponent(r.value);
    expect(placeholder).toContain("a.png");
    expect(placeholder).not.toContain("/Users/alice");
    expect(placeholder).not.toContain("IPC unavailable");
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0].reason).toContain("无法解析为本地路径");
    expect(p.warnings[0].reason).toContain("IPC unavailable");
    expect(p.warnings[0].reason).toContain("/Users/alice/secret");
  });

  it("formatResourceWarnings 汇总条数并逐条列出", () => {
    const text = formatResourceWarnings(["a：读取失败", "b：超时"]);
    expect(text).toContain("2 处内容未能完整导出");
    expect(text).toContain("· a：读取失败");
    expect(text).toContain("· b：超时");
  });

  it("读到网页而不是图片 → 判为降级，绝不把 HTML 当 PNG 内联", async () => {
    // 真实形态：路径写错时 dev server / 静态站点回落 index.html 并回 200。
    // 不校验内容的话这里会「成功」内联一整页 HTML，产物里的图是坏的且毫无告知。
    const p = processor({
      "/notes/img/a.png": "<!doctype html>\n<html><body>Not Found</body></html>",
    });
    const r = await p.resolveRef(assetUrl("/notes/img/a.png"));
    expect(r.ok).toBe(false);
    expect(r.value.startsWith("data:image/svg+xml")).toBe(true);
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0].reason).toContain("文件内容与扩展名不符");
  });

  it("内容校验只拦「完全不像资源」的字节：扩展名与真实格式不符的图片照常导出", async () => {
    // 用户把 PNG 存成 .jpg 是常见情形，浏览器能嗅探；不能因为我们校验就丢掉这张图。
    const p = processor({ "/notes/img/wrong.jpg": PNG_BYTES, "/notes/img/a.png": PNG_BYTES });
    const r = await p.resolveRef(assetUrl("/notes/img/wrong.jpg"));
    expect(r.ok).toBe(true);
    expect(r.value.startsWith("data:image/png;base64,")).toBe(true);
    expect(p.warnings).toHaveLength(0);
  });

  it("非图片/字体类扩展名（CSS、未知后缀）不做内容校验", async () => {
    const p = processor({
      "/notes/theme.css": "body{color:red}",
      "/notes/data.bin": new Uint8Array([1, 2, 3, 4]),
    });
    expect((await p.resolveRef(assetUrl("/notes/theme.css"))).ok).toBe(true);
    expect((await p.resolveRef(assetUrl("/notes/data.bin"))).ok).toBe(true);
    expect(p.warnings).toHaveLength(0);
  });
});

describe("#372 CSS 通道：字体/背景 url() 与 @import", () => {
  it("asset 协议的字体 url() 内联为 data URL，产物里再无运行时地址", async () => {
    const css = `@font-face { font-family: KaTeX; src: url(${assetUrl("/fonts/katex.woff2")}) format("woff2"); }`;
    const p = processor({ "/fonts/katex.woff2": enc.encode("wOF2fake") });
    const out = await p.processCss(css);
    expect(out).toContain('url("data:font/woff2;base64,');
    expect(out).not.toContain("asset.localhost");
    expect(out).toContain('format("woff2")');
    expect(p.warnings).toEqual([]);
  });

  it("多个 url() 分别处理：成功的内联，失败的那条声明整体删除（不留半截无效 CSS）", async () => {
    const css =
      `@font-face { font-family: A; src: url(${assetUrl("/fonts/a.woff2")}); }\n` +
      `@font-face { font-family: B; src: url(${assetUrl("/fonts/missing.woff2")}); }\n` +
      `.bg { background: url(${assetUrl("/img/bg.png")}) no-repeat; }`;
    const p = processor({ "/fonts/a.woff2": enc.encode("wOF2"), "/img/bg.png": PNG_BYTES });
    const out = await p.processCss(css);
    expect(out).toContain("font-family: A");
    expect(out).toContain("font-family: B");
    expect(out).not.toContain("missing.woff2");
    expect(out).toContain("data:image/png;base64,");
    // 失败的是 src 声明，不是整条 @font-face 规则：font-family 仍在
    expect(out.match(/@font-face/g)).toHaveLength(2);
    expect(p.warnings.map((w) => w.reason)).toContain("file not found: /fonts/missing.woff2");
  });

  it("远程 url() 原样保留", async () => {
    const css = `.bg { background: url("https://cdn.example.com/x.png"); }`;
    const p = processor({});
    expect(await p.processCss(css)).toContain("https://cdn.example.com/x.png");
  });

  it('引号内的括号不被当成 url() 的右括号（url("chart (1).png") 能正常内联）', async () => {
    const css = `.bg { background: url("${assetUrl("/img/chart (1).png")}"); }`;
    const p = processor({ "/img/chart (1).png": PNG_BYTES });
    const out = await p.processCss(css);
    expect(out).toContain('url("data:image/png;base64,');
    expect(out).not.toContain("asset.localhost");
    expect(p.warnings).toEqual([]);
  });

  it("双引号 URL 里的撇号不会截断扫描（url(\"it's.png\")）", async () => {
    const css = `.bg { background: url("${assetUrl("/img/it's.png")}"); }`;
    const p = processor({ "/img/it's.png": PNG_BYTES });
    const out = await p.processCss(css);
    expect(out).toContain('url("data:image/png;base64,');
    expect(out).not.toContain("asset.localhost");
    expect(p.warnings).toEqual([]);
  });

  it("同一条声明里两个 url() 都失败：只删一次，后面的规则不被连带截掉", async () => {
    const css =
      `@font-face{font-family:X;src:url(${assetUrl("/fonts/a.woff2")}) format("woff2"),` +
      `url(${assetUrl("/fonts/a.woff")}) format("woff");}\n` +
      `body{color:red}\n.x{margin:0}`;
    const p = processor({});
    const out = await p.processCss(css);
    // 两个失败落进同一段声明：边界去重后整条删一次，规则里的其它声明与后续规则都还在
    expect(out).not.toContain("a.woff");
    expect(out).toContain("font-family:X");
    expect(out).toContain("body{color:red}");
    expect(out).toContain(".x{margin:0}");
    expect(p.warnings).toHaveLength(2);
  });

  it("@font-face 多候选只挂一个：保留声明与可用候选，仅摘除失败的那一段", async () => {
    const css =
      `@font-face { font-family: A; src: url(${assetUrl("/fonts/a.woff2")}) format("woff2"), ` +
      `url(${assetUrl("/fonts/gone.woff")}) format("woff"); }\n` +
      `.x { color: red; }`;
    const p = processor({ "/fonts/a.woff2": enc.encode("wOF2") });
    const out = await p.processCss(css);
    expect(out).toContain('url("data:font/woff2;base64,');
    expect(out).toContain('format("woff2")');
    expect(out).not.toContain("gone.woff");
    expect(out).not.toContain('format("woff")');
    expect(out).toContain("@font-face");
    expect(out).toContain(".x { color: red; }");
    expect(p.warnings.map((w) => w.reason)).toContain("file not found: /fonts/gone.woff");
  });

  it("失败的是第一个候选：摘除首段后，后一个候选仍被内联", async () => {
    const css =
      `.x { background: url(${assetUrl("/img/gone.png")}) no-repeat, ` +
      `url(${assetUrl("/img/ok.png")}); }`;
    const p = processor({ "/img/ok.png": PNG_BYTES });
    const out = await p.processCss(css);
    expect(out).not.toContain("gone.png");
    expect(out).not.toContain("no-repeat");
    expect(out).toContain("background:");
    expect(out).toContain('url("data:image/png;base64,');
    expect(out).toContain("; }");
  });

  it("失败的是最后一个候选：连同前面的逗号一起摘除，保留声明结尾分号", async () => {
    const css =
      `.x { background: url(${assetUrl("/img/ok.png")}), ` +
      `url(${assetUrl("/img/gone.png")}) no-repeat; color: red; }`;
    const p = processor({ "/img/ok.png": PNG_BYTES });
    const out = await p.processCss(css);
    expect(out).not.toContain("gone.png");
    expect(out).not.toContain("no-repeat");
    expect(out).toContain('url("data:image/png;base64,');
    // 分号必须留下，否则后面的 color 声明会并进 background
    expect(out).toMatch(/\);\s*color: red; \}/);
  });

  it("片段引用 url(#grad) 不是外部资源：原样保留，不读盘、不告警", async () => {
    const css = `.icon { fill: url(#grad); }`;
    const readFile = vi.fn(async () => PNG_BYTES);
    const p = processor({}, { readFile });
    expect(await p.processCss(css)).toBe(css);
    expect(p.warnings).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("注释里的 url() 不是引用：不读文件、不删声明、不告警", async () => {
    const css =
      `/* 旧背景：url(${assetUrl("/img/old.png")}) */\n` +
      `.bg{background:url(https://cdn.example.com/x.png)}`;
    const readFile = vi.fn(async () => PNG_BYTES);
    const p = processor({}, { readFile });
    const out = await p.processCss(css);
    // 注释原样保留；活声明里的远程地址只做统一引号化，不被删
    expect(out).toContain(`/* 旧背景：url(${assetUrl("/img/old.png")}) */`);
    expect(out).toContain('background:url("https://cdn.example.com/x.png")');
    expect(p.warnings).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("删掉失败声明后，后续成功 url() 仍按原文位置正确替换（不会错位）", async () => {
    const css =
      `.a{background:url(${assetUrl("/img/missing.png")})}\n` +
      `.b{background:url(${assetUrl("/img/bg.png")})}`;
    const p = processor({ "/img/bg.png": PNG_BYTES });
    const out = await p.processCss(css);
    expect(out).not.toContain("missing.png");
    expect(out).toContain('.b{background:url("data:image/png;base64,');
  });

  it("@import 一律不改写；指向本地/应用内样式表时给出可见告警", async () => {
    const css =
      `@import url(${assetUrl("/themes/a.css")});\n` +
      `@import url("https://fonts.googleapis.com/css?family=X");\n` +
      `.x { color: red; }`;
    const p = processor({ "/themes/a.css": enc.encode(".x{}") });
    const out = await p.processCss(css);
    expect(out).toContain(assetUrl("/themes/a.css"));
    expect(out).toContain("fonts.googleapis.com");
    expect(out).toContain(".x { color: red; }");
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0].reason).toContain("@import");
  });

  it("没有 url() 的 CSS 原文返回（不做无谓改写）", async () => {
    const p = processor({});
    const css = `.milkdown p { color: var(--text); }`;
    expect(await p.processCss(css)).toBe(css);
  });

  it("declarationBounds 在嵌套 @media 里也取到正确声明边界", () => {
    const css = "@media print {\n  .a { color: red; background: url(x.png); }\n}";
    const at = css.indexOf("url(x.png)");
    // 起点是上一条声明的分号之后：前导空白算在声明内（删除时一并清掉，不留孤立空格）
    expect(css.slice(declarationBounds(css, at).start, declarationBounds(css, at).end)).toBe(
      " background: url(x.png);",
    );
    const simple = ".a{color:red;background:url(y.png)}";
    const b2 = declarationBounds(simple, simple.indexOf("url(y.png)"));
    expect(simple.slice(b2.start, b2.end)).toBe("background:url(y.png)");
  });
});

describe("#372 同源应用资源：打包进应用的字体在产物里同样失效，需内联", () => {
  function withFetch(fetchUrl: (url: string) => Promise<Uint8Array>, opts: Partial<ConstructorParameters<typeof ExportResourceProcessor>[0]> = {}) {
    return new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile: makeFs({}),
      resolveRelative: fakeResolveRelative,
      fetchUrl,
      ...opts,
    });
  }

  it("同源 http 资源走 fetch 内联；跨域资源不动、不 fetch", async () => {
    const fetchUrl = vi.fn(async (url: string) => {
      if (url !== `${APP_ORIGIN}assets/katex.woff2`) throw new Error("unexpected " + url);
      return enc.encode("wOF2");
    });
    const p = withFetch(fetchUrl);
    expect((await p.resolve(`${APP_ORIGIN}assets/katex.woff2`)).startsWith("data:font/woff2;base64,")).toBe(true);
    expect(await p.resolve("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
    expect(fetchUrl).toHaveBeenCalledTimes(1);
  });

  it("任意 *.localhost 不等于应用自身：普通跨域引用原样保留，不发起 fetch", async () => {
    const fetchUrl = vi.fn(async () => enc.encode("x"));
    const p = withFetch(fetchUrl, { appOrigin: "http://tauri.localhost/" });
    expect(await p.resolve("http://foo.localhost/a.png")).toBe("http://foo.localhost/a.png");
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("CSS 通道里的相对 url() 按**应用 origin**展开（样式表锚定在应用内，不是文档目录）", async () => {
    const fetchUrl = vi.fn(async () => enc.encode("wOF2"));
    const p = withFetch(fetchUrl);
    const out = await p.processCss(`@font-face { src: url(assets/katex.woff2) format("woff2"); }`);
    expect(out).toContain('url("data:font/woff2;base64,');
    expect(fetchUrl).toHaveBeenCalledWith(`${APP_ORIGIN}assets/katex.woff2`);
  });

  it("DOM 通道里的相对 src 仍按**文档目录**解析（用户原始 HTML 块的语义）", async () => {
    const readFile = makeFs({ "/notes/images/a.png": PNG_BYTES });
    const fetchUrl = vi.fn(async () => enc.encode("wOF2"));
    const p = new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile,
      resolveRelative: fakeResolveRelative,
      fetchUrl,
    });
    const root = document.createElement("div");
    const img = document.createElement("img");
    img.setAttribute("src", "images/a.png");
    root.appendChild(img);
    await processDomResources(root, p);
    expect(img.getAttribute("src")!.startsWith("data:image/png;base64,")).toBe(true);
    expect(readFile).toHaveBeenCalledWith("/notes/images/a.png");
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it("同源 fetch 失败也降级为可见占位图，不把失效地址留在产物里", async () => {
    const p = withFetch(async () => {
      throw new Error("HTTP 404");
    });
    const r = await p.resolveRef(`${APP_ORIGIN}assets/gone.woff2`);
    expect(r.ok).toBe(false);
    expect(r.value.startsWith("data:image/svg+xml")).toBe(true);
    expect(p.warnings[0].reason).toBe("HTTP 404");
  });

  it("打包后的 tauri 自定义协议 origin 也认（tauri://localhost 与 http://tauri.localhost）", async () => {
    for (const origin of ["tauri://localhost/index.html", "http://tauri.localhost/index.html"]) {
      const fetchUrl = vi.fn(async () => enc.encode("wOF2"));
      const p = withFetch(fetchUrl, { appOrigin: origin });
      await p.resolve(`${origin.replace(/\/index\.html$/, "")}/assets/katex.woff2`);
      expect(fetchUrl, origin).toHaveBeenCalledTimes(1);
    }
  });
  it("非应用 origin 的 tauri: URL 不算同源（不能因为 origin 都是 null 就放行）", async () => {
    const fetchUrl = vi.fn(async () => enc.encode("wOF2"));
    const p = withFetch(fetchUrl, { appOrigin: "tauri://localhost/index.html" });
    expect(await p.resolve("tauri://evil.example/x.woff2")).toBe("tauri://evil.example/x.woff2");
    expect(fetchUrl).not.toHaveBeenCalled();
  });
});

describe("#372 processDomResources：DOM 通道的两条资源路径", () => {
  /** 建一棵与编辑器 DOM 同形的子树；包在 <div> 里，避免 HTML 解析器把裸 <img> 塞进 <p> */
  function dom(html: string): HTMLElement {
    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html><body><div id="host">${html}</div></body></html>`,
      "text/html",
    );
    return parsed.getElementById("host")!;
  }

  it("<img src> 的 asset 地址被换成 data URL", async () => {
    const root = dom(`<p>前</p><img src="${assetUrl("/notes/img/a.png")}" alt="图A"><p>后</p>`);
    const p = processor({ "/notes/img/a.png": PNG_BYTES });
    await processDomResources(root, p);
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")!.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.getAttribute("alt")).toBe("图A");
    // 结构不动
    expect(root.children).toHaveLength(3);
    expect(root.textContent).toBe("前后");
    expect(p.warnings).toEqual([]);
  });

  it("内联 style 的 background url() 被改写（url() 不只在 <img> 上）", async () => {
    const root = dom(`<div style="background-image: url(${assetUrl("/notes/img/a.png")}); color: red">x</div>`);
    const p = processor({ "/notes/img/a.png": PNG_BYTES });
    await processDomResources(root, p);
    const style = root.querySelector("div")!.getAttribute("style")!;
    expect(style).toContain("data:image/png;base64,");
    expect(style).not.toContain("asset.localhost");
    expect(style).toContain("color: red");
  });

  it("style 里没有 url() 时不动它，也不触发任何读取", async () => {
    const root = dom(`<div style="transform: scale(1.2)">x</div>`);
    const read = makeFs({});
    const p = new ExportResourceProcessor({
      mode: "inline",
      documentPath: DOC,
      appOrigin: APP_ORIGIN,
      readFile: read,
      resolveRelative: fakeResolveRelative,
    });
    await processDomResources(root, p);
    expect(root.querySelector("div")!.getAttribute("style")).toBe("transform: scale(1.2)");
    expect(read).not.toHaveBeenCalled();
  });

  it("图片缺失时 <img> 仍在，src 变成可见占位图（不是静默删掉用户的图）", async () => {
    const root = dom(`<img src="${assetUrl("/notes/img/gone.png")}" alt="丢了">`);
    const p = processor({});
    await processDomResources(root, p);
    const img = root.querySelector("img")!;
    expect(img.getAttribute("src")!.startsWith("data:image/svg+xml")).toBe(true);
    expect(img.getAttribute("alt")).toBe("丢了");
    expect(p.warnings).toHaveLength(1);
  });

  it("原始 HTML 块里的 <style> 元素同样要改写（不是只有 <img> 和 style 属性）", async () => {
    const root = dom(
      `<style>.hero { background: url(${assetUrl("/notes/img/bg.png")}) no-repeat; }</style>` +
        `<div class="hero">x</div>`,
    );
    const p = processor({ "/notes/img/bg.png": PNG_BYTES });
    await processDomResources(root, p);
    const css = root.querySelector("style")!.textContent!;
    expect(css).toContain("data:image/png;base64,");
    expect(css).not.toContain("asset.localhost");
    expect(css).toContain("no-repeat");
    expect(p.warnings).toEqual([]);
  });

  it("远程图片保持原地址", async () => {
    const root = dom(`<img src="https://cdn.example.com/a.png">`);
    const p = processor({});
    await processDomResources(root, p);
    expect(root.querySelector("img")!.getAttribute("src")).toBe("https://cdn.example.com/a.png");
  });

  it("多个 img 顺序处理，互不影响", async () => {
    const root = dom(
      `<img src="${assetUrl("/notes/img/a.png")}"><img src="${assetLocalhostUrl("/notes/img/图 片.svg")}">`,
    );
    const p = processor({ "/notes/img/a.png": PNG_BYTES, "/notes/img/图 片.svg": SVG_TEXT });
    await processDomResources(root, p);
    const [one, two] = Array.from(root.querySelectorAll("img"));
    expect(one.getAttribute("src")!.startsWith("data:image/png")).toBe(true);
    expect(two.getAttribute("src")!.startsWith("data:image/svg+xml")).toBe(true);
    expect(p.warnings).toEqual([]);
  });
});

describe("#372 findRuntimeUrls：产物兜底探针", () => {
  it("找出属性与 url() 里的 asset 残留，去重并截到引号/空白为止", () => {
    const html = `<img src="asset://localhost/a.png"><div style='background:url(http://asset.localhost/b.png)'></div>`
      + `<img src="asset://localhost/a.png"><a href="https://asset.localhost/c.png">x</a>`;
    expect(findRuntimeUrls(html)).toEqual([
      "asset://localhost/a.png",
      "http://asset.localhost/b.png",
      "https://asset.localhost/c.png",
    ]);
  });

  it("正文里写到 asset 地址的文档不算残留（不是资源引用，不能误报导出不完整）", () => {
    expect(
      findRuntimeUrls(`<p>本文描述 asset://localhost/a.png 与 https://asset.localhost/b.png</p>`),
    ).toEqual([]);
  });

  it("代码块里的示例文本不算残留（对原始字符串扫 src=/url( 会误报）", () => {
    const html =
      `<pre><code>&lt;img src="asset://localhost/a.png"&gt;</code></pre>` +
      `<p>CSS 示例：background:url(asset://localhost/b.png)</p>`;
    expect(findRuntimeUrls(html)).toEqual([]);
  });

  it("<style> 里的 url() 与任意属性上的残留仍要报出", () => {
    const html =
      `<style>.x{background:url(${assetUrl("/bg.png")})}</style>` +
      `<div background="${assetUrl("/legacy.png")}"></div>`;
    expect(findRuntimeUrls(html)).toEqual([assetUrl("/bg.png"), assetUrl("/legacy.png")]);
  });

  it("内联 SVG 里的 <style> 也要扫（SVG 元素 tagName 是小写）", () => {
    const html =
      `<svg xmlns="http://www.w3.org/2000/svg">` +
      `<style>.grad{fill:url(${assetUrl("/grad.png")})}</style><rect class="grad"/></svg>`;
    expect(findRuntimeUrls(html)).toEqual([assetUrl("/grad.png")]);
  });

  it("干净的产物返回空数组", () => {
    expect(findRuntimeUrls(`<img src="data:image/png;base64,AAA"><p>正文</p>`)).toEqual([]);
    expect(findRuntimeUrls("")).toEqual([]);
  });

  it("srcset 里的运行时地址也要报出（响应式图片不是只有 src）", () => {
    const html = `<img src="data:image/png;base64,AAA" srcset="${assetUrl("/a.png")} 1x, ${assetUrl("/b.png")} 2x">`;
    expect(findRuntimeUrls(html)).toEqual([assetUrl("/a.png"), assetUrl("/b.png")]);
  });

  it("末尾无终止符时也要报出（不把残留漏成通过）", () => {
    expect(findRuntimeUrls("<img src=asset://localhost/tail.png>")).toEqual([
      "asset://localhost/tail.png",
    ]);
  });
});

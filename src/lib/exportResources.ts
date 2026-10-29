// #372：导出资源可移植化
//
// 问题：编辑器 DOM 里的本地图片是 Tauri asset 协议的**运行时地址**
// （Windows `http://asset.localhost/<enc>`、其他平台 `asset://localhost/<enc>`），
// 主题 CSS 的字体/背景 `url()` 同样如此（#306）。这些地址只在应用进程内有效，
// 导出到 HTML/PDF/PNG 或复制进外部程序后全部失效。
//
// 口径：把每个资源引用换成**自包含**的形式——
// - `inline` 模式（PDF / PNG / 剪贴板 / 浏览器端 HTML）：一律 data URL。
//   这三路的产物都不在原始磁盘位置（about:blank、离屏容器、外部应用），
//   相对路径无从解析，只能内联。
// - `sidecar` 模式（桌面端 HTML 导出）：小资源内联，大资源复制到 HTML 旁的
//   `<name>_assets/` 并写相对路径——HTML 可独立分发，也不必把大图 base64 进文本。
//   因为旁挂目录取决于最终保存位置，`exportHTML` 必须**先拿到路径再处理资源**。
//
// 远程（http/https/协议相对）、`data:`、`blob:` 一律保持原语义不动。

import { readBinaryFile, resolvePathFromDocument } from "./fs";

/** 单资源内联上限：超过则改走旁挂文件（仅 sidecar 模式有意义） */
export const INLINE_MAX_BYTES = 2 * 1024 * 1024;
/** 单次导出的资源总预算：内存与 Base64 IPC 的护栏，超出即降级并可见告知 */
export const TOTAL_MAX_BYTES = 24 * 1024 * 1024;

export type ResourceMode = "inline" | "sidecar";

/** 资源引用分类结果 */
export type ResourceRef =
  /** data: / blob: —— 已经自包含 */
  | { kind: "self-contained" }
  /** http(s) / 协议相对 —— 远程资源，保持既有语义 */
  | { kind: "remote"; url: string }
  /** asset 协议或 file: URL —— 已解出绝对路径 */
  | { kind: "local"; absPath: string }
  /** 无 scheme 的相对引用 —— 需按文档所在目录解析 */
  | { kind: "relative"; ref: string };

/** convertFileSrc 的两种形态（见 @tauri-apps/api/core） */
const ASSET_URL_FORMS = [/^asset:\/\/localhost\/(.*)$/i, /^https?:\/\/asset\.localhost\/(.*)$/i];

/** 运行时 asset 地址的特征串：最终产物里不允许残留（兜底清扫用） */
export const RUNTIME_URL_MARKERS = ["asset://localhost", "http://asset.localhost", "https://asset.localhost"];

/** decodeURIComponent 遇到裸 `%` 会抛；失败时按原串使用（路径里确有未编码 % 的情况） */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 去掉引用串上的 query / hash（本地文件路径里它们是噪声） */
function stripQueryHash(s: string): string {
  return s.split("#")[0].split("?")[0];
}

/**
 * 分类一个资源引用串。**纯函数**，不做任何 IO。
 * 顺序很重要：asset 形态必须先于「其他带 scheme 即远程」的判定。
 */
export function classifyResource(raw: string): ResourceRef {
  const url = (raw ?? "").trim();
  if (!url) return { kind: "self-contained" };
  if (/^(data:|blob:)/i.test(url)) return { kind: "self-contained" };

  for (const form of ASSET_URL_FORMS) {
    const m = form.exec(url);
    if (m) return { kind: "local", absPath: safeDecode(stripQueryHash(m[1])) };
  }

  if (/^file:/i.test(url)) {
    // 交给 WHATWG URL 解析：`file://[host]/path`、盘符路径、反斜杠都能一次归一。
    // 手写正则很容易数错前导斜杠（`file:///E:/a.png` 会剩 `/E:/a.png`，
    // 再补一个 `/` 就成了 `//E:/a.png`，Windows 上读不到）。
    try {
      const u = new URL(url);
      const decoded = safeDecode(u.pathname);
      // UNC（`file://server/share/a.png`）：host 是共享所在主机，丢了会读成本机 `\share\a.png`
      const host = u.host && u.host !== "localhost" ? `//${u.host}` : "";
      return {
        kind: "local",
        absPath: host ? `${host}${decoded}` : decoded.replace(/^\/(?=[a-zA-Z]:[\\/])/, ""),
      };
    } catch {
      // 非法 URL（如路径里带裸 `%`）：退回按前缀裁剪，能读到就读，读不到走可见降级
      const stripped = safeDecode(stripQueryHash(url.replace(/^file:(\/\/[^/?#]*)?/i, "")));
      return { kind: "local", absPath: /^[a-zA-Z]:[\\/]/.test(stripped) ? stripped : `/${stripped}` };
    }
  }

  // Windows 盘符路径（`E:/notes/a.png`、`E:\notes\a.png`）：单字母 scheme 在 URL
  // 语法里并不存在，这是路径而不是 `mailto:` 之类的协议。必须先于下面的 scheme 判定，
  // 否则会被当成远程地址原样写进产物——既不内联也不告警，离开本机就是死链。
  if (/^[a-zA-Z]:[\\/]/.test(url)) return { kind: "local", absPath: safeDecode(url) };

  // 其余带 scheme（http/https/ftp/mailto…）或协议相对 //host/path：远程
  if (/^[a-z][a-z0-9+.\-]*:/i.test(url) || url.startsWith("//")) return { kind: "remote", url };

  return { kind: "relative", ref: url };
}

/** 应用自身 origin：dev 是 vite 地址，打包后是 tauri://localhost / http://tauri.localhost */
function defaultAppOrigin(): string {
  return typeof location !== "undefined" ? location.href : "";
}

/**
 * 应用自身资源的 host。打包后前端跑在 `*.localhost` 自定义协议下
 * （Windows `http://tauri.localhost`，其他平台 `tauri://localhost`）；
 * asset 协议地址在分类阶段已按路径处理，这里只兜住应用自身的两个 host。
 * 不能把任意 `*.localhost` 都当应用资源：用户文档里的 `http://foo.localhost/a.png`
 * 是普通跨域引用，去 fetch 只会被 CSP 拦掉并降级成占位图。
 */
const APP_LOCAL_HOSTS = new Set(["asset.localhost", "tauri.localhost"]);

function isAppOriginUrl(url: string, appOrigin: string): boolean {
  let u: URL;
  try {
    u = new URL(url, appOrigin || undefined);
  } catch {
    return false;
  }
  if (APP_LOCAL_HOSTS.has(u.hostname)) return true;
  if (!appOrigin) return false;
  let base: URL;
  try {
    base = new URL(appOrigin);
  } catch {
    return false;
  }
  // 比 protocol + host 而不是 origin：`tauri:` 这类非特殊 scheme 的 origin 恒为
  // "null"，比 origin 会把任意 `tauri://…` 都判成同源（含用户文档里的恶意远程引用）。
  return u.protocol === base.protocol && u.host === base.host;
}

/**
 * 取应用自身资源的字节。CSP 没有 `connect-src`，回落 `default-src 'self'`，
 * 故**同源**可 fetch；这也正是 asset 协议地址不能走这条路、必须用 Rust 命令的原因。
 */
async function fetchAsBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
};

/** 取路径扩展名（含点、小写）；兼容 Windows 反斜杠与正斜杠 */
export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

/** 去掉路径里的目录部分，只留文件名 */
function baseNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || "resource";
}

/** 地址侧逐段百分号编码（磁盘路径不编码） */
function encodePathSegments(path: string): string {
  return path.split("/").map((seg) => encodeURIComponent(seg)).join("/");
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  // 跳过 BOM 与前导空白后看开头一段：合法 SVG 常带 `<?xml ?>` 声明、`<!DOCTYPE svg>`
  // 或注释，只看前 16 字节会把它们判成「内容与扩展名不符」而误降级占位图。
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  const head = String.fromCharCode(...Array.from(bytes.subarray(i, i + 512))).toLowerCase();
  // 反例：dev server 回落出来的 HTML 首页同样可能在前 512 字节里带图标 `<svg>`，
  // 必须显式排除，否则「把网页当资源内联」的老问题会以另一种形态复活。
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return false;
  return head.startsWith("<?xml") || head.includes("<svg");
}

/**
 * 判定资源 MIME：先看魔数（扩展名可能与真实内容不符），再回落扩展名，
 * 最后 `application/octet-stream`（浏览器对 `<img>` 会自行嗅探，不影响显示）。
 */
export function mimeForResource(path: string, bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[0] === 0x47) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  const ext = extensionOf(path);
  if (ext === ".svg" || (ext !== ".png" && ext !== ".jpg" && looksLikeSvg(bytes))) return "image/svg+xml";
  return EXT_MIME[ext] ?? "application/octet-stream";
}

/** 字节 → data URL（分块避免 String.fromCharCode 展开超大数组爆栈） */export function toDataUrl(mime: string, bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...(bytes.subarray(i, i + CHUNK) as unknown as number[]));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

/** 资源不可用时的可见占位图：产物里能直接看到「哪个资源、为什么没导出」 */
export function missingResourcePlaceholder(ref: string, reason: string): string {
  const label = `${ref} — ${reason}`.slice(0, 80);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="56" viewBox="0 0 460 56">` +
    `<rect x="0.5" y="0.5" width="459" height="55" fill="#fff3cd" stroke="#d9a400"/>` +
    `<text x="12" y="24" font-family="sans-serif" font-size="13" fill="#6b4e00">⚠ 资源未导出</text>` +
    `<text x="12" y="43" font-family="sans-serif" font-size="12" fill="#6b4e00">${escapeXml(label)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 能按魔数可靠识别的资源类型；其余扩展名一律不做内容校验 */
const SNIFFABLE = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);

/** 字节是否像**任何一种**已知的图片 / 字体（不要求与扩展名一一对应） */
function looksLikeKnownResource(b: Uint8Array): boolean {
  const at = (...sig: number[]) => sig.every((v, i) => b[i] === v);
  const tag = (from: number, to: number) =>
    String.fromCharCode(...Array.from(b.subarray(from, to)));
  if (at(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return true; // PNG
  if (at(0xff, 0xd8, 0xff)) return true; // JPEG
  if (at(0x47, 0x49, 0x46, 0x38)) return true; // GIF8
  if (at(0x52, 0x49, 0x46, 0x46) && tag(8, 12) === "WEBP") return true; // RIFF…WEBP
  if (at(0x42, 0x4d)) return true; // BM
  if (at(0x00, 0x00, 0x01, 0x00)) return true; // ICO
  if (tag(4, 8) === "ftyp" && tag(8, 12).startsWith("avif")) return true;
  if (at(0x77, 0x4f, 0x46, 0x46) || at(0x77, 0x4f, 0x46, 0x32)) return true; // wOFF / wOF2
  if (at(0x4f, 0x54, 0x54, 0x4f)) return true; // OTTO
  if (at(0x00, 0x01, 0x00, 0x00) || tag(0, 4) === "true") return true; // TTF
  return looksLikeSvg(b);
}

/**
 * 读到了字节 ≠ 读到了正确的资源。
 *
 * 典型场景：路径写错时，dev server / 静态站点会把请求**回落成 `index.html` 并回 200**。
 * 原样内联就会把一整页 HTML 当作 PNG 写进产物——导出看起来「成功」，图却是坏的，
 * 也没有任何告知，正是 #372 明令禁止的静默缺图。所以按扩展名声明的类别做一次
 * 内容校验：只要字节**像**某个已知图片/字体就放行（扩展名与真实格式不符的图片
 * 浏览器自己能嗅探），完全不像才判为读错。
 *
 * 只校验能按魔数识别的类型；文本类（CSS/JS/JSON）与未知扩展名一律放行。
 */
function contentMatchesDeclaredType(path: string, bytes: Uint8Array): boolean {
  if (!SNIFFABLE.has(extensionOf(stripQueryHash(path)))) return true;
  return looksLikeKnownResource(bytes);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ResourceWarning {
  /** 出问题的原始引用串 */
  ref: string;
  /** 可读原因 */
  reason: string;
}

export interface SidecarFile {
  /** 写进 HTML/CSS 的相对地址（已百分号编码） */
  relativeUrl: string;
  /** 相对 HTML 所在目录的路径，固定用 `/` 分隔；调用方按段交给 `resolvePath` 拼系统分隔符 */
  relativePath: string;
  data: Uint8Array;
}

export interface ResourceProcessorOptions {
  mode: ResourceMode;
  /** 当前 Markdown 文档路径，用于解析相对引用 */
  documentPath: string;
  /** sidecar 模式的旁挂目录名（不含路径分隔符） */
  sidecarDir?: string;
  inlineMaxBytes?: number;
  totalMaxBytes?: number;
  /**
   * 应用自身 origin（默认取 `location.href`）。同源资源（打包进应用的 KaTeX 字体、
   * 代码高亮字体等）在导出产物里同样失效，需 fetch 回来内联；跨域资源保持原语义。
   */
  appOrigin?: string;
  /** IO 注入点（默认走 fs.ts 真实实现）：单测用内存夹具，E2E 用真实文件 */
  readFile?: (absPath: string) => Promise<Uint8Array>;
  resolveRelative?: (documentPath: string, ref: string) => Promise<string>;
  fetchUrl?: (url: string) => Promise<Uint8Array>;
}

/**
 * 一次导出的资源处理器：分类 → 读字节 → 内联或旁挂，带预算、去重与可见降级。
 * 每个导出动作（HTML/PDF/PNG/复制）各建一个实例，预算互不干扰。
 */
export class ExportResourceProcessor {
  readonly warnings: ResourceWarning[] = [];
  readonly sidecars: SidecarFile[] = [];

  private readonly mode: ResourceMode;
  private readonly documentPath: string;
  private readonly sidecarDir: string;
  private readonly inlineMax: number;
  private readonly totalMax: number;
  private readonly appOrigin: string;
  private readonly readFile: (absPath: string) => Promise<Uint8Array>;
  private readonly resolveRelative: (documentPath: string, ref: string) => Promise<string>;
  private readonly fetchUrl: (url: string) => Promise<Uint8Array>;
  /** absPath / 同源 URL → 解析结果（同一资源被引用多次只读一次） */
  private readonly resolved = new Map<string, { value: string; ok: boolean }>();
  private readonly usedNames = new Map<string, string>();
  private usedBytes = 0;

  constructor(options: ResourceProcessorOptions) {
    this.mode = options.mode;
    this.documentPath = options.documentPath;
    this.sidecarDir = options.sidecarDir ?? "assets";
    this.inlineMax = options.inlineMaxBytes ?? INLINE_MAX_BYTES;
    this.totalMax = options.totalMaxBytes ?? TOTAL_MAX_BYTES;
    this.appOrigin = options.appOrigin ?? defaultAppOrigin();
    this.readFile = options.readFile ?? ((p) => readBinaryFile(p));
    this.resolveRelative =
      options.resolveRelative ?? ((doc, ref) => resolvePathFromDocument(doc, ref));
    this.fetchUrl = options.fetchUrl ?? fetchAsBytes;
  }

  private warn(ref: string, reason: string): void {
    this.warnings.push({ ref, reason });
  }

  /**
   * 解析一个资源引用，返回写回产物的地址与是否成功。
   * 远程 / data: / blob: 原样返回；本地资源与同源应用资源内联或旁挂；
   * 失败时 `ok=false` 且 value 为可见占位图（DOM 通道用它，CSS 通道据 ok 降级）。
   */
  async resolveRef(raw: string): Promise<{ value: string; ok: boolean }> {
    const ref = classifyResource(raw);
    if (ref.kind === "self-contained") {
      const value = raw.trim();
      if (/^blob:/i.test(value)) {
        // blob: 由创建它的文档进程持有，产物换到别处打开时通常已失效；
        // 拿不到字节所以无法内联，但「静默留着死链」不符合可见降级口径。
        this.warn(value, "blob: 地址只在当前页面进程内有效，导出产物中可能无法加载");
      }
      return { value, ok: true };
    }

    // 跨域远程资源保持既有语义；同源（应用自身打包资源）在产物里同样失效，必须内联
    if (ref.kind === "remote") {
      if (!isAppOriginUrl(ref.url, this.appOrigin)) return { value: raw.trim(), ok: true };
      return this.acquire(ref.url, ref.url, false);
    }

    let absPath: string;
    if (ref.kind === "local") {
      absPath = ref.absPath;
    } else {
      const cleaned = safeDecode(stripQueryHash(ref.ref));
      try {
        absPath = await this.resolveRelative(this.documentPath, cleaned);
      } catch (e) {
        // 路径解析本身也会失败（IPC 异常/非法路径）：按资源降级处理，
        // 不能让一次解析异常把整份导出连同已收集的警告一起吞掉。
        // 错误细节只进本机告警：占位图会随产物分享出去，不能带绝对路径。
        return this.degrade(
          raw,
          "",
          "无法解析为本地路径",
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (!absPath) return this.degrade(raw, "", "无法解析为本地路径");
    return this.acquire(raw, absPath, true);
  }

  /** 读字节 → 预算判定 → 内联或旁挂（本地文件与同源 URL 共用） */
  private async acquire(
    ref: string,
    key: string,
    isLocalFile: boolean,
  ): Promise<{ value: string; ok: boolean }> {
    const cached = this.resolved.get(key);
    if (cached) return cached;

    let bytes: Uint8Array;
    try {
      bytes = isLocalFile ? await this.readFile(key) : await this.fetchUrl(key);
    } catch (e) {
      return this.degrade(ref, key, e instanceof Error ? e.message : String(e));
    }

    if (!contentMatchesDeclaredType(key, bytes)) {
      return this.degrade(
        ref,
        key,
        "文件内容与扩展名不符（路径可能写错，或被服务器回落成了网页）",
      );
    }

    if (this.usedBytes + bytes.length > this.totalMax) {
      return this.degrade(
        ref,
        key,
        `超出单次导出资源总预算 ${Math.round(this.totalMax / 1024 / 1024)} MB`,
      );
    }
    this.usedBytes += bytes.length;

    // sidecar 模式下大资源旁挂落盘；inline 模式没有磁盘落点，只能内联
    const value =
      this.mode === "sidecar" && isLocalFile && bytes.length > this.inlineMax
        ? this.addSidecar(key, bytes)
        : toDataUrl(mimeForResource(key, bytes), bytes);
    const entry = { value, ok: true };
    this.resolved.set(key, entry);
    return entry;
  }

  /** DOM 通道只关心最终地址 */
  async resolve(raw: string): Promise<string> {
    return (await this.resolveRef(raw)).value;
  }

  private degrade(
    ref: string,
    key: string,
    reason: string,
    detail?: string,
  ): { value: string; ok: boolean } {
    // 细节只给本机告警；占位图（会随产物分享）只带文件名与稳定的原因文案
    this.warn(ref, detail ? `${reason}（${detail}）` : reason);
    // 占位图会被写进 HTML/PNG/剪贴板并随导出分享出去：只能出现**文件名**。
    // asset 地址解码后就是用户的完整目录结构，Rust 的读取错误串里也带着绝对路径。
    // 完整路径与原因保留在 warnings 里，仅在本机弹窗展示。
    const label = key ? baseNameOf(key) : ref;
    const short = key ? baseNameOf(key) : "";
    const safeReason = key
      ? reason.split(key).join(short).split(key.replace(/\\/g, "/")).join(short)
      : reason;
    const entry = { value: missingResourcePlaceholder(label, safeReason), ok: false };
    // 同一资源被引用多次只告警/读取一次；key 为空时无从缓存（下次仍会重新尝试）
    if (key) this.resolved.set(key, entry);
    return entry;
  }

  /** 登记一个旁挂文件，返回写进产物的相对地址 */
  private addSidecar(absPath: string, bytes: Uint8Array): string {
    const base = baseNameOf(absPath);
    // 同名不同内容：加序号，绝不互相覆盖。
    // 比较键用小写：导出目标常见于 Windows，`Logo.PNG` 与 `logo.png` 落盘会互相覆盖。
    const key = (name: string) => name.toLowerCase();
    let fileName = base;
    let seq = 1;
    while (this.usedNames.has(key(fileName)) && this.usedNames.get(key(fileName)) !== absPath) {
      const dot = base.lastIndexOf(".");
      fileName = dot > 0 ? `${base.slice(0, dot)}-${seq}${base.slice(dot)}` : `${base}-${seq}`;
      seq++;
    }
    this.usedNames.set(key(fileName), absPath);
    const relativePath = `${this.sidecarDir}/${fileName}`;
    // 文件名可能含空格/中文/#/%：地址侧百分号编码，磁盘侧保留原名。
    // 目录名同样来自用户保存的文件名（`report #1.html` → `report #1_assets`），
    // 不编码的话 `#1_assets` 会被浏览器当成片段，整目录资源 404。
    const urlDir = encodePathSegments(this.sidecarDir);
    const relativeUrl = `${urlDir}/${encodeURIComponent(fileName)}`;
    this.sidecars.push({ relativeUrl, relativePath, data: bytes.slice() });
    return relativeUrl;
  }

  /**
   * 处理一段 CSS 里的所有 `url(...)`（主题字体、背景图）。
   *
   * 相对地址按**应用 origin** 展开，不按 Markdown 文档目录：CSS 里的 `url(fonts/x.woff2)`
   * 相对于样式表自身，而样式表要么打包在应用内，要么已由 #306 改写成 asset 绝对地址。
   *
   * 降级口径（按**声明**判定，不按单个 url()）：
   * - 声明里所有 url() 都取不到 → **整条声明删掉**并告警。留下半截
   *   `src: format("woff2")` 之类是无效 CSS，浏览器会静默忽略整条规则，更难排查。
   * - 声明里还有可取到的候选 → 保留声明，只摘掉失败的那**一个候选段**
   *   （`url(...)` + 相邻 `format(...)` + 逗号）。`@font-face` 的 `src` 常列
   *   woff2/woff 多个候选，整条删会连累能用的兄弟。
   *
   * 片段引用 `url(#id)`（同一 SVG 内的渐变/裁剪）不是外部资源，原样保留。
   */
  async processCss(css: string): Promise<string> {
    const comments = commentRanges(css);
    const found: { start: number; end: number; value: string; ok: boolean }[] = [];
    for (const hit of findCssUrls(css)) {
      // 注释里的 url() 不是真实引用；误删还会连带删掉旁边的活声明
      if (comments.some(([s, e]) => hit.start >= s && hit.start < e)) continue;
      const raw = hit.value.trim();
      if (raw.startsWith("#")) continue;
      const absolute = this.absolutize(raw);
      if (this.skipImport(css, hit.start, raw, absolute)) continue;
      const { value, ok } = await this.resolveRef(absolute);
      found.push({ start: hit.start, end: hit.end, value: `url("${value}")`, ok });
    }
    if (found.length === 0) return css;

    const groups = new Map<string, { start: number; end: number; hits: typeof found }>();
    for (const hit of found) {
      const b = declarationBounds(css, hit.start);
      const key = `${b.start}:${b.end}`;
      const group = groups.get(key);
      if (group) group.hits.push(hit);
      else groups.set(key, { ...b, hits: [hit] });
    }

    const replacements: typeof found = [];
    const deletions: { start: number; end: number }[] = [];
    for (const group of groups.values()) {
      const ok = group.hits.filter((h) => h.ok);
      if (ok.length > 0) {
        replacements.push(...ok);
        for (const hit of group.hits) {
          if (hit.ok) continue;
          deletions.push(failingCandidateBounds(css, group.start, group.end, hit.start, hit.end));
        }
      } else {
        deletions.push({ start: group.start, end: group.end });
      }
    }

    // 同一条声明里的多个失败会算出**相同/相邻**边界：必须先去重/合并。
    // 否则同一段被删两次，第二次的旧下标会越过已经缩短的字符串，把后面的规则整片截掉。
    const merged = mergeRanges(deletions);

    let out = "";
    let cursor = 0;
    for (const { start, end } of merged) {
      out += this.replaceWithin(css, cursor, start, replacements);
      cursor = Math.max(cursor, end);
    }
    out += this.replaceWithin(css, cursor, css.length, replacements);
    return out;
  }

  /** 拼出 [from,to) 原文，并把**完全落在其中**的成功 url() 换成新地址（失败声明已整条删除，不参与替换） */
  private replaceWithin(
    css: string,
    from: number,
    to: number,
    replacements: { start: number; end: number; value: string }[],
  ): string {
    let out = "";
    let cursor = from;
    for (const r of replacements) {
      if (r.start < from || r.end > to) continue;
      out += css.slice(cursor, r.start) + r.value;
      cursor = r.end;
    }
    return out + css.slice(cursor, to);
  }

  /**
   * `@import` 一律不改写，只在它指向应用内/本地资源时登记告警。
   *
   * 为什么不内联：`@import url(data:text/css…)` 会被 CSP 的 `style-src`（只有
   * `'self' 'unsafe-inline'`）挡掉——PDF 走 `about:blank` 新窗口、继承应用 CSP，
   * 于是「HTML 导出正常、PDF 静默无样式」。而 `buildExportCss` 的 `@import` 外提
   * （#322）也假定拿到的是原始文本。改写它的两条路都更糟，故保持原样 + 可见告知。
   */
  private skipImport(css: string, at: number, raw: string, absolute: string): boolean {
    const { start, end } = declarationBounds(css, at);
    if (!/^\s*@import\b/i.test(css.slice(start, end))) return false;
    const kind = classifyResource(absolute).kind;
    if (kind === "local" || (kind === "remote" && isAppOriginUrl(absolute, this.appOrigin))) {
      this.warn(raw, "@import 的样式表无法内联进导出产物，已保持原样（在应用外可能失效）");
    }
    return true;
  }

  /** 相对地址按应用 origin 展开；已是绝对地址（含 asset:/data:）时原样返回 */
  private absolutize(raw: string): string {
    if (!this.appOrigin) return raw;
    try {
      return new URL(raw, this.appOrigin).href;
    } catch {
      return raw;
    }
  }
}

/**
 * 改写一棵 DOM 子树里的资源地址（#372）。
 *
 * 覆盖 `<img src>`、`<style>` 元素与内联 `style` 里的 `url()`（背景图/字体）——
 * 这些就是编辑器 DOM 里会出现本地资源地址的位置。原始 HTML 块里手写的 `<style>`
 * 同样可能引用本地图片；远程图片、`data:`、`blob:` 由处理器按分类原样放过。
 */
export async function processDomResources(
  root: ParentNode,
  processor: ExportResourceProcessor,
): Promise<void> {
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[src]"))) {
    const raw = img.getAttribute("src");
    if (!raw) continue;
    const value = await processor.resolve(raw);
    if (value !== raw) img.setAttribute("src", value);
  }
  for (const style of Array.from(root.querySelectorAll<HTMLStyleElement>("style"))) {
    const css = style.textContent ?? "";
    if (!css.includes("url(")) continue;
    const next = await processor.processCss(css);
    if (next !== css) style.textContent = next;
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[style]"))) {
    const raw = el.getAttribute("style") ?? "";
    if (!raw.includes("url(")) continue;
    const next = await processor.processCss(raw);
    if (next !== raw) el.setAttribute("style", next);
  }
}

/**
 * 兜底探针：产物里是否还残留运行时 asset 地址。
 * 正常路径下 `processDomResources` + `processCss` 已经覆盖全部引用；这里只做**可见告警**，
 * 让「漏网的一处」暴露给用户而不是伪装成导出成功（例如用户原始 HTML 块里手写的
 * `background="asset://…"` 这类属性通道）。
 *
 * 只看**引用位置**：DOM 属性值与 `<style>` 里的 `url(...)`。正文/代码块里恰好写到
 * `asset://localhost/…` 的文档（本仓库的技术说明、代码示例就有）是文本而不是资源引用，
 * 对原始字符串扫 `src=` / `url(` 会把这些示例误报成「导出不完整」。
 */
export function findRuntimeUrls(html: string): string[] {
  if (!html.trim()) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string) => {
    for (const hit of runtimeHitsIn(value)) {
      if (seen.has(hit)) continue;
      seen.add(hit);
      out.push(hit);
    }
  };
  // 单趟按文档顺序：属性通道（src/href/poster/srcset/style/background…）
  // 与 `<style>` 里的 url(...)（注释里的不算）都算引用
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) add(attr.value);
    // 内联 SVG 里的 <style> 在 HTML 解析下 tagName 是小写 `style`，按 localName 判定
    if (el.localName !== "style") continue;
    const css = el.textContent ?? "";
    const comments = commentRanges(css);
    for (const hit of findCssUrls(css)) {
      if (comments.some(([s, e]) => hit.start >= s && hit.start < e)) continue;
      add(hit.value);
    }
  }
  return out;
}

/** 一个属性值 / 一段 CSS 值里的运行时地址（`srcset` 一个值里可能有多个） */
function runtimeHitsIn(value: string): string[] {
  const out: string[] = [];
  for (const marker of RUNTIME_URL_MARKERS) {
    let from = 0;
    for (;;) {
      const at = value.indexOf(marker, from);
      if (at < 0) break;
      const rest = value.slice(at);
      const stop = rest.search(/["')\s,]/);
      out.push(stop < 0 ? rest : rest.slice(0, stop));
      from = at + marker.length;
    }
  }
  return out;
}

/** 合并重叠/相邻区间（按起点排序），供「一条声明里多个 url() 失败」去重 */
function mergeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

interface CssUrlHit {
  /** `url(` 的起始位置 */
  start: number;
  /** 右括号之后的位置 */
  end: number;
  /** 引号内/裸写的地址原文（不含引号） */
  value: string;
}

/**
 * 扫描 CSS 里真实的 `url(...)`，正确处理引号内的括号/撇号与反斜杠转义。
 * 正则 `[^'")]+` 会在 `url("chart (1).png")` 的 `)` 处截断，也会被
 * `url("it's.png")` 里的撇号卡住，导致资源取不到、整条声明被删。
 */
function findCssUrls(css: string): CssUrlHit[] {
  const out: CssUrlHit[] = [];
  const re = /url\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const start = m.index;
    // 必须是函数名本身：`myurl(` 之类的标识符不是 url()
    if (start > 0 && /[-\w]/.test(css[start - 1])) continue;
    let j = start + 4;
    const skipSpace = () => {
      while (j < css.length && /\s/.test(css[j])) j++;
    };
    skipSpace();
    let value: string;
    const quote = css[j];
    if (quote === '"' || quote === "'") {
      j++;
      let buf = "";
      let closed = false;
      while (j < css.length) {
        const ch = css[j];
        if (ch === "\\" && j + 1 < css.length) {
          buf += ch + css[j + 1];
          j += 2;
          continue;
        }
        if (ch === quote) {
          j++;
          closed = true;
          break;
        }
        buf += ch;
        j++;
      }
      if (!closed) continue;
      value = buf;
    } else {
      const valueStart = j;
      while (j < css.length) {
        const ch = css[j];
        if (ch === "\\" && j + 1 < css.length) {
          j += 2;
          continue;
        }
        if (ch === ")") break;
        j++;
      }
      value = css.slice(valueStart, j);
    }
    skipSpace();
    if (css[j] !== ")") continue;
    out.push({ start, end: j + 1, value });
    // 跳过整个 url(...)，避免把值里的 `url(` 片段再扫一遍
    re.lastIndex = j + 1;
  }
  return out;
}

/** CSS 注释区间（含未闭合的尾部注释），用于跳过注释里的 url() */
function commentRanges(css: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /\/\*[\s\S]*?(?:\*\/|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

/**
 * 定位包含 `at` 的那条 CSS 声明的起止（含结尾分号）。
 * 边界字符取 `;` `{` `}`：嵌套 `@media { ... }` 里也成立。
 */
export function declarationBounds(css: string, at: number): { start: number; end: number } {
  let start = at;
  while (start > 0 && !";{}".includes(css[start - 1])) start--;
  let end = at;
  while (end < css.length && css[end] !== ";" && css[end] !== "}") end++;
  if (css[end] === ";") end++;
  return { start, end };
}

/**
 * 声明里**包含 `[hitStart,hitEnd)` 的那一个候选段**（逗号分隔）的起止，
 * 连同分隔逗号一起摘除；最后一段保留声明结尾的 `;`。
 *
 * 只用于「同一声明里还有可用候选」的混合场景：整条删会连累可用候选，
 * 而留下 `url(missing) format("woff")` 又会让该候选在浏览器里反复失败。
 * 逗号只在括号/引号之外的顶层生效（`url(data:…,…)` 里的逗号不是分隔符）。
 */
function failingCandidateBounds(
  css: string,
  declStart: number,
  declEnd: number,
  hitStart: number,
  hitEnd: number,
): { start: number; end: number } {
  // 声明值从第一个顶层冒号之后开始（属性名里不会出现顶层冒号）
  let valueStart = declStart;
  {
    let depth = 0;
    let quote = "";
    for (let i = declStart; i < declEnd; i++) {
      const ch = css[i];
      if (quote) {
        if (ch === quote && css[i - 1] !== "\\") quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (ch === ":" && depth === 0) {
        valueStart = i + 1;
        break;
      }
    }
  }

  let segStart = valueStart;
  let depth = 0;
  let quote = "";
  for (let i = valueStart; i < declEnd; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === quote && css[i - 1] !== "\\") quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (ch === "," && depth === 0) {
      // 命中本段：删到逗号为止（含），保留后续候选的缩进
      if (hitStart >= segStart && hitEnd <= i) return { start: segStart, end: i + 1 };
      segStart = i + 1;
    }
  }
  // 最后一段：连同前面的逗号一起删，保留声明结尾的 `;`
  if (hitStart >= segStart) {
    let start = segStart;
    while (start > valueStart && /\s/.test(css[start - 1])) start--;
    if (css[start - 1] === ",") start--;
    const end = css[declEnd - 1] === ";" ? declEnd - 1 : declEnd;
    return { start, end };
  }
  // 理论上不可达（hit 必在声明内）；保守起见只摘 url() 本身，不误删整条声明
  return { start: hitStart, end: hitEnd };
}

/** 把降级告知拼成给用户看的文本（导出后统一提示，不静默） */
export function formatResourceWarnings(lines: readonly string[]): string {
  return [
    `导出时有 ${lines.length} 处内容未能完整导出：`,
    ...lines.map((l) => `· ${l}`),
  ].join("\n");
}

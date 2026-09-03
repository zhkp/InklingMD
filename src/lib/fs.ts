// 文件系统封装层
// 桌面端走 Tauri command（Rust 端实现），浏览器端用 mock 数据走通 UI
// 这样保证沙箱内可开发验证，真实环境走原生 fs

import { invoke, isTauri, convertFileSrc } from "@tauri-apps/api/core";
import { resolve as resolvePath } from "@tauri-apps/api/path";
import { dirNameOf, joinPath, normalizePath } from "./path";

export { joinPath, normalizePath, dirNameOf, isTauri };

/** 文件树节点（与 Rust 端 FileNode 对应） */
export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileNode[];
}

/** 列出目录的直接子项（子目录 children 为空，由调用方按需继续加载） */
export async function listDir(dirPath: string): Promise<FileNode> {
  if (isTauri()) {
    return invoke<FileNode>("list_dir", { dirPath });
  }
  // 浏览器 mock 降级分支按需动态导入，避免打包到生产桌面端
  const { MOCK_TREE, findNode } = await import("./mockFs");
  await new Promise((r) => setTimeout(r, 100));
  const node = findNode(MOCK_TREE, dirPath);
  if (!node) throw new Error(`路径不存在: ${dirPath}`);
  if (!node.is_dir) throw new Error(`不是目录: ${dirPath}`);
  return {
    ...structuredClone(node),
    children: node.children.map((child) => ({
      ...structuredClone(child),
      children: [],
    })),
  };
}

/** issue #159：Rust 后端读取错误的结构化标记（与 src-tauri commands 常量保持契约一致） */
const READ_ERROR_ENCODING_UNSUPPORTED = "ENCODING_UNSUPPORTED";
const READ_ERROR_FILE_TOO_LARGE = "FILE_TOO_LARGE";

/** 把后端结构化错误标记映射为用户可读提示；其他错误原样抛出。
 * review 修复：用 startsWith 而非 includes——Rust 侧真实错误永远以标记开头，
 * includes 会把「消息里含标记串路径」的普通错误（如文件不存在）误映射 */
function mapReadError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith(READ_ERROR_ENCODING_UNSUPPORTED)) {
    return new Error("无法打开：文件不是 UTF-8 编码（可能是 GBK/Big5 等旧编码），请转换编码后重试");
  }
  if (raw.startsWith(READ_ERROR_FILE_TOO_LARGE)) {
    return new Error("无法打开：文件过大，超过打开大小上限");
  }
  return error instanceof Error ? error : new Error(raw);
}

/** 读取文本文件 */
export async function readTextFile(filePath: string): Promise<string> {
  if (isTauri()) {
    try {
      return await invoke<string>("read_text_file", { filePath });
    } catch (e) {
      throw mapReadError(e);
    }
  }
  const { MOCK_FILE_CONTENT } = await import("./mockFs");
  await new Promise((r) => setTimeout(r, 50));
  return MOCK_FILE_CONTENT[filePath] ?? "";
}

/** 写入文本文件 */
export async function writeTextFile(
  filePath: string,
  content: string,
): Promise<void> {
  if (isTauri()) {
    return invoke<void>("write_text_file", { filePath, content });
  }
  // 浏览器 mock：只在内存里记录
  const { MOCK_FILE_CONTENT } = await import("./mockFs");
  MOCK_FILE_CONTENT[filePath] = content;
}

/** 读取文件最后修改时间（Unix 毫秒时间戳）。浏览器 mock 返回当前时间毫秒 */
export async function fileMtime(filePath: string): Promise<number> {
  if (isTauri()) {
    return invoke<number>("file_mtime", { filePath });
  }
  return Date.now();
}

/** 重命名/移动文件或目录 */
export async function renamePath(from: string, to: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("rename_path", { from, to });
  }
  // 浏览器 mock：更新内容键
  const { MOCK_FILE_CONTENT, MOCK_TREE, findNode, splitPath, rebasePath } = await import("./mockFs");
  if (MOCK_FILE_CONTENT[from] !== undefined) {
    MOCK_FILE_CONTENT[to] = MOCK_FILE_CONTENT[from];
    delete MOCK_FILE_CONTENT[from];
  }
  // 同步 mock 目录树：就地改 name/path 并重算子项 path 前缀
  const node = findNode(MOCK_TREE, from);
  if (node) {
    const { base } = splitPath(to);
    node.name = base;
    rebasePath(node, from, to);
  }
}

/** 删除文件或目录（目录递归）。浏览器 mock 仅清内容表 */
export async function deletePath(path: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("delete_path", { path });
  }
  const { MOCK_FILE_CONTENT, MOCK_TREE, findParent } = await import("./mockFs");
  for (const k of Object.keys(MOCK_FILE_CONTENT)) {
    if (k === path || k.startsWith(path + "/")) delete MOCK_FILE_CONTENT[k];
  }
  // 同步 mock 目录树：从父节点 children 中移除
  const found = findParent(MOCK_TREE, path);
  if (found) {
    found.parent.children.splice(found.index, 1);
  }
}

/** 创建空文件 */
export async function createFile(filePath: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("create_file", { filePath });
  }
  const { MOCK_FILE_CONTENT, MOCK_TREE, findNode, splitPath } = await import("./mockFs");
  MOCK_FILE_CONTENT[filePath] = "";
  // 同步 mock 目录树：在父目录下新增文件节点
  const { dir, base } = splitPath(filePath);
  const parent = dir ? findNode(MOCK_TREE, dir) : null;
  if (parent && !parent.children.some((c) => c.path === filePath)) {
    parent.children.push({ name: base, path: filePath, is_dir: false, children: [] });
  }
}

/** 创建目录 */
export async function createDir(dirPath: string): Promise<void> {
  if (isTauri()) {
    return invoke<void>("create_dir", { dirPath });
  }
  // 浏览器 mock：在父目录下新增目录节点
  const { MOCK_TREE, findNode, splitPath } = await import("./mockFs");
  const { dir, base } = splitPath(dirPath);
  const parent = dir ? findNode(MOCK_TREE, dir) : null;
  if (parent && !parent.children.some((c) => c.path === dirPath)) {
    parent.children.push({ name: base, path: dirPath, is_dir: true, children: [] });
  }
}

/** 全局搜索命中项 */
export interface SearchHit {
  path: string;
  line: number;
  column: number;
  preview: string;
}

/** 全局搜索结果（#160：截断对前端可见） */
export interface SearchResult {
  hits: SearchHit[];
  /** 命中数达到后端上限（5000）被截断时为 true */
  truncated: boolean;
}

/** 搜索代次：每次发起递增，Rust 侧用它取消落后的在途搜索（#163） */
let globalSearchGeneration = 0;
export function nextGlobalSearchGeneration(): number {
  return ++globalSearchGeneration;
}

/** 在工作区所有 .md 文件中搜索文本内容 */
export async function searchInWorkspace(
  root: string,
  query: string,
  caseSensitive: boolean,
  useRegex: boolean,
  generation = 0,
): Promise<SearchResult> {
  if (isTauri()) {
    return invoke<SearchResult>("search_in_workspace", {
      root,
      query,
      caseSensitive,
      useRegex,
      generation,
    });
  }
  // 浏览器 mock：扫描内存中的 mock 文件
  // 空查询与 Rust 侧命令入口一致：登记代次后立即返回，不扫描（卸载取消调用会传空查询）
  if (!query) return { hits: [], truncated: false };
  const { MOCK_FILE_CONTENT } = await import("./mockFs");
  const hits: SearchHit[] = [];
  const q = useRegex ? query : query;
  let re: RegExp;
  try {
    const pattern = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(pattern, caseSensitive ? "g" : "gi");
  } catch {
    return { hits, truncated: false };
  }
  for (const [path, content] of Object.entries(MOCK_FILE_CONTENT)) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) {
        hits.push({ path, line: i + 1, column: 1, preview: lines[i] });
      }
    }
  }
  return { hits, truncated: false };
}

/**
 * 将 Uint8Array 分块转为 base64 字符串。
 * 分块处理（每块 0x8000 字节）以防止超大数组一次性展开导致 JS 引擎调用栈溢出。
 */
export function uint8ArrayToBase64(data: Uint8Array): string {
  const CHUNK_SIZE = 0x8000;
  let binary = "";
  for (let i = 0; i < data.length; i += CHUNK_SIZE) {
    const chunk = data.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * 写入二进制文件（图片等）。
 * 桌面端将数据编码为 base64 后调用 Rust write_binary_file 命令（避免 JSON 数字数组导致的 IPC 膨胀）；
 * 浏览器端无真实 fs，仅返回成功（mock 无法持久化二进制）。
 * @param data 字节数组
 */
export async function writeBinaryFile(
  filePath: string,
  data: Uint8Array,
): Promise<void> {
  if (isTauri()) {
    return invoke<void>("write_binary_file", {
      filePath,
      data: uint8ArrayToBase64(data),
    });
  }
  // 浏览器 mock：无操作
}

/**
 * 以 Markdown 文件所在目录为基准解析路径。
 * Tauri 的原生路径实现会按当前平台处理分隔符、绝对路径及 ./../ 片段。
 */
export async function resolvePathFromDocument(
  documentPath: string,
  ...paths: string[]
): Promise<string> {
  if (!isTauri() || !documentPath) return paths.join("/");
  return resolvePath(documentPath, "..", ...paths);
}

/** 已通过 allow_asset_dir 放行的目录（避免重复 IPC） */
const allowedAssetDirs = new Set<string>();

/**
 * 把目录加入 asset 协议运行时白名单（仅桌面端）。
 * tauri.conf.json 的静态 scope 只覆盖用户目录，工作区/文档在其他磁盘分区
 * （如 Windows 的 E:\code\...）时必须先放行再 convertFileSrc，否则图片加载被拒。
 */
async function allowAssetDir(dir: string): Promise<void> {
  if (!isTauri() || !dir || allowedAssetDirs.has(dir)) return;
  allowedAssetDirs.add(dir);
  try {
    await invoke("allow_asset_dir", { path: dir });
  } catch {
    // 放行失败不阻断渲染：目录恰好落在静态白名单内时仍可加载
    allowedAssetDirs.delete(dir);
  }
}

/** 路径与 asset URL 缓存映射，避免重复解析与动态放行 IPC */
const imageSrcCache = new Map<string, string>();
const MAX_IMAGE_CACHE = 500;

/**
 * 把 markdown 中的图片 src 解析为 WebView 可加载的 URL。
 * - http(s)/data/blob/asset 协议：原样返回
 * - 本地路径：以当前 Markdown 文件所在目录为基准解析并正规化，再用 convertFileSrc 转换
 *   （转换前先把图片所在目录加入 asset 协议运行时白名单，覆盖非用户目录的工作区）
 * - 浏览器环境：原样返回（无法访问本地文件）
 */
export async function resolveImageSrc(
  src: string,
  documentPath: string,
): Promise<string> {
  if (!src) return src;
  if (!isTauri()) return src;
  // 非本地协议 URL 直接放行；file: URL 仍需转成 Tauri 可读取的本地路径。
  if (/^(https?:|data:|blob:|asset:|tauri:)/i.test(src)) return src;

  const cacheKey = `${documentPath}::${src}`;
  const cached = imageSrcCache.get(cacheKey);
  if (cached) {
    // 命中移至末尾实现 LRU
    imageSrcCache.delete(cacheKey);
    imageSrcCache.set(cacheKey, cached);
    return cached;
  }

  // Markdown 图片地址遵循 URI 编码；转成本地路径前解码空格、#、中文等字符。
  // 非法的百分号序列保留原值，避免单张图片导致编辑器初始化失败。
  let localPath = src;
  try {
    if (/^file:/i.test(src)) {
      const url = new URL(src);
      const host =
        url.hostname && url.hostname !== "localhost"
          ? `//${url.hostname}`
          : "";
      localPath = host + decodeURIComponent(url.pathname);
      // file:///C:/... 的 pathname 会多一个前导 /，Windows 路径需去掉。
      if (!host && /^\/[a-zA-Z]:\//.test(localPath)) {
        localPath = localPath.slice(1);
      }
    } else {
      localPath = decodeURIComponent(src);
    }
  } catch {
    // 保留未经编码的普通文件路径
  }
  const abs = await resolvePathFromDocument(documentPath, localPath);
  // 静态 scope 之外的目录（其他磁盘分区等）先动态放行，再转 asset 协议 URL
  await allowAssetDir(dirNameOf(abs));
  const res = convertFileSrc(abs);
  if (imageSrcCache.size >= MAX_IMAGE_CACHE) {
    const firstKey = imageSrcCache.keys().next().value;
    if (firstKey) imageSrcCache.delete(firstKey);
  }
  imageSrcCache.set(cacheKey, res);
  return res;
}

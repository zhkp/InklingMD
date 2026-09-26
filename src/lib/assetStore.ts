// 图片资源落盘（#220）：文件型粘贴/拖拽与远程图片下载共用的写入入口。
//
// 落盘前按内容（大小 + SHA-256）在目标 assets/ 目录里查找已有文件，命中即复用，
// 解决「重复粘贴同一张图产生多份副本」。查重是**尽力而为**：查重失败（目录无权限、
// IPC 异常等）不阻断插入，按新文件写入——多一份副本远好于图片插入失败。

import { findAssetByHash, resolvePathFromDocument, writeBinaryFile } from "./fs";

/** markdown 中引用资源的相对目录（正斜杠，跨平台） */
export const ASSETS_DIR = "assets";

const MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

/** MIME → 扩展名（未知类型回落 .png，与既有文件型粘贴的默认值一致） */
export function extensionForMime(mime: string): string {
  return MIME_EXT[mime.split(";")[0].trim().toLowerCase()] ?? ".png";
}

/** 生成唯一文件名：时间戳 + 随机串 + 扩展名（与既有 assets 命名规则一致） */
export function genAssetName(ext: string): string {
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${rand}${normalized}`;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 把图片字节写入文档同目录的 assets/，返回 markdown 用的相对路径（assets/xxx.png）。
 * 目录里已有相同内容的文件时直接复用其文件名，不再写入。
 * @param documentPath 当前 Markdown 文件完整路径（调用方保证不是未命名草稿）
 * @param fileName 无可复用文件时新文件使用的文件名
 */
export async function saveImageAsset(
  documentPath: string,
  data: Uint8Array,
  fileName: string,
): Promise<string> {
  try {
    const dir = await resolvePathFromDocument(documentPath, ASSETS_DIR);
    const existing = await findAssetByHash(dir, data.byteLength, await sha256Hex(data));
    if (existing) return `${ASSETS_DIR}/${existing}`;
  } catch (e) {
    console.warn("assets 查重失败，按新文件写入：", e);
  }
  const fullPath = await resolvePathFromDocument(documentPath, ASSETS_DIR, fileName);
  await writeBinaryFile(fullPath, data);
  return `${ASSETS_DIR}/${fileName}`;
}

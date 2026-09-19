/**
 * 跨平台路径操作统一工具库（解决 #115）
 * 规范化处理 POSIX (/) 与 Windows (\) 分隔符
 */

/**
 * 统一路径分隔符为 POSIX 风格 (/)，移除末尾多余分隔符（除根目录外）
 */
export function normalizePath(path: string): string {
  if (!path) return "";
  let normalized = path.replace(/\\/g, "/");
  // 匹配形如 c:/ 或 c: 的 Windows 盘符并将其转为大写 C:/
  if (/^[a-zA-Z]:/.test(normalized)) {
    normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
  // 保持单斜杠根目录或盘符根目录 (如 C:/)
  if (normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized;
  }
  return normalized.replace(/\/+$/, "");
}

/**
 * 获取路径的文件名或最后一级目录名
 */
export function baseName(path: string): string {
  if (!path) return "";
  const normalized = normalizePath(path);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

/**
 * 获取路径的父目录
 * - Windows 盘符根 (如 C:\ 或 C:/) 返回原盘符根 C:\ 或 C:/
 * - POSIX 根 (/) 返回 /
 * - 相对单级路径或无分隔符时返回原路径
 */
export function parentDir(filePath: string): string {
  if (!filePath) return "";
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (idx < 0) return filePath;
  const sep = filePath[idx];
  if (idx === 0) return sep; // '/' 或 '\'
  // Windows 盘符根：如 C:\file.md -> C:\，C:/file.md -> C:/
  if (idx === 2 && /^[a-zA-Z]:[\\/]/.test(filePath)) {
    return filePath.slice(0, 2) + sep;
  }
  return filePath.slice(0, idx);
}

/**
 * 别名，与 dirNameOf 兼容统一
 */
export const dirNameOf = parentDir;

/**
 * 连接多个路径片段，自动根据第一个片段风格或使用 '/' 拼接
 */
export function joinPath(base: string, ...parts: string[]): string {
  if (!base) return parts.filter(Boolean).join("/");
  const isWinSep = base.includes("\\") && !base.includes("/");
  const sep = isWinSep ? "\\" : "/";
  if (parts.length === 1 && parts[0] === "") {
    const left = base.replace(/[\\/]+$/, "");
    return left + sep;
  }
  let result = base.replace(/[\\/]+$/, "");
  for (const part of parts) {
    if (!part) continue;
    const clean = part.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
    if (clean) {
      result += sep + clean;
    }
  }
  return result;
}

/**
 * 判断 targetPath 是否在 parentPath 目录下（或两者相等）
 */
export function isPathWithin(targetPath: string, parentPath: string): boolean {
  if (!parentPath || !targetPath) return false;
  const normParent = normalizePath(parentPath);
  const normTarget = normalizePath(targetPath);
  if (normParent === normTarget) return true;
  const prefix = normParent.endsWith("/") ? normParent : normParent + "/";
  return normTarget.startsWith(prefix);
}

/**
 * 把目录重命名前缀同步到子路径
 */
export function rebasePathPrefix(path: string, from: string, to: string): string {
  return isPathWithin(path, from) ? to + path.slice(from.length) : path;
}

/**
 * 取 targetPath 相对 root 的 POSIX 风格路径
 *
 * - 不在 root 下（或未提供 root）时退化为文件名，保证展示层永远有可用的短路径；
 * - 统一走 normalizePath，因此两侧的分隔符差异与末尾斜杠都不会影响判定。
 */
export function relativeToRoot(targetPath: string, root: string | null): string {
  if (!targetPath) return "";
  if (!root) return baseName(targetPath);
  const normRoot = normalizePath(root);
  const normTarget = normalizePath(targetPath);
  const prefix = normRoot.endsWith("/") ? normRoot : normRoot + "/";
  if (normTarget.startsWith(prefix)) {
    return normTarget.slice(prefix.length);
  }
  return baseName(targetPath);
}

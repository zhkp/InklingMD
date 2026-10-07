/**
 * #306：浏览器安全的路径工具（渲染进程没有 `node:path`，且 `rewrite` 必须是纯函数）。
 *
 * 约定：
 * - **分隔符跟随基准目录**（`themeDir` 是 Windows 原生路径就产出 `\`，POSIX 就产出 `/`）——
 *   这样 `toAssetUrl(absPath)` 收到的串与「用户直接打开该文件」时完全同类，
 *   `convertFileSrc` 的编码形态（`:`→`%3A`、`\`→`%5C`）才有唯一期望值（台账 #4 实测）。
 * - `.` / `..` 一律折叠；Windows 盘符（`C:` / `C:/` / `C:\`）与 UNC（`\\srv\share`）视为绝对。
 */

/** 绝对路径：Windows 盘符（`C:\` / `C:/`）、UNC（`\\srv\share`）、POSIX 根（`/…`）。 */
export function isAbsolutePath(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  return /^[a-zA-Z]:\//.test(n) || n.startsWith("//") || n.startsWith("/");
}

/** 取所在目录（同为绝对路径时返回同级目录；已是根则返回根）。 */
export function dirname(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const n = p.replace(/\\/g, "/");
  const idx = n.lastIndexOf("/");
  if (idx < 0) return ".";
  // 保留盘符根（"C:/" → "C:/"）与 POSIX 根（"/" → "/"）
  const head = n.slice(0, idx + 1);
  if (/^[a-zA-Z]:\/$/.test(head) || head === "/") return sep === "\\" ? head.replace(/\//g, "\\") : head;
  return (head.length > 1 ? head.replace(/\/$/, "") : head).replace(/\//g, sep);
}

/** 折叠 `.` / `..`（先统一为 `/`，再按需还原分隔符）。 */
export function normalizePath(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const n = p.replace(/\\/g, "/");
  const drive = /^([a-zA-Z]:)(\/|$)/.exec(n);
  const prefix = drive ? drive[1] : "";
  const rest = drive ? n.slice(drive[1].length) : n;
  const isAbs = !drive && rest.startsWith("/");
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  const head = prefix + (isAbs || prefix ? "/" : "");
  const result = (head + joined) || "/";
  return sep === "\\" ? result.replace(/\//g, "\\") : result;
}

/**
 * 以 `baseDir` 为基准解析 `target`：
 * - 绝对目标（`C:\…` / `/…` / UNC）→ 直接归一化（§C9：绝对路径不重写，由调用方判断后跳过）；
 * - 相对目标 → 拼到 baseDir 后归一化（分隔符跟随 baseDir）。
 */
export function resolvePath(baseDir: string, target: string): string {
  if (isAbsolutePath(target)) return normalizePath(target);
  const base = baseDir.replace(/[\\/]$/, "");
  return normalizePath(`${base}/${target}`);
}

export const defaultPathApi = {
  resolve: resolvePath,
  dirname,
};

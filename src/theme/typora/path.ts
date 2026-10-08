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

/** 折叠 `.` / `..`（先统一为 `/`，再按需还原分隔符）。UNC（`\\srv\share`）双前导斜杠必须保留。 */
export function normalizePath(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const n = p.replace(/\\/g, "/");
  const drive = /^([a-zA-Z]:)(\/|$)/.exec(n);
  // UNC：`//srv/share/...`（`//` 之后必须是主机名，不能是路径分隔的残留）
  const unc = !drive && /^\/\/[^/]/.test(n);
  const prefix = drive ? drive[1] : unc ? "//" : "";
  const rest = drive ? n.slice(drive[1].length) : unc ? n.slice(2) : n;
  const isAbs = !drive && (unc || rest.startsWith("/"));
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
  // 盘符 → `C:/…`；UNC → `//srv/…`（双斜杠已是前缀本体，不再补 `/`）；POSIX 绝对 → `/…`
  const head = drive ? `${prefix}/` : unc ? prefix : isAbs ? "/" : "";
  const result = (head + joined) || "/";
  return sep === "\\" ? result.replace(/\//g, "\\") : result;
}

/** 路径是否按 Windows 语义比较（盘符 / UNC / 反斜杠分隔）——Windows 大小写不敏感，POSIX 敏感。 */
function usesWindowsSemantics(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.startsWith("\\\\") || p.includes("\\");
}

/**
 * §C9 越界判据：`abs` 是否**在根内**（含根本身）。必须是**路径边界比较**而不是前缀比较：
 * `C:\themes\dark-extra\x.png` 以前缀 `C:\themes\dark` 开头，但它**不在**该根内。
 * 大小写口径按路径形态判定（Windows 语义不敏感 / POSIX 敏感），不依赖运行平台，
 * 保证同一输入的判定在任何 CI 平台上一致。
 */
export function isWithinRoot(abs: string, root: string): boolean {
  const fold = usesWindowsSemantics(root) || usesWindowsSemantics(abs);
  // 规范化 + 统一为正斜杠再比较（否则 `C:/x` 与 `C:\x` 这类同义写法会误判为越界）
  const canon = (p: string) => {
    const s = normalizePath(p).replace(/\\/g, "/");
    return fold ? s.toLowerCase() : s;
  };
  const a = canon(abs);
  const r = canon(root);
  if (a === r) return true;
  return a.startsWith(r.endsWith("/") ? r : `${r}/`);
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

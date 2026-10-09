/**
 * #307 主题目录的**浏览器 mock**（仅在 `!isTauri()` 时被动态 import，不进桌面端产物）。
 *
 * 用途：E2E（Playwright 跑在浏览器里）要能走通「主题目录 → 扫描 → 列表 → 切换 → 重启保持」
 * 这条真实链路。测试用 `page.addInitScript` 预置 `window.__inklingThemesMock` 播种虚拟文件系统；
 * 应用侧的 `src/lib/themeFiles.ts` 在浏览器分支调这里，形状与 Rust 命令**逐字段一致**。
 */

export interface MockThemeSeed {
  /** 虚拟主题目录绝对路径（默认 `/mock-appdata/themes`） */
  root?: string;
  /** 预装源副本目录（默认 `/mock-resource/themes`） */
  bundledRoot?: string;
  /** 相对主题目录的路径 → 文件内容（`/` 分隔） */
  files?: Record<string, string>;
  /** 压缩包路径 → `{ 包内相对路径: 内容 }`（用于模拟解压） */
  zips?: Record<string, Record<string, string>>;
}

interface MockState {
  root: string;
  bundledRoot: string;
  files: Map<string, string>;
  zips: Map<string, Record<string, string>>;
}

const DEFAULT_ROOT = "/mock-appdata/themes";
const DEFAULT_BUNDLED_ROOT = "/mock-resource/themes";

let state: MockState | null = null;

function ensureState(): MockState {
  if (state) return state;
  const seed = (globalThis as { __inklingThemesMock?: MockThemeSeed }).__inklingThemesMock;
  state = {
    root: seed?.root ?? DEFAULT_ROOT,
    bundledRoot: seed?.bundledRoot ?? DEFAULT_BUNDLED_ROOT,
    files: new Map(Object.entries(seed?.files ?? {})),
    zips: new Map(Object.entries(seed?.zips ?? {})),
  };
  return state;
}

/** 测试用：重置内部状态（下一次访问会重新读 `window.__inklingThemesMock`） */
export function resetMockThemes(): void {
  state = null;
}

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function mockThemesRoot(): string {
  return ensureState().root;
}

export function mockBundledThemesRoot(): string {
  return ensureState().bundledRoot;
}

export interface MockScan {
  entries: { name: string; path: string; is_dir: boolean; size: number }[];
  skipped: string[];
}

/** 单层扫描（与 Rust `scan_theme_dir` 同形状：目录在前、跳过隐藏项） */
export function mockScan(dir: string): MockScan {
  const s = ensureState();
  const base = dir.replace(/\/+$/, "");
  const entries = new Map<string, { name: string; path: string; is_dir: boolean; size: number }>();
  for (const [path, content] of s.files) {
    if (!path.startsWith(`${base}/`)) continue;
    const rest = path.slice(base.length + 1);
    const [head, ...tail] = rest.split("/");
    if (!head || head.startsWith(".")) continue;
    if (tail.length === 0) {
      entries.set(head, { name: head, path, is_dir: false, size: new TextEncoder().encode(content).length });
    } else if (!entries.has(head)) {
      entries.set(head, { name: head, path: join(base, head), is_dir: true, size: 0 });
    }
  }
  const list = [...entries.values()].sort((a, b) =>
    a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1,
  );
  return { entries: list, skipped: [] };
}

/** 读取文本（主题 CSS / manifest） */
export function mockReadText(path: string): string {
  const s = ensureState();
  const hit = s.files.get(path);
  if (hit === undefined) throw new Error(`文件不存在: ${path}`);
  return hit;
}

export function mockFileExists(path: string): boolean {
  return ensureState().files.has(path);
}

export function mockListFilesUnder(dir: string): string[] {
  const base = dir.replace(/\/+$/, "");
  return [...ensureState().files.keys()].filter((p) => p.startsWith(`${base}/`));
}

/** 幂等建目录（mock 只看文件，目录由路径隐含） */
export function mockEnsureDir(): void {
  ensureState();
}

/** 复制（文件或目录前缀），覆盖同名 */
export function mockCopy(from: string, to: string): { files: number; bytes: number; skipped: string[] } {
  const s = ensureState();
  let files = 0;
  let bytes = 0;
  if (s.files.has(from)) {
    const content = s.files.get(from)!;
    s.files.set(to, content);
    files += 1;
    bytes += new TextEncoder().encode(content).length;
  } else {
    for (const [path, content] of [...s.files]) {
      if (!path.startsWith(`${from}/`)) continue;
      const dest = `${to}/${path.slice(from.length + 1)}`;
      s.files.set(dest, content);
      files += 1;
      bytes += new TextEncoder().encode(content).length;
    }
  }
  return { files, bytes, skipped: [] };
}

/** 解压（mock：把播种的 zip 内容摊到目标目录） */
export function mockExtractZip(zipPath: string, dest: string): {
  entries: string[];
  files: number;
  bytes: number;
  skipped: string[];
} {
  const s = ensureState();
  const contents = s.zips.get(zipPath);
  if (!contents) throw new Error(`解析压缩包失败（mock 未播种该 zip）: ${zipPath}`);
  const entries: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const [rel, content] of Object.entries(contents)) {
    if (rel.includes("..")) throw new Error(`压缩包条目含 \`..\`（${rel}）→ 拒绝整包（zip slip）`);
    const target = `${dest.replace(/\/+$/, "")}/${rel}`;
    s.files.set(target, content);
    entries.push(rel);
    files += 1;
    bytes += new TextEncoder().encode(content).length;
  }
  return { entries, files, bytes, skipped: [] };
}

/** 删除（文件或目录前缀） */
export function mockDelete(path: string): void {
  const s = ensureState();
  s.files.delete(path);
  for (const key of [...s.files.keys()]) {
    if (key.startsWith(`${path}/`)) s.files.delete(key);
  }
}

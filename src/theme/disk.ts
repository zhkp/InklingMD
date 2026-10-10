/**
 * #307 磁盘主题的**读盘路径**（补齐 `session.ts` 首帧注释里那句「交给调用方（#307 的磁盘读盘路径）」）。
 *
 * 职责：把「主题文件 + 本地 `@import`」读进来 → 交 `#306` 兼容层改写（`rewriteWithReport`）
 * → 交给 `#225` 注入层（`applyTheme`，落快照）。
 *
 * 关键口径（与 #306 冻结实现**逐项对齐**，不另立一套）：
 * - `@import` 目标一律**相对主题目录**解析（`inlineImports` 的既定语义），因此预读也用同一基准；
 * - 预读键同时放「精确大小写」与「小写」两份（`inlineImports` 的查找是 `get(abs) ?? get(abs.toLowerCase())`）；
 * - 远程 / 绝对 / 超深度 / 循环 → 不预读，流水线会**丢弃并登记**（P1-6）；
 * - 资源 `url()` 的允许根 = **assetProtocol.scope 的根**（如应用数据目录），否则同包内 `../fonts/x` 会被判越界降级。
 */
import { rewriteWithReport, themeCssHash, type RewriteResult } from "./typora/rewrite";
import { defaultPathApi, isWithinRoot, normalizePath } from "./typora/path";
import type { ThemePathApi, ThemeRewriteContext } from "./typora/types";

/** 读盘依赖（生产用 `readThemeFile` / `convertFileSrc`；单测注入桩，保持纯函数可断言） */
export interface ThemeDiskIo {
  readFile: (absPath: string) => Promise<string>;
  toAssetUrl: (absPath: string) => string;
}

export interface LoadThemeCssOptions {
  themeId: string;
  /** 主题 CSS 文件绝对路径 */
  filePath: string;
  /** 资源允许根（§C9；生产传应用数据目录 = `assetProtocol.scope` 的根） */
  assetRoot: string;
  io: ThemeDiskIo;
  /** `@import` 递归深度上限（P1-6，默认 8，与 `#306` 一致） */
  maxImportDepth?: number;
  path?: ThemePathApi;
}

const REMOTE_SCHEME = /^(?:data|blob|https?|asset|file|tauri):/i;

/**
 * 抽出 CSS 里的 `@import` 目标（只取**本地**相对路径；远程/绝对/URL 方案交给流水线丢弃并登记）。
 * 与 `#306` 的 `inlineImports` 使用同一组形态：`@import "x.css"` / `'x.css'` / `url(x.css)` / `url("x.css")`。
 */
export function extractImportTargets(css: string): string[] {
  const out: string[] = [];
  const re = /@import\s+(?:url\(\s*)?["']?([^"');\s]+)["']?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const target = m[1]?.trim();
    if (!target) continue;
    if (REMOTE_SCHEME.test(target) || target.startsWith("/")) continue;
    out.push(target);
  }
  return out;
}

export interface PreloadOptions {
  /** `@import` 递归深度上限（P1-6，默认 8，与 `#306` 一致） */
  maxImportDepth?: number;
  /**
   * 允许读取的根（**默认 = themeDir**，保守）：解析后的目标必须落在该根内，否则**丢弃该 `@import`**。
   * 与 `§C9` 的 `url()` 越界判据**同一套**（`isWithinRoot` 路径边界比较），生产传 `assetRoot` = 应用数据目录，
   * 这样主题目录区内的合法共享（`../shared/x.css`）仍可用，而 `../../.ssh/id_rsa` 这类越界读取被拦。
   */
  assetRoot?: string;
  path?: ThemePathApi;
  /** 被拦下的越界目标（调用方据此写诊断，不允许静默丢弃） */
  onBlocked?: (target: string, abs: string) => void;
}

/**
 * 递归预读本地 `@import`（P1-6：导入/切换期把本地方案读进来，产物里不允许出现指向 asset 的 `@import`）。
 *
 * - **越界即拦**（不允许读到允许根之外的文件，更不允许内联进注入产物）；
 * - 目标缺失（真实主题包常见的可选资源）**不算错误**：不预读 → 流水线丢弃该 `@import` 并登记。
 */
export async function preloadLocalImports(
  themeDir: string,
  css: string,
  readFile: (absPath: string) => Promise<string>,
  options: PreloadOptions = {},
): Promise<Map<string, string>> {
  const path = options.path ?? defaultPathApi;
  const maxImportDepth = options.maxImportDepth ?? 8;
  const root = normalizePath(options.assetRoot ?? themeDir);
  const sources = new Map<string, string>();
  const seen = new Set<string>();

  const visit = async (text: string, depth: number): Promise<void> => {
    if (depth >= maxImportDepth) return;
    for (const target of extractImportTargets(text)) {
      const abs = path.resolve(themeDir, target);
      if (!isWithinRoot(abs, root)) {
        // 越界：不读、不内联（与 §C9 的 url() 越界对称）
        options.onBlocked?.(target, abs);
        continue;
      }
      const key = abs.toLowerCase();
      if (seen.has(key)) continue; // 循环引用保护
      seen.add(key);
      try {
        const content = await readFile(abs);
        // 两种大小写都登记：与 `inlineImports` 的 `get(abs) ?? get(abs.toLowerCase())` 对齐
        sources.set(abs, content);
        sources.set(key, content);
        await visit(content, depth + 1);
      } catch {
        // 读取失败 / 目标缺失：不预读（流水线会登记为 dropped-import）
      }
    }
  };

  await visit(css, 0);
  return sources;
}

export interface LoadThemeCssResult {
  /** 兼容层输出（`css` 为可注入文本；`rejected` 为整包拒绝） */
  result: RewriteResult;
  /** 预读到的本地 `@import` 表（诊断/断言用） */
  importSources: Map<string, string>;
  /** 主题文件所在的目录（资源解析基准） */
  themeDir: string;
  /** 被拦下的越界 `@import`（已写进 `result.diagnostics`，这里供调用方观测/断言） */
  blockedImports: { target: string; abs: string }[];
}

/** 读盘 + 预读 `@import` + 兼容层改写（#307 §6.1 的第③层） */
export async function loadThemeCss(opts: LoadThemeCssOptions): Promise<LoadThemeCssResult> {
  const path = opts.path ?? defaultPathApi;
  const themeDir = path.dirname(opts.filePath);
  const raw = await opts.io.readFile(opts.filePath);
  const blocked: { target: string; abs: string }[] = [];
  const importSources = await preloadLocalImports(themeDir, raw, opts.io.readFile, {
    maxImportDepth: opts.maxImportDepth ?? 8,
    assetRoot: opts.assetRoot,
    path,
    onBlocked: (target, abs) => blocked.push({ target, abs }),
  });
  const ctx: ThemeRewriteContext = {
    themeId: opts.themeId,
    themeDir,
    toAssetUrl: opts.io.toAssetUrl,
    importSources,
    maxImportDepth: opts.maxImportDepth ?? 8,
    assetRoot: opts.assetRoot,
  };
  const result = rewriteWithReport(raw, ctx);
  // 越界 `@import`：显式登记（与 §C9 的 dropped-url 对称；流水线另外也会给一条通用 dropped-import）
  for (const item of blocked) {
    result.diagnostics.push({
      kind: "dropped-import",
      target: item.target,
      reason: `@import 目标越出允许根（${item.abs}）→ 丢弃且**不读取**（§9；与 §C9 的 url() 越界同一判据）`,
    });
  }
  return { result, importSources, themeDir, blockedImports: blocked };
}

/** 读盘路径的内容 hash（与扫描期 `themeCssHash` 同口径，供断言「快照 key 一致」） */
export function rawThemeHash(raw: string): string {
  return themeCssHash(raw);
}

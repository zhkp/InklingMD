/**
 * #307 §3 / §4 / §9 / §2 新-2 / §10 N13·N15：主题导入与预装清单的**纯核心**。
 *
 * 本模块**不碰文件系统、不碰 DOM**（与 `typora/*` 同风格：纯函数 + 显式入参），
 * 因此可以被单测直接喂字符串/结构断言；真正的读盘/解压/复制在 `src/lib/themeFiles.ts`
 * 与 Rust 命令里（`#307` 的 IO 层）。
 *
 * 覆盖的冻结口径：
 * - §3.1 包结构归一化（压缩包/文件夹结构不固定：下探 1 层、`<name>.css` ↔ `<name>/` 绑定、README/LICENSE 保留）；
 * - §4 重名与覆盖（不允许静默覆盖；`bundled:*` 命中时**禁用覆盖**，只能「复制为我的主题」/取消；同 hash 跳过）；
 * - §9 安全校验（`url(javascript:)`/`expression()` 拒绝、体积三档、远程资源显式提示）；
 * - §2 新-2 预装清单（`$RESOURCE/themes/manifest.json` 最小字段集）与 §10 N15 清单驱动识别 + §N13 幂等补齐；
 * - §10 符号链接策略：**不跟随**（由 IO 层执行，此处只定义判据）。
 */
import {
  buildThemeId,
  isThemeFile,
  normalizeThemeSlug,
  stripExtension,
  type ThemeMode,
  type ThemeSource,
} from "./typora/metadata";

// ── §3.1 包结构归一化 ────────────────────────────────────────────────────────

/** 包内条目（由 Rust 侧扫描/解压后给出；`path` 为包内相对路径，posix 分隔符） */
export interface PackageEntry {
  path: string;
  kind: "file" | "dir";
}

export interface NormalizedThemeEntry {
  /** 归一化 slug（`<name>`，走 G11 唯一实现） */
  slug: string;
  /** 主题 CSS 在包内的相对路径 */
  cssPath: string;
  /** 同名资源目录（字体/图片）在包内的相对路径；无则 undefined */
  resourceDir?: string;
  /** 随主题保留的附加文件（README/LICENSE，供详情展示与署名衔接） */
  extras: string[];
  /** 归一化后的明暗（此处按文件名 `-dark` 后缀判定；权威判定在 scan 侧 `parseThemeCandidate`） */
  mode: ThemeMode;
}

export interface NormalizePackageResult {
  themes: NormalizedThemeEntry[];
  issues: string[];
}

/** 统一为 posix 风格、去掉前导 `./` 与多余分隔符 */
function normalizeRelPath(raw: string): string {
  let s = raw.replace(/\\/g, "/").trim();
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/\/{2,}/g, "/");
  return s.replace(/\/+$/, "");
}

function segments(rel: string): string[] {
  return rel.split("/").filter(Boolean);
}

/** 附加文件（保留但不成主题）判据：根层 README* / LICENSE* / COPYING*（§3.1） */
function isExtraFile(baseName: string): boolean {
  return /^(readme|license|licence|copying|notice)(\.[^.]*)?$/i.test(baseName);
}

/**
 * 归一化导入包结构（§3.1）：
 *
 * ```
 * <name>.css + <name>/            → 直接接受
 * <repo>-<branch>/<name>.css      → 下探 1 层后接受（**只允许 1 层**）
 * ```
 * 校验：`.css` 数量 ≥1（否则整包拒绝并给原因）；检出多个 `<name>.css` → 全部导入（明暗成对场景）。
 */
export function normalizePackage(entries: readonly PackageEntry[]): NormalizePackageResult {
  const issues: string[] = [];
  const files = entries
    .filter((e) => e.kind === "file")
    .map((e) => normalizeRelPath(e.path))
    .filter(Boolean);
  const dirs = new Set(
    entries
      .filter((e) => e.kind === "dir")
      .map((e) => normalizeRelPath(e.path))
      .filter(Boolean),
  );

  const cssAtDepth1 = files.filter((f) => segments(f).length === 1 && isThemeFile(f));
  let root = "";
  if (cssAtDepth1.length === 0) {
    // 下探 1 层：所有条目共享同一个顶层目录时才下探（避免把多主题包误判为一层）
    const tops = new Set(
      [...files, ...dirs].map((p) => segments(p)[0]).filter((s): s is string => !!s),
    );
    const depth2Css = files.filter((f) => segments(f).length === 2 && isThemeFile(f));
    if (tops.size === 1 && depth2Css.length > 0) {
      root = [...tops][0];
    } else if (depth2Css.length > 0) {
      issues.push(
        `包内根目录未找到 .css，且存在多个顶层目录 → 不做猜测下探（§3.1 只允许下探 1 层且需唯一顶层）`,
      );
      return { themes: [], issues };
    } else {
      issues.push("包内未找到任何 .css（§3.1：包内 .css 数量必须 ≥1）");
      return { themes: [], issues };
    }
  }

  const relOf = (abs: string): string => {
    const segs = segments(abs);
    return root ? segs.slice(segments(root).length).join("/") : segs.join("/");
  };

  const inPackage = files.filter((f) => (root ? f.startsWith(`${root}/`) : true)).map(relOf);
  const cssFiles = inPackage.filter((f) => segments(f).length === 1 && isThemeFile(f));

  const themes: NormalizedThemeEntry[] = [];
  const usedSlugs = new Map<string, string>();
  for (const cssPath of cssFiles) {
    const base = segments(cssPath)[0];
    const rawBase = stripExtension(base);
    const slug = normalizeThemeSlug(rawBase);
    if (!slug) {
      issues.push(`无法从文件名派生 slug：${cssPath} → 跳过（不导入无名主题）`);
      continue;
    }
    const prior = usedSlugs.get(slug);
    if (prior) {
      // 归一化后同名（`Vue.css` 与 `vue.css`）：取先出现者（与 G11 一致的「不静默」策略）
      issues.push(`归一化同名冲突：${prior} 与 ${cssPath} 同为 ${slug} → 只导入先出现者`);
      continue;
    }
    usedSlugs.set(slug, cssPath);

    // 同名资源目录：与 `.css` 基名同名（大小写不敏感）
    const resourceDir = [...dirs].map(relOf).find((d) => {
      const segs = segments(d);
      return segs.length === 1 && segs[0].toLowerCase() === rawBase.toLowerCase();
    });

    const extras = inPackage.filter((f) => {
      const segs = segments(f);
      if (segs.length !== 1) return false;
      return isExtraFile(segs[0]);
    });

    themes.push({
      slug,
      cssPath: root ? `${root}/${cssPath}` : cssPath,
      resourceDir: resourceDir ? (root ? `${root}/${resourceDir}` : resourceDir) : undefined,
      extras: root ? extras.map((e) => `${root}/${e}`) : extras,
      mode: /-dark(?:-dark)?$/i.test(slug) ? "dark" : "light",
    });
  }

  if (themes.length === 0) issues.push("归一化后没有可导入的主题（全部被跳过）");
  return { themes, issues };
}

// ── §4 重名与覆盖策略 ────────────────────────────────────────────────────────

/** 冲突可选动作（`skip-identical` 由判据自动决定，不作为用户选项） */
export type ConflictAction = "skip-identical" | "overwrite" | "rename" | "duplicate-as-user";

export interface ExistingThemeRef {
  id: string;
  source: "builtin-base" | "builtin" | "bundled" | "user";
  hash?: string;
}

export interface ConflictInput {
  /** 待导入主题期望的 id（`user:<slug>`） */
  incomingId: string;
  /** 待导入内容 hash（规范化文本，G9 同一哈希口径） */
  incomingHash: string;
  /** 同 id 的既有主题（无冲突则不传） */
  existing?: ExistingThemeRef;
  /** 已占用的全部 id（用于 rename 找空位） */
  takenIds: ReadonlySet<string>;
}

export interface ConflictResolution {
  action: ConflictAction;
  /** 动作后的目标 id（overwrite 保持原 id；rename 追加序号；duplicate-as-user 落 user:<slug>） */
  targetId: string;
  /** 人话原因（写进可见提示，不允许静默） */
  reason: string;
}

/** `<slug>-2` / `-3` … 找第一个空位（§4「追加序号后导入」） */
export function nextFreeSlugId(baseId: string, takenIds: ReadonlySet<string>): string {
  const prefix = baseId.slice(0, baseId.indexOf(":") + 1);
  const slug = baseId.slice(prefix.length);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${prefix}${slug}-${n}`;
    if (!takenIds.has(candidate)) return candidate;
  }
  // 极端情况（上千个同名）：退回时间戳后缀，仍然保证不覆盖
  return `${prefix}${slug}-${Date.now().toString(36)}`;
}

/** 该冲突下用户可选的策略（§4 + 新-1：预装主题禁止覆盖） */
export function availableConflictChoices(existing?: ExistingThemeRef): ConflictAction[] {
  if (!existing) return [];
  if (existing.source === "bundled" || existing.source === "builtin" || existing.source === "builtin-base") {
    return ["duplicate-as-user", "rename"];
  }
  return ["overwrite", "rename"];
}

/**
 * 冲突判定（§4）：
 * - 同 hash → `skip-identical`（提示「已存在相同主题」，不重复导入）；
 * - 目标是预装/内置 → **禁止覆盖**：默认「复制为我的主题」（`user:<slug>`，占用则追加序号）；
 * - 目标是用户主题 → 默认「覆盖」（调用方仍可让用户改选 rename）。
 */
export function resolveImportConflict(input: ConflictInput): ConflictResolution {
  const { incomingId, incomingHash, existing, takenIds } = input;
  if (existing?.hash && existing.hash === incomingHash) {
    return {
      action: "skip-identical",
      targetId: existing.id,
      reason: `内容与 ${existing.id} 完全相同（hash 一致）→ 跳过，不重复导入`,
    };
  }
  if (!existing) {
    return { action: "overwrite", targetId: incomingId, reason: "无同名主题，直接落盘导入" };
  }
  const protectedSource =
    existing.source === "bundled" || existing.source === "builtin" || existing.source === "builtin-base";
  if (protectedSource) {
    // 新-1：对预装主题「覆盖」会让运行时副本被 N13 幂等补齐静默回滚 → 只允许复制为我的主题
    const asUser = incomingId.startsWith("user:") ? incomingId : `user:${incomingId.slice(incomingId.indexOf(":") + 1)}`;
    const targetId = takenIds.has(asUser) ? nextFreeSlugId(asUser, takenIds) : asUser;
    return {
      action: "duplicate-as-user",
      targetId,
      reason: `${existing.id} 由应用管理（预装），不允许原地替换 → 复制为 ${targetId}（独立文件，改动只落 user:*）`,
    };
  }
  return { action: "overwrite", targetId: existing.id, reason: `覆盖用户主题 ${existing.id}（旧文件移入备份目录）` };
}

// ── §9 体积分档与安全校验 ────────────────────────────────────────────────────

/** 快照预算（≤256 KB 走快照、享受零闪烁；A-2 分档） */
export const THEME_SNAPSHOT_MAX_BYTES = 256 * 1024;
/** 单主题体积上限（>512 KB 拒绝） */
export const THEME_REJECT_MAX_BYTES = 512 * 1024;

export type SizeTier = "snapshot" | "degraded" | "reject";

export function sizeTierOf(bytes: number): SizeTier {
  if (bytes > THEME_REJECT_MAX_BYTES) return "reject";
  if (bytes > THEME_SNAPSHOT_MAX_BYTES) return "degraded";
  return "snapshot";
}

/** §9：显式拒绝的可执行样式（现代浏览器已不执行，但校验层必须拒绝） */
const FORBIDDEN_CSS = [
  { re: /url\(\s*['"]?\s*javascript:/i, what: "url(javascript:…)" },
  { re: /\bexpression\s*\(/i, what: "expression(…)" },
] as const;

export interface CssSafetyVerdict {
  ok: boolean;
  reason?: string;
}

export function checkThemeCssSafety(css: string): CssSafetyVerdict {
  for (const { re, what } of FORBIDDEN_CSS) {
    if (re.test(css)) {
      return { ok: false, reason: `含被显式拒绝的可执行样式 ${what}（§9）` };
    }
  }
  return { ok: true };
}

/** §9 远程资源的显式提示（不是拒绝，但必须在 UI 说明；P1-7 预留离线开关位） */
export interface RemoteResourceNotice {
  /** 远程样式表 `@import url(http…)` 条数 */
  remoteImports: number;
  /** 远程字体（`@font-face` 内的 http(s) url）条数 */
  remoteFonts: number;
  /** 远程图片（其它 http(s) url）条数 */
  remoteImages: number;
  /** 是否应给用户提示 */
  shouldNotice: boolean;
}

export function analyzeRemoteResources(css: string): RemoteResourceNotice {
  const remote = (css.match(/url\(\s*['"]?\s*https?:/gi) ?? []).length;
  const imports = (css.match(/@import[^;]*https?:/gi) ?? []).length;
  const fontBlocks = css.match(/@font-face\s*\{[^}]*\}/gi) ?? [];
  const remoteFonts = fontBlocks.filter((b) => /url\(\s*['"]?\s*https?:/i.test(b)).length;
  const remoteImages = Math.max(0, remote - remoteFonts - imports);
  return {
    remoteImports: imports,
    remoteFonts,
    remoteImages,
    shouldNotice: remote > 0 || imports > 0,
  };
}

export interface ImportValidation {
  ok: boolean;
  tier: SizeTier;
  reason?: string;
  /** 面向用户的提示（体积降级 / 远程资源 / 整包拒绝说明），允许为空 */
  notices: string[];
}

/** 导入期的整体校验（§9）：体积三档 + 显式拒绝项 + 远程资源提示 */
export function validateImportedTheme(css: string, bytes: number = utf8Bytes(css)): ImportValidation {
  const notices: string[] = [];
  const safety = checkThemeCssSafety(css);
  if (!safety.ok) return { ok: false, tier: "reject", reason: safety.reason, notices };

  const tier = sizeTierOf(bytes);
  if (tier === "reject") {
    return {
      ok: false,
      tier,
      reason: `主题体积 ${formatKb(bytes)} 超过上限 ${formatKb(THEME_REJECT_MAX_BYTES)}（A-2 分档）`,
      notices,
    };
  }
  if (tier === "degraded") {
    notices.push(
      `主题体积 ${formatKb(bytes)}（> ${formatKb(THEME_SNAPSHOT_MAX_BYTES)}）：可用但不走首屏快照，每次冷启动会有一次可见切换`,
    );
  }
  const remote = analyzeRemoteResources(css);
  if (remote.shouldNotice) {
    notices.push(
      `含远程资源（样式表 ${remote.remoteImports} / 字体 ${remote.remoteFonts} / 图片 ${remote.remoteImages}）：远程样式表与字体不加载，远程图片可加载但会发起网络请求`,
    );
  }
  return { ok: true, tier, notices };
}

function formatKb(bytes: number): string {
  return `${Math.round((bytes / 1024) * 10) / 10} KB`;
}

/** 文本 → UTF-8 字节数（与落盘一致；不依赖 TextEncoder 在旧环境的差异） */
export function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  // 兜底：按 UTF-8 变长编码估算（与 TextEncoder 结果一致）
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

// ── §2 新-2 预装清单 + §10 N13/N15 ──────────────────────────────────────────

/** 预装清单条目（最小字段集；许可字段留在 `07` §3.1 发版登记，**不进运行时 manifest**） */
export interface BundledManifestEntry {
  slug: string;
  /** 相对 `$RESOURCE/themes/` 的 css 相对路径 */
  css: string;
  /** 同名资源目录（相对路径） */
  dir?: string;
  name: string;
  mode: ThemeMode;
  hiddenByDefault?: boolean;
}

export const BUNDLED_MANIFEST_VERSION = 1;

export interface BundledManifest {
  v: number;
  themes: BundledManifestEntry[];
}

export interface ParseManifestResult {
  entries: BundledManifestEntry[];
  issues: string[];
}

/**
 * 解析预装清单（§2 新-2）。**宽容但必须留痕**：单条非法只跳过该条并登记，
 * 整份非法（不是对象/缺 themes）→ 返回空清单 + issue（调用方按「无预装主题」降级）。
 */
export function parseBundledManifest(raw: unknown): ParseManifestResult {
  const issues: string[] = [];
  const empty = { entries: [] as BundledManifestEntry[], issues };
  if (!raw || typeof raw !== "object") {
    issues.push("预装清单不是对象 → 视为无预装主题");
    return empty;
  }
  const obj = raw as { v?: unknown; themes?: unknown };
  if (typeof obj.v !== "number" || obj.v !== BUNDLED_MANIFEST_VERSION) {
    issues.push(`预装清单版本不认识（v=${String(obj.v)}，期望 ${BUNDLED_MANIFEST_VERSION}）→ 视为无预装主题`);
    return empty;
  }
  if (!Array.isArray(obj.themes)) {
    issues.push("预装清单缺少 themes 数组 → 视为无预装主题");
    return empty;
  }
  const entries: BundledManifestEntry[] = [];
  const seen = new Set<string>();
  for (const item of obj.themes) {
    if (!item || typeof item !== "object") {
      issues.push("预装清单存在非对象条目 → 跳过");
      continue;
    }
    const t = item as Record<string, unknown>;
    // 清单里的 slug 必须**显式给出**（不像文件名那样允许 emoji 兜底：清单是发版产物，
    // 空 slug 是登记错误，必须暴露而不是被 `normalizeThemeSlug` 的 `theme-<hash>` 兜底掩盖）
    const rawSlug = typeof t.slug === "string" ? t.slug.trim() : "";
    const slug = rawSlug ? normalizeThemeSlug(rawSlug) : "";
    const css = typeof t.css === "string" ? normalizeRelPath(t.css) : "";
    const name = typeof t.name === "string" ? t.name.trim() : "";
    const mode = t.mode === "dark" ? "dark" : t.mode === "light" ? "light" : undefined;
    if (!slug || !css || !name || !mode) {
      issues.push(`预装清单条目字段缺失（slug/css/name/mode 必填）→ 跳过：${JSON.stringify(t)}`);
      continue;
    }
    if (seen.has(slug)) {
      issues.push(`预装清单 slug 重复：${slug} → 只取先出现者`);
      continue;
    }
    seen.add(slug);
    entries.push({
      slug,
      css,
      dir: typeof t.dir === "string" ? normalizeRelPath(t.dir) : undefined,
      name,
      mode,
      hiddenByDefault: t.hiddenByDefault === true,
    });
  }
  return { entries, issues };
}

/**
 * §10 N15 清单驱动识别：把主题目录里的**相对路径**映射回 slug。
 * 归一化（统一分隔符、剥前导 `./`、大小写不敏感）后与清单的 `css` / `dir` 精确比对——
 * 因此清单 `vue` + 文件 `Vue.css` / `vue-1.2.css` **不会**被误判为 `user:*`
 * （后者本就不匹配：不做前缀/模糊匹配，避免把用户的 `vue-1.2.css` 认成预装）。
 */
export function matchBundledSlug(
  relPath: string,
  entries: readonly BundledManifestEntry[],
): string | undefined {
  const needle = normalizeRelPath(relPath).toLowerCase();
  for (const e of entries) {
    if (normalizeRelPath(e.css).toLowerCase() === needle) return e.slug;
    if (e.dir && normalizeRelPath(e.dir).toLowerCase() === needle) return e.slug;
  }
  return undefined;
}

/** 运行时副本现状（IO 层读盘后给出） */
export interface BundledRuntimeState {
  /** 相对 `themes/` 的 css 相对路径（清单条目的实际落点） */
  css: string;
  /** 规范化文本 hash（与 `themeCssHash` 同一口径）；读取失败为 undefined */
  hash?: string;
}

export interface BundledSyncPlan {
  /** 需要从源副本复制（覆盖）的条目 */
  copy: BundledManifestEntry[];
  /** 需要复制的原因（逐条登记，不允许静默） */
  reasons: Record<string, string>;
}

/**
 * §10 N13/N15 幂等补齐：**按源副本覆盖**预装主题的运行时副本。
 *
 * 判据 = 「清单条目的落点缺失」或「源副本 hash ≠ 运行时副本 hash」→ 复制（幂等）；
 * 二者相同则不动（避免每次启动都写盘）。用户改动只落 `user:*`，因此这里覆盖不伤用户数据。
 */
export function planBundledSync(
  manifest: readonly BundledManifestEntry[],
  sourceHashes: ReadonlyMap<string, string>,
  runtime: readonly BundledRuntimeState[],
): BundledSyncPlan {
  const runtimeByCss = new Map(runtime.map((r) => [normalizeRelPath(r.css).toLowerCase(), r]));
  const copy: BundledManifestEntry[] = [];
  const reasons: Record<string, string> = {};
  for (const e of manifest) {
    const key = normalizeRelPath(e.css).toLowerCase();
    const live = runtimeByCss.get(key);
    const srcHash = sourceHashes.get(key);
    if (!live) {
      copy.push(e);
      reasons[e.slug] = "运行时副本缺失 → 从源副本补齐（N15）";
      continue;
    }
    if (srcHash && live.hash !== srcHash) {
      copy.push(e);
      reasons[e.slug] = `运行时副本与源副本不一致（${live.hash ?? "读取失败"} ≠ ${srcHash}）→ 按源副本覆盖（N13 升级语义）`;
    }
  }
  return { copy, reasons };
}

/** 预装主题的 themeId（清单驱动，§2 新-2 / N15） */
export function bundledThemeId(slug: string): string {
  return buildThemeId("bundled", slug);
}

/** 用户主题的 themeId（导入/扫描路径用） */
export function userThemeId(slug: string): string {
  return buildThemeId("user", slug);
}

/** 主题文件名的 slug（供 IO 层落盘命名；与 `userThemeFromFileName` 同口径） */
export function slugOfThemeFile(fileName: string): string {
  return normalizeThemeSlug(stripExtension(fileName));
}

export type { ThemeSource };

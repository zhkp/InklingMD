/**
 * #306 §5 + C6（G11 首落地）：主题文件元数据解析。
 *
 * G11（与 #223 同批冻结）规定了必须定义的内容，本模块是其**第一处落地实现**，
 * 全部口径按 G11 的五条要求逐条实现并在注释里标出对应条款：
 *   ① 归一化算法（大小写 / 空格 / `#` / emoji / 中文 / 超长 / 保留字）
 *   ② `themeId` 生成（`builtin:*` / `bundled:*` / `user:*`）
 *   ③ `-dark` 配对与 `variantOf`（含 `-dark-dark` / `.scss` / 大小写边界）
 *   ④ `mode` 判定优先级（文件名后缀 > 主题内声明 > 启发式；允许用户覆盖）
 *   ⑤ 目录扫描范围（**不递归**）与同名大小写冲突判定
 */
import { hashThemeCss } from "./normalize";

export type ThemeMode = "light" | "dark";
export type ThemeSource = "user" | "bundled";

export interface ThemeCandidate {
  /** 文件名（含扩展名） */
  fileName: string;
  /** 同目录**顶层**的其它文件名（含本文件） */
  siblings: string[];
  /** 同目录下的子目录名（同名资源目录识别） */
  dirNames?: string[];
  /** 来源（决定 themeId 前缀）：`user:*` / `bundled:*` */
  source: ThemeSource;
  /** 清单给的 slug（`bundled:*` 走清单驱动识别，N15-3：清单与文件不同名也不得误判） */
  manifestSlug?: string;
  /** 主题内显式声明的 mode（清单字段或文件内 `inkling-mode: dark` 标记） */
  declaredMode?: ThemeMode;
  /** 主题文件内容（启发式 mode 判定用；调用方可只给前 2KB） */
  content?: string;
}

export interface ThemeDescriptor {
  themeId: string;
  slug: string;
  /** 展示名（去扩展名、保留原始大小写与语言） */
  name: string;
  fileName: string;
  mode: ThemeMode;
  /** mode 的判定来源（登记用：文件名 / 声明 / 启发式） */
  modeSource: "filename" | "declared" | "heuristic";
  /** 成对变体互指（`vue.css` ↔ `vue-dark.css`） */
  variantOf?: string;
  /** 同名资源目录（字体/图片） */
  resourceDir?: string;
  /** 边界登记（解析期发现的问题，逐条写入兼容性矩阵） */
  issues: string[];
}

export const THEME_EXTENSION = ".css";
const MODE_SUFFIX = /-(dark|light)$/i;
/** ② themeId 生成：`<source>:<slug>`（不依赖路径，仅依赖归一化文件名 + 来源前缀） */
export function buildThemeId(source: ThemeSource, slug: string): string {
  return `${source}:${slug}`;
}

/**
 * ① 归一化算法（G11-1）：
 * - 去首尾空白 → 小写（Windows/macOS 文件名大小写不敏感，必须归一到同一 id）；
 * - 空白 / 下划线 / 路径分隔符 / `#` / `:` / 其它标点 → `-`，连续 `-` 折叠；
 * - **保留中文与字母数字**（CJK 主题名可用），**emoji 与其它符号剔除**（会破坏 key/选择器）；
 * - 超长截断（> 64 → 48 + `-<hash8>`），避免 key/路径过长；
 * - 归一化后为空（例如名字全是 emoji）→ 回落到 `theme-<hash8>`。
 */
export function normalizeThemeSlug(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  const replaced = trimmed
    .replace(/[\s_#:./\\*?"<>|+@!$%^&()[\]{},;'`~=]+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (replaced === "") return `theme-${hashThemeCss(raw).slice(0, 8)}`;
  if (replaced.length > 64) {
    return `${replaced.slice(0, 48)}-${hashThemeCss(replaced).slice(0, 8)}`;
  }
  return replaced;
}

/** G11-5：只识别 `.css`；`.scss` 等不予识别（登记，不静默）。 */
export function isThemeFile(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(THEME_EXTENSION);
}

/** 文件名去扩展名（保留大小写）。 */
export function stripExtension(fileName: string): string {
  return fileName.slice(0, fileName.length - THEME_EXTENSION.length);
}

/** ④ 主题内声明的 mode 标记（`/* inkling-mode: dark *​/`，大小写不敏感）。 */
export function detectDeclaredMode(content: string): ThemeMode | undefined {
  const m = /inkling-mode\s*:\s*(light|dark)/i.exec(content.slice(0, 2048));
  return m ? (m[1].toLowerCase() as ThemeMode) : undefined;
}

/** ④ 启发式（仅在无文件名后缀、无声明时使用）：暗色媒体查询 / color-scheme。 */
export function detectHeuristicMode(content: string): ThemeMode {
  if (/prefers-color-scheme\s*:\s*dark/i.test(content)) return "dark";
  if (/color-scheme\s*:\s*dark/i.test(content)) return "dark";
  return "light";
}

/** 在 siblings 里按「文件名（不含扩展名）」做大小写不敏感查找（G11-3/5 的 Windows 语义）。 */
function findSibling(siblings: string[], baseName: string): string | undefined {
  const target = baseName.toLowerCase();
  return siblings.find((f) => isThemeFile(f) && stripExtension(f).toLowerCase() === target);
}

/** 解析单个候选主题文件 → 描述符（③ 配对在 `pairVariants` 中互补）。 */
export function parseThemeCandidate(c: ThemeCandidate): ThemeDescriptor {
  const issues: string[] = [];
  if (!isThemeFile(c.fileName)) {
    issues.push(`非 .css 主题文件（${c.fileName}）不予识别（G11-5）`);
  }
  const rawBase = isThemeFile(c.fileName) ? stripExtension(c.fileName) : c.fileName;
  const suffix = MODE_SUFFIX.exec(rawBase);
  const hasSuffix = suffix !== null;
  const baseForPairing = hasSuffix ? rawBase.slice(0, rawBase.length - suffix[0].length) : rawBase;
  // ② themeId 用**完整**文件名（`vue` 与 `vue-dark` 是两个 themeId，靠 variantOf 互指）
  const slug = c.manifestSlug ? normalizeThemeSlug(c.manifestSlug) : normalizeThemeSlug(rawBase);

  // ④ mode 判定优先级：文件名后缀 > 主题内声明 > 启发式
  let mode: ThemeMode;
  let modeSource: ThemeDescriptor["modeSource"];
  if (hasSuffix) {
    mode = suffix![1].toLowerCase() as ThemeMode;
    modeSource = "filename";
  } else {
    const declared = c.declaredMode ?? (c.content ? detectDeclaredMode(c.content) : undefined);
    if (declared) {
      mode = declared;
      modeSource = "declared";
    } else {
      mode = c.content ? detectHeuristicMode(c.content) : "light";
      modeSource = "heuristic";
    }
  }

  // ③ `-dark-dark.css`：只剥一层后缀 → 配对目标是 `-dark` 那个名字（若存在）
  const pairFile = findSibling(c.siblings, baseForPairing);
  const issues2: string[] = [];
  if (hasSuffix && !pairFile) {
    issues2.push(
      `文件名带 ${suffix![0]} 后缀但其配对文件 ${baseForPairing}${THEME_EXTENSION} 不存在 → 作为独立主题（G11-3）`,
    );
  }
  if (/-dark-dark$/i.test(rawBase)) {
    issues2.push("`-dark-dark` 形态：只剥一层后缀（配对目标为 `<name>-dark`，G11-3）");
  }

  // ⑤ 同名资源目录（大小写不敏感；不递归扫描）。
  // 暗色变体优先用完整同名目录，其次回落到**配对基名**目录（Typora 常见：`vue-dark.css` + `vue/`）
  const dirs = c.dirNames ?? [];
  const resourceDir =
    dirs.find((d) => d.toLowerCase() === rawBase.toLowerCase()) ??
    dirs.find((d) => d.toLowerCase() === baseForPairing.toLowerCase());

  // 同名大小写冲突（同目录出现两个归一化后相同的 slug）
  const collide = c.siblings.filter(
    (f) => isThemeFile(f) && f !== c.fileName && normalizeThemeSlug(stripExtension(f)) === slug,
  );
  if (collide.length > 0) {
    issues2.push(`归一化名冲突：与 ${collide.join(", ")} 归一化后同为 ${slug}（取先出现者，其余登记）`);
  }

  return {
    themeId: buildThemeId(c.source, slug),
    slug,
    // 展示名保留完整文件名（`vue-dark`），配对关系看 variantOf
    name: rawBase,
    fileName: c.fileName,
    mode,
    modeSource,
    resourceDir,
    issues: [...issues, ...issues2],
  };
}

/**
 * ③ 成对变体互指：`vue.css` ↔ `vue-dark.css` 双向 `variantOf`。
 * 配对判据 = 「去掉一层 mode 后缀后名字相同」且**两个文件都在**（G11-3）。
 */
export function pairVariants(descriptors: ThemeDescriptor[]): ThemeDescriptor[] {
  const nameOf = (d: ThemeDescriptor) => d.fileName.replace(/\.css$/i, "").toLowerCase();
  for (const d of descriptors) {
    const suffix = MODE_SUFFIX.exec(d.name);
    // 带后缀（`vue-dark`）→ 找 `vue`；不带后缀（`vue`）→ 找 `vue-dark` / `vue-light`
    const targets = suffix
      ? [d.name.slice(0, d.name.length - suffix[0].length)]
      : [`${d.name}-dark`, `${d.name}-light`];
    const other = descriptors.find(
      (o) => o !== d && targets.some((t) => t.toLowerCase() === nameOf(o)),
    );
    if (other && other.slug !== d.slug) d.variantOf = other.themeId;
  }
  return descriptors;
}

export interface ScanResult {
  themes: ThemeDescriptor[];
  /** 目录级问题（非 .css 文件、扫描范围等） */
  issues: string[];
}

/**
 * ⑤ 目录扫描（**不递归**，G11-5）：只处理给定目录顶层文件；
 * 同目录下与主题**同名**的目录视为资源目录（不进入）。
 */
export function scanThemesInDirectory(
  fileNames: string[],
  dirNames: string[],
  source: ThemeSource,
  contentByName?: ReadonlyMap<string, string>,
): ScanResult {
  const issues: string[] = [];
  const cssFiles = fileNames.filter(isThemeFile);
  const skipped = fileNames.filter((f) => !isThemeFile(f) && /\.(scss|less|sass)$/i.test(f));
  for (const f of skipped) {
    issues.push(`跳过非 .css 样式文件 ${f}（G11-5：只识别 .css 主题）`);
  }
  const parsedDescriptors = cssFiles.map((fileName) =>
    parseThemeCandidate({
      fileName,
      siblings: fileNames,
      dirNames,
      source,
      content: contentByName?.get(fileName),
    }),
  );
  // 归一化名冲突（大小写等）：**取先出现者，其余登记**——下游（主题列表 / 选中态 / 快照 key）
  // 不允许出现重复 themeId（G11「取先出现者」口径的落实，评审阻塞 4）。
  const descriptors: ThemeDescriptor[] = [];
  const byThemeId = new Map<string, ThemeDescriptor>();
  for (const d of parsedDescriptors) {
    const prior = byThemeId.get(d.themeId);
    if (prior) {
      issues.push(
        `主题 ID 冲突：${d.fileName} 与 ${prior.fileName} 归一化后同为 ${d.themeId} → 取先出现者 ${prior.fileName}，${d.fileName} 不登记（G11）`,
      );
      continue;
    }
    byThemeId.set(d.themeId, d);
    descriptors.push(d);
  }
  return { themes: pairVariants(descriptors), issues };
}

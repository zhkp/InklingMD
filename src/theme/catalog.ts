/**
 * #307 §2 / §10 N13·N15：主题目录的**清单编排**（扫描 → 清单驱动识别 → 幂等补齐计划）。
 *
 * 本模块是「纯编排」：所有 IO（扫描目录 / 读文件 / 拼路径）由调用方注入——
 * 生产用 `src/lib/themeFiles.ts`，单测注入内存桩。它把 #225 的 `registry`/`snapshot` 契约
 * 与 #306 的 `metadata` 归一化能力串起来，**不自己发明第二套 id / 归一化规则**。
 *
 * 关键口径：
 * - **N15 清单驱动识别**：先按 `$RESOURCE/themes/manifest.json` 的相对路径匹配 → `bundled:<slug>`，
 *   未命中才 `user:`（文件名与清单不一致时**不得**误判为用户主题）；
 * - **N13 幂等补齐**：源副本与运行时副本 hash 不一致或运行时缺失 → 计划复制（用户改动只落 `user:*`）；
 * - 主题 CSS 的 hash = `themeCssHash`（规范化文本），与切换期快照 key **同口径**（G9）。
 */
import {
  isThemeFile,
  pairVariants,
  parseThemeCandidate,
  type ThemeDescriptor,
} from "./typora/metadata";
import { themeCssHash } from "./typora/rewrite";
import { fromTyporaDescriptors, type AppTheme } from "./registry";
import {
  matchBundledSlug,
  parseBundledManifest,
  planBundledSync,
  type BundledManifestEntry,
} from "./import";
import type { ThemesIndexEntry } from "./snapshot";

export interface CatalogScanEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface CatalogIo {
  themesRoot: string;
  bundledRoot: string;
  scanDir: (dir: string) => Promise<{ entries: CatalogScanEntry[]; skipped: string[] }>;
  readFile: (absPath: string) => Promise<string>;
  /** 路径拼接（Windows 为 `\`，POSIX 为 `/`） */
  join: (dir: string, rel: string) => string;
  /** 预装清单原文（缺失/损坏时传 undefined） */
  manifestRaw: unknown;
}

/** N13 幂等补齐的一项（需调用方执行后再重建一次清单） */
export interface CopyPlanItem {
  slug: string;
  from: string;
  to: string;
  reason: string;
}

export interface CatalogResult {
  /** 可注册的主题（`bundled:*` / `user:*`；不含内置基线） */
  themes: AppTheme[];
  /** 落盘清单（`inkling-themes-index`） */
  index: ThemesIndexEntry[];
  /** 目录级/单主题级问题（统一走可见提示，不静默） */
  issues: string[];
  copyPlan: CopyPlanItem[];
  manifest: BundledManifestEntry[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function buildThemeCatalog(io: CatalogIo): Promise<CatalogResult> {
  const issues: string[] = [];
  const scan = await io.scanDir(io.themesRoot);
  issues.push(...scan.skipped);

  // 无预装清单（尚无预装主题 / 索引未落地）是**正常状态**：不登记 issue；仅有内容但非法时才登记
  const manifest =
    io.manifestRaw === undefined
      ? { entries: [] as BundledManifestEntry[], issues: [] as string[] }
      : parseBundledManifest(io.manifestRaw);
  issues.push(...manifest.issues);

  const fileEntries = scan.entries.filter((e) => !e.is_dir);
  const dirNames = scan.entries.filter((e) => e.is_dir).map((e) => e.name);
  const fileNames = fileEntries.map((e) => e.name);
  const cssEntries = fileEntries.filter((e) => isThemeFile(e.name));
  const pathByName = new Map(fileEntries.map((e) => [e.name, e.path]));

  // 读取主题 CSS（明暗判定需要 declared mode；hash 需要内容）
  const contentByName = new Map<string, string>();
  for (const entry of cssEntries) {
    try {
      contentByName.set(entry.name, await io.readFile(entry.path));
    } catch (error) {
      issues.push(`读取主题文件失败：${entry.name}（${messageOf(error)}）→ 本次未登记该主题`);
    }
  }

  // N15：清单驱动识别 + G11 归一化（复用 #306 的唯一实现）
  const descriptors: ThemeDescriptor[] = [];
  const byThemeId = new Map<string, ThemeDescriptor>();
  for (const entry of cssEntries) {
    if (!contentByName.has(entry.name)) continue;
    const manifestSlug = matchBundledSlug(entry.name, manifest.entries);
    const descriptor = parseThemeCandidate({
      fileName: entry.name,
      siblings: fileNames,
      dirNames,
      source: manifestSlug ? "bundled" : "user",
      manifestSlug,
      content: contentByName.get(entry.name),
    });
    issues.push(...descriptor.issues.map((i) => `${entry.name}: ${i}`));
    const prior = byThemeId.get(descriptor.themeId);
    if (prior) {
      issues.push(
        `主题 ID 冲突：${descriptor.fileName} 与 ${prior.fileName} 归一化后同为 ${descriptor.themeId} → 取先出现者（G11）`,
      );
      continue;
    }
    byThemeId.set(descriptor.themeId, descriptor);
    descriptors.push(descriptor);
  }

  const paired = pairVariants(descriptors);
  const hashByFile = new Map<string, string>();
  for (const [name, content] of contentByName) hashByFile.set(name, themeCssHash(content));
  const hashByFileLower = new Map([...hashByFile].map(([name, hash]) => [name.toLowerCase(), hash]));

  const themes = fromTyporaDescriptors(
    paired,
    (d) => hashByFile.get(d.fileName),
    (d) => {
      const path = pathByName.get(d.fileName);
      return path ? { kind: "file", path } : undefined;
    },
  );
  const fileByThemeId = new Map(paired.map((d) => [d.themeId, d.fileName]));
  const index: ThemesIndexEntry[] = themes.map((t) => ({
    id: t.id,
    name: t.name,
    mode: t.mode,
    hash: t.hash,
    variantOf: t.variantOf,
    source: t.source === "bundled" ? "bundled" : "user",
    file: fileByThemeId.get(t.id),
  }));

  // N13：源副本 hash（用于判断运行时副本是否需要按源覆盖）
  const sourceHashes = new Map<string, string>();
  for (const entry of manifest.entries) {
    try {
      const css = await io.readFile(io.join(io.bundledRoot, entry.css));
      sourceHashes.set(entry.css.toLowerCase(), themeCssHash(css));
    } catch (error) {
      issues.push(
        `预装源副本缺失或不可读：${entry.css}（清单 slug=${entry.slug}，${messageOf(error)}）→ 本次不补齐该主题`,
      );
    }
  }
  // 只把**实际读到的**运行时副本计入：读不到 = 运行时缺失（→ 补齐），
  // 与「读到了但与源不一致」（→ 按源覆盖）是两条不同原因，提示语不同（不静默、可区分）
  const runtime = manifest.entries
    .map((entry) => {
      const base = entry.css.split("/").pop() ?? entry.css;
      return { css: entry.css, hash: hashByFileLower.get(base.toLowerCase()) };
    })
    .filter((r) => r.hash !== undefined);
  const sync = planBundledSync(manifest.entries, sourceHashes, runtime);
  const copyPlan: CopyPlanItem[] = [];
  for (const entry of sync.copy) {
    const reason = sync.reasons[entry.slug] ?? "预装主题补齐";
    copyPlan.push({
      slug: entry.slug,
      from: io.join(io.bundledRoot, entry.css),
      to: io.join(io.themesRoot, entry.css),
      reason,
    });
    if (entry.dir) {
      copyPlan.push({
        slug: entry.slug,
        from: io.join(io.bundledRoot, entry.dir),
        to: io.join(io.themesRoot, entry.dir),
        reason: `${reason}（含同名资源目录）`,
      });
    }
  }

  return { themes, index, issues, copyPlan, manifest: manifest.entries };
}

/** 清单是否需要重写（避免多窗口 storage 事件风暴：内容相同就不写） */
export function indexChanged(
  next: readonly ThemesIndexEntry[],
  prev: readonly ThemesIndexEntry[],
): boolean {
  if (next.length !== prev.length) return true;
  const key = (t: ThemesIndexEntry) =>
    [t.id, t.name, t.mode, t.hash ?? "", t.variantOf ?? "", t.source ?? "", t.file ?? ""].join("|");
  const a = next.map(key).join("\n");
  const b = prev.map(key).join("\n");
  return a !== b;
}

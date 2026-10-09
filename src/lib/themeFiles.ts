/**
 * #307 主题目录的 IO 封装（桌面端走 Rust 命令；浏览器端走 `mockThemes`，供 E2E 跑通真实链路）。
 *
 * 目录规范（§2，对标 Typora）：
 *   Windows  `%APPDATA%/inklingmd/themes/`
 *   macOS    `~/Library/Application Support/inklingmd/themes/`
 *   Linux    `~/.config/inklingmd/themes/`
 * 约定「一个主题 = 一个 `<name>.css` + 同名可选资源目录 `<name>/`」；备份目录为隐藏项 `.backup/`
 * （扫描会跳过，见 Rust `scan_theme_dir`）。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { appDataDir } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { createDir, dirNameOf, joinPath, normalizePath, readTextFile } from "./fs";

export const THEMES_DIR_NAME = "themes";
/** 备份目录（隐藏项 → 不进入扫描结果；§4「旧文件移入备份目录，可恢复」） */
export const THEMES_BACKUP_DIR = ".backup";
/** 预装清单文件名（§2 新-2：`$RESOURCE/themes/manifest.json`） */
export const BUNDLED_MANIFEST_FILE = "manifest.json";

export interface ThemeDirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

export interface ThemeDirScan {
  entries: ThemeDirEntry[];
  /** 被跳过的项（符号链接等）——必须显式登记，不允许静默 */
  skipped: string[];
}

export interface CopyReport {
  files: number;
  bytes: number;
  skipped: string[];
}

export interface ExtractReport {
  /** 解压出的包内相对路径（posix 分隔符） */
  entries: string[];
  files: number;
  bytes: number;
  skipped: string[];
}

/** 主题目录（应用数据目录下的 `themes/`） */
export async function themesRoot(): Promise<string> {
  if (isTauri()) {
    return normalizePath(joinPath(await appDataDir(), THEMES_DIR_NAME));
  }
  const { mockThemesRoot } = await import("./mockThemes");
  return mockThemesRoot();
}

/** 预装主题源副本目录（`$RESOURCE/themes`；含只读 `manifest.json`） */
export async function bundledThemesRoot(): Promise<string> {
  if (isTauri()) {
    return normalizePath(await invoke<string>("resource_themes_dir"));
  }
  const { mockBundledThemesRoot } = await import("./mockThemes");
  return mockBundledThemesRoot();
}

/** 幂等建目录（已存在不报错；首次启动自动创建，§10） */
export async function ensureDir(dir: string): Promise<void> {
  if (isTauri()) {
    try {
      await createDir(dir);
    } catch {
      // 已存在（`create_dir` 对已存在目录报错）——幂等语义，忽略
    }
    return;
  }
  const { mockEnsureDir } = await import("./mockThemes");
  mockEnsureDir();
}

/** 扫描主题目录单层（文件 + 目录；跳过隐藏项与符号链接） */
export async function scanThemesDir(dir?: string): Promise<ThemeDirScan> {
  const target = dir ?? (await themesRoot());
  if (isTauri()) {
    return invoke<ThemeDirScan>("scan_theme_dir", { dirPath: target });
  }
  const { mockScan } = await import("./mockThemes");
  return mockScan(target);
}

/** 递归复制（导入路径①的 `.css` 与路径②的文件夹；符号链接不跟随，跳过项由调用方提示） */
export async function copyThemePath(from: string, to: string): Promise<CopyReport> {
  if (isTauri()) {
    return invoke<CopyReport>("copy_path", { from, to });
  }
  const { mockCopy } = await import("./mockThemes");
  return mockCopy(from, to);
}

/** 解压主题压缩包（zip slip 防护在 Rust 侧；任一条目越界 → 整包拒绝） */
export async function extractThemeZip(zipPath: string, destDir: string): Promise<ExtractReport> {
  if (isTauri()) {
    return invoke<ExtractReport>("extract_zip", { zipPath, destDir });
  }
  const { mockExtractZip } = await import("./mockThemes");
  return mockExtractZip(zipPath, destDir);
}

/** 读取主题 CSS（导入/扫描/切换共用；`readTextFile` 已在 #220 处理编码错误映射） */
export async function readThemeFile(absPath: string): Promise<string> {
  if (isTauri()) {
    return readTextFile(absPath);
  }
  const { mockReadText } = await import("./mockThemes");
  return mockReadText(absPath);
}

/** 读取预装清单原文（缺失/不可读 → `undefined`，由 `parseBundledManifest` 判定为「无预装主题」） */
export async function readBundledManifest(root?: string): Promise<unknown> {
  const dir = root ?? (await bundledThemesRoot());
  const file = normalizePath(joinPath(dir, BUNDLED_MANIFEST_FILE));
  try {
    const text = await readThemeFile(file);
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 把主题目录里的一项（`.css` 或资源目录）移入 `.backup/<stamp>/`（§4「覆盖」的可恢复语义）。
 * 返回备份后的路径。
 */
export async function moveToBackup(themesRootPath: string, name: string, stamp: string): Promise<string> {
  const backupDir = normalizePath(joinPath(joinPath(themesRootPath, THEMES_BACKUP_DIR), stamp));
  const from = normalizePath(joinPath(themesRootPath, name));
  await ensureDir(themesRootPath);
  if (isTauri()) {
    // 备份父目录必须先存在（`rename_path` 不建父目录）
    try {
      await createDir(normalizePath(joinPath(themesRootPath, THEMES_BACKUP_DIR)));
    } catch {
      // 已存在
    }
    await createDir(backupDir);
    const to = normalizePath(joinPath(backupDir, name));
    await invoke<void>("rename_path", { from, to });
    return to;
  }
  const { mockCopy, mockDelete } = await import("./mockThemes");
  mockCopy(from, normalizePath(joinPath(backupDir, name)));
  mockDelete(from);
  return normalizePath(joinPath(backupDir, name));
}

/** 彻底删除主题目录里的一项（用户主题「移除」；预装主题只写隐藏位，不物理删除，N15） */
export async function deleteThemeEntry(themesRootPath: string, name: string): Promise<void> {
  const target = normalizePath(joinPath(themesRootPath, name));
  if (isTauri()) {
    await invoke<void>("delete_path", { path: target });
    return;
  }
  const { mockDelete } = await import("./mockThemes");
  mockDelete(target);
}

/** 在系统文件管理器中定位（「打开主题文件夹」入口，§2） */
export async function revealPath(absPath: string): Promise<void> {
  if (isTauri()) {
    await revealItemInDir(absPath);
    return;
  }
  // 浏览器（E2E）：无系统文件管理器 → 静默降级；调用方负责给出可见提示
  await Promise.resolve();
}

/** 上一层目录（主题目录创建失败时「打开上级目录」的降级入口，§10） */
export function parentDirOf(absPath: string): string {
  return dirNameOf(normalizePath(absPath));
}

export { readTextFile };

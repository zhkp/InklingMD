/**
 * 应用数据根目录（#404）。
 *
 * 便携模式（exe 同级 `portable.txt`）下 Rust 侧把它解析成 exe 同级 `data/`，安装版
 * 仍是 Roaming `app_data_dir()`。前端的 `themes/`、`recovery/` 一律从这里拼路径：
 *
 * - 与 Rust 的 `write_recovery_file` 路径守卫同源——继续用 `@tauri-apps/api/path`
 *   的 `appDataDir()` 会在便携模式下算出「恢复区之外」的路径，草稿与会话标记直接写不进去；
 * - 单一取值点，避免 themes 与 recovery 各自解析出不同的根。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

/** 便携模式首启迁移结果（与 Rust `app_paths::PortableMigration` 一一对应） */
export interface PortableMigration {
  /** 旧数据根（安装版使用的 `app_data_dir()`） */
  from: string;
  /** 便携数据根（exe 同级 `data/`） */
  to: string;
  copied: string[];
  failed: string[];
  skipped: string[];
  /** 不属于迁移、但同样需要用户知道的启动问题（asset scope 放行失败等） */
  warnings: string[];
}

/**
 * 应用数据根（Rust 侧解析，两条分支都保证目录已存在）。
 *
 * **只在桌面端调用**：其余调用方都先判 `isTauri()`（浏览器预览没有 Tauri IPC）。
 */
export async function appDataRoot(): Promise<string> {
  return invoke<string>("app_data_root");
}

/**
 * 取走本次启动的便携迁移结果（没有则 null；一次性，取走即清空）。
 *
 * Rust 在 setup 里完成复制，前端只负责把结果告诉用户：「明确迁移」不能只体现在
 * 代码里，否则用户换机后只会发现「主题怎么换了」。
 */
export async function takePortableMigration(): Promise<PortableMigration | null> {
  if (!isTauri()) return null;
  return invoke<PortableMigration | null>("take_portable_migration");
}

/**
 * 迁移提示的文案与语气。
 *
 * 首句必须跟着结果走：`copied` 为空时还写「已复制」，就是把失败伪装成成功——
 * 用户通常只读弹窗的第一句。
 */
export function portableMigrationMessage(migration: PortableMigration): {
  text: string;
  kind: "info" | "warning" | "error";
} {
  const copied = migration.copied ?? [];
  const skipped = migration.skipped ?? [];
  const failed = migration.failed ?? [];
  const warnings = migration.warnings ?? [];

  let headline: string;
  let kind: "info" | "warning" | "error";
  if (failed.length > 0) {
    headline = copied.length > 0 ? "便携模式数据迁移部分失败。" : "便携模式数据迁移未完成。";
    kind = "error";
  } else if (skipped.length > 0 || warnings.length > 0) {
    headline =
      copied.length > 0
        ? "便携模式数据迁移完成，但有部分数据没有带过来。"
        : "便携模式：便携目录已有数据，本次未复制。";
    kind = "warning";
  } else {
    headline = "便携模式：已把系统目录的应用数据复制到便携目录。";
    kind = "info";
  }

  const lines = [headline, `来源：${migration.from}`, `目标：${migration.to}`];
  if (copied.length > 0) lines.push(`已复制：${copied.join("、")}`);
  if (skipped.length > 0) {
    lines.push("", "以下条目未复制（源文件仍在原处）：", ...skipped.map((s) => `· ${s}`));
  }
  if (failed.length > 0) {
    lines.push("", "以下条目复制失败，便携目录里没有它们：", ...failed.map((f) => `· ${f}`));
  }
  if (warnings.length > 0) {
    lines.push("", "另外发现以下问题：", ...warnings.map((w) => `· ${w}`));
  }
  if (copied.length > 0) lines.push("", "原位置的文件保留未删除，可自行清理。");
  return { text: lines.join("\n"), kind };
}

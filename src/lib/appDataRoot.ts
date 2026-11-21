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
}

/** 应用数据根（Rust 侧解析，目录已保证存在） */
export async function appDataRoot(): Promise<string> {
  return invoke<string>("app_data_root");
}

/**
 * 取走本次启动的便携迁移结果（没有则 null）。
 *
 * Rust 在 setup 里完成复制，前端只负责把结果告诉用户：「明确迁移」不能只体现在
 * 代码里，否则用户换机后只会发现「主题怎么换了」。
 */
export async function takePortableMigration(): Promise<PortableMigration | null> {
  if (!isTauri()) return null;
  return invoke<PortableMigration | null>("take_portable_migration");
}

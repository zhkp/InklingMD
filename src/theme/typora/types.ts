/**
 * #306 Typora 兼容层：类型契约。
 *
 * 层序与作用域契约（来自 #221 冻结契约，本文件只引用不另立）：
 * - G6-I1：映射输出的选择器前缀形态**恒为 2 段** `.editor-scroll .milkdown`；
 * - G8：主题对「基础变量 + `--shell-*`」的赋值被拒绝，主题私有变量原样保留 + 作用域收敛；
 * - G12：仅 `theme` 层剥离 `!important`；
 * - G7-b / §C9：资源 `url()` 重写为 `convertFileSrc()` 绝对 URL；
 * - G6-I3 / §C10：全局名称（keyframes / @font-face family / @counter-style）前缀化 + 引用重写；
 * - N11-1 / N12：流水线第 0 步剥 BOM + 剥 `@charset`，hash 基于规范化文本。
 */

/** 诊断种类：兼容性矩阵的登记来源，同时是单测的断言载体。 */
export type ThemeDiagnosticKind =
  | "normalize-bom"
  | "normalize-charset"
  | "normalize-eol"
  | "parse-error"
  | "dropped-selector"
  | "dropped-at-rule"
  | "scoped-root"
  | "rejected-token"
  | "private-token-scoped"
  | "prefixed-name"
  | "rewritten-ref"
  | "stripped-important"
  | "inlined-import"
  | "dropped-import"
  | "rewritten-url"
  | "dropped-url";

export interface ThemeDiagnostic {
  kind: ThemeDiagnosticKind;
  /** 被处理的对象（选择器 / token 名 / at-rule 名 / url 等），便于矩阵逐条登记 */
  target: string;
  /** 人话原因（写入矩阵「备注」列） */
  reason: string;
  /** 原始位置（postcss 提供；规范化后仍然有效） */
  line?: number;
  column?: number;
}

export interface TokenWhitelist {
  /** `--shell-*` 等外壳层名（拒绝） */
  shell: readonly string[];
  /** 基础变量（拒绝）：App.css 现有 47 名里属基础层的部分 */
  base: readonly string[];
  /** `--content-*` / `--code-block-*`（允许覆盖） */
  content: readonly string[];
  /** 前缀形态的白名单（白名单 JSON 里的 `shellPrefixes` / `contentPrefixes`） */
  shellPrefixes?: readonly string[];
  contentPrefixes?: readonly string[];
}

/** 路径工具：浏览器侧没有 `node:path`，由本模块内置实现（跨平台分隔符）。 */
export interface ThemePathApi {
  /** 以 baseDir 为基准解析 target（相对 / `../` / 绝对均可），返回归一化后的绝对路径 */
  resolve: (baseDir: string, target: string) => string;
  dirname: (absPath: string) => string;
}

export interface ThemeRewriteContext {
  /** G11 归一化后的 themeId；用作全局名称前缀种子（短哈希，无需碰撞检测） */
  themeId: string;
  /** 主题文件所在目录（绝对路径）—— `url()` 相对路径按**主题目录**解析（§C9 边界） */
  themeDir: string;
  /** 绝对路径 → 可加载 URL。生产注入 `convertFileSrc`；单测注入期望值桩（纯函数不碰 DOM） */
  toAssetUrl: (absPath: string) => string;
  /**
   * 已预读的 `@import` 目标表（归一化绝对路径 → 原文）。
   * `rewrite` 是**同步纯函数**（接口冻结），故文件读取由调用方预读后注入；
   * 表内缺失即视为「读取失败 / 远程 / 越界」→ 丢弃该 `@import` 并登记（P1-6）。
   */
  importSources?: ReadonlyMap<string, string>;
  /** `@import` 递归深度上限（P1-6；默认 8） */
  maxImportDepth?: number;
  /**
   * 资源 URL 允许的根（§C9）：默认 = `themeDir`（保守）。
   * 调用方（#307/#225）应传 **assetProtocol.scope 的实际根**（如 `$APPDATA`），
   * 这样 `../` 指向同包内的资源仍可加载；越出该根即按 §C9 降级为不加载并登记。
   */
  assetRoot?: string;
  /** 应用 token 白名单；缺省时由 rewrite.ts 使用内置 whitelist-instance */
  whitelist?: TokenWhitelist;
  /** 诊断回调（矩阵登记 / 断言） */
  onDiagnostic?: (d: ThemeDiagnostic) => void;
  /** 可注入的路径工具（默认用内置实现） */
  path?: ThemePathApi;
}

/** 便捷收集器：`rewrite` 保持 `(css, ctx) => string` 的冻结签名，诊断经回调收集。 */
export function collectDiagnostics(): {
  diagnostics: ThemeDiagnostic[];
  onDiagnostic: (d: ThemeDiagnostic) => void;
} {
  const diagnostics: ThemeDiagnostic[] = [];
  return { diagnostics, onDiagnostic: (d) => diagnostics.push(d) };
}

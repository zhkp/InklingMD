// 全局崩溃兜底的错误分类（issue #171）
//
// 背景：main.tsx 对任意 window error / unhandledrejection 都直接替换成
// 永久崩溃页。但其中相当一部分是良性噪音或可恢复错误：
// - ResizeObserver「loop completed / limit exceeded」是 Chromium/WebView2
//   的已知良性噪音（本项目 WorkspaceFileTree、SourceModeEditor 使用
//   ResizeObserver），会反复触发 window error 事件——每次都整页崩溃显然错误
// - 空 message（如跨域 "Script error."）没有任何可诊断信息，崩溃页无用
// - 未捕获 rejection 通常只是异步链断裂，应用可继续运行
//
// 本模块把分类抽成纯函数，供 main.tsx 兜底策略与单测使用。

const BENIGN_PATTERNS: RegExp[] = [
  // ResizeObserver 通知循环（loop completed / limit exceeded）
  /ResizeObserver loop/i,
  // 跨域脚本错误：浏览器只上报 "Script error."，无可诊断信息
  /^script error\.?$/i,
];

/** 是否为已知良性/无诊断价值的全局错误（命中则不触发崩溃页） */
export function isBenignGlobalError(message: string): boolean {
  const text = (message ?? "").trim();
  if (!text) return true; // 空 message：无信息可用，视为噪音
  return BENIGN_PATTERNS.some((re) => re.test(text));
}

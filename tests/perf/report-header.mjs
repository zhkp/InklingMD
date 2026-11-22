// 报告头部的「运行时」描述（#421 评审 4 抽成纯函数，便于单测）
//
// 这份描述决定读者怎么理解整份报告：prod 通道跑的是 `vite build` 产物 +
// `vite preview`，写「dev server、绝对值不代表生产构建」会与通道目的相反。

export const DEV_RUNTIME_LINE =
  "> 运行时：Playwright chromium + vite dev server（未压缩、含 HMR）。**绝对值不代表生产构建**，仅用于同环境纵向对比。";

export const PROD_RUNTIME_LINE =
  "> 运行时：Playwright chromium + `vite build` **生产构建**产物（`vite preview` 静态服务，已压缩、无 HMR）。**绝对值反映生产代码**，但仍只用于同环境纵向对比。";

/** 环境名以 `prod-` 开头即生产构建口径（`prod-local` / `prod-ci-ubuntu` …） */
export function runtimeDescription(env) {
  return String(env ?? "").startsWith("prod-")
    ? PROD_RUNTIME_LINE
    : DEV_RUNTIME_LINE;
}

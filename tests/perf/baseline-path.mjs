// 基线文件路径（#420 抽出为纯函数，便于单测锁住「环境不能串味」）
//
// 路径 = **测量配置** 的函数：`<BASE_DIR>/<envPrefix><profile>/<mode>/r<rounds>/<id>.json`
//
// `envPrefix` 的规则见 envDirPrefix：**白名单**式——只有 `ci-ubuntu` / `ci-windows`
// 沿用无前缀的历史布局；`local` 走 `local/`，其余任何 env（`prod-*`、将来的
// `ci-macos` 等）都用自己的命名空间。首版反过来做（只给 `local` 加前缀）时，
// `prod-local` 被当成 CI 默认环境、把生产口径的数值直接写进 dev 的 CI 基线目录
// （实测覆盖过一次）。

import { resolve } from "node:path";
import { MODE_FALLBACK, ROUNDS_FALLBACK } from "./comparability.js";

/**
 * 基线目录的环境前缀。
 *
 * - `local`：本机 dev 口径，独立目录；
 * - `ci-ubuntu` / `ci-windows`：沿用历史布局（无前缀），否则现有基线全体失效；
 * - 其余（`prod-local` / `prod-ci-ubuntu` 等）：必须用自己的命名空间。
 */
export function envDirPrefix(env) {
  if (env === "local") return "local/";
  if (env === "ci-ubuntu" || env === "ci-windows") return "";
  return `${env}/`;
}

export function baselinePath(baseDir, env, profile, id, mode, rounds) {
  const envPrefix = envDirPrefix(env);
  const modeSegment = mode ?? MODE_FALLBACK;
  const roundsSegment = `r${rounds ?? ROUNDS_FALLBACK}`;
  return resolve(
    baseDir,
    `${envPrefix}${profile}/${modeSegment}/${roundsSegment}/${id}.json`,
  );
}

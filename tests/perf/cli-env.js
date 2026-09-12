// CLI 参数解析与"参数 → 子进程环境变量"的映射（benchmark.mjs 与单测共用）
//
// 为什么单独成模块：这里出过一个静默失败——`--scenario=xxx` 被解析了却没有任何消费点，
// 用户以为只跑 1 个场景，实际静默全量跑 16 个（实测 `Running 16 tests`）。
// 这类缺陷不会报错、不会警告，只能靠对"映射本身"的断言锁住，
// 因此把映射抽成纯函数，让单测直接断言线上实现。cli-env.d.ts 提供类型。

/** 支持的参数（未知参数一律报错，而不是静默忽略——静默忽略正是上面那个缺陷的成因） */
export const KNOWN_ARG_KEYS = ["profile", "port", "repeat", "scenario", "update-baseline"];

/**
 * 解析 `--key=value` / `--flag` 形式的参数。
 * - 裸 `--` 会被跳过：`pnpm run benchmark -- --update-baseline=1` 透传时会带上它
 *   （旧实现会把它解析成名为 "" 的参数）
 * - 值里允许出现 `=`（按第一个 `=` 切分，保留后续内容）
 */
export function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === "--") continue;
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const key = eq === -1 ? body : body.slice(0, eq);
    if (key === "") continue;
    out[key] = eq === -1 ? "1" : body.slice(eq + 1);
  }
  return out;
}

/** 返回无法识别的参数名（供调用方报错退出，避免"写了却没生效"） */
export function unknownArgKeys(args) {
  return Object.keys(args).filter((key) => !KNOWN_ARG_KEYS.includes(key));
}

/**
 * 组装传给 playwright 子进程的环境变量。
 *
 * `PERF_SCENARIO` 的消费点就在这里：playwright 子进程的 env 是
 * `{ ...process.env, ...buildRunEnv(...) }`，argv 形式只有映射进来才能生效。
 * 曾经漏掉这一项 → argv 形式静默全量跑；单测锁死它，防止消费点再次丢失。
 */
export function buildRunEnv({ profile, port, repeat, scenario }) {
  return {
    PERF_PROFILE: profile,
    PERF_PORT: port,
    ...(repeat ? { PERF_REPEAT: String(repeat) } : {}),
    ...(scenario ? { PERF_SCENARIO: scenario } : {}),
  };
}

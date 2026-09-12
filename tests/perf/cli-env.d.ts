// cli-env.js 的类型声明：让 tsc 与 vitest 能直接断言这份 .js 实现。

export const KNOWN_ARG_KEYS: string[];

/** 解析后的参数表（值为字符串，裸 flag 为 "1"） */
export type ParsedArgs = Record<string, string>;

export function parseArgs(argv: string[]): ParsedArgs;
export function unknownArgKeys(args: ParsedArgs): string[];

export interface RunEnvOptions {
  profile: string;
  port: string;
  /** 空字符串表示未指定，不写入环境变量 */
  repeat?: string;
  /** 空字符串表示未指定，不写入环境变量 */
  scenario?: string;
}

export function buildRunEnv(options: RunEnvOptions): Record<string, string>;

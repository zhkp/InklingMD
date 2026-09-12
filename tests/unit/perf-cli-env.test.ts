// CLI 参数解析与「参数 → 子进程环境变量」映射的测试
//
// 背景：`--scenario=xxx` 曾被解析却没有任何消费点（argv 形式不写入 PERF_SCENARIO），
// 用户执行 `pnpm run benchmark -- --scenario=scroll-M-rich` 实际静默全量跑 16 个场景
// （实测输出 `Running 16 tests`）。这类缺陷不报错、不警告，只能靠断言"映射本身"锁住。
//
// 这里断言的是线上实现（cli-env.js），并复刻 benchmark.mjs 组装子进程 env 的方式。

import { describe, expect, it } from "vitest";
import {
  buildRunEnv,
  KNOWN_ARG_KEYS,
  parseArgs,
  unknownArgKeys,
} from "../perf/cli-env.js";

describe("parseArgs", () => {
  it("解析 --key=value 与裸 flag", () => {
    expect(parseArgs(["--scenario=open-S-rich"])).toEqual({ scenario: "open-S-rich" });
    expect(parseArgs(["--update-baseline"])).toEqual({ "update-baseline": "1" });
    expect(parseArgs(["--profile=full", "--repeat=3"])).toEqual({
      profile: "full",
      repeat: "3",
    });
  });

  it("跳过裸 --（pnpm/npm 透传时会带上它，旧实现会解析出名为空串的参数）", () => {
    expect(parseArgs(["--", "--update-baseline=1"])).toEqual({
      "update-baseline": "1",
    });
  });

  it("值里允许出现 =（按第一个 = 切分）", () => {
    expect(parseArgs(["--doc=a=b=c"])).toEqual({ doc: "a=b=c" });
  });

  it("忽略空 key 与非 -- 开头的参数", () => {
    expect(parseArgs(["--=1", "plain", "-x"])).toEqual({});
  });
});

describe("unknownArgKeys", () => {
  it("已登记参数不报未知", () => {
    expect(unknownArgKeys(parseArgs(KNOWN_ARG_KEYS.map((k) => `--${k}=1`)))).toEqual([]);
  });

  it("拼错的参数会被识别出来（调用方据此报错退出，而不是静默忽略）", () => {
    expect(unknownArgKeys(parseArgs(["--scenrio=x"]))).toEqual(["scenrio"]);
  });
});

describe("buildRunEnv：参数到子进程环境变量的映射", () => {
  it("PERF_SCENARIO 必须被写入（曾漏掉这一项导致 argv 形式静默失效）", () => {
    const env = buildRunEnv({ profile: "quick", port: "3000", scenario: "open-S-rich" });
    expect(env.PERF_SCENARIO).toBe("open-S-rich");
  });

  it("未指定 scenario / repeat 时不写入，避免覆盖用户已有的环境变量", () => {
    const env = buildRunEnv({ profile: "quick", port: "1420", scenario: "" });
    expect("PERF_SCENARIO" in env).toBe(false);
    expect("PERF_REPEAT" in env).toBe(false);
  });

  it("profile / port / repeat 照常写入，且 repeat 归一化为字符串", () => {
    const env = buildRunEnv({
      profile: "full",
      port: "3001",
      repeat: "3",
      scenario: "scroll",
    });
    expect(env.PERF_PROFILE).toBe("full");
    expect(env.PERF_PORT).toBe("3001");
    expect(env.PERF_REPEAT).toBe("3");
  });

  it("按 benchmark.mjs 的方式展开后，argv 参数确实能覆盖/传递给子进程", () => {
    // 复刻：env: { ...process.env, ...buildRunEnv(...) }
    const childEnv = {
      ...{ PERF_SCENARIO: "stale-from-shell" },
      ...buildRunEnv({ profile: "quick", port: "3000", scenario: "open-M-rich" }),
    };
    expect(childEnv.PERF_SCENARIO).toBe("open-M-rich");
  });
});

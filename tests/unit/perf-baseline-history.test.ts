// 基线身份与历史累积策略的端到端测试（P1 回归锁）
//
// 背景：`withHistory`（决定 3σ 与滚动参考值）早期只查 fixture 就判定"可比"，
// 于是「headless 日常回归建基线 → 切 uncapped 做定向验证并 --update-baseline」
// 会把两种测量模式的聚合值混进同一条 history：
//   [16.8, 16.8, 16.8] → [16.8, 16.8, 16.8, 8.5]
// σ 被污染成 ≈4.4ms、3σ≈13ms，真实的 8.4→11ms 回归会被「变化在运行噪声内」吞掉。
//
// 修复分两层，缺一不可：
// ① 累积侧的可比性复用 comparability 五维（不再各写一份）；
// ② **基线路径纳入测量配置** `.perf-baseline/[local/]<profile>/<mode>/r<rounds>/<id>.json`
//    ——不同 mode/rounds 各自维护基线、互不覆盖。
// 这里用子进程真实调用 report.mjs 锁死这两层行为。

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "scroll-H-test";
const FIXTURE = { version: 2, hash: "histtest0001", lines: 1000, source: "generated:rich" };
// Keep this override local: Vitest's documented default is 5s, while this case starts 11 child processes.
// https://vitest.dev/api/#test
const HISTORY_LIMIT_TEST_TIMEOUT_MS = 30_000;
const DEFAULT_VITEST_TEST_TIMEOUT_MS = 5_000;

const roots: string[] = [];
let perf: PerfReportWorkspace;

interface RawOptions {
  mode?: string;
  rounds?: number;
  frameMedian?: number;
  fixtureHash?: string;
}

function writeRaw({
  mode = "headless",
  rounds = 2,
  frameMedian = 16.7,
  fixtureHash = FIXTURE.hash,
}: RawOptions): void {
  const raw = {
    id: ID,
    scenario: "scroll",
    tier: "S",
    kind: "rich",
    env: "local",
    profile: "quick",
    rounds,
    warmups: 1,
    mode,
    absoluteEligible: mode !== "headless",
    fixture: { ...FIXTURE, hash: fixtureHash },
    samples: { frameMs: Array.from({ length: 120 }, (_, i) => frameMedian + (i % 3) * 0.1) },
    scalars: {
      frameBudgetMs: 16.7,
      jankFactor: 1.5,
      step: 240,
      jankCount: 0,
      jankRatePct: 0,
      longFrameCount: 0,
      longTaskCount: 0,
      longTaskMs: 0,
      cls: 0,
      heapDeltaMB: 0,
    },
  };
  writeFileSync(join(perf.rawDir, `${ID}.json`), JSON.stringify(raw, null, 2), "utf8");
}

function updateBaseline(): string {
  return execFileSync(process.execPath, [REPORT, "--phase=final", "--update-baseline=1"], {
    env: perf.env(),
    encoding: "utf8",
  });
}

/** 基线路径 = 测量配置的函数：[local/]<profile>/<mode>/r<rounds>/<id>.json */
function baselineFile(mode = "headless", rounds = 2): string {
  return join(perf.baselineDir, "local", "quick", mode, `r${rounds}`, `${ID}.json`);
}

function readBaseline(mode = "headless", rounds = 2): {
  mode: string;
  rounds: number;
  schemaVersion: number;
  metrics: Record<string, { history?: number[]; historyP95?: number[] }>;
} {
  return JSON.parse(readFileSync(baselineFile(mode, rounds), "utf8"));
}

function frameHistory(mode = "headless", rounds = 2): number[] {
  return readBaseline(mode, rounds).metrics.frameMs?.history ?? [];
}

function baselineFiles(): string[] {
  const walk = (dir: string, prefix = ""): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    );
  return walk(perf.baselineDir);
}

beforeEach(() => {
  perf = createPerfReportWorkspace("perf-hist-");
  roots.push(perf.root);
});

afterEach(() => {
  // 隔离是否完整：真实 .perf-baseline 必须一字未动（漏重定向哪个目录都会在这里炸）
  perf.assertRepoBaselineUntouched();
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("基线身份 = 测量配置（路径隔离）", () => {
  it("同配置逐次累积", () => {
    for (const frameMedian of [16.7, 16.8, 16.9]) {
      writeRaw({ frameMedian });
      updateBaseline();
    }

    expect(frameHistory()).toHaveLength(3);
    expect(baselineFiles()).toEqual([`local/quick/headless/r2/${ID}.json`]);
  });

  it("P1 回归锁：切 uncapped 后两套基线共存，headless 历史不被污染、切回后继续累积", () => {
    for (const frameMedian of [16.7, 16.7, 16.7]) {
      writeRaw({ mode: "headless", frameMedian });
      updateBaseline();
    }
    // 首个断言必须与具体布局无关：变异（退回扁平路径）时会给出语义化失败而不是 ENOENT
    expect(baselineFiles()).toEqual([`local/quick/headless/r2/${ID}.json`]);

    // 定向验证：uncapped + 更严预算的那条工作流
    writeRaw({ mode: "uncapped", frameMedian: 8.4 });
    const out = updateBaseline();

    // 定点验证：路径隔离是否真的生效（先断这一条，变异时才会给出语义化失败而不是 ENOENT）
    expect(baselineFiles().sort()).toEqual(
      [`local/quick/headless/r2/${ID}.json`, `local/quick/uncapped/r2/${ID}.json`].sort(),
    );

    // 关键：headless 基线**原样保留**（修复前会被写成 [16.8,16.8,16.8,8.5]）
    expect(frameHistory("headless")).toEqual([16.8, 16.8, 16.8]);
    expect(readBaseline("headless").mode).toBe("headless");
    expect(frameHistory("uncapped")).toEqual([8.5]);
    expect(readBaseline("uncapped").mode).toBe("uncapped");
    // 路径隔离后不再需要"历史重新起头"的补救
    expect(out).not.toContain("基线历史重新起头");

    // 切回 headless 继续累积（第 4 点），而不是被 MODE_MISMATCH 拦住
    writeRaw({ mode: "headless", frameMedian: 16.7 });
    updateBaseline();
    expect(frameHistory("headless")).toHaveLength(4);
  });

  it("采样轮数不同也是独立基线（PERF_REPEAT 不会覆盖标准轮数的基线）", () => {
    writeRaw({ rounds: 2 });
    updateBaseline();
    writeRaw({ rounds: 2 });
    updateBaseline();
    expect(frameHistory("headless", 2)).toHaveLength(2);

    writeRaw({ rounds: 3 });
    updateBaseline();

    expect(baselineFiles().sort()).toEqual(
      [`local/quick/headless/r2/${ID}.json`, `local/quick/headless/r3/${ID}.json`].sort(),
    );
    expect(frameHistory("headless", 2)).toHaveLength(2); // 未被覆盖
    expect(frameHistory("headless", 3)).toHaveLength(1);
  });

  it("fixture 变化：同一路径重建，历史重新起头并给出原因", () => {
    writeRaw({});
    updateBaseline();
    writeRaw({});
    updateBaseline();
    expect(frameHistory()).toHaveLength(2);

    writeRaw({ fixtureHash: "anotherhash1" });
    const out = updateBaseline();

    expect(baselineFiles()).toEqual([`local/quick/headless/r2/${ID}.json`]);
    expect(frameHistory()).toHaveLength(1);
    expect(out).toContain("基线历史重新起头");
    expect(out).toContain("FIXTURE_CHANGED");
  });

  it("旧 schema 基线（无历史序列）不会被当成一个历史点重复计入", () => {
    writeRaw({});
    updateBaseline();
    const file = baselineFile();
    const legacy = JSON.parse(readFileSync(file, "utf8"));
    legacy.schemaVersion = 1;
    for (const entry of Object.values<Record<string, unknown>>(legacy.metrics)) {
      delete entry.history;
      delete entry.historyP95;
    }
    writeFileSync(file, JSON.stringify(legacy, null, 2), "utf8");

    updateBaseline();

    expect(frameHistory()).toHaveLength(1); // 从本次重新起头，而不是 [median, median]
  });

  it("历史序列上限 8 点，保留最近的运行", { timeout: HISTORY_LIMIT_TEST_TIMEOUT_MS }, async () => {
    for (let i = 0; i < 11; i += 1) {
      writeRaw({ frameMedian: 16 + i * 0.1 });
      updateBaseline();
    }
    // Deliberately cross Vitest's 5s default so removing the local override fails this test.
    await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_VITEST_TEST_TIMEOUT_MS + 250));
    const history = frameHistory();
    expect(history).toHaveLength(8);
    expect(history[history.length - 1]).toBeGreaterThan(history[0]); // 保留尾部
  });
});

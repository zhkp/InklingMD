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
import { join, resolve } from "node:path";
import * as ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPerfReportWorkspace, type PerfReportWorkspace } from "./perf-report-env";

const REPORT = "tests/perf/report.mjs";
const ID = "scroll-H-test";
const FIXTURE = { version: 2, hash: "histtest0001", lines: 1000, source: "generated:rich" };
const HISTORY_LIMIT_TEST_TITLE = "历史序列上限 8 点，保留最近的运行";
const HISTORY_LIMIT_TIMEOUT_MS = 30_000;
// Calibration was measured on snapshot 421708176835c415a28919d867cbbb064c9367cb; this update records the evidence, not a callback/timeout change.
// 40 callback samples were fully inside all four gate PID intervals (50ms edge pad); nearest-rank p95 = 2,029.138ms (ceil 2,030ms), max = 2,062.349ms.
// The 30s local timeout is 14.78× the rounded p95 and 9.7s above the 10× guard; the repository-wide Vitest timeout remains untouched.
const HISTORY_LIMIT_CALLBACK_WALL_P95_MS = 2_030;
const HISTORY_LIMIT_TIMEOUT_SAFETY_FACTOR = 10;
const HISTORY_LIMIT_SUBPROCESS_COUNT = 11;

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

  // Vitest documents the per-test timeout option at https://vitest.dev/api/#test.
  // Keep the override local: this sync test launches 11 report.mjs subprocesses serially.
  it("历史序列上限 8 点，保留最近的运行", { timeout: 30_000 }, () => {
    for (let i = 0; i < 11; i += 1) {
      writeRaw({ frameMedian: 16 + i * 0.1 });
      updateBaseline();
    }
    const history = frameHistory();
    expect(history).toHaveLength(8);
    expect(history[history.length - 1]).toBeGreaterThan(history[0]); // 保留尾部
  });
});

// Use TypeScript's AST API so comments and unrelated strings cannot satisfy the source-level contract.
// https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
function parseTypeScriptFile(relativePath: string): ts.SourceFile {
  const absolutePath = resolve(process.cwd(), relativePath);
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function objectMemberName(member: ts.ObjectLiteralElementLike): string | undefined {
  if (
    ts.isPropertyAssignment(member) ||
    ts.isShorthandPropertyAssignment(member) ||
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    const name = member.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  }
  return undefined;
}

function objectMembersNamed(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike[] {
  return object.properties.filter((member) => objectMemberName(member) === name);
}

function collectAstNodes<T extends ts.Node>(root: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node): void => {
    if (matches(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

function vitestTestOptions(source: ts.SourceFile): ts.ObjectLiteralExpression {
  const calls = collectAstNodes(
    source,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineConfig",
  );
  if (calls.length !== 1 || !calls[0].arguments[0] || !ts.isObjectLiteralExpression(calls[0].arguments[0])) {
    throw new Error("vitest.config.ts must have one defineConfig object");
  }

  const testMembers = objectMembersNamed(calls[0].arguments[0], "test");
  if (
    testMembers.length !== 1 ||
    !ts.isPropertyAssignment(testMembers[0]) ||
    !ts.isObjectLiteralExpression(testMembers[0].initializer)
  ) {
    throw new Error("vitest.config.ts must define one direct test options object");
  }
  return testMembers[0].initializer;
}

function numericLiteralValue(expression: ts.Expression): number | undefined {
  return ts.isNumericLiteral(expression) ? Number(expression.text.replaceAll("_", "")) : undefined;
}

function isHistorySubprocessLoop(loop: ts.ForStatement): boolean {
  const initializer = loop.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) {
    return false;
  }
  const declaration = initializer.declarations[0];
  if (
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    numericLiteralValue(declaration.initializer) !== 0
  ) {
    return false;
  }

  const index = declaration.name.text;
  const condition = loop.condition;
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(condition.left) ||
    condition.left.text !== index ||
    numericLiteralValue(condition.right) !== HISTORY_LIMIT_SUBPROCESS_COUNT
  ) {
    return false;
  }

  const incrementor = loop.incrementor;
  return Boolean(
    incrementor &&
      ts.isBinaryExpression(incrementor) &&
      incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isIdentifier(incrementor.left) &&
      incrementor.left.text === index &&
      numericLiteralValue(incrementor.right) === 1,
  );
}

function historyLimitTestCall(source: ts.SourceFile): ts.CallExpression {
  const calls = collectAstNodes(
    source,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "it",
  );
  const targetCalls = calls.filter((call) => {
    const title = call.arguments[0];
    return title && ts.isStringLiteral(title) && title.text === HISTORY_LIMIT_TEST_TITLE;
  });
  if (targetCalls.length !== 1) throw new Error(`expected one test titled "${HISTORY_LIMIT_TEST_TITLE}"`);
  return targetCalls[0];
}

describe("#411 历史上限测试超时配置守卫", () => {
  it("全局默认不变、目标用例有足够的局部 wall-time 预算", () => {
    const config = parseTypeScriptFile("vitest.config.ts");
    const globalTestOptions = vitestTestOptions(config);
    expect(objectMembersNamed(globalTestOptions, "testTimeout")).toHaveLength(0);
    expect(globalTestOptions.properties.some((member) => ts.isSpreadAssignment(member))).toBe(false);

    const source = parseTypeScriptFile("tests/unit/perf-baseline-history.test.ts");
    const target = historyLimitTestCall(source);
    const options = target.arguments[1];
    if (!options || !ts.isObjectLiteralExpression(options)) {
      throw new Error("history limit test must keep a direct local options object");
    }
    const timeoutMembers = objectMembersNamed(options, "timeout");
    expect(timeoutMembers).toHaveLength(1);
    if (timeoutMembers.length !== 1 || !ts.isPropertyAssignment(timeoutMembers[0])) {
      throw new Error("history limit test must declare one numeric timeout option");
    }
    const timeoutMs = numericLiteralValue(timeoutMembers[0].initializer);
    expect(timeoutMs).toBe(HISTORY_LIMIT_TIMEOUT_MS);
    expect(timeoutMs).toBeGreaterThanOrEqual(HISTORY_LIMIT_CALLBACK_WALL_P95_MS * HISTORY_LIMIT_TIMEOUT_SAFETY_FACTOR);

    const callback = target.arguments[2];
    if (!callback || !ts.isArrowFunction(callback)) throw new Error("history limit callback must remain an arrow function");
    expect(callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false).toBe(false);

    const loops = collectAstNodes(callback, (node): node is ts.ForStatement => ts.isForStatement(node));
    const historyLoops = loops.filter(isHistorySubprocessLoop);
    expect(historyLoops).toHaveLength(1);
    if (historyLoops.length === 1) {
      const body = historyLoops[0].statement;
      if (!ts.isBlock(body)) throw new Error("history subprocess loop must use a direct block body");
      const bodyCalls = body.statements.map((statement) => {
        if (
          !ts.isExpressionStatement(statement) ||
          !ts.isCallExpression(statement.expression) ||
          !ts.isIdentifier(statement.expression.expression)
        ) {
          return undefined;
        }
        return statement.expression.expression.text;
      });
      expect(bodyCalls).toEqual(["writeRaw", "updateBaseline"]);
    }
  });
});

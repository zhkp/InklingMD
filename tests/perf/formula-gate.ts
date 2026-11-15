// 公式测量的就绪门禁（#375 评审 R6-1）
//
// 抽成纯函数是为了可被单测锁定：这条判定曾把 custom 档整体判红——
// 预期值来自「只挂 remark-math」的管线，而编辑器还挂 GFM 表格与 frontmatter，
// 这两处会吃掉 `$`，实际节点数可能少于预期。若把完整预期当成就绪阈值，
// 等待会跑满帧预算并返回 complete=false，整场景按 UNMEASURED 失败。
export interface FormulaGate {
  /** true = 生成档位：预期数必须与编辑器实际挂载精确相等 */
  strict: boolean;
  /** waitFormulaSettled 的就绪阈值；0 表示不按数量门禁 */
  minNodes: number;
}

/**
 * - 生成档位（rich / plain / 其它）：要求 `nodeViews >= expectedNodes`，
 *   且之后还要与实际挂载数精确对账（漏算=少挂、高估=假 UNMEASURED）。
 * - custom：**不做数量门禁**（`minNodes: 0`），完成条件退化为「已挂载节点都
 *   渲染完」；`nodeViews=0` 时首帧即 complete=true（用户文档里公式被 GFM 表格 /
 *   frontmatter 吃掉是合法结果），数量差异一律由 `unmeasured` 披露，不判红、
 *   也不写 `formulaReadyMs`。
 */
export function formulaGate(kind: string, expectedNodes: number): FormulaGate {
  const strict = kind !== "custom";
  const expected = Number.isFinite(expectedNodes)
    ? Math.max(0, Math.floor(expectedNodes))
    : 0;
  return {
    strict,
    minNodes: strict ? expected : 0,
  };
}

/** 公式归因等待的帧预算（KaTeX 懒加载 + 逐公式渲染的尾部） */
export const FORMULA_MAX_FRAMES = 1800;

/** `waitFormulaSettled` 的完整入参 */
export interface FormulaWaitOptions {
  maxFrames: number;
  expectedNodes: number;
  minNodes: number;
}

/**
 * 生产接线唯一入口（#375 评审 R8-1）。
 *
 * `open.spec` 只允许 `page.evaluate(waitFormulaSettled, formulaWaitOptions(kind, expected))`，
 * 不再就地拼 options：就地拼盘时 `minNodes` 这一行可以被删掉而**所有单测仍绿**
 * （CI 的 18 个默认场景都是生成档，`minNodes` 默认等于 expected，行为不变），
 * 只有手动跑 custom 才会暴露。抽成纯函数后，参数由单测锁死，接线由
 * `perf-formula-settle.test.ts` 的源码断言锁死。
 */
export function formulaWaitOptions(
  kind: string,
  expectedNodes: number,
): FormulaWaitOptions {
  const expected = Number.isFinite(expectedNodes)
    ? Math.max(0, Math.floor(expectedNodes))
    : 0;
  return {
    maxFrames: FORMULA_MAX_FRAMES,
    expectedNodes: expected,
    minNodes: formulaGate(kind, expected).minNodes,
  };
}

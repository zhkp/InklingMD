// KaTeX 等待完成条件的语义锁（#376 / #379）
//
// 背景：`waitFormulaSettled()` 到帧预算上限与正常完成走同一个 resolve，返回值没有
// 「是否等到完整」的标志。调用方因此会把「超时时刻」当成「渲染完成时刻」写进
// formulaReadyMs，等于用不完整样本给 #376「先测量再决定」下结论。
// 这里锁死：超时必须被标成 complete=false，完成才标 true。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFormulaSettled } from "../perf/metrics.js";

/** 造一个公式节点；rendered=true 时附带 KaTeX 输出 */
function formulaNode(rendered: boolean, empty = false): HTMLElement {
  const node = document.createElement("span");
  node.setAttribute("data-math-inline", "");
  if (empty) node.setAttribute("data-value", "");
  if (rendered) {
    const katex = document.createElement("span");
    katex.className = "katex";
    node.appendChild(katex);
  }
  document.body.appendChild(node);
  return node;
}

describe("waitFormulaSettled 完成条件（#379 评审 P1）", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    // 帧预算为 0 时首个回调就会判定，无需推进动画帧
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("帧预算耗尽时 complete=false（超时不能被当成完成）", async () => {
    formulaNode(false);
    const result = await waitFormulaSettled({ maxFrames: 0 });
    expect(result.nodeViews).toBe(1);
    expect(result.rendered).toBe(0);
    expect(result.complete).toBe(false);
  });

  it("全部渲染出 KaTeX 时 complete=true", async () => {
    formulaNode(true);
    formulaNode(true);
    const result = await waitFormulaSettled({ maxFrames: 0 });
    expect(result.rendered).toBe(2);
    expect(result.complete).toBe(true);
  });

  it("空公式（占位提示）算作已完成，不计入未渲染", async () => {
    formulaNode(true);
    formulaNode(false, true);
    const result = await waitFormulaSettled({ maxFrames: 0 });
    expect(result.nodeViews).toBe(2);
    expect(result.empty).toBe(1);
    expect(result.complete).toBe(true);
  });

  it("部分渲染 + 帧预算耗尽 → complete=false，且 completed 计数如实反映", async () => {
    formulaNode(true);
    formulaNode(false);
    const result = await waitFormulaSettled({ maxFrames: 0 });
    expect(result.rendered).toBe(1);
    expect(result.nodeViews).toBe(2);
    expect(result.complete).toBe(false);
  });

  it("没有公式节点时视作已完成（纯文本档不应被这条门禁卡住）", async () => {
    const result = await waitFormulaSettled({ maxFrames: 0 });
    expect(result.nodeViews).toBe(0);
    expect(result.complete).toBe(true);
  });
});

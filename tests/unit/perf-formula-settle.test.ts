// KaTeX 等待完成条件的语义锁（#376 / #379）
//
// 背景：`waitFormulaSettled()` 到帧预算上限与正常完成走同一个 resolve，返回值没有
// 「是否等到完整」的标志。调用方因此会把「超时时刻」当成「渲染完成时刻」写进
// formulaReadyMs，等于用不完整样本给 #376「先测量再决定」下结论。
// 这里锁死：超时必须被标成 complete=false，完成才标 true。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  countExpectedMathNodes,
  waitFormulaSettled,
} from "../perf/metrics.js";

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
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  /** 手动推进动画帧，让「节点延迟挂载」成为确定性事件 */
  function mockFrames() {
    const callbacks: ((time: number) => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: (time: number) => void) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    return { step: () => callbacks.shift()?.(0) };
  }

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

  it("没有公式节点且预期为 0 时视作已完成（纯文本档不应被这条门禁卡住）", async () => {
    const result = await waitFormulaSettled({ maxFrames: 0, expectedNodes: 0 });
    expect(result.nodeViews).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.unmeasured).toBe(false);
  });

  it("预期有公式但节点延迟挂载：不立刻完成，挂载并渲染后才 complete（#379 评审 R4）", async () => {
    const frames = mockFrames();
    const pending = waitFormulaSettled({ maxFrames: 5, expectedNodes: 1 });
    frames.step(); // 首帧 nodeViews=0：旧实现 `0 >= 0` 会立刻判完成
    formulaNode(true); // 节点晚一帧才挂载
    frames.step(); // 逐帧重读到 nodeViews=1 / rendered=1
    const result = await pending;
    expect(result.nodeViews).toBe(1);
    expect(result.rendered).toBe(1);
    expect(result.complete).toBe(true);
    expect(result.unmeasured).toBe(false);
  });

  it("等待期间追加公式节点：逐帧重读不会漏掉首帧之外的节点", async () => {
    const frames = mockFrames();
    formulaNode(true);
    const pending = waitFormulaSettled({ maxFrames: 5, expectedNodes: 2 });
    frames.step(); // 只有 1 个节点，未达预期 → 继续等
    formulaNode(true);
    frames.step();
    const result = await pending;
    expect(result.nodeViews).toBe(2);
    expect(result.rendered).toBe(2);
    expect(result.complete).toBe(true);
  });

  it("预期有公式但节点始终未挂载：complete=false + unmeasured=true", async () => {
    const frames = mockFrames();
    const pending = waitFormulaSettled({ maxFrames: 2, expectedNodes: 1 });
    frames.step();
    frames.step();
    frames.step(); // 帧预算耗尽
    const result = await pending;
    expect(result.nodeViews).toBe(0);
    expect(result.complete).toBe(false);
    expect(result.unmeasured).toBe(true);
  });
});

// #379 评审 R4 / 验收 F5：custom 档直接读用户文档，预期节点数不能把
// 代码/转义里的 `$` 误当公式，也不能漏掉同行 $$...$$。
describe("countExpectedMathNodes（公式前提计数）", () => {
  it("生成档位：行内 + 成对块级各计一个", () => {
    const md = "行内公式 $E = mc^2$ 与块级公式：\n$$\n\\int_0^1 x^2 dx\n$$\n";
    expect(countExpectedMathNodes(md)).toBe(2);
  });

  it("围栏代码块、行内代码与转义 $ 都不误数（custom 档）", () => {
    const md = [
      "```js",
      "const a = `$x$`;",
      "```",
      "",
      "价格 \\$5 与 \\$9，另有 `$$not math$$`",
    ].join("\n");
    expect(countExpectedMathNodes(md)).toBe(0);
  });

  it("同行 $$...$$ 计一个节点，块级内部不再重复计数", () => {
    expect(countExpectedMathNodes("$$a+b$$")).toBe(1);
    expect(countExpectedMathNodes("$$\n$x$\n$$\n")).toBe(1);
  });

  it("纯文本档返回 0（等待逻辑据此合法完成）", () => {
    expect(countExpectedMathNodes("普通段落，没有公式")).toBe(0);
  });

  it("缩进代码块 / 多反引号 / 表格跨格 $ / 块级闭合同行都不误数（custom 档）", () => {
    expect(countExpectedMathNodes("    const a = $5 + $9;")).toBe(0);
    expect(countExpectedMathNodes("``$x$``")).toBe(0);
    expect(countExpectedMathNodes("| $x | y$ |")).toBe(0);
    expect(countExpectedMathNodes("$$\na$$")).toBe(1);
    // 闭合标记后仍有正常行内公式，不能被 inBlockMath 吞掉
    expect(countExpectedMathNodes("$$\na$$\n后文 $E=mc^2$")).toBe(2);
  });
});

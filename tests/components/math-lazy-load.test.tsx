// #168 KaTeX 懒加载测试
//
// 背景：katex（JS + 样式 + mhchem，~822KB vendor_katex）被静态导入
// 进入启动加载图。修复后首次遇到公式节点才动态导入。
//
// 验证（mock 模块工厂调用计数）：
// - 导入 math 模块本身不加载 katex（懒）
// - 构造公式 NodeView 后异步加载一次并渲染；多节点复用模块
// - 快速连续变更值时，异步加载返回后只应用最新值（seq 守卫）
//
// 注意：本测试不得静态 import "katex"——静态导入会立即触发模块工厂，
// 破坏懒加载断言；需要 mock 句柄时在渲染发生后动态 import 获取。

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";

const counters = vi.hoisted(() => ({
  katexFactory: { n: 0 },
}));

vi.mock("katex", () => {
  counters.katexFactory.n += 1;
  return {
    default: {
      renderToString: vi.fn(
        (expr: string) => `<span class="katex-mock" data-expr="${expr}"></span>`,
      ),
    },
  };
});
vi.mock("katex/dist/katex.min.css", () => ({}));
vi.mock("katex/dist/contrib/mhchem.js", () => ({}));

import { createMathView } from "../../src/components/Editor/math";

function fakeNode(value: string): Node {
  return {
    attrs: { value, number: null },
    type: { name: "math_inline" },
  } as unknown as Node;
}

const fakeView = {} as PMView;

// ProseMirror 的 NodeViewConstructor/update 类型要求显式传装饰参数（运行时
// 并不需要）；这里收窄为最小签名，让测试只传业务参数、聚焦懒加载行为。
type MathViewShim = {
  dom: HTMLElement;
  update?: (next: Node) => boolean;
};
function makeMathView(displayMode: boolean) {
  return createMathView(displayMode) as unknown as (
    node: Node,
    view: PMView,
    getPos: () => number | undefined,
  ) => MathViewShim;
}

/** 冲刷微任务，等待动态 import 与渲染回调完成 */
async function flushAsync(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

describe("#168 KaTeX 懒加载", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("导入模块与构造 NodeView 不加载 katex，首次渲染异步加载且仅一次", async () => {
    // math 模块已导入、NodeView 构造前：动态 import 未发生
    expect(counters.katexFactory.n).toBe(0);

    const factory = makeMathView(false);
    expect(counters.katexFactory.n).toBe(0);

    factory(fakeNode("a^2"), fakeView, () => 0);
    // 构造仅发射异步加载，同步代码路径仍未加载模块
    expect(counters.katexFactory.n).toBe(0);

    await flushAsync();
    // 加载完成后渲染，模块只加载一次
    expect(counters.katexFactory.n).toBe(1);
    const katex = (await import("katex")).default;
    expect(vi.mocked(katex.renderToString)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(katex.renderToString)).toHaveBeenCalledWith(
      "a^2",
      expect.objectContaining({ displayMode: false }),
    );

    // 第二个公式节点复用模块
    factory(fakeNode("b_1"), fakeView, () => 1);
    await flushAsync();
    expect(counters.katexFactory.n).toBe(1);
    expect(vi.mocked(katex.renderToString)).toHaveBeenCalledTimes(2);
  });

  it("加载期间值快速变化时只渲染最新值（seq 守卫）", async () => {
    const factory = makeMathView(false);
    const nv = factory(fakeNode("old"), fakeView, () => 0);

    // 加载完成前连续更新节点值：旧值的渲染回调应被 seq 守卫丢弃
    nv.update!(fakeNode("mid"));
    nv.update!(fakeNode("newest"));

    await flushAsync();
    const katex = (await import("katex")).default;
    // renderToString 只应用最新值一次（而非 old/mid/newest 各一次）
    const calls = vi.mocked(katex.renderToString).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("newest");
  });
});

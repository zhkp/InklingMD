// #168 mermaid 懒加载测试
//
// 背景：mermaid 被静态导入进入启动加载图（~3.1MB vendor_mermaid），
// 文档不含图表时纯属浪费。修复后首次遇到图表节点才动态导入。
//
// 验证（mock 模块工厂调用计数）：
// - 导入 mermaid-view 模块本身不加载 mermaid（懒）
// - 首次渲染触发一次加载 + 一次 initialize
// - 后续渲染复用模块（不重复加载、不重复 initialize）
// - 缓存命中的渲染不触发 mermaid.render
//
// 注意：本测试不得静态 import "mermaid"——静态导入会立即触发模块工厂，
// 破坏懒加载断言。
//
// 实现说明：mock 的 initialize/render 用普通闭包 + hoisted 计数器而非
// vi.fn——全局 setup 在 afterEach 会 restoreAllMocks（抹掉 vi.mock 工厂
// 里 spy 的实现），跨用例需要实现存活时普通函数天然免疫该机制。

import { describe, it, expect, vi } from "vitest";

const counters = vi.hoisted(() => ({
  factoryCalls: { n: 0 },
  initializeCalls: { n: 0 },
  renderCalls: { n: 0 },
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("mermaid", () => {
  counters.factoryCalls.n += 1;
  return {
    default: {
      initialize: () => {
        counters.initializeCalls.n += 1;
      },
      render: async (id: string, text: string) => {
        counters.renderCalls.n += 1;
        return { svg: `<svg id="${id}"><text>${text}</text></svg>` };
      },
    },
  };
});

import { renderMermaidWithSeq } from "../../src/components/Editor/mermaid-view";

describe("#168 mermaid 懒加载", () => {
  it("首次渲染才加载模块并初始化，且只加载/初始化一次", async () => {
    // 模块已导入但尚未渲染：动态 import 未发生（工厂未执行）
    expect(counters.factoryCalls.n).toBe(0);

    let seq = 0;
    const svg1 = await renderMermaidWithSeq("graph TD; A-->B", ++seq, () => seq);
    expect(svg1).toContain("<svg");
    // 首次渲染触发模块加载与初始化，各一次
    expect(counters.factoryCalls.n).toBe(1);
    expect(counters.initializeCalls.n).toBe(1);
    expect(counters.renderCalls.n).toBe(1);

    // 第二个不同源码的图表：复用已加载模块，不再加载/初始化
    const svg2 = await renderMermaidWithSeq("graph LR; C-->D", ++seq, () => seq);
    expect(svg2).toContain("<svg");
    expect(counters.factoryCalls.n).toBe(1);
    expect(counters.initializeCalls.n).toBe(1);
    expect(counters.renderCalls.n).toBe(2);
  });

  it("源码缓存命中的渲染跳过 mermaid.render（也无需模块参与）", async () => {
    // 记录当前累计值，只做相对断言（模块级状态跨用例共享，勿假设绝对数）
    const factoryBefore = counters.factoryCalls.n;
    const renderBefore = counters.renderCalls.n;

    let seq = 100;
    const code = "graph TD; CACHE-->HIT";
    const svg1 = await renderMermaidWithSeq(code, ++seq, () => seq);
    expect(svg1).toContain("<svg");
    // 新源码：触发一次渲染（缓存未命中）；模块已加载，不重新加载
    expect(counters.factoryCalls.n).toBe(factoryBefore);
    expect(counters.renderCalls.n).toBe(renderBefore + 1);

    // 同源码再次渲染：命中渲染结果缓存，不再调用 mermaid.render
    const svg2 = await renderMermaidWithSeq(code, ++seq, () => seq);
    expect(svg2).toContain("<svg");
    expect(counters.factoryCalls.n).toBe(factoryBefore);
    expect(counters.renderCalls.n).toBe(renderBefore + 1);
  });
});

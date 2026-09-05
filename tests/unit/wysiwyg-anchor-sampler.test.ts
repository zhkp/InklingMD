// #212：WYSIWYG 切换源码模式的「事前锚点采样」注册表与 store 集成测试
//
// 机制：setTabSourceMode 进入源码方向、翻转 sourceMode 之前，同步执行
// 注册表中该文档的采样器（此刻 .md-editor-wysiwyg 仍可见，posAtCoords 等
// 几何现场读可靠）——替代 #139 引入的「滚动路径每帧采样」性能灾难路径。

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerWysiwygAnchorSampler,
  runWysiwygAnchorSampler,
  unregisterWysiwygAnchorSampler,
} from "../../src/lib/wysiwyg-anchor-sampler";
import { useWorkspace, type OpenTab } from "../../src/store/workspace";

function tab(path: string): OpenTab {
  return {
    path,
    content: `# ${path}`,
    dirty: false,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
  };
}

describe("wysiwyg-anchor-sampler 注册表", () => {
  it("register 后 run 执行采样器；unregister 后不再执行", () => {
    const sampler = vi.fn();
    registerWysiwygAnchorSampler("/x.md", sampler);
    runWysiwygAnchorSampler("/x.md");
    expect(sampler).toHaveBeenCalledTimes(1);

    unregisterWysiwygAnchorSampler("/x.md");
    runWysiwygAnchorSampler("/x.md");
    expect(sampler).toHaveBeenCalledTimes(1);
  });

  it("未注册的文档路径 run 静默跳过，不抛错", () => {
    expect(() => runWysiwygAnchorSampler("/not-registered.md")).not.toThrow();
  });

  it("同一路径重复注册以最新采样器为准（编辑器实例重建场景）", () => {
    const oldSampler = vi.fn();
    const newSampler = vi.fn();
    registerWysiwygAnchorSampler("/y.md", oldSampler);
    registerWysiwygAnchorSampler("/y.md", newSampler);
    runWysiwygAnchorSampler("/y.md");
    expect(oldSampler).not.toHaveBeenCalled();
    expect(newSampler).toHaveBeenCalledTimes(1);
    unregisterWysiwygAnchorSampler("/y.md");
  });

  it("采样器抛错时 run 不向上传播（不阻断模式切换）", () => {
    registerWysiwygAnchorSampler("/boom.md", () => {
      throw new Error("geometry exploded");
    });
    expect(() => runWysiwygAnchorSampler("/boom.md")).not.toThrow();
    unregisterWysiwygAnchorSampler("/boom.md");
  });
});

describe("setTabSourceMode 事前锚点采样集成（#212）", () => {
  beforeEach(() => {
    useWorkspace.setState({
      openTabs: [tab("/a.md"), tab("/b.md")],
      activeTabPath: "/a.md",
      currentFile: "/a.md",
      currentContent: "# /a.md",
    });
  });

  it("从 WYSIWYG 进入源码方向：翻转 sourceMode 之前同步执行采样器", () => {
    const sampler = vi.fn(() => {
      // 采样时刻必须仍在 WYSIWYG（sourceMode 尚未翻转）——这是「几何
      // 现场读可靠」的时序前提（容器此时尚未 display:none）
      expect(useWorkspace.getState().getTabSourceMode("/a.md")).toBe(false);
    });
    registerWysiwygAnchorSampler("/a.md", sampler);

    useWorkspace.getState().setTabSourceMode(true, "/a.md");

    expect(sampler).toHaveBeenCalledTimes(1);
    // 采样完成后状态才翻转
    expect(useWorkspace.getState().getTabSourceMode("/a.md")).toBe(true);
    unregisterWysiwygAnchorSampler("/a.md");
  });

  it("toggleTabSourceMode 进入方向同样触发采样（快捷键/顶栏按钮路径汇聚点）", () => {
    const sampler = vi.fn();
    registerWysiwygAnchorSampler("/a.md", sampler);

    useWorkspace.getState().toggleTabSourceMode(); // false → true
    expect(sampler).toHaveBeenCalledTimes(1);

    useWorkspace.getState().toggleTabSourceMode(); // true → false，退出方向不采样
    expect(sampler).toHaveBeenCalledTimes(1);
    unregisterWysiwygAnchorSampler("/a.md");
  });

  it("退出源码方向（enabled=false）不触发采样", () => {
    const sampler = vi.fn();
    registerWysiwygAnchorSampler("/a.md", sampler);
    useWorkspace.setState({
      openTabs: [{ ...tab("/a.md"), sourceMode: true }],
    });

    useWorkspace.getState().setTabSourceMode(false, "/a.md");
    expect(sampler).not.toHaveBeenCalled();
    unregisterWysiwygAnchorSampler("/a.md");
  });

  it("已处于源码模式再置位 true（解析失败回退路径）不重复采样", () => {
    const sampler = vi.fn();
    registerWysiwygAnchorSampler("/a.md", sampler);
    useWorkspace.setState({
      openTabs: [{ ...tab("/a.md"), sourceMode: true }],
    });

    useWorkspace.getState().setTabSourceMode(true, "/a.md");
    // 此刻容器已塌陷，现场几何不可靠，采样既无意义又有污染缓存风险
    expect(sampler).not.toHaveBeenCalled();
    unregisterWysiwygAnchorSampler("/a.md");
  });

  it("采样只针对目标文档：其他 tab 的采样器不被调用", () => {
    const samplerA = vi.fn();
    const samplerB = vi.fn();
    registerWysiwygAnchorSampler("/a.md", samplerA);
    registerWysiwygAnchorSampler("/b.md", samplerB);

    useWorkspace.getState().setTabSourceMode(true, "/b.md");
    expect(samplerA).not.toHaveBeenCalled();
    expect(samplerB).toHaveBeenCalledTimes(1);
    unregisterWysiwygAnchorSampler("/a.md");
    unregisterWysiwygAnchorSampler("/b.md");
  });

  it("采样器抛错不阻断模式切换（状态照常翻转）", () => {
    registerWysiwygAnchorSampler("/a.md", () => {
      throw new Error("posAtCoords exploded");
    });

    useWorkspace.getState().setTabSourceMode(true, "/a.md");
    expect(useWorkspace.getState().getTabSourceMode("/a.md")).toBe(true);
    unregisterWysiwygAnchorSampler("/a.md");
  });

  it("编辑器未就绪（未注册采样器）时切换照常，回退旧缓存路径", () => {
    // 不注册任何采样器：runWysiwygAnchorSampler 静默跳过，
    // useSourceModeTransition 消费端拿到的是初始/上次缓存值（既有兜底语义）
    useWorkspace.getState().setTabSourceMode(true, "/a.md");
    expect(useWorkspace.getState().getTabSourceMode("/a.md")).toBe(true);
  });
});

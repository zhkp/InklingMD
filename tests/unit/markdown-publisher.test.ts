// markdown-publisher 插件测试
// 验证：序列化防抖合并、doc 未变不触发、idle flush 跳过、
// 与 lastSynced 相同不回调、blur/销毁立即 flush、pending 不因模式丢弃

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushAllMarkdownPublishers,
  flushMarkdownPublisherFor,
  markdownPublisherPlugin,
} from "../../src/components/Editor/markdown-publisher";

interface FakeDoc {
  id: number;
}

function setup(options?: { initialSynced?: string; filePath?: string }) {
  const onChange = vi.fn();
  const serialize = vi.fn((doc: unknown) => `md-${(doc as FakeDoc).id}`);
  let lastSynced = options?.initialSynced ?? "md-0";
  const plugin = markdownPublisherPlugin({
    serialize,
    getLastSynced: () => lastSynced,
    setLastSynced: (md) => {
      lastSynced = md;
    },
    getFilePath: () => options?.filePath ?? "/docs/note.md",
    onChange,
  });
  const dom = document.createElement("div");
  document.body.append(dom);
  // 模拟活的 EditorView：state.doc 随 update 更新
  const view = { dom, state: { doc: { id: 0 } as FakeDoc } };
  const pluginView = plugin.spec.view?.(
    view as never,
  ) as unknown as {
    update: (next: never, prev: never) => void;
    destroy: () => void;
  };
  // view 创建时插件会用「当前 doc 的序列化结果」初始化同步基线
  // （修复 E2E 关 tab 误判 dirty 的改动）。这里清掉这次基线调用的计数，
  // 并按测试意图复位 lastSynced，让后续断言聚焦 flush/防循环行为本身。
  serialize.mockClear();
  if (options?.initialSynced !== undefined) lastSynced = options.initialSynced;
  const bump = (id: number) => {
    // PM 约定：update(view, prevState)，prevState 为 EditorState（doc 在顶层）
    const prevState = { doc: view.state.doc };
    view.state.doc = { id };
    pluginView.update(
      { state: { doc: view.state.doc } } as never,
      prevState as never,
    );
  };
  return { onChange, serialize, pluginView, dom, bump, view };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("markdownPublisherPlugin", () => {
  it("连续 doc 变更在防抖窗口内只序列化并发布一次", () => {
    vi.useFakeTimers();
    const { onChange, serialize, bump } = setup();
    bump(1);
    bump(2);
    bump(3);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(160);
    // 只取最新 doc 序列化一次
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(serialize).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-3");
  });

  it("doc 未变化的 transaction 不触发序列化", () => {
    vi.useFakeTimers();
    const { onChange, serialize, pluginView } = setup();
    const doc = { id: 0 };
    pluginView.update(
      { state: { doc } } as never,
      { doc } as never,
    );
    vi.advanceTimersByTime(300);
    expect(serialize).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("序列化结果与外部同步值相同时不回调（防循环）", () => {
    vi.useFakeTimers();
    const { onChange, bump } = setup({ initialSynced: "md-1" });
    bump(1);
    vi.advanceTimersByTime(160);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("待发编辑的 flush 不受模式影响（进入源码模式不得丢弃 pending）", () => {
    // 回归：旧 isSourceMode 守卫会在进入源码模式的 flush 中清掉 timer
    // 且不发布，丢失窗口内编辑。源码模式下 PM doc 不变，timer 非空即
    // 进入前的待发编辑，必须发布；源码模式期间的保护由 idle 守卫承担
    vi.useFakeTimers();
    const { onChange, serialize, bump } = setup();
    bump(1);
    vi.advanceTimersByTime(160);
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-1");
  });

  it("blur 立即 flush 待定序列化", () => {
    vi.useFakeTimers();
    const { onChange, dom, bump } = setup();
    bump(7);
    dom.dispatchEvent(new Event("blur"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-7");
  });

  it("保存路径 flush 跳过 idle 编辑器，不重跑全文序列化", () => {
    // 自动保存每 2s 触发一次 flush：idle 编辑器不得重复全文序列化（PR #34 P2）
    vi.useFakeTimers();
    const { serialize, bump } = setup();
    flushAllMarkdownPublishers();
    expect(serialize).not.toHaveBeenCalled();

    bump(1);
    flushAllMarkdownPublishers();
    expect(serialize).toHaveBeenCalledTimes(1);

    // 发布后回到 idle：再次 flush 不重复序列化
    flushAllMarkdownPublishers();
    expect(serialize).toHaveBeenCalledTimes(1);
  });

  it("按 view flush 只发布该编辑器的待发编辑（#431 评审）", () => {
    // 切 tab / 进源码模式是单编辑器交互：分屏侧仍停在自己的文件上，
    // 不能被顺带做一次全文序列化（大文档就是一次长任务）。
    vi.useFakeTimers();
    const a = setup();
    const b = setup();
    a.bump(1);
    b.bump(2);

    flushMarkdownPublisherFor(a.view as never);
    expect(a.onChange).toHaveBeenCalledTimes(1);
    expect(a.onChange).toHaveBeenCalledWith("md-1");
    expect(b.onChange).not.toHaveBeenCalled();
    expect(b.serialize).not.toHaveBeenCalled();

    flushAllMarkdownPublishers();
    expect(b.onChange).toHaveBeenCalledTimes(1);
    expect(b.onChange).toHaveBeenCalledWith("md-2");

    a.pluginView.destroy();
    b.pluginView.destroy();
  });

  it("销毁时 flush 待定序列化", () => {
    vi.useFakeTimers();
    const { onChange, pluginView, bump } = setup();
    bump(9);
    pluginView.destroy();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("md-9");
  });
});

// #184 图片右键菜单生命周期测试
//
// 背景：图片右键菜单每次新建挂到 document.body，用 setTimeout(0) 注册
// document 级 mousedown close 监听；destroy() 不清理打开中的菜单与监听，
// 也无单例保护——快速连续右键叠出多份菜单，节点销毁后菜单永久残留。
//
// 验证（真实 DOM + 真实事件）：
// - 菜单结构完整（对齐三项 + 重置大小）
// - 同实例连续右键不叠加；跨实例同时只有一份菜单
// - destroy 移除菜单与 document 级监听（含定时器未触发即销毁的竞态）
// - 点击外部 / 点击菜单项均关闭菜单且监听一并清理

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { ImageNodeView } from "../../src/components/Editor/image-node-view";

/** 最小可构造的 image 节点（src 为空跳过异步路径解析） */
function fakeNode(): Node {
  return {
    attrs: { src: "", alt: "示例图片", title: null },
    type: { name: "image" },
  } as unknown as Node;
}

function makeView(): ImageNodeView {
  const view = { dispatch: vi.fn() } as unknown as PMView;
  return new ImageNodeView(fakeNode(), view, () => undefined, () => "/doc.md");
}

function openMenu(view: ImageNodeView): void {
  view.dom.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

function menus(): NodeListOf<Element> {
  return document.querySelectorAll(".image-context-menu");
}

function documentMousedownRemovals(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return spy.mock.calls.filter(([type]) => type === "mousedown");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  menus().forEach((m) => m.remove());
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("#184 图片右键菜单", () => {
  it("右键打开菜单，含对齐三项与重置大小", () => {
    const v = makeView();
    openMenu(v);

    expect(menus()).toHaveLength(1);
    const items = [...menus()[0].querySelectorAll(".image-context-item")].map(
      (b) => b.textContent,
    );
    expect(items).toEqual(["左对齐", "居中", "右对齐", "重置大小"]);

    v.destroy();
    expect(menus()).toHaveLength(0);
  });

  it("同实例快速连续右键不叠加菜单（单例）", () => {
    const v = makeView();
    openMenu(v);
    openMenu(v);
    openMenu(v);

    expect(menus()).toHaveLength(1);
    v.destroy();
  });

  it("跨图片节点同一时间只有一份菜单，旧菜单被移除", () => {
    const a = makeView();
    const b = makeView();

    openMenu(a);
    const menuA = menus()[0];
    expect(menuA.isConnected).toBe(true);

    openMenu(b);
    expect(menus()).toHaveLength(1);
    expect(menuA.isConnected).toBe(false); // A 的菜单已被关闭

    b.destroy();
    expect(menus()).toHaveLength(0);
  });

  it("节点销毁时移除打开中的菜单与 document 级监听，不再残留", () => {
    const v = makeView();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    openMenu(v);
    vi.runAllTimers(); // 让 setTimeout(0) 注册 close 监听
    expect(menus()).toHaveLength(1);

    v.destroy();

    expect(menus()).toHaveLength(0);
    expect(documentMousedownRemovals(removeSpy)).toHaveLength(1);

    // 销毁后再派发 mousedown 无任何副作用（监听已清理）
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menus()).toHaveLength(0);
    removeSpy.mockRestore();
  });

  it("定时器尚未注册监听时节点即销毁，close 监听不会被挂上", () => {
    const v = makeView();
    const addSpy = vi.spyOn(document, "addEventListener");

    openMenu(v);
    v.destroy(); // setTimeout(0) 还在排队时销毁
    vi.runAllTimers();

    expect(addSpy.mock.calls.filter(([type]) => type === "mousedown")).toHaveLength(0);
    addSpy.mockRestore();
  });

  it("点击菜单外部关闭菜单并清理监听", () => {
    const v = makeView();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    openMenu(v);
    vi.runAllTimers();
    expect(menus()).toHaveLength(1);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(menus()).toHaveLength(0);
    expect(documentMousedownRemovals(removeSpy)).toHaveLength(1);

    v.destroy();
    removeSpy.mockRestore();
  });

  it("点击菜单项执行动作后关闭菜单，监听不泄漏", () => {
    const v = makeView();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    openMenu(v);
    vi.runAllTimers();
    const btn = [...menus()[0].querySelectorAll(".image-context-item")].find(
      (b) => b.textContent === "重置大小",
    )!;

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(menus()).toHaveLength(0);
    expect(documentMousedownRemovals(removeSpy)).toHaveLength(1);

    v.destroy();
    removeSpy.mockRestore();
  });
});

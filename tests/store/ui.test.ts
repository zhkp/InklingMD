// UI store 测试
// 覆盖默认值、localStorage 恢复、toggle/set、持久化写入
// 注意：store 在模块加载时读 localStorage，需 resetModules + 动态 import 隔离

import { describe, it, expect, vi, beforeEach } from "vitest";

async function loadUI() {
  vi.resetModules();
  const mod = await import("../../src/store/ui");
  return mod.useUI;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("useUI store", () => {
  it("无持久化时使用默认值（侧边栏/大纲均可见）", async () => {
    const useUI = await loadUI();
    expect(useUI.getState().sidebarVisible).toBe(true);
    expect(useUI.getState().outlineVisible).toBe(true);
    expect(useUI.getState().zenMode).toBe(false); // 禅模式不持久化
  });

  it("从 localStorage 恢复用户偏好", async () => {
    localStorage.setItem(
      "inkling-ui",
      JSON.stringify({ sidebarVisible: false, outlineVisible: false }),
    );
    const useUI = await loadUI();
    expect(useUI.getState().sidebarVisible).toBe(false);
    expect(useUI.getState().outlineVisible).toBe(false);
  });

  it("部分持久化时缺失字段回退默认值", async () => {
    localStorage.setItem("inkling-ui", JSON.stringify({ sidebarVisible: false }));
    const useUI = await loadUI();
    expect(useUI.getState().sidebarVisible).toBe(false);
    expect(useUI.getState().outlineVisible).toBe(true); // 默认
  });

  it("localStorage 损坏时回退默认值", async () => {
    localStorage.setItem("inkling-ui", "{invalid json");
    const useUI = await loadUI();
    expect(useUI.getState().sidebarVisible).toBe(true);
  });

  it("toggleSidebar 切换并持久化", async () => {
    const useUI = await loadUI();
    expect(useUI.getState().sidebarVisible).toBe(true);
    useUI.getState().toggleSidebar();
    expect(useUI.getState().sidebarVisible).toBe(false);
    const persisted = JSON.parse(localStorage.getItem("inkling-ui")!);
    expect(persisted.sidebarVisible).toBe(false);
  });

  it("toggleOutline 切换并持久化", async () => {
    const useUI = await loadUI();
    useUI.getState().toggleOutline();
    expect(useUI.getState().outlineVisible).toBe(false);
    const persisted = JSON.parse(localStorage.getItem("inkling-ui")!);
    expect(persisted.outlineVisible).toBe(false);
  });

  it("setSidebarVisible 直接设置", async () => {
    const useUI = await loadUI();
    useUI.getState().setSidebarVisible(false);
    expect(useUI.getState().sidebarVisible).toBe(false);
    useUI.getState().setSidebarVisible(true);
    expect(useUI.getState().sidebarVisible).toBe(true);
  });

  it("toggleZenMode 切换但不持久化", async () => {
    const useUI = await loadUI();
    // 先触发一次持久化（写 sidebar/outline），确保 localStorage 有 inkling-ui 键
    useUI.getState().setSidebarVisible(false);
    useUI.getState().toggleZenMode();
    expect(useUI.getState().zenMode).toBe(true);
    // 禅模式不写入 localStorage（持久化数据里不应有 zenMode 字段）
    const raw = localStorage.getItem("inkling-ui");
    expect(raw).not.toBeNull();
    const persisted = JSON.parse(raw!);
    expect(persisted.zenMode).toBeUndefined();
    expect(persisted.sidebarVisible).toBe(false);
  });

  it("setZenMode 直接设置", async () => {
    const useUI = await loadUI();
    useUI.getState().setZenMode(true);
    expect(useUI.getState().zenMode).toBe(true);
  });

  it("持久化时保留另一个字段的值", async () => {
    const useUI = await loadUI();
    useUI.getState().setSidebarVisible(false);
    useUI.getState().toggleOutline();
    const persisted = JSON.parse(localStorage.getItem("inkling-ui")!);
    expect(persisted.sidebarVisible).toBe(false);
    expect(persisted.outlineVisible).toBe(false);
  });

  it("showNotice / dismissNotice：按 id 只关自己那条，且不持久化", async () => {
    const useUI = await loadUI();
    useUI.getState().showNotice("该文档超过 10 MB，未建立崩溃恢复副本");
    const first = useUI.getState().notice!;
    expect(first.text).toContain("未建立崩溃恢复副本");

    // 自动关闭带的是旧 id：期间来了新提示时不能把它一起关掉
    useUI.getState().showNotice("第二条");
    const second = useUI.getState().notice!;
    expect(second.id).not.toBe(first.id);
    useUI.getState().dismissNotice(first.id);
    expect(useUI.getState().notice?.id).toBe(second.id);

    useUI.getState().dismissNotice(second.id);
    expect(useUI.getState().notice).toBeNull();

    // 提示是瞬时 UI 状态，不进 localStorage
    expect(localStorage.getItem("inkling-ui") ?? "").not.toContain("未建立崩溃恢复副本");
  });
});

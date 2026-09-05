// #188 SaveIndicator 冲突入口键盘可达性
// 冲突态指示器是「自动保存已暂停」状态下唯一处理入口，之前是带 role=button
// 的 <span>——不可 Tab 聚焦、无原生 Enter/Space 语义。改真实 <button> 后：
// - 以真实 button 渲染（queryByRole("button") 可命中）
// - 点击仍触发 saveCurrent({ interactive: true })
// - 非冲突态不渲染 button（不引入多余可聚焦元素）

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SaveIndicator } from "../../src/components/Topbar/SaveIndicator";
import { useWorkspace } from "../../src/store/workspace";

beforeEach(() => {
  useWorkspace.setState({
    dirty: false,
    saving: false,
    saveError: null,
    conflictPending: false,
    lastSavedAt: null,
  });
});

describe("#188 SaveIndicator 冲突入口", () => {
  it("冲突态渲染为真实 button 且带冲突说明", () => {
    useWorkspace.setState({ conflictPending: true });
    render(<SaveIndicator />);
    const btn = screen.queryByRole("button");
    expect(btn).not.toBeNull();
    expect(btn!.tagName).toBe("BUTTON");
    expect(btn!.textContent).toContain("外部冲突");
  });

  it("点击冲突入口触发交互式保存（冲突处理）", () => {
    const saveCurrent = vi.fn();
    useWorkspace.setState({ conflictPending: true, saveCurrent });
    render(<SaveIndicator />);
    fireEvent.click(screen.getByRole("button"));
    expect(saveCurrent).toHaveBeenCalledWith({ interactive: true });
  });

  it("非冲突态不渲染 button（保持只读展示）", () => {
    render(<SaveIndicator />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

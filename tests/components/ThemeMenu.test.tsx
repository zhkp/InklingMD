import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeMenu } from "../../src/components/Topbar/ThemeMenu";
import { useTheme } from "../../src/store/theme";

afterEach(() => {
  cleanup();
  useTheme.setState({ scanIssues: [] });
});

beforeEach(() => {
  useTheme.setState({ scanIssues: [] });
});

describe("ThemeMenu scan diagnostics", () => {
  it("exposes the skipped bundled symlink path through an accessible disclosure", () => {
    const skippedPath = "/resources/themes/assets/fonts/font-link.woff2（符号链接，不跟随）";
    useTheme.setState({
      scanIssues: [`预装主题资源跳过（theme-with-assets）：${skippedPath}`],
    });

    render(<ThemeMenu open onOpenChange={vi.fn()} />);

    const toggle = screen.getByRole("menuitem", { name: "查看上次扫描提示（1 条）" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const details = screen.getByRole("group", { name: "收起扫描提示（1 条）" });
    expect(details).toBeVisible();
    expect(details).toHaveTextContent("theme-with-assets");
    expect(details).toHaveTextContent(skippedPath);
  });

  it("keeps expanded details out of the menu tab and arrow-key focus model", () => {
    useTheme.setState({ scanIssues: ["预装主题资源跳过（theme-with-assets）：font-link.woff2"] });
    render(<ThemeMenu open onOpenChange={vi.fn()} />);

    const menu = screen.getByRole("menu");
    const toggle = screen.getByRole("menuitem", { name: "查看上次扫描提示（1 条）" });
    fireEvent.click(toggle);

    const details = screen.getByRole("group", { name: "收起扫描提示（1 条）" });
    const focusableItems = Array.from(
      menu.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
    );
    expect(focusableItems.every((item) => item.getAttribute("role")?.startsWith("menuitem"))).toBe(true);
    expect(details).not.toHaveAttribute("tabindex");

    const menuItems = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const toggleIndex = menuItems.indexOf(toggle);
    expect(menuItems).not.toContain(details);
    expect(menuItems[toggleIndex + 1]).toBeDefined();

    toggle.focus();
    fireEvent.keyDown(toggle, { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItems[toggleIndex + 1]);
    expect(document.activeElement).not.toBe(details);
  });
});

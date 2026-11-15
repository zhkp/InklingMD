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
});

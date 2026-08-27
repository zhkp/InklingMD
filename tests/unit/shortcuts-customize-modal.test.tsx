import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ShortcutsCustomize } from "../../src/components/Shortcuts/ShortcutsCustomize";
import { useShortcuts, RESERVED_SHORTCUTS } from "../../src/store/shortcuts";

describe("ShortcutsCustomize reserved shortcuts", () => {
  beforeEach(() => {
    localStorage.clear();
    useShortcuts.getState().resetAll();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("RESERVED_SHORTCUTS contains fixed shortcuts", () => {
    expect(RESERVED_SHORTCUTS.some((r) => r.binding === "mod+n")).toBe(true);
    expect(RESERVED_SHORTCUTS.some((r) => r.binding === "mod+shift+f")).toBe(true);
    expect(RESERVED_SHORTCUTS.some((r) => r.binding === "mod+k")).toBe(true);
  });

  it("blocks user from binding to reserved shortcut mod+n and displays error", () => {
    const onClose = vi.fn();
    render(<ShortcutsCustomize onClose={onClose} />);

    // Click on the first shortcut button to start capturing
    const buttons = screen.getAllByTitle("点击修改");
    fireEvent.click(buttons[0]);

    expect(screen.getByText("按下组合键…")).toBeTruthy();

    // Trigger keydown for Ctrl+N
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "n",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    // Error message should appear
    expect(
      screen.getByText(/该组合为固定快捷键（新建未命名草稿），请换一个组合/),
    ).toBeTruthy();

    // Override shouldn't be set
    expect(useShortcuts.getState().overrides["find"]).toBeUndefined();
  });

  it("blocks binding to a source-mode built-in key (mod+z) and displays error", () => {
    const onClose = vi.fn();
    render(<ShortcutsCustomize onClose={onClose} />);

    const buttons = screen.getAllByTitle("点击修改");
    fireEvent.click(buttons[0]);
    expect(screen.getByText("按下组合键…")).toBeTruthy();

    // Ctrl+Z：源码模式 CM undo 占用（review 问题 2 黑名单补盲点）
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(
      screen.getByText(/已被源代码模式编辑器内置键位占用，请换一个组合/),
    ).toBeTruthy();
    expect(useShortcuts.getState().overrides["find"]).toBeUndefined();
  });
});

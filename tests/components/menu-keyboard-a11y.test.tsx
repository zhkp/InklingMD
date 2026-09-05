// #188 菜单键盘可达性
// - 右键菜单（TabContextMenu）：打开后焦点自动移入首项；方向键在可用项间移动；
//   Esc 关闭
// - 下拉菜单（ExportMenu）：打开聚焦首项 + 方向键；EditorTopbar 层 Esc 统一关闭，
//   触发器带 aria-haspopup/aria-expanded

import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TabContextMenu } from "../../src/components/Tabs/TabContextMenu";
import { ExportMenu } from "../../src/components/Topbar/ExportMenu";
import { EditorTopbar } from "../../src/components/Topbar/EditorTopbar";
import { useWorkspace, type OpenTab } from "../../src/store/workspace";

function makeTab(overrides: Partial<OpenTab> = {}): OpenTab {
  return {
    path: "/test.md",
    content: "",
    cursorPos: null,
    scrollTop: 0,
    dirty: false,
    isUntitled: false,
    lastSavedAt: null,
    ...overrides,
  };
}

function activeItemText(): string {
  const el = document.activeElement;
  return el ? (el.textContent ?? "") : "";
}

describe("#188 右键菜单（TabContextMenu）", () => {
  beforeEach(() => {
    useWorkspace.setState({
      openTabs: [
        makeTab({ path: "/a.md" }),
        makeTab({ path: "/test.md" }),
        makeTab({ path: "/c.md" }),
      ],
      activeTabPath: "/test.md",
      splitFile: null,
    });
  });

  it("菜单项带 role=menuitem，打开后焦点自动移入首项", () => {
    render(<TabContextMenu tab={makeTab()} x={0} y={0} onClose={() => {}} />);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").length).toBeGreaterThan(3);
    expect(activeItemText()).toContain("关闭");
  });

  it("ArrowDown/ArrowUp 在可用菜单项间移动焦点", () => {
    render(<TabContextMenu tab={makeTab()} x={0} y={0} onClose={() => {}} />);
    const menu = screen.getByRole("menu");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(activeItemText()).toContain("关闭其他");

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(activeItemText()).toContain("关闭右侧");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(activeItemText()).toContain("关闭其他");
  });

  it("Esc 关闭菜单", () => {
    const onClose = vi.fn();
    render(<TabContextMenu tab={makeTab()} x={0} y={0} onClose={onClose} />);
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("#188 下拉菜单（ExportMenu）", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <ExportMenu
        open={open}
        onOpenChange={setOpen}
        sourceMode={false}
        getEditor={() => undefined}
      />
    );
  }

  it("打开后焦点移入首项，方向键在菜单项间移动", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: /导出/ });
    fireEvent.click(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(activeItemText()).toContain("复制为富文本");

    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(activeItemText()).toContain("复制为 Markdown");

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(activeItemText()).toContain("复制为富文本");
  });
});

describe("#188 顶栏下拉 Esc 与触发器 ARIA（EditorTopbar）", () => {
  function renderTopbar() {
    return render(
      <EditorTopbar
        currentFile="/notes/a.md"
        sourceMode={false}
        onToggleSourceMode={() => {}}
        onToggleZenMode={() => {}}
        onToggleSidebar={() => {}}
        onOpenShortcuts={() => {}}
        onOpenSettings={() => {}}
        getEditor={() => undefined}
      />,
    );
  }

  beforeEach(() => {
    useWorkspace.setState({
      dirty: false,
      saving: false,
      saveError: null,
      conflictPending: false,
      lastSavedAt: null,
    });
  });

  it("触发器带 aria-haspopup/aria-expanded，Esc 统一关闭下拉", () => {
    renderTopbar();
    const trigger = screen.getByRole("button", { name: /导出/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});

// Quick Open 无障碍语义（#228）
//
// 采用 WAI-ARIA combobox 模式：焦点留在输入框，用 aria-activedescendant 指向高亮项。
// 这里锁定该模式的关键约束，防止后续改回「把焦点移进列表」（会打断连续输入）。

import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderQuickOpen,
  resetWorkspaceState,
  stubFileRead,
  stubIndexFiles,
} from "../fixtures/quickOpenHarness";

describe("QuickOpenPanel（a11y 语义）", () => {
  beforeEach(() => {
    stubIndexFiles(["/w/a.md", "/w/b.md"]);
    stubFileRead();
    resetWorkspaceState();
  });

  it("弹层是带标签的模态对话框", () => {
    return renderQuickOpen().then(() => {
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-label")).toBe("快速打开文件");
    });
  });

  it("输入框是 combobox，且通过 aria-controls 关联到 listbox", async () => {
    const { input } = await renderQuickOpen();

    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    const list = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(list.id).toBe("quick-open-list");
  });

  it("aria-activedescendant 始终指向 listbox 内唯一 aria-selected=true 的选项", async () => {
    const { input } = await renderQuickOpen();
    const list = screen.getByRole("listbox");

    const assertConsistent = () => {
      const activeId = input.getAttribute("aria-activedescendant");
      expect(activeId).not.toBeNull();
      const active = document.getElementById(activeId!);
      expect(active).not.toBeNull();
      expect(active!.getAttribute("role")).toBe("option");
      expect(list.contains(active!)).toBe(true);
      expect(active!.getAttribute("aria-selected")).toBe("true");
      const selected = screen
        .getAllByRole("option")
        .filter((el) => el.getAttribute("aria-selected") === "true");
      expect(selected).toHaveLength(1);
      expect(selected[0]).toBe(active);
    };

    assertConsistent();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    assertConsistent();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    assertConsistent();
  });

  it("无候选时不指向任何选项（否则读屏会指向不存在的元素）", async () => {
    stubIndexFiles([]);
    const { input } = await renderQuickOpen();

    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("输入框有可访问名称（不能只靠 placeholder）", async () => {
    const { input } = await renderQuickOpen();

    // placeholder 不作为可访问名称；只靠它读屏会把控件念成「编辑框」
    expect(input.getAttribute("aria-label")).toBe("快速打开文件");
  });

  it("Tab 被限制在面板内（aria-modal=true 的前提），Shift+Tab 反向环绕", async () => {
    const { input } = await renderQuickOpen();
    const close = screen.getByTitle("关闭 (Esc)");

    // 焦点在最后一个可聚焦控件（关闭按钮）时按 Tab → 回到面板内第一个
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    // 反向：焦点在第一个时按 Shift+Tab → 绕到最后一个（仍在面板内）
    input.focus();
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);
    expect(document.querySelector(".qo-modal")!.contains(document.activeElement)).toBe(true);
  });

  it("关闭按钮是可聚焦的真实 button（不是 div）", async () => {
    await renderQuickOpen();
    const close = screen.getByTitle("关闭 (Esc)");
    expect(close.tagName).toBe("BUTTON");
  });

  it("可聚焦控件在样式表里有可见焦点环（与 #188 约定一致）", () => {
    // 焦点环是纯视觉属性，happy-dom 无法用 getComputedStyle 真实求值，
    // 与 tests/components/aria-a11y-static.test.ts 同思路：对源文件做事实断言
    const css = readFileSync(
      resolve(process.cwd(), "src/components/QuickOpen/QuickOpenPanel.css"),
      "utf8",
    );
    expect(css).toContain(".qo-close:focus-visible");
    expect(css).toContain(".qo-retry:focus-visible");
    // 输入框用 :focus 给出边框高亮 + ring（面板的默认焦点位置）
    expect(css).toContain(".qo-input:focus");
  });
});

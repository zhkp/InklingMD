// Quick Open 面板交互单测（#228）
//
// 断言尽量落在**真实副作用**上（store 的 currentFile 是否真的切到目标文件），
// 而不是「某个 mock 被调用过」。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useWorkspace } from "../../src/store/workspace";
import * as fsApi from "../../src/lib/fs";
import {
  MAX_RENDERED_RESULTS,
} from "../../src/components/QuickOpen/QuickOpenPanel";
import {
  minimalTab,
  renderQuickOpen,
  resetWorkspaceState,
  stubFileRead,
  stubIndexFiles,
  type QuickOpenHarness,
} from "../fixtures/quickOpenHarness";

/** 读取输入框上的 aria-activedescendant（即当前高亮项 id） */
function activeOptionId(input: HTMLInputElement): string | null {
  return input.getAttribute("aria-activedescendant");
}

describe("QuickOpenPanel（交互）", () => {
  beforeEach(() => {
    stubIndexFiles([]);
    stubFileRead();
    resetWorkspaceState();
  });

  it("打开即展示全部候选，并按深度/路径稳定排序", async () => {
    stubIndexFiles(["/w/notes/readme.md", "/w/todo.md", "/w/alpha.md"]);
    await renderQuickOpen();

    const names = screen
      .getAllByRole("option")
      .map((el) => el.querySelector(".qo-item-name")?.textContent);
    // 深度相同者按 relPath 升序；notes/ 下多一层，排最后
    expect(names).toEqual(["alpha.md", "todo.md", "readme.md"]);
  });

  it("输入实时过滤：只保留命中的候选，未命中的被剔除", async () => {
    stubIndexFiles(["/w/notes/readme.md", "/w/todo.md"]);
    const { input } = await renderQuickOpen();

    fireEvent.change(input, { target: { value: "todo" } });

    expect(screen.getByText("todo.md")).toBeTruthy();
    expect(screen.queryByText("readme.md")).toBeNull();
  });

  it("无匹配时展示空态，且没有可选项", async () => {
    stubIndexFiles(["/w/todo.md"]);
    const { input } = await renderQuickOpen();

    fireEvent.change(input, { target: { value: "zzzz" } });

    expect(screen.getByText("无匹配结果")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("↑ 在首项不越界、↓ 在末项不越界", async () => {
    stubIndexFiles(["/w/a.md", "/w/b.md"]);
    const { input } = await renderQuickOpen();

    expect(activeOptionId(input)).toBe("quick-open-option-0");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeOptionId(input)).toBe("quick-open-option-0");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOptionId(input)).toBe("quick-open-option-1");

    // 已在末项，继续按 ↓ 不得越界到不存在的第 3 项
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeOptionId(input)).toBe("quick-open-option-1");
  });

  it("Enter 打开高亮项：store 的当前文件真的切过去，并关闭面板", async () => {
    stubIndexFiles(["/w/a.md", "/w/b.md"]);
    const { input, onClose } = await renderQuickOpen();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useWorkspace.getState().currentFile).toBe("/w/b.md");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("点击候选项同样能打开并关闭", async () => {
    stubIndexFiles(["/w/a.md"]);
    const { onClose } = await renderQuickOpen();

    fireEvent.click(screen.getByText("a.md"));

    await waitFor(() => {
      expect(useWorkspace.getState().currentFile).toBe("/w/a.md");
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("打开失败时保持面板开启、在面板内提示，且不误报成功（文件已被删除的场景）", async () => {
    stubIndexFiles(["/w/gone.md"]);
    vi.spyOn(fsApi, "readTextFile").mockRejectedValue(new Error("文件不存在"));
    const { input, onClose } = await renderQuickOpen();

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useWorkspace.getState().currentFile).not.toBe("/w/gone.md");
    });
    expect(onClose).not.toHaveBeenCalled();
    // 反馈必须出现在面板内：store 的 fileOpenErrors 只在侧边栏渲染，
    // 而「已删除」的路径恰恰不在文件树里（#228 评审 P3-3）
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("打开失败");
    });
    // 列表仍可操作，用户能直接改选其他候选
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
  });

  it("Esc 关闭面板", async () => {
    stubIndexFiles([]);
    const { onClose } = await renderQuickOpen();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("5,000 候选下仍只渲染上限条数，并提示继续输入以缩小范围", async () => {
    // 取 #228 验收标准的规模（5,000 文件）作为确定性断言：不依赖计时，
    // 因此可安全进 CI；真实耗时另按本机口径人工记录。
    const many = Array.from(
      { length: 5000 },
      (_, i) => `/w/d${String(i % 50).padStart(2, "0")}/f${String(i).padStart(4, "0")}.md`,
    );
    stubIndexFiles(many);
    const { input } = await renderQuickOpen();

    expect(screen.getAllByRole("option").length).toBe(MAX_RENDERED_RESULTS);
    expect(
      screen.getByText(new RegExp(`仅显示前 ${MAX_RENDERED_RESULTS} 条`)),
    ).toBeTruthy();

    // 输入过滤后同样受上限约束（不会因为命中多而放大渲染量）
    fireEvent.change(input, { target: { value: "f0" } });
    expect(screen.getAllByRole("option").length).toBeLessThanOrEqual(
      MAX_RENDERED_RESULTS,
    );
  });

  it("索引失败时展示错误与重试，重试成功后恢复列表", async () => {
    // 用「先整体拒绝、再整体放行」两阶段，而不是 mockRejectedValueOnce：
    // 组件在测试环境下 effect 会重跑一次，一次性实现会被第一次的 cleanup 吃掉。
    const listSpy = vi
      .spyOn(fsApi, "listWorkspaceFiles")
      .mockRejectedValue(new Error("工作区不存在: /w"));
    resetWorkspaceState();

    const { onClose } = await renderQuickOpen();

    expect(screen.getByText("工作区不存在: /w")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText("重试")).toBeTruthy();

    listSpy.mockResolvedValue({ files: ["/w/recovered.md"], truncated: false });
    fireEvent.click(screen.getByText("重试"));

    await waitFor(() => {
      expect(screen.getByText("recovered.md")).toBeTruthy();
    });
    expect(screen.queryByText("工作区不存在: /w")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("工作区没有 Markdown 文件时给出空态文案", async () => {
    stubIndexFiles([]);
    await renderQuickOpen();

    expect(screen.getByText("没有可打开的文件")).toBeTruthy();
  });

  it("单文件模式：候选来自已打开标签页 + 最近文件，且不调用索引命令", async () => {
    const listSpy = vi.spyOn(fsApi, "listWorkspaceFiles");
    listSpy.mockClear();
    resetWorkspaceState({
      workspaceMode: "file",
      rootPath: "/some/dir",
      openTabs: [minimalTab("/some/dir/open.md")],
      recentFiles: ["/some/dir/recent.md", "/some/dir/open.md"],
    });

    await renderQuickOpen();

    expect(listSpy).not.toHaveBeenCalled();
    const names = screen
      .getAllByRole("option")
      .map((el) => el.querySelector(".qo-item-name")?.textContent);
    expect(names).toEqual(["open.md", "recent.md"]);
  });

  it("加载完成后输入框自动获得焦点（键盘优先）", async () => {
    stubIndexFiles(["/w/a.md"]);
    const { input }: QuickOpenHarness = await renderQuickOpen();

    expect(document.activeElement).toBe(input);
  });
});

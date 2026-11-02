// 恢复面板（#365 / #378 §8.6）：只测「展示 + 选择 + 回调」，
// 真正的文件读写由 session-recovery 的用例覆盖（这里注入 props 即可）。

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RecoveryPanel } from "../../src/components/Recovery/RecoveryPanel";
import type { RecoverableDraft } from "../../src/lib/session-recovery";

function draft(tabPath: string, content: string, updatedAt = Date.now()): RecoverableDraft {
  return {
    draftId: tabPath,
    tabPath,
    isUntitled: false,
    title: tabPath.split("/").pop() ?? tabPath,
    content,
    pinned: false,
    updatedAt,
  };
}

describe("RecoveryPanel", () => {
  it("没有副本时给出说明，而不是空白面板", () => {
    render(
      <RecoveryPanel drafts={[]} onRestore={vi.fn()} onDiscard={vi.fn()} onClose={vi.fn()} />,
    );

    expect(screen.getByText("没有可恢复的副本")).toBeTruthy();
    expect(screen.queryByText("恢复选中")).toBeNull();
  });

  it("列出标题 / 大小，并可全选后一次性恢复", () => {
    const onRestore = vi.fn();
    const drafts = [draft("/w/a.md", "一二三"), draft("/w/b.md", "四五六")];
    render(
      <RecoveryPanel
        drafts={drafts}
        onRestore={onRestore}
        onDiscard={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("a.md")).toBeTruthy();
    expect(screen.getByText("b.md")).toBeTruthy();
    expect(screen.getByText("共 2 份副本")).toBeTruthy();

    fireEvent.click(screen.getByText("全选"));
    fireEvent.click(screen.getByText("恢复选中"));

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore.mock.calls[0][0]).toHaveLength(2);
    expect(onRestore.mock.calls[0][0].map((d: RecoverableDraft) => d.tabPath)).toEqual([
      "/w/a.md",
      "/w/b.md",
    ]);
  });

  it("只勾选一条时，丢弃回调只收到那条", () => {
    const onDiscard = vi.fn();
    const drafts = [draft("/w/a.md", "一"), draft("/w/b.md", "二")];
    render(
      <RecoveryPanel
        drafts={drafts}
        onRestore={vi.fn()}
        onDiscard={onDiscard}
        onClose={vi.fn()}
      />,
    );

    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[1]);
    fireEvent.click(screen.getByText("丢弃选中"));

    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard.mock.calls[0][0].map((d: RecoverableDraft) => d.tabPath)).toEqual(["/w/b.md"]);
  });

  it("未选中时按钮是禁用的（避免误触「恢复 0 条」）", () => {
    render(
      <RecoveryPanel
        drafts={[draft("/w/a.md", "一")]}
        onRestore={vi.fn()}
        onDiscard={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect((screen.getByText("恢复选中") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("丢弃选中") as HTMLButtonElement).disabled).toBe(true);
  });
});

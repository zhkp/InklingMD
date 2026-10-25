// Quick Open 面板测试的共享装配
//
// 放在 tests/fixtures 下：vitest 的 include 只收 `*.test.*` / `*.spec.*`，
// 本文件不会被当作测试文件收集。两个面板测试文件共用，避免重复装配逻辑。

import { render, screen, waitFor } from "@testing-library/react";
import { expect, vi } from "vitest";
import { QuickOpenPanel } from "../../src/components/QuickOpen/QuickOpenPanel";
import { useWorkspace, type OpenTab, type WorkspaceState } from "../../src/store/workspace";
import * as fsApi from "../../src/lib/fs";
import { __resetWorkspaceIndexForTests } from "../../src/lib/workspaceIndex";

/** 面板只读取 tab.path；其余字段给中性默认值即可 */
export function minimalTab(path: string): OpenTab {
  return {
    path,
    content: "",
    dirty: false,
    lastSavedAt: null,
    cursorPos: null,
    scrollTop: null,
  };
}

/** 让索引层拿到固定候选集，并清掉模块级缓存（否则会复用上一个用例的结果） */
export function stubIndexFiles(paths: string[]): void {
  __resetWorkspaceIndexForTests();
  vi.spyOn(fsApi, "listWorkspaceFiles").mockResolvedValue({
    files: paths,
    truncated: false,
  });
}

/** 一次可控在途的索引遍历 */
export interface PendingIndexCall {
  root: string;
  /** 以给定候选集落定这次遍历 */
  resolve: (files: string[]) => void;
  /** 让这次遍历失败 */
  reject: (error: unknown) => void;
}

/**
 * 可控在途的索引桩（复现「在途 + 失效 / TTL 过期」这类时间窗口用）
 *
 * 每次遍历都挂起，由用例自行按序落定 —— 这样才能构造出「重建在途时发生失效，
 * 于是重建结果又派生下一层 refresh」这种嵌套链（#228 TomGoh 复审 P2）。
 */
export function stubDeferredIndexFiles(): { pending: PendingIndexCall[] } {
  __resetWorkspaceIndexForTests();
  const pending: PendingIndexCall[] = [];
  vi.spyOn(fsApi, "listWorkspaceFiles").mockImplementation((root: string) => {
    return new Promise<{ files: string[]; truncated: boolean }>((resolve, reject) => {
      pending.push({
        root,
        resolve: (files) => resolve({ files, truncated: false }),
        reject,
      });
    });
  });
  return { pending };
}

/** 让「打开文件」这条链路真的能跑通（openFile → ensureTab 走成对读取，需要内容 + stat） */
export function stubFileRead(): void {
  const stat = { mtimeUs: 1_000, size: 8 };
  vi.spyOn(fsApi, "readTextFile").mockResolvedValue("# opened");
  vi.spyOn(fsApi, "fileMtime").mockResolvedValue(1);
  vi.spyOn(fsApi, "readDocument").mockResolvedValue({ content: "# opened", stat });
  vi.spyOn(fsApi, "fileStat").mockResolvedValue(stat);
}

/** 复位工作区状态到「打开了一个文件夹工作区」 */
export function resetWorkspaceState(overrides: Partial<WorkspaceState> = {}): void {
  useWorkspace.setState({
    rootPath: "/w",
    workspaceMode: "folder",
    openTabs: [],
    recentFiles: [],
    currentFile: null,
    activeTabPath: null,
    ...overrides,
  });
}

export interface QuickOpenHarness {
  onClose: ReturnType<typeof vi.fn>;
  input: HTMLInputElement;
}

/** 渲染面板并等到索引落定（不再显示「正在索引工作区…」） */
export async function renderQuickOpen(): Promise<QuickOpenHarness> {
  const onClose = vi.fn();
  render(<QuickOpenPanel onClose={onClose} />);
  // 用 role 而非 placeholder 定位：placeholder 不作为可访问名称，
  // 靠它取元素会掩盖「输入框没有可访问名称」这类缺陷（#228 评审 P3-2）
  const input = (await screen.findByRole("combobox")) as HTMLInputElement;
  await waitFor(() => {
    expect(screen.queryByText("正在索引工作区…")).toBeNull();
  });
  return { onClose, input };
}

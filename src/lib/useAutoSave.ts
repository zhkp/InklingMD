// 保存逻辑：Ctrl/Cmd+S 手动保存 + dirty 变化后防抖自动保存（支持连续失败指数退避与非阻塞模式）

import { useEffect, useRef, useState } from "react";
import { flushAllMarkdownPublishers } from "../components/Editor/markdown-publisher";
import { useWorkspace } from "../store/workspace";

const BASE_AUTOSAVE_DEBOUNCE_MS = 2000;
const MAX_AUTOSAVE_DEBOUNCE_MS = 60000;

/**
 * 挂载后监听：
 * - 全局 Ctrl/Cmd+S 键盘事件 → 立即保存
 * - dirty 变为 true 后防抖自动保存（未命名草稿与磁盘上已不存在的文件除外；支持连续失败指数退避 2s -> 4s -> 8s... -> 60s；非阻塞静默跳过冲突）
 */
export function useAutoSave() {
  const dirty = useWorkspace((s) => s.dirty);
  const saving = useWorkspace((s) => s.saving);
  const currentFile = useWorkspace((s) => s.currentFile);
  const conflictPending = useWorkspace((s) => s.conflictPending);
  // 只订阅「活跃 tab 是否未命名」这一布尔派生值，避免 openTabs 因 content 变化时重订阅 effect
  const activeTabIsUntitled = useWorkspace((s) => {
    const tab = s.openTabs.find((t) => t.path === s.activeTabPath);
    return tab?.isUntitled ?? false;
  });
  // issue #363：活跃文件已不在磁盘原处时暂停自动保存，绝不悄悄写回
  const activeTabDeletedOnDisk = useWorkspace((s) => {
    const tab = s.openTabs.find((t) => t.path === s.activeTabPath);
    return tab?.deletedOnDisk ?? false;
  });
  const saveCurrent = useWorkspace((s) => s.saveCurrent);

  // 连续失败次数计数器：按文件维护（issue #149），
  // 避免一个文件的失败退避连带拖慢其他文件的自动保存
  const failCountRef = useRef<Map<string, number>>(new Map());
  // saveCurrent flips `saving` back to false (re-running this effect) before
  // the timer callback can increment failCount, so the effect schedules a
  // base-delay timer with a stale count. Bump a revision after the increment
  // so the effect replaces that premature timer with the correct backoff timer.
  const [retryRevision, setRetryRevision] = useState(0);

  // 手动保存快捷键
  useEffect(() => {
    function onKeydown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      // 排除 Alt/Shift，避免与 Ctrl/Cmd+Alt+S（源代码模式）等组合键冲突
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // 先 flush 防抖窗口内的序列化，再保存，否则可能保存旧内容
        flushAllMarkdownPublishers();
        void saveCurrent({ interactive: true });
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [saveCurrent]);

  // 自动保存：dirty 且非保存中且非未命名草稿时，防抖触发（指数退避）
  useEffect(() => {
    if (!dirty || saving || !currentFile) return;
    if (activeTabIsUntitled) return;
    // 文件已被删除 / 移动：等用户经 Ctrl+S 或状态栏入口决定去向，或文件恢复后由监听器解除
    if (activeTabDeletedOnDisk) return;
    // 冲突待处理：暂停自动保存，等待用户通过冲突对话框处理（issue #149）。
    // 否则冲突态下每 2 秒 stat + 全量读盘空转一次，形成隐性 IO 风暴
    if (conflictPending) return;

    const filePath = currentFile;
    // 指数退避：fails = 0 -> 2s, 1 -> 4s, 2 -> 8s... 最大 60s
    const fails = failCountRef.current.get(filePath) ?? 0;
    const delay = fails === 0
      ? BASE_AUTOSAVE_DEBOUNCE_MS
      : Math.min(MAX_AUTOSAVE_DEBOUNCE_MS, BASE_AUTOSAVE_DEBOUNCE_MS * Math.pow(2, fails));

    const timer = window.setTimeout(async () => {
      // 脏状态可能来自上一次保存；定时器到点时最新编辑或仍在防抖窗口内，
      // 与手动保存同样先 flush，避免保存旧内容（PR #34 review）
      flushAllMarkdownPublishers();
      const bumpFail = () => {
        const next = Math.min((failCountRef.current.get(filePath) ?? 0) + 1, 6);
        failCountRef.current.set(filePath, next);
      };
      try {
        await saveCurrent({ interactive: false });
        const state = useWorkspace.getState();
        if (!state.dirty && !state.saveError && !state.conflictPending) {
          failCountRef.current.delete(filePath);
        } else if (state.saveError) {
          bumpFail();
          setRetryRevision((revision) => revision + 1);
        } else if (state.conflictPending) {
          // 冲突态自动保存已被上方暂停（effect 早退不调度定时器），
          // 无需替换定时器，仅累计退避计数
          bumpFail();
        }
      } catch {
        bumpFail();
        setRetryRevision((revision) => revision + 1);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [
    dirty,
    saving,
    currentFile,
    activeTabIsUntitled,
    activeTabDeletedOnDisk,
    conflictPending,
    saveCurrent,
    retryRevision,
  ]);
}

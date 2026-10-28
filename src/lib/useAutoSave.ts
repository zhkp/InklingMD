// 保存逻辑：Ctrl/Cmd+S 手动保存 + **按 path 独立防抖**的自动保存（#364）
//
// 旧实现只订阅「活跃 tab 是否 dirty」：保存期间若又有输入，保存完 tab 仍是 dirty，
// 派生值不变 → effect 不重跑 → 该 path 再也不会排下一次保存；同一 path 继续编辑
// 也不会重置 2s。现在订阅键带上 `pathRevs` 的内容版本，任何一次真实编辑都会让
// 该 path 的防抖重新计时。

import { useEffect, useRef, useState } from "react";
import { flushAllMarkdownPublishers } from "../components/Editor/markdown-publisher";
import { useWorkspace } from "../store/workspace";
import { getPathRev } from "../store/workspace/shared";

const BASE_AUTOSAVE_DEBOUNCE_MS = 2000;
const MAX_AUTOSAVE_DEBOUNCE_MS = 60000;

/**
 * 挂载后监听：
 * - 全局 Ctrl/Cmd+S → 立即保存当前 tab；
 * - 每个 dirty tab 独立 2s 防抖（指数退避 2s→4s→…→60s），逐个 `saveTab(path, {interactive:false})`。
 *   未命名草稿 / 已删除 / 冲突待处理的 tab 不进调度（非交互 `saveTab` 里也有同样的早退，双保险）。
 */
export function useAutoSave() {
  const saveTab = useWorkspace((s) => s.saveTab);

  // 订阅键：path + 内容版本 + dirty/saving/deleted/conflict/untitled。
  // 带 rev 是必须的：保存期间的新输入不改变 dirty 派生值，只有 rev 会变。
  const saveKey = useWorkspace((s) =>
    s.openTabs
      .map(
        (t) =>
          // 不带 `saving`：保存开始/结束都会改变它，会让 effect 重跑并提前重排一次，
        // 把「失败后退避 4s」打回 2s（退避测试正是靠这条）
        `${t.path}#${getPathRev(t.path)}#${t.dirty ? 1 : 0}` +
          `${t.deletedOnDisk ? 1 : 0}${t.conflictPending ? 1 : 0}${t.isUntitled ? 1 : 0}`,
      )
      .join("|"),
  );

  // 连续失败次数：按 path 维护（issue #149），一个文件的失败退避不拖慢其它文件
  const failCountRef = useRef<Map<string, number>>(new Map());
  /** 每个 path 当前挂着的定时器 */
  const timersRef = useRef<Map<string, number>>(new Map());
  /** 每个 path 上次调度时的内容版本：rev 没变就不重置它的防抖 */
  const seenRevRef = useRef<Map<string, number>>(new Map());
  // 递增后重跑 effect，把「失败后按退避重排」这件事交给同一段调度逻辑
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
        const activePath = useWorkspace.getState().activeTabPath;
        if (activePath) void saveTab(activePath, { interactive: true });
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [saveTab]);

  // 按 path 独立调度
  useEffect(() => {
    const clearTimer = (path: string) => {
      const timer = timersRef.current.get(path);
      if (timer !== undefined) window.clearTimeout(timer);
      timersRef.current.delete(path);
    };

    const schedule = (path: string) => {
      const fails = failCountRef.current.get(path) ?? 0;
      const delay =
        fails === 0
          ? BASE_AUTOSAVE_DEBOUNCE_MS
          : Math.min(MAX_AUTOSAVE_DEBOUNCE_MS, BASE_AUTOSAVE_DEBOUNCE_MS * Math.pow(2, fails));

      const timer = window.setTimeout(async () => {
        timersRef.current.delete(path);
        // 定时器到点时可能又有新输入：与手动保存同样先 flush，避免保存旧内容（PR #34 review）
        flushAllMarkdownPublishers();
        // 先记一次尝试再写盘：失败后的重排必须按退避，不能被「保存中 / 保存完」的
        // 状态变化提前重排一次（那会把 4s 退避打回 2s）
        failCountRef.current.set(path, Math.min((failCountRef.current.get(path) ?? 0) + 1, 6));
        try {
          await saveTab(path, { interactive: false });
          const tab = useWorkspace.getState().openTabs.find((t) => t.path === path);
          if (!tab) {
            // tab 已关闭：清理退避与版本记忆
            failCountRef.current.delete(path);
            seenRevRef.current.delete(path);
            return;
          }
          if (!tab.dirty && !tab.conflictPending) {
            failCountRef.current.delete(path);
            return;
          }
          // 仍是 dirty（保存期间又编辑了 / 写盘失败）：按退避再排一次
          if (tab.conflictPending || tab.deletedOnDisk) return; // 交给用户处理，不空转
          setRetryRevision((revision) => revision + 1);
        } catch {
          failCountRef.current.set(path, Math.min((failCountRef.current.get(path) ?? 0) + 1, 6));
          setRetryRevision((revision) => revision + 1);
        }
      }, delay);

      timersRef.current.set(path, timer);
    };

    const state = useWorkspace.getState();
    for (const tab of state.openTabs) {
      // 未命名草稿（交互另存为才有意义）、已删除、冲突待处理：不进调度
      if (!tab.dirty || tab.saving || tab.isUntitled) continue;
      if (tab.deletedOnDisk || tab.conflictPending) continue;

      const rev = getPathRev(tab.path);
      if (seenRevRef.current.get(tab.path) === rev && timersRef.current.has(tab.path)) {
        continue; // 内容版本没变：保留已有防抖，不重置
      }
      seenRevRef.current.set(tab.path, rev);
      clearTimer(tab.path);
      schedule(tab.path);
    }

    // 不再 dirty / 已关闭的 path：撤掉定时器
    for (const path of [...timersRef.current.keys()]) {
      const tab = state.openTabs.find((t) => t.path === path);
      if (!tab || !tab.dirty || tab.saving || tab.deletedOnDisk || tab.conflictPending) {
        clearTimer(path);
      }
    }

    // 注意：**不能**在这里清空全部定时器。effect 每次重跑（任何 tab 的 rev 变化）都会
    // 执行 cleanup，清空会让所有 path 的防抖一起重来 —— A 里连续输入会把 B 的保存
    // 无限推迟（饥饿）。这里只做「不再符合条件的 path」的清理（见上方循环）。
  }, [saveKey, retryRevision, saveTab]);

  // 卸载时清空所有定时器（单独一个 effect，只跑一次 cleanup）
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
}

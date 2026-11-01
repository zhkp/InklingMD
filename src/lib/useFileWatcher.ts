// 文件变更监听（#362 M0 / M2）
//
// 轮询**所有**非草稿 tab 的磁盘身份，判定统一交给 store 的 `verifyTabOnDisk`：
// - stat 分类：`notFound` / `notAFile` → 删除态；权限 / IO → 只记 tab 错误、保留基线；
// - 基线未变 → 什么都不做（不再维护 `knownMtimes` 影子状态）；
// - 变了 → 成对读盘 → 先比内容 → adopt / 静默重载 / 冲突（只有活跃 tab 弹窗）。
//
// 为什么不再需要「保存后 2 秒忽略窗」：保存回执把写盘后的新身份直接登记成基线，
// watcher 拿 stat 比对自然命中，不存在「自家写盘被当成外部修改」的窗口。

import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useWorkspace } from "../store/workspace";
import { useConflict } from "../store/conflict";

const POLL_INTERVAL = 3000;

export function useFileWatcher(): void {
  useEffect(() => {
    if (!isTauri()) return;

    let timer: number | null = null;
    let cancelled = false;
    // 聚焦事件与定时器可能同时触发：并发跑两轮会让同一冲突弹两次窗
    let inFlight = false;

    const check = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await runCheck();
      } finally {
        inFlight = false;
      }
    };

    const runCheck = async () => {
      const state = useWorkspace.getState();
      if (state.openTabs.length === 0) return;
      const isConflictOpen = Boolean(useConflict.getState().conflict);

      // 在途保存的 tab 跳过：写完会自己登记基线，中途读盘只会制造假冲突
      const tabs = state.openTabs.filter((t) => !t.isUntitled && !t.saving);
      for (const tab of tabs) {
        if (cancelled) return;
        // 只有活跃 tab 允许弹窗；后台 tab 只做静默对齐 / 标记 conflictPending
        const interactive =
          tab.path === useWorkspace.getState().activeTabPath && !isConflictOpen;
        try {
          await useWorkspace.getState().verifyTabOnDisk(tab.path, {
            interactive,
            // watcher 是唯一持续观察后台 tab 的入口：后台冲突必须留痕（状态栏可见），
            // 否则用户切回去之前完全不知道磁盘变了
            markBackgroundConflict: true,
          });
        } catch (err) {
          // 单个 tab 的核验异常不能中断整轮检查（否则后面的 tab 永远轮不到）
          console.warn("[watcher] 核验失败", tab.path, err);
        }
      }
    };

    // 启动即核验一次：窗口可能刚从后台回来，tab 基线还是切走前的
    void check();
    timer = window.setInterval(check, POLL_INTERVAL);

    const onFocusOrVisible = () => {
      void check();
    };
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);

    // 切走文件时关掉残留的冲突对话框（上下文已失配）
    let lastFile = useWorkspace.getState().currentFile;
    const unsub = useWorkspace.subscribe((s) => {
      if (s.currentFile !== lastFile) {
        lastFile = s.currentFile;
        if (useConflict.getState().conflict) {
          useConflict.getState().dismiss();
        }
      }
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
      unsub();
    };
  }, []);
}

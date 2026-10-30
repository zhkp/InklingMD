import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { flushAllMarkdownPublishers } from "../components/Editor/markdown-publisher";
import { useWorkspace } from "../store/workspace";
import {
  flushAllDrafts,
  hasRecoverableDraft,
  markCleanExit,
  markUncleanExit,
} from "./exit-session";

const RETRY = "重试保存";
const DISCARD = "放弃并退出";
const CANCEL = "取消退出";
/** 第 3 轮仍失败就不再询问，直接进「放弃」分支（与 exit-save-retry-vs-discard 一致） */
const MAX_ATTEMPTS = 2;

/**
 * 关闭窗口前保存所有 dirty tab（#367）。
 *
 * 顺序按设计 §7.3：
 * ① flush 编辑器 → ② `flushAllDrafts()`（PR-4 阶段无正文，立即 resolve）
 * ③ `waitForSaves()` → 逐 tab 交互式 `saveTab(path)` → 再 `waitForSaves()`
 * ④ 仍有未解决项：三选一（重试 / 放弃并退出 / 取消退出）；第 3 轮强制放弃
 * ⑤ 放弃前：`markUncleanExit()` 失败则**不允许 destroy**；正常退出 `markCleanExit()` 失败只警告
 */
export function useExitHandler(): void {
  const closeInProgressRef = useRef(false);

  useEffect(() => {
    const handleBeforeUnload = () => {
      flushAllMarkdownPublishers();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);

    let disposed = false;
    let unlistenClose: (() => void) | undefined;
    if (isTauri()) {
      const win = getCurrentWindow();
      void win
        .onCloseRequested(async (event) => {
          event.preventDefault();
          if (closeInProgressRef.current) return;
          closeInProgressRef.current = true;
          const originalActivePath = useWorkspace.getState().activeTabPath;

          try {
            // ①② 先把编辑器内容与 draft 落盘
            flushAllMarkdownPublishers();
            await flushAllDrafts({ durability: "sync" });

            let attempt = 0;
            // ③④ 线性循环：每轮只做一件事
            for (;;) {
              const ws = useWorkspace.getState();
              await ws.waitForSaves();

              // 逐个处理仍未解决的 tab（每个 path 只处理一次）
              for (const tab of useWorkspace.getState().openTabs) {
                // 该 path 还有在途写盘（例如刚按过 Ctrl+S）：先等它落定，别再叠一次
                if (useWorkspace.getState().isSaveInFlight(tab.path)) {
                  await useWorkspace.getState().waitForSaves(tab.path);
                }
                // 只算「有未保存内容」的 tab：deletedOnDisk 但干净的文件没有可丢内容（设计 §7.3）
                if (!tab.dirty) continue;
                // 已解决（保存过程中被别的路径合并/关闭）就跳过
                const fresh = useWorkspace.getState().openTabs.find((t) => t.path === tab.path);
                if (!fresh || !fresh.dirty) continue;
                try {
                  await useWorkspace.getState().saveTab(tab.path, { interactive: true });
                } catch {
                  // 单个 tab 失败不能拦住后面的 tab
                }
              }

              await useWorkspace.getState().waitForSaves();

              const unresolved = useWorkspace
                .getState()
                .openTabs.filter((t) => t.dirty);
              if (unresolved.length === 0) break;

              attempt += 1;
              const choice = await askExitChoice(unresolved.length, attempt);
              if (choice === CANCEL) {
                if (originalActivePath) useWorkspace.getState().switchTab(originalActivePath);
                return;
              }
              if (choice === RETRY) continue;
              // DISCARD 或超过重试上限 → 走「放弃并退出」
              if (!(await confirmDiscard(unresolved.length))) {
                if (originalActivePath) useWorkspace.getState().switchTab(originalActivePath);
                return;
              }
              await flushAllDrafts({ durability: "sync" });
              await useWorkspace.getState().waitForSaves();
              if (!(await markUncleanExit())) {
                // 连「记录放弃」都写不进去：不允许 destroy，否则下次启动既看不到也恢复不了
                const { showMessage } = await import("./dialogs");
                await showMessage(
                  "无法写入退出标记，已取消退出。请检查磁盘空间或权限后重试。",
                  { kind: "error", title: "退出失败" },
                );
                if (originalActivePath) useWorkspace.getState().switchTab(originalActivePath);
                return;
              }
              await win.destroy();
              return;
            }

            // ⑤ 正常退出
            const ok = await markCleanExit();
            if (!ok) {
              const { showMessage } = await import("./dialogs");
              await showMessage("部分恢复副本未能清理，下次启动可恢复。", {
                kind: "warning",
                title: "退出",
              });
            }
            await win.destroy();
          } finally {
            closeInProgressRef.current = false;
          }
        })
        .then((unlisten) => {
          if (disposed) {
            unlisten();
          } else {
            unlistenClose = unlisten;
          }
        });
    }

    return () => {
      disposed = true;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unlistenClose?.();
    };
  }, []);
}

/** 三选一；超过重试上限直接返回 DISCARD（不再询问） */
async function askExitChoice(unresolvedCount: number, attempt: number): Promise<string> {
  if (attempt > MAX_ATTEMPTS) return DISCARD;
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    const choice = await message(
      `有 ${unresolvedCount} 个文件未能保存。可以重试、放弃并退出，或取消退出继续编辑。`,
      {
        title: "退出前保存",
        kind: "warning",
        buttons: { yes: RETRY, no: DISCARD, cancel: CANCEL },
      },
    );
    // 自定义按钮在不同平台可能回传按钮文字或 Yes/No
    if (choice === RETRY || choice === "Yes") return RETRY;
    if (choice === DISCARD || choice === "No") return DISCARD;
    return CANCEL;
  } catch {
    // 弹窗异常一律按「取消退出」处理：绝不因为对话框报错丢内容
    return CANCEL;
  }
}

/** 没有恢复副本时的二选一确认；返回 true 表示仍然退出 */
async function confirmDiscard(unresolvedCount: number): Promise<boolean> {
  // PR-4 还没有 draft 正文：此时「没有恢复副本」是事实，不是假承诺
  if (hasRecoverableDraft()) return true;
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    const choice = await message(
      `其中 ${unresolvedCount} 个文档没有恢复副本，退出将永久丢失这些修改。仍然退出？`,
      { title: "退出确认", kind: "warning", buttons: { ok: DISCARD, cancel: CANCEL } },
    );
    return choice === DISCARD || choice === "Ok" || choice === "Yes";
  } catch {
    return false;
  }
}

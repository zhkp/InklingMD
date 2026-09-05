// 启动时打开目标文件，三种来源：
// 1. 多窗口派生：URL 查询参数 inklingFile（由「在新窗口打开」创建的窗口）
// 2. 文件关联双击（首次启动）：Rust 端从 argv 提取，前端就绪后 take_pending_file 拉取
// 3. 单实例转发（程序已运行时双击 .md）：Rust 端 emit open-file 事件到存活窗口
import { useEffect } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getNewWindowFilePath } from "./newWindow";
import { useWorkspace } from "../store/workspace";

export function useStartupFile() {
  useEffect(() => {
    if (!isTauri()) return;
    const open = useWorkspace.getState().openFileStandalone;
    let cancelled = false;

    // 派生窗口：打开自身的派生目标；不参与 pending（避免与自身 inklingFile 重复打开）
    const winTarget = getNewWindowFilePath();
    if (winTarget) {
      void open(winTarget).catch(() => {});
    } else {
      // 主窗口：拉取首次启动的待打开文件
      void invoke<string | null>("take_pending_file")
        .then((p) => {
          if (!cancelled && p) void open(p).catch(() => {});
        })
        .catch(() => {
          // issue #171：take_pending_file 失败（Rust 命令异常等）不应放大成启动即
          // 崩溃——记日志降级，用户照常进入编辑器、可手动打开文件。
          console.warn("[useStartupFile] take_pending_file 失败，跳过待打开文件");
        });
    }

    // 所有窗口都监听单实例转发的双击打开事件。Rust 端把事件定向到存活窗口：
    // 主窗口存活时是 "main"；主窗口被关闭而派生窗口存活时退回应答的派生窗口
    // （issue #147）。因此派生窗口也必须注册监听，否则主窗口关闭后双击 .md
    // 会静默失效。
    const unlisten = listen<string>("open-file", (e) => {
      if (!cancelled) void open(e.payload).catch(() => {});
    });

    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, []);
}

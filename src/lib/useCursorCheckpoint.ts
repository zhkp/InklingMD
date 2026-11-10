// 失焦 / 页面隐藏时把还没落盘的光标 checkpoint 刷出去（设计 §8.2）

import { useEffect } from "react";
import { flushCursorCheckpoint } from "./cursor-checkpoint";

export function useCursorCheckpoint(): void {
  useEffect(() => {
    const flush = () => {
      void flushCursorCheckpoint("none");
      // 设计 §8.2：失焦 / hidden 时还要把仍 dirty 的草稿以 Sync 重写一次。
      // 动态导入避免 hook 与退出模块形成静态循环依赖
      void import("./exit-session").then(({ flushAllDrafts }) =>
        flushAllDrafts({ durability: "sync" }),
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("blur", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      // 卸载（含 StrictMode 重挂）也要落一次，避免丢最后一次光标
      void flushCursorCheckpoint();
    };
  }, []);
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isBenignGlobalError } from "./lib/crash-guard";

// 全局错误兜底：捕获 React effect 里抛出的未捕获错误（如 Milkdown 初始化失败）。
// React 18 production 下 effect 内的同步错误会冒泡到 window error 事件，
// 此时整棵树已被卸载变白屏，这里注入恢复 UI 并显示错误信息。
// issue #171：只对真正致命的 window error 触发崩溃页——
// - ResizeObserver loop 等良性噪音与空 message（跨域 "Script error."）直接忽略
// - 未捕获 rejection 多为可恢复的异步链断裂，只记日志不整页崩溃
let errorReported = false;
const showCrashUI = (message: string) => {
  if (errorReported) return;
  errorReported = true;
  const root = document.getElementById("root");
  if (!root) return;
  root.innerHTML = `
    <div style="padding:48px 24px;max-width:720px;margin:0 auto;font-family:system-ui,sans-serif;color:#1f2328;">
      <h2 style="color:#cf222e;">⚠️ 应用崩溃</h2>
      <p>InklingMD 编辑器初始化时发生错误。请把以下错误信息反馈给开发者：</p>
      <pre style="background:#f6f8fa;padding:16px;border-radius:6px;overflow:auto;font-size:12px;border:1px solid #d0d7de;">${message}</pre>
      <button id="__inkling_reload" style="margin-top:16px;padding:8px 18px;font-size:14px;background:#2f81f7;color:#fff;border:none;border-radius:6px;cursor:pointer;">重新加载</button>
    </div>
  `;
  const btn = document.getElementById("__inkling_reload");
  if (btn) btn.addEventListener("click", () => window.location.reload());
};

window.addEventListener("error", (e) => {
  const msg = e.error?.stack || e.error?.message || e.message || String(e.error || e);
  if (isBenignGlobalError(msg)) {
    // ResizeObserver loop 等良性噪音：记录但不打断用户
    console.warn("[crash-guard] 忽略已知良性错误：", msg);
    return;
  }
  console.error("[crash-guard] 未捕获错误，触发崩溃页：", msg);
  showCrashUI(msg);
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason?.stack || e.reason?.message || String(e.reason || "");
  if (isBenignGlobalError(msg)) {
    console.warn("[crash-guard] 忽略已知良性 rejection：", msg);
    return;
  }
  // issue #171：未捕获 rejection 通常只代表异步链断裂，应用主体仍可用，
  // 记日志即可——整页崩溃只留给会卸载 React 树的同步 error。
  console.error("[crash-guard] 未捕获的 Promise rejection（不替换界面）：", e.reason);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.DEV) {
  // @ts-ignore
  import("./store/conflict").then(({ useConflict }) => {
    // @ts-ignore
    window.__triggerConflict = (conflict: any) => useConflict.getState().openConflict(conflict);
  });
}

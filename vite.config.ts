import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const isTauriDev = !!process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST || "127.0.0.1";

/**
 * #223/#224（G5/N2/S13/S16）：把 3 个无法在业务源码侧包裹的 vendor CSS
 * （node_modules 内文件 + 懒加载 katex）在构建管线里整体包进 @layer base。
 * dev 与 build 同一管线，保证 S13（dev E2E）与 S16（产物完全层化）同时成立，
 * 并保持 manualChunks 的 CSS 资产命名：
 *   - vendor_milkdown.css：prosemirror.css / tables.css
 *   - vendor_katex.css：katex/dist/katex.min.css（懒加载，含 20 条 @font-face）
 *
 * 实现要点（实测）：
 * - katex.min.css 由 JS 直接 import，会经过本 transform → 直接包裹；
 * - @milkdown/kit 的入口文件内容只有一行 `@import '@milkdown/prose/…'`，
 *   Vite 对 CSS @import 的内联目标是直接读盘、绕过 transform 的，
 *   因此在 stub 上拦截，this.resolve 出真实文件后读出并包裹（等价内联）。
 */
const KIT_STUB_RE =
  /@milkdown\/kit\/(?:lib|src)\/prose\/(?:view|tables)\/style\/(prosemirror|tables)\.css(?:\?.*)?$/;
const KATEX_RE = /katex\/dist\/katex\.min\.css(?:\?.*)?$/;

function themeBaseLayerPlugin(): PluginOption {
  return {
    name: "inkling-theme-base-layer",
    enforce: "pre",
    async transform(code, id) {
      const normalized = id.replace(/\\/g, "/");
      if (KATEX_RE.test(normalized)) {
        return { code: `@layer base {\n${code}\n}\n`, map: null };
      }
      const stub = normalized.match(KIT_STUB_RE);
      if (stub) {
        const importSpec = code.match(/@import\s+["']([^"']+)["']/)?.[1];
        if (importSpec) {
          const resolved = await this.resolve(importSpec, id);
          const targetId = resolved?.id.split("?")[0];
          if (targetId) {
            const target = readFileSync(targetId, "utf8");
            return { code: `@layer base {\n${target}\n}\n`, map: null };
          }
        }
      }
      return null;
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), themeBaseLayerPlugin()],

  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("mermaid")) return "vendor_mermaid";
            if (id.includes("katex")) return "vendor_katex";
            if (id.includes("@milkdown")) return "vendor_milkdown";
            if (id.includes("@codemirror") || id.includes("codemirror")) return "vendor_codemirror";
            if (id.includes("react") || id.includes("zustand")) return "vendor_framework";
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    // 仅 Tauri 场景（TAURI_DEV_HOST 已设置）强制 HMR 走固定端口 1421；
    // 浏览器（E2E）场景下通过 CLI 覆盖 server.port（如 --port 3000）时，
    // HMR 自动跟随 server 端口，避免写死 1421 在系统保留端口段导致 WS 断连崩溃。
    hmr: isTauriDev
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : true,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` 与依赖目录，避免触及 inotify 上限
      ignored: ["**/src-tauri/**", "**/node_modules/**", "**/.pnpm-store/**"],
    },
  },
}));

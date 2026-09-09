// Vitest 配置
// 复用 Vite 的 React 插件转译管线，单元/组件测试零额外配置。
// E2E 走 Playwright 独立配置（playwright.config.ts），不在此处。

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // happy-dom 比 jsdom 轻量快速，足够覆盖组件测试
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    // tests/perf 走独立 Playwright 配置与 npm run benchmark，不能被 Vitest 收走
    exclude: ["tests/e2e/**", "tests/perf/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/**/*.d.ts", "src-tauri/**"],
    },
  },
});

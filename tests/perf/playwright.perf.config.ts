// 性能 Benchmark 的独立 Playwright 配置（issue #216）
//
// 与 playwright.config.ts（功能 E2E）刻意分开，差异全部服务于"测量可信"：
// - workers 1 / fullyParallel false：并发会互相抢占 CPU，测量值不可比
// - retries 0：不靠重试掩盖 flaky（#214 教训），flaky 靠 warm-up + 多轮 + median 消化
// - trace/screenshot/video 全关：录制本身会拖慢页面，污染测量
// - 关闭后台节流：避免窗口不可见时被降频，导致帧间隔虚高
//
// 端口：默认 1420（CI 正常）。本机 Windows 把 1350–2149 划入动态保留端口段，
// 需 PERF_PORT=3000 覆盖（vite.config.ts 的 HMR 已跟随 server 端口，无需另改）。

import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PERF_PORT ?? 1420);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  reporter: [["list"], ["json", { outputFile: ".perf-output/pw-report.json" }]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    screenshot: "off",
    video: "off",
    launchOptions: {
      args: [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

// 把大文档 fixture 注入浏览器 mock 文件系统（issue #216）
//
// 范式来自 tests/e2e/source-mode-scroll-race.spec.ts:41-49：
// 浏览器模式（isTauri() === false）下，fs.ts 的 readTextFile 读的是 mockFs.ts 的
// MOCK_FILE_CONTENT 常量。用 Vite dev 的运行时 import 拿到同一个模块实例后直接改写，
// 即可让「打开文件」读到任意大小的 fixture，完全不需要改动生产代码。
//
// 两条必须遵守的约束（违反会静默失效）：
// 1. import 路径必须带 .ts 扩展名——无扩展的 specifier 会被 Vite 解析成另一个模块 URL，
//    生成第二份 MOCK_FILE_CONTENT，注入不生效。
// 2. 必须在 page.goto() 之后注入；任何一次新的 goto 都会重置模块状态，注入丢失。

import type { Page } from "@playwright/test";

/** 主文档槽位：覆盖 mock 工作区里已存在的 readme.md 内容 */
export const PERF_DOC_PATH = "/mock-workspace/notes/readme.md";

/** 副文档槽位：tab-switch 场景需要一个第二标签 */
export const PERF_SECOND_DOC_PATH = "/mock-workspace/notes/todo.md";

/** 把 content 写入指定路径的 mock 文件内容槽 */
export async function injectFile(
  page: Page,
  path: string,
  content: string,
): Promise<void> {
  // 生产构建口径：mock 内容由 main.tsx 动态 import 后异步挂到 window，
  // 页面 load 与它完成之间没有顺序保证——先等它到位再注入（dev 下没有该全局，
  // 走 `/src/lib/mockFs.ts` 同步可用，不必等）。
  if (process.env.PERF_BUILD === "prod") {
    await page.waitForFunction(
      () =>
        (window as unknown as { __perfMockFs?: unknown }).__perfMockFs !==
        undefined,
      undefined,
      { timeout: 15_000 },
    );
  }
  await page.evaluate(
    async (arg: { path: string; content: string }) => {
      // 生产构建口径（#420）：`main.tsx` 在 `PERF_BUILD=prod` 的构建里把 mock
      // 内容挂到 window；dev server 下没有这个全局，回落到 Vite 的绝对模块路径。
      const fromWindow = (
        window as unknown as { __perfMockFs?: Record<string, string> }
      ).__perfMockFs;
      const MOCK_FILE_CONTENT =
        fromWindow ??
        (
          (await import(
            // @ts-ignore Vite dev 专用绝对模块路径（运行时可用，TS 无对应声明）
            "/src/lib/mockFs.ts"
          )) as { MOCK_FILE_CONTENT: Record<string, string> }
        ).MOCK_FILE_CONTENT;
      MOCK_FILE_CONTENT[arg.path] = arg.content;
    },
    { path, content },
  );
}

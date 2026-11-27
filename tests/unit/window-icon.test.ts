// #432：窗口图标必须在 `run` 之前装进 context，否则修复会静默回退。
//
// 运行期事实（tauri-2.11.5）：`Builder::build()` 里 `AppManager::with_handlers(context, …)`
// 就把 `context.default_window_icon` 取走了（manager/mod.rs），窗口创建时再由
// `prepare_window` 注入。`.setup()` 在 build 之后才执行，图标此时再设置已经晚了；
// 窗口按 codegen 的 ICO 首档 16×16 建好，任务栏发糊的 bug 原样回归。
//
// Rust 单测只能证明 `high_resolution_window_icon()` 解出 256×256，
// 删掉注入、改成 `None` 或挪进 `.setup()` 时它们仍然全绿，所以这里直接锚定
// 源码调用位置，作为不需要 GUI runner 的确定性守卫。
// 同类做法先例：tests/unit/capabilities.test.ts、tests/unit/app-data-root.test.ts。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const libRs = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");

describe("#432 窗口图标注入时序（源码锚定，无需 GUI runner）", () => {
  it("set_default_window_icon 作用在 run 的同一个 context 上，且早于 run 与 setup", () => {
    // `.run(context)` 是唯一终点：解析实际传给 builder 的变量名
    const runCalls = [...libRs.matchAll(/\.run\(\s*(\w+)\s*\)/g)];
    expect(runCalls).toHaveLength(1);
    const runContext = runCalls[0][1];
    const runIndex = runCalls[0].index ?? -1;

    // 注入只允许一处，且接收者必须与 run 的实参是同一个变量——
    // 防止「给一个被丢弃的 context 设图标，run 用另一个」的假修复
    const injections = [...libRs.matchAll(/(\w+)\.set_default_window_icon\(\s*Some\(/g)];
    expect(injections).toHaveLength(1);
    expect(injections[0][1]).toBe(runContext);
    const injectionIndex = injections[0].index ?? -1;

    // ① 必须在 `.run(...)` 之前：窗口管理器在 build 期就取走了默认图标
    expect(injectionIndex, "窗口图标注入必须位于 .run(context) 之前").toBeLessThan(runIndex);

    // ② 不能落在 `.setup(` 之后：那是 build 完成后的回调，窗口图标已经定下来了
    const setupIndex = libRs.indexOf(".setup(");
    expect(setupIndex).toBeGreaterThan(-1);
    expect(
      injectionIndex,
      "窗口图标注入不得挪进 .setup()（窗口已按默认图标创建）",
    ).toBeLessThan(setupIndex);

    // ③ 注入的必须是解码出的高清图标，而不是把默认图标清空
    const injectionBlock = libRs.slice(Math.max(0, injectionIndex - 160), injectionIndex);
    expect(injectionBlock).toContain("high_resolution_window_icon()");
  });
});

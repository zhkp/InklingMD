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

/**
 * 抹掉 Rust 源码里的注释与字符串内容（换行保留），只留可执行代码。
 *
 * 守卫按字符位置判断时序，必须先把非代码部分清空，否则一段解释时序的注释
 * （如「不要挪进 .setup()」）就会让守卫误红。需要识别：行注释、可嵌套块注释、
 * 普通字符串（含转义）与 `r"…"` / `r#"…"#` 原始字符串——避免字符串里的 `//`
 * 被当成注释起点而截断后续代码。
 */
function rustCodeOnly(source: string): string {
  const blank = (ch: string) => (ch === "\n" ? "\n" : " ");
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // Rust 块注释可以嵌套
    if (ch === "/" && next === "*") {
      let depth = 1;
      out += "  ";
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === "/" && source[i + 1] === "*") {
          depth++;
          out += "  ";
          i += 2;
        } else if (source[i] === "*" && source[i + 1] === "/") {
          depth--;
          out += "  ";
          i += 2;
        } else {
          out += blank(source[i]);
          i++;
        }
      }
      continue;
    }

    // 原始字符串：r"…" 或 r#"…"#（r#ident 是原始标识符，不会匹配到引号）
    if (ch === "r" && (next === '"' || next === "#")) {
      const opener = /^r(#+)?"/.exec(source.slice(i));
      if (opener) {
        const terminator = `"${"#".repeat(opener[1]?.length ?? 0)}`;
        const closing = source.indexOf(terminator, i + opener[0].length);
        const stop = closing === -1 ? source.length : closing + terminator.length;
        for (; i < stop; i++) out += blank(source[i]);
        continue;
      }
    }

    if (ch === '"') {
      out += " ";
      i++;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source[i + 1] === "\n" ? "\n" : "  ";
          i += 2;
          continue;
        }
        const current = source[i];
        out += blank(current);
        i++;
        if (current === '"') break;
      }
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** 断言窗口图标注入满足 #432 的时序与绑定唯一性；不满足时由 expect 抛错。 */
function assertWindowIconInjectionTiming(source: string): void {
  const code = rustCodeOnly(source);

  // ① 启动 context 只允许构造一次：第二份 `generate_context!()` 可以阴影原名，
  //    让图标设在一个绑定上、`.run()` 用另一个——正是本守卫要拦的假修复
  expect(
    [...code.matchAll(/generate_context!\s*\(/g)],
    "lib.rs 只允许构造一个 generate_context!()（防止 run 用到另一份 context）",
  ).toHaveLength(1);

  // ② `.run(context)` 是唯一终点：解析实际传给 builder 的变量名
  const runCalls = [...code.matchAll(/\.run\(\s*(\w+)\s*\)/g)];
  expect(runCalls).toHaveLength(1);
  const runContext = runCalls[0][1];
  const runIndex = runCalls[0].index ?? -1;

  // ③ 注入只允许一处，且必须是 Some(...)：`set_default_window_icon(None)` 会把
  //    默认图标清空，等于让修复失效；接收者还必须是 run 的同一个变量
  expect(code, "不得把默认窗口图标清空为 None").not.toMatch(
    /set_default_window_icon\(\s*None\s*\)/,
  );
  const injections = [...code.matchAll(/(\w+)\.set_default_window_icon\(\s*Some\(/g)];
  expect(injections).toHaveLength(1);
  expect(injections[0][1]).toBe(runContext);
  const injectionIndex = injections[0].index ?? -1;

  // ④ 必须在 `.run(...)` 之前：窗口管理器在 build 期就取走了默认图标
  expect(injectionIndex, "窗口图标注入必须位于 .run(context) 之前").toBeLessThan(runIndex);

  // ⑤ 不能落在 `.setup(` 之后：那是 build 完成后的回调，窗口图标已经定下来了
  const setupIndex = code.indexOf(".setup(");
  expect(setupIndex).toBeGreaterThan(-1);
  expect(
    injectionIndex,
    "窗口图标注入不得挪进 .setup()（窗口已按默认图标创建）",
  ).toBeLessThan(setupIndex);

  // ⑥ 注入的必须是解码出的高清图标，而不是别的位图
  const injectionBlock = code.slice(Math.max(0, injectionIndex - 160), injectionIndex);
  expect(injectionBlock).toContain("high_resolution_window_icon()");
}

describe("#432 窗口图标注入时序（源码锚定，无需 GUI runner）", () => {
  it("lib.rs：图标注入在 run 之前、作用在同一 context、且不在 setup 内", () => {
    assertWindowIconInjectionTiming(libRs);
  });

  it("注释与字符串里的锚点不参与匹配（补充说明时序不会误红 CI）", () => {
    // 注释里刻意堆满守卫的全部锚点：剥离后只剩下面那段最小可执行代码
    const source = `
      // 只加一行注释：不要挪进 .setup()
      /// 也不要在注释里写 .run(context)
      /* 更不要写 context.set_default_window_icon(Some(icon)) 或 generate_context!() */
      fn start() {
        let note = "注释风格：// .setup() .run(context) generate_context!()";
        let mut context = tauri::generate_context!();
        match high_resolution_window_icon() {
          Ok(icon) => context.set_default_window_icon(Some(icon)),
          Err(_) => unreachable!(),
        }
        builder.setup(|app| { let _ = app; }).run(context);
      }
    `;
    expect(() => assertWindowIconInjectionTiming(source)).not.toThrow();
  });
});

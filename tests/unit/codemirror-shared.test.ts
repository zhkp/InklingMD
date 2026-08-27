// CM 键位记法 ↔ 应用绑定格式转换与源码模式冲突清单（issue #136 review 问题 2）
//
// CM keymap 命中后只 preventDefault、不 stopPropagation，事件继续冒泡到
// window 级全局快捷键处理器。因此源码模式实际占用的所有 mod 组合都必须
// 进入快捷键自定义的冲突黑名单，清单直接从启用的 keymap 数组派生。

import { describe, expect, it } from "vitest";
import {
  cmKeyToBinding,
  getSourceModeConflictBindings,
} from "../../src/lib/codemirror-shared";

describe("cmKeyToBinding", () => {
  it("标准组合转换为应用绑定格式", () => {
    expect(cmKeyToBinding("Mod-Shift-z")).toBe("mod+shift+z");
    expect(cmKeyToBinding("Mod-/")).toBe("mod+/");
    expect(cmKeyToBinding("Ctrl-n")).toBe("mod+n");
    expect(cmKeyToBinding("Cmd-ArrowDown")).toBe("mod+arrowdown");
    expect(cmKeyToBinding("Shift-Mod-Home")).toBe("mod+shift+home");
    expect(cmKeyToBinding("Mod-Shift-Alt-a")).toBe("mod+shift+alt+a");
  });

  it("无 Ctrl/Cmd 修饰键或仅修饰键的组合不可绑定，返回 null", () => {
    expect(cmKeyToBinding("Alt-A")).toBeNull();
    expect(cmKeyToBinding("F3")).toBeNull();
    expect(cmKeyToBinding("Home")).toBeNull();
    expect(cmKeyToBinding("Mod")).toBeNull();
    expect(cmKeyToBinding("Shift-Ctrl")).toBeNull();
    expect(cmKeyToBinding(undefined)).toBeNull();
  });
});

describe("getSourceModeConflictBindings", () => {
  const bindings = getSourceModeConflictBindings();

  it("被过滤掉的冲突键位不出现在清单中（Mod-/ 与全局帮助、Ctrl-n 与新建草稿）", () => {
    expect(bindings).not.toContain("mod+/");
    expect(bindings).not.toContain("mod+n");
  });

  it("启用的 CM keymap 实际占用的组合都在清单中", () => {
    expect(bindings).toContain("mod+z"); // historyKeymap undo
    expect(bindings).toContain("mod+f"); // searchKeymap openSearchPanel
    expect(bindings).toContain("mod+home"); // defaultKeymap cursorDocStart
    expect(bindings).toContain("mod+r"); // 源码模式 replaceNext
  });

  it("清单无重复项", () => {
    expect(new Set(bindings).size).toBe(bindings.length);
  });
});

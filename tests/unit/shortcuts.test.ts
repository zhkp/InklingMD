// 快捷键匹配单元测试
// 重点覆盖 matchBinding（曾因 MODIFIER_KEYS 漏加 "mod" 导致全部失效），
// 以及 formatBinding / captureFromEvent 的纯函数行为。

import { describe, it, expect, vi } from "vitest";
import {
  matchBinding,
  captureFromEvent,
  SHORTCUT_DEFS,
  RESERVED_SHORTCUTS,
} from "../../src/store/shortcuts";
import { getSourceModeConflictBindings } from "../../src/lib/codemirror-shared";

/** 构造 KeyboardEvent 的辅助函数 */
function kbd(
  key: string,
  opts: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    altKey: opts.alt ?? false,
  });
}

describe("matchBinding", () => {
  it("mod+f 匹配 Ctrl+F", () => {
    expect(matchBinding("mod+f", kbd("f", { ctrl: true }))).toBe(true);
  });

  it("mod+f 匹配 Cmd+F（Mac）", () => {
    expect(matchBinding("mod+f", kbd("f", { meta: true }))).toBe(true);
  });

  it("mod+f 不匹配无修饰键的 f", () => {
    expect(matchBinding("mod+f", kbd("f"))).toBe(false);
  });

  it("mod+f 不匹配 Ctrl+Shift+F（多余 shift）", () => {
    expect(matchBinding("mod+f", kbd("f", { ctrl: true, shift: true }))).toBe(false);
  });

  it("mod+shift+f 匹配 Ctrl+Shift+F", () => {
    expect(matchBinding("mod+shift+f", kbd("f", { ctrl: true, shift: true }))).toBe(true);
  });

  it("mod+alt+f 匹配 Ctrl+Alt+F", () => {
    expect(matchBinding("mod+alt+f", kbd("f", { ctrl: true, alt: true }))).toBe(true);
  });

  it("mod+shift+alt+f 匹配三修饰键组合", () => {
    expect(
      matchBinding("mod+shift+alt+f", kbd("f", { ctrl: true, shift: true, alt: true })),
    ).toBe(true);
  });

  it("大小写不敏感：mod+f 匹配 Ctrl+F（大写 F）", () => {
    expect(matchBinding("mod+f", kbd("F", { ctrl: true }))).toBe(true);
  });

  it("绑定字符串大小写不敏感：MOD+F 匹配 Ctrl+f", () => {
    expect(matchBinding("MOD+F", kbd("f", { ctrl: true }))).toBe(true);
  });

  it("mod+\\ 匹配反斜杠", () => {
    expect(matchBinding("mod+\\", kbd("\\", { ctrl: true }))).toBe(true);
  });

  it("mod+' 匹配单引号", () => {
    expect(matchBinding("mod+'", kbd("'", { ctrl: true }))).toBe(true);
  });

  it("mod+, 匹配逗号", () => {
    expect(matchBinding("mod+,", kbd(",", { ctrl: true }))).toBe(true);
  });

  it("mod+/ 匹配斜杠", () => {
    expect(matchBinding("mod+/", kbd("/", { ctrl: true }))).toBe(true);
  });

  it("不同按键不匹配：mod+f 不匹配 Ctrl+g", () => {
    expect(matchBinding("mod+f", kbd("g", { ctrl: true }))).toBe(false);
  });

  it("回车键名匹配", () => {
    expect(matchBinding("mod+enter", kbd("Enter", { ctrl: true }))).toBe(true);
  });

  it("退格键名匹配", () => {
    expect(matchBinding("mod+backspace", kbd("Backspace", { ctrl: true }))).toBe(true);
  });

  it("空绑定不匹配任何事件", () => {
    expect(matchBinding("", kbd("f", { ctrl: true }))).toBe(false);
  });

  it("仅修饰键的绑定不匹配（mod+shift 无最终按键）", () => {
    expect(matchBinding("mod+shift", kbd("f", { ctrl: true, shift: true }))).toBe(false);
  });
});

describe("captureFromEvent", () => {
  it("Ctrl+F 捕获为 mod+f", () => {
    expect(captureFromEvent(kbd("f", { ctrl: true }))).toBe("mod+f");
  });

  it("Cmd+Shift+F 捕获为 mod+shift+f", () => {
    expect(captureFromEvent(kbd("f", { meta: true, shift: true }))).toBe("mod+shift+f");
  });

  it("Ctrl+Alt+F 捕获为 mod+alt+f", () => {
    expect(captureFromEvent(kbd("f", { ctrl: true, alt: true }))).toBe("mod+alt+f");
  });

  it("无修饰键返回 null", () => {
    expect(captureFromEvent(kbd("f"))).toBeNull();
  });

  it("仅按修饰键返回 null", () => {
    expect(captureFromEvent(kbd("Control", { ctrl: true }))).toBeNull();
    expect(captureFromEvent(kbd("Shift", { shift: true }))).toBeNull();
    expect(captureFromEvent(kbd("Alt", { alt: true }))).toBeNull();
    expect(captureFromEvent(kbd("Meta", { meta: true }))).toBeNull();
  });

  it("大写字母捕获为小写", () => {
    expect(captureFromEvent(kbd("F", { ctrl: true }))).toBe("mod+f");
  });

  it("特殊键名捕获为小写", () => {
    expect(captureFromEvent(kbd("Enter", { ctrl: true }))).toBe("mod+enter");
    expect(captureFromEvent(kbd("Backspace", { ctrl: true }))).toBe("mod+backspace");
  });
});

describe("formatBinding", () => {
  // MAC_PLATFORM 是模块加载时计算的常量，需 resetModules 后动态 import 才能切换平台
  async function loadWithPlatform(platform: string) {
    vi.resetModules();
    const original = navigator.platform;
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      get: () => platform,
    });
    const mod = await import("../../src/store/shortcuts");
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      get: () => original,
    });
    return mod.formatBinding;
  }

  it("Windows 平台 mod+f 格式化为 Ctrl+F", async () => {
    const fb = await loadWithPlatform("Win32");
    expect(fb("mod+f")).toBe("Ctrl+F");
  });

  it("Windows 平台 mod+shift+f 格式化为 Ctrl+Shift+F", async () => {
    const fb = await loadWithPlatform("Win32");
    expect(fb("mod+shift+f")).toBe("Ctrl+Shift+F");
  });

  it("Mac 平台 mod+f 格式化为 ⌘+F", async () => {
    const fb = await loadWithPlatform("MacIntel");
    expect(fb("mod+f")).toBe("⌘+F");
  });

  it("Mac 平台 mod+shift+alt+f 格式化为 ⌘+⇧+⌥+F", async () => {
    const fb = await loadWithPlatform("MacIntel");
    expect(fb("mod+shift+alt+f")).toBe("⌘+⇧+⌥+F");
  });

  it("单字符按键转大写显示", async () => {
    const fb = await loadWithPlatform("Win32");
    expect(fb("mod+a")).toBe("Ctrl+A");
  });

  it("特殊键名原样保留（长度>1 不转大写）", async () => {
    const fb = await loadWithPlatform("Win32");
    expect(fb("mod+enter")).toBe("Ctrl+enter");
    expect(fb("mod+backspace")).toBe("Ctrl+backspace");
  });
});

describe("SHORTCUT_DEFS", () => {
  it("包含全部 8 个可自定义快捷键", () => {
    const ids = SHORTCUT_DEFS.map((d) => d.id);
    expect(ids).toEqual([
      "find",
      "toggleSidebar",
      "toggleOutline",
      "showShortcuts",
      "openSettings",
      "toggleSourceMode",
      "quickOpen",
      "pastePlainText",
    ]);
  });

  it("粘贴为纯文本的默认绑定是 mod+shift+v 且不与保留快捷键冲突（#219）", () => {
    const def = SHORTCUT_DEFS.find((d) => d.id === "pastePlainText");
    expect(def?.default).toBe("mod+shift+v");
    expect(RESERVED_SHORTCUTS.map((r) => r.binding)).not.toContain("mod+shift+v");
    expect(getSourceModeConflictBindings()).not.toContain("mod+shift+v");
  });

  it("每个定义都有默认绑定", () => {
    for (const def of SHORTCUT_DEFS) {
      expect(def.default).toBeTruthy();
      expect(def.default.startsWith("mod+")).toBe(true);
    }
  });

  it("快速打开的默认绑定是 mod+p", () => {
    const quickOpen = SHORTCUT_DEFS.find((d) => d.id === "quickOpen");
    expect(quickOpen?.default).toBe("mod+p");
  });

  it("mod+p 未被源码模式 CodeMirror 键位占用（#228 R9）", () => {
    // 被占用则会在源码模式下双重触发。数据由 CM keymap 派生，故 CM 升级后
    // 若新增 Mod-p 绑定，本断言会立刻失败，提示改用 mod+shift+p。
    expect(getSourceModeConflictBindings()).not.toContain("mod+p");
  });
});

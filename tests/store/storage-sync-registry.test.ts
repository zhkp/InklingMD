// #225 C4（方案 A：全量收敛）：跨窗口 storage 同步的**唯一注册点**单测。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerStorageSync,
  registerStorageSyncPrefix,
  registeredStorageSyncKeys,
} from "../../src/store/storageSyncRegistry";

function emitStorageFromOtherWindow(key: string | null, newValue: string | null): void {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}

beforeEach(() => {
  // 注意：本文件不断言「登记清单为空」——app 各 store 在模块求值时已登记（这正是收敛目标）
});

describe("#225 C4：登记与派发语义", () => {
  it("精确 key：只有匹配的 handler 收到事件", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerStorageSync("test:key-a", a, "test");
    const offB = registerStorageSync("test:key-b", b, "test");

    emitStorageFromOtherWindow("test:key-a", "1");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();

    offA();
    offB();
  });

  it("前缀 key：快照这类动态 key 用前缀登记（`inkling-theme-snapshot:`）", () => {
    const onSnapshot = vi.fn();
    const off = registerStorageSyncPrefix("test-snapshot:", onSnapshot, "test");

    emitStorageFromOtherWindow("test-snapshot:user:vue:abcd1234", "{}");
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    emitStorageFromOtherWindow("test-other", "{}");
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    off();
  });

  it("e.key === null（localStorage.clear()）不派发：不抹除本窗口状态（既有约定）", () => {
    const handler = vi.fn();
    const off = registerStorageSync("test:key-null", handler, "test");
    emitStorageFromOtherWindow(null, null);
    expect(handler).not.toHaveBeenCalled();
    off();
  });

  it("取消注册后不再收到事件（组件卸载路径）", () => {
    const handler = vi.fn();
    const off = registerStorageSync("test:key-off", handler, "test");
    emitStorageFromOtherWindow("test:key-off", "1");
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    emitStorageFromOtherWindow("test:key-off", "2");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("单个 handler 抛错不影响其它 handler（隔离）", () => {
    const boom = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    const off1 = registerStorageSync("test:key-boom", boom, "test");
    const off2 = registerStorageSync("test:key-boom", ok, "test");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    emitStorageFromOtherWindow("test:key-boom", "1");
    expect(boom).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
    spy.mockRestore();
    off1();
    off2();
  });
});

describe("#225 C4：app 各域的 key 均已收敛到同一注册点", () => {
  it("theme / settings / shortcuts / workspace 三 key 都能在注册清单里看到", async () => {
    // 动态 import：确保各 store 的模块级登记已发生
    await import("../../src/store/theme");
    await import("../../src/store/settings");
    await import("../../src/store/shortcuts");
    const { RECENT_FILES_KEY, BOOKMARKS_KEY, EXPANDED_DIRS_KEY } = await import(
      "../../src/store/workspace/shared"
    );
    const { useWorkspace } = await import("../../src/store/workspace");
    useWorkspace.getState();

    const keys = registeredStorageSyncKeys();
    expect(keys).toContain("inkling-theme");
    expect(keys).toContain("inkling-themes-index");
    expect(keys).toContain("inkling-theme-snapshot:*");
    expect(keys).toContain(RECENT_FILES_KEY);
    expect(keys).toContain(BOOKMARKS_KEY);
    expect(keys).toContain(EXPANDED_DIRS_KEY);
  });

  it("主题 key 的跨窗口事件确实会切换本窗口主题（正例）", async () => {
    const { useTheme } = await import("../../src/store/theme");
    const { registerThemes, resetRegisteredThemes } = await import("../../src/theme/registry");
    resetRegisteredThemes();
    registerThemes([
      { id: "user:cross", name: "Cross", mode: "dark", source: "user", hash: "ffffffff" },
    ]);
    localStorage.setItem("inkling-theme", "user:cross");
    emitStorageFromOtherWindow("inkling-theme", "user:cross");
    expect(useTheme.getState().themeId).toBe("user:cross");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    resetRegisteredThemes();
  });
});

describe("#225 C4：只安装一次 window 'storage' 监听（唯一注册点）", () => {
  it("多次登记只产生 1 次 addEventListener('storage')", async () => {
    const { resetStorageSyncForTests } = await import("../../src/store/storageSyncRegistry");
    resetStorageSyncForTests();
    const spy = vi.spyOn(window, "addEventListener");
    registerStorageSync("spy:1", () => {}, "spy");
    registerStorageSync("spy:2", () => {}, "spy");
    registerStorageSyncPrefix("spy:", () => {}, "spy");
    const storageCalls = spy.mock.calls.filter(([type]) => type === "storage");
    expect(storageCalls).toHaveLength(1);
    spy.mockRestore();
  });
});

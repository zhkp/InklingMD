import { describe, it, expect } from "vitest";
import { isBenignGlobalError } from "../../src/lib/crash-guard";

// issue #171：全局崩溃兜底只对真正致命错误触发崩溃页，
// 良性噪音（ResizeObserver loop、跨域 Script error、空 message）必须被过滤。
describe("isBenignGlobalError（issue #171）", () => {
  it("ResizeObserver loop 系列（Chromium/WebView2 已知噪音）判为良性", () => {
    expect(isBenignGlobalError("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(isBenignGlobalError("ResizeObserver loop limit exceeded")).toBe(true);
    // 实际经 error.stack 上报时同样命中
    expect(isBenignGlobalError("ResizeObserver loop completed with undelivered notifications.\n    at ...")).toBe(true);
  });

  it("空 message 与跨域 Script error（无诊断价值）判为良性", () => {
    expect(isBenignGlobalError("")).toBe(true);
    expect(isBenignGlobalError("   ")).toBe(true);
    expect(isBenignGlobalError("Script error.")).toBe(true);
    expect(isBenignGlobalError("Script error")).toBe(true);
    expect(isBenignGlobalError("script error")).toBe(true);
  });

  it("真实致命错误（初始化失败/类型错误）不被误伤", () => {
    expect(isBenignGlobalError("Error: Failed to fetch markdown plugin")).toBe(false);
    expect(isBenignGlobalError("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(false);
    expect(isBenignGlobalError("Milkdown: failed to initialize editor")).toBe(false);
    expect(isBenignGlobalError("SyntaxError: Unexpected token <")).toBe(false);
  });
});

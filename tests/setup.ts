// 测试全局 setup
// - 注册 @testing-library/jest-dom 的 DOM 断言匹配器
// - 每个用例间清理 localStorage，避免 store 持久化串扰

import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { drainHostedTimers, hostTimeouts } from "./fixtures/hostedTimers";

// Node 26 exposes experimental storage properties whose values are undefined
// unless --localstorage-file is supplied. That also shadows happy-dom's storage.
// Install deterministic per-worker in-memory implementations for tests.
function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(String(key)) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => { values.delete(String(key)); },
    setItem: (key, value) => { values.set(String(key), String(value)); },
  };
}
const storageWindow = window as Window & {
  localStorage?: Storage;
  sessionStorage?: Storage;
};
const testLocalStorage = storageWindow.localStorage ?? createMemoryStorage();
const testSessionStorage = storageWindow.sessionStorage ?? createMemoryStorage();
if (!storageWindow.localStorage) {
  Object.defineProperty(window, "localStorage", { configurable: true, value: testLocalStorage });
}
if (!storageWindow.sessionStorage) {
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: testSessionStorage });
}
vi.stubGlobal("localStorage", testLocalStorage);
vi.stubGlobal("sessionStorage", testSessionStorage);

// happy-dom 不实现 matchMedia，部分库（如主题相关）会调用，桩一个最小实现
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

// 测试期定时器托管（#257）：milkdown 编辑器留下的 3s 超时在环境销毁后触发会调用裸全局
// removeEventListener → 用例全绿但 `pnpm test` 随机 exit 1；文件结束时统一清掉。
hostTimeouts();
afterAll(() => drainHostedTimers());

afterEach(() => {
  vi.restoreAllMocks();
});

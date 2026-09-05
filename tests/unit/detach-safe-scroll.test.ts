// readDetachSafeScrollMetrics（issue #174）测试
// 守卫语义：clientHeight>1（容器在线且有布局）才信现场读数；否则（cleanup 在
// DOM 移除/容器塌缩后执行，scrollTop/scrollHeight 读 0）回退最后一次可信缓存。
// 变异验证：把 live 判据改成恒真 → 「脱链/塌缩回退缓存」用例失败。

import { describe, it, expect } from "vitest";
import { readDetachSafeScrollMetrics } from "../../src/lib/detachSafeScroll";

function makeEl(clientHeight: number, scrollTop: number, scrollHeight: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(el, "scrollTop", { configurable: true, value: scrollTop });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  return el;
}

describe("readDetachSafeScrollMetrics（issue #174 脱链安全读）", () => {
  it("容器在线且布局可信（clientHeight>1）→ 取现场 scrollTop/scrollHeight", () => {
    const el = makeEl(600, 1200, 4000);
    const out = readDetachSafeScrollMetrics(el, { scrollTop: 500, scrollHeight: 4000 });
    expect(out).toEqual({ scrollTop: 1200, scrollHeight: 4000 });
  });

  it("容器已脱链（clientHeight=0）→ 回退最后可信缓存，不信现场读 0", () => {
    const el = makeEl(0, 0, 0);
    const out = readDetachSafeScrollMetrics(el, { scrollTop: 1200, scrollHeight: 4000 });
    expect(out).toEqual({ scrollTop: 1200, scrollHeight: 4000 });
  });

  it("容器塌缩中间帧（clientHeight=1）→ 同样回退缓存（旧实现会读 0 丢失阅读位置）", () => {
    const el = makeEl(1, 0, 0);
    const out = readDetachSafeScrollMetrics(el, { scrollTop: 1200, scrollHeight: 4000 });
    expect(out).toEqual({ scrollTop: 1200, scrollHeight: 4000 });
  });

  it("现场可信但用户确实在顶部（scrollTop=0）→ 信现场 0，不用过期缓存兜错", () => {
    const el = makeEl(600, 0, 4000);
    const out = readDetachSafeScrollMetrics(el, { scrollTop: 1200, scrollHeight: 4000 });
    expect(out).toEqual({ scrollTop: 0, scrollHeight: 4000 });
  });
});

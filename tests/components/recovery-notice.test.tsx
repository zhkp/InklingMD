// #409 配额：草稿超限的非阻塞提示条
//
// 失败模式是「提示该出现时没出现 / 该消失时不消失 / 把后来的新提示关掉」，
// 所以断言都落在 store 的 notice 状态与 DOM 的 role="status" 上。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { RecoveryNotice } from "../../src/components/Notice/RecoveryNotice";
import { useUI } from "../../src/store/ui";

beforeEach(() => {
  vi.useFakeTimers();
  act(() => useUI.getState().dismissNotice());
});

afterEach(() => {
  // 组件仍挂载时改 store 会被 React 记为一次未包裹的更新，统一在 act 内复位
  act(() => useUI.getState().dismissNotice());
  vi.useRealTimers();
});

describe("#409 非阻塞提示条", () => {
  it("显示文案并在 4s 后自动消失", () => {
    render(<RecoveryNotice />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      useUI.getState().showNotice("该文档超过 10 MB，未建立崩溃恢复副本");
    });
    expect(screen.getByRole("status").textContent).toContain("未建立崩溃恢复副本");

    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(useUI.getState().notice).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("旧提示的定时器不会关掉期间到达的新提示", () => {
    render(<RecoveryNotice />);
    act(() => {
      useUI.getState().showNotice("第一条");
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      useUI.getState().showNotice("第二条");
    });

    // 第一条的 4s 到点：它的定时器已在换提示时被清掉，不能误关第二条
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    expect(useUI.getState().notice?.text).toBe("第二条");
    expect(screen.getByRole("status").textContent).toBe("第二条");
  });

  it("卸载时清掉定时器，不再改动 store", () => {
    const { unmount } = render(<RecoveryNotice />);
    act(() => {
      useUI.getState().showNotice("第一条");
    });

    unmount();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(useUI.getState().notice?.text).toBe("第一条");
  });
});

// 菜单键盘无障碍 hook（#188）
// 统一为下拉菜单与右键菜单提供：打开聚焦首个可用菜单项 + 方向键/Home/End 移动。
// Esc/点击外部等关闭逻辑由各菜单自身（或 EditorTopbar）负责，避免重复拦截。

import { useEffect } from "react";
import type { RefObject } from "react";

interface UseMenuA11yOptions {
  /** 菜单容器（含 [role="menuitem"] 后代），如 .export-dropdown / .tree-context-menu */
  ref: RefObject<HTMLElement | null>;
  /** 菜单是否打开；下拉菜单传 open，右键菜单挂载即打开传 true */
  enabled: boolean;
  /** 打开后是否把焦点移入首个可用菜单项（焦点已在菜单内时不移） */
  focusFirstOnOpen?: boolean;
}

/** 收集容器内未 disabled 的 menuitem */
function enabledItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).filter((el) => !(el as HTMLButtonElement).disabled);
}

export function useMenuA11y({
  ref,
  enabled,
  focusFirstOnOpen = false,
}: UseMenuA11yOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const container = ref.current;
    if (!container) return;

    if (focusFirstOnOpen) {
      const first = enabledItems(container)[0];
      if (first && !container.contains(document.activeElement)) {
        first.focus();
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key !== "ArrowDown"
        && e.key !== "ArrowUp"
        && e.key !== "Home"
        && e.key !== "End"
      ) {
        return;
      }
      const items = enabledItems(container);
      if (items.length === 0) return;
      const currentIdx = items.indexOf(document.activeElement as HTMLElement);
      let next: number;
      if (e.key === "Home") next = 0;
      else if (e.key === "End") next = items.length - 1;
      else if (e.key === "ArrowDown") {
        next = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1);
      } else {
        next = currentIdx <= 0 ? items.length - 1 : currentIdx - 1;
      }
      e.preventDefault();
      e.stopPropagation();
      items[next].focus();
    };

    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [enabled, focusFirstOnOpen, ref]);
}

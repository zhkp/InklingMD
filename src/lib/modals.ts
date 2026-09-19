// 模态互斥（#228）
//
// 背景：App.tsx 里此前是 6 个彼此不可知的 useState 布尔量，因此「全局搜索打开时按
// mod+p」必然叠加弹层。这里把「当前哪个模态是活动的」收敛为单值 + 一个纯判定函数，
// 让互斥规则可被单测锁定，而不是散落在各处的 if。

/** 应用内互斥的模态标识 */
export type ModalId =
  | "settings"
  | "shortcutsHelp"
  | "shortcutsCustomize"
  | "globalSearch"
  | "quickOpen"
  | "linkDialog";

export type ModalAction = "open" | "close" | "ignore";

/**
 * 模态请求的归并规则（三分支）
 *
 * - 当前无模态 → `open`
 * - 请求的是同一个模态 → `close`（统一为「重按即关闭」）
 * - 请求的是别的模态 → `ignore`（**不叠加**，这是本模块存在的理由）
 */
export function resolveModalAction(
  active: ModalId | null,
  requested: ModalId,
): ModalAction {
  if (active === null) return "open";
  if (active === requested) return "close";
  return "ignore";
}

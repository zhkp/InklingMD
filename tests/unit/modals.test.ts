// 模态互斥判定单测（#228）
//
// 这是「全局搜索打开时按 mod+p 不得叠加」规则的唯一判定点，因此在这里穷举锁定。

import { describe, expect, it } from "vitest";
import { resolveModalAction, type ModalId } from "../../src/lib/modals";

const ALL_MODALS: ModalId[] = [
  "settings",
  "shortcutsHelp",
  "shortcutsCustomize",
  "globalSearch",
  "quickOpen",
  "linkDialog",
];

describe("resolveModalAction（模态互斥三分支）", () => {
  it("无活动模态 → 打开", () => {
    for (const requested of ALL_MODALS) {
      expect(resolveModalAction(null, requested)).toBe("open");
    }
  });

  it("请求同一模态 → 关闭（统一为「重按即关闭」）", () => {
    for (const id of ALL_MODALS) {
      expect(resolveModalAction(id, id)).toBe("close");
    }
  });

  it("已有其他模态 → 忽略（不叠加）", () => {
    expect(resolveModalAction("globalSearch", "quickOpen")).toBe("ignore");
    expect(resolveModalAction("quickOpen", "globalSearch")).toBe("ignore");
    expect(resolveModalAction("settings", "shortcutsHelp")).toBe("ignore");
    expect(resolveModalAction("linkDialog", "quickOpen")).toBe("ignore");
  });

  it("穷举 6×6 组合：只有「同模态」是关闭，其余全是忽略", () => {
    for (const active of ALL_MODALS) {
      for (const requested of ALL_MODALS) {
        const action = resolveModalAction(active, requested);
        if (active === requested) {
          expect(action).toBe("close");
        } else {
          expect(action).toBe("ignore");
        }
        // 任意组合都不得出现「叠加打开」
        expect(action).not.toBe("open");
      }
    }
  });
});

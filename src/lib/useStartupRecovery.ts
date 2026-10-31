// 启动恢复入口（#365 / #378）
//
// 只在桌面端跑；顺序固定为：
//   ① `beginSession()` 先把本次会话标成 `cleanExit:false`（进程被杀下次才有提示）
//   ② 读上次标记 + 草稿 → 明确询问用户「恢复 / 丢弃 / 稍后」
//   ③ 收尾清理超过 TTL 的草稿
//
// 为什么不自动恢复：一份过期草稿直接铺到编辑器里，用户很可能顺手保存，
// 把他在这期间对文件做的修改覆盖掉。

import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  applyRecovery,
  beginSession,
  cleanupExpiredDrafts,
  discardDrafts,
  findRecoverableDrafts,
} from "./session-recovery";

export const RECOVER = "恢复";
export const DISCARD = "丢弃";
export const LATER = "稍后";

export function useStartupRecovery(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;

    void (async () => {
      await beginSession();
      const drafts = await findRecoverableDrafts();
      if (cancelled) return;

      if (drafts.length > 0) {
        let choice: string | null = null;
        try {
          const { message } = await import("@tauri-apps/plugin-dialog");
          const files = drafts
            .slice(0, 5)
            .map((d) => `· ${d.title}`)
            .join("\n");
          choice = await message(
            `上次未正常退出，发现 ${drafts.length} 份未保存内容：\n${files}${
              drafts.length > 5 ? "\n…" : ""
            }\n\n恢复会把这些内容作为「未保存」标签打开，不会直接写盘。`,
            {
              title: "恢复未保存内容",
              kind: "warning",
              buttons: { yes: RECOVER, no: DISCARD, cancel: LATER },
            },
          );
        } catch {
          // 弹窗不可用（headless / 权限）：按「稍后」处理，草案留着下次再问
          choice = LATER;
        }

        if (!cancelled && choice === RECOVER) {
          applyRecovery(drafts);
          await discardDrafts(drafts);
        } else if (!cancelled && choice === DISCARD) {
          await discardDrafts(drafts);
        }
      }

      if (!cancelled) await cleanupExpiredDrafts();
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}

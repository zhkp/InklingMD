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
      // 先取旧标记再写新标记：`beginSession()` 会把同一个文件覆盖成 cleanExit:false，
      // 之后再读就永远读到 false（「上次正常退出不提示」会变成死代码）
      const previous = await beginSession();
      const drafts = await findRecoverableDrafts(previous);
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
          // 恢复**不删**草稿：
          // ① `applyRecovery` 会跳过已打开的 path，删了就把那些内容彻底丢了；
          // ② 恢复出来的 tab 在下一次编辑前不会产生新草稿，此时崩溃等于没有副本。
          // 草稿由「保存成功」或 TTL 清理负责收尾。
          await applyRecovery(drafts);
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

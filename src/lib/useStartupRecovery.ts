// 启动恢复入口（#365 / #378）
//
// 只在桌面端跑；顺序固定为：
//   ① `beginSession()` 先把本次会话标成 `cleanExit:false`（进程被杀下次才有提示）
//   ② 读上次标记 + 草稿 → 明确询问用户「恢复 / 丢弃 / 稍后」
//   ③ 收尾清理「已处理且超过 TTL」的草稿
//
// 为什么不自动恢复：一份过期草稿直接铺到编辑器里，用户很可能顺手保存，
// 把他在这期间对文件做的修改覆盖掉。

import { useEffect } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  portableMigrationMessage,
  takePortableMigration,
  type PortableMigration,
} from "./appDataRoot";
import {
  applyRecovery,
  beginSession,
  cleanupExpiredDrafts,
  discardDrafts,
  findRecoverableDrafts,
  markDraftsHandled,
} from "./session-recovery";

export const RECOVER = "恢复";
export const DISCARD = "丢弃";
export const LATER = "稍后";

/**
 * #404：便携模式首启把旧数据（themes / recovery）从旧位置复制到便携目录后，
 * 必须让用户看见。静默迁移等于把「我的主题怎么变成这份了」留给用户猜。
 */
async function reportPortableMigration(migration: PortableMigration): Promise<void> {
  const { text, kind } = portableMigrationMessage(migration);
  try {
    const { message } = await import("@tauri-apps/plugin-dialog");
    await message(text, { title: "便携模式数据迁移", kind });
  } catch {
    // 弹窗不可用（headless / 权限）不能影响启动：退化为控制台留痕
    console.warn("[portable] 数据迁移提示无法显示：", text.replace(/\n/g, " | "));
  }
}

export function useStartupRecovery(): void {
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    /** 本次被恢复的 path：TTL 清理要放过它们 */
    const restored: string[] = [];

    void (async () => {
      // #404：迁移本身在 Rust setup 里完成（先于窗口创建），这里只负责告知结果。
      // 报告是**一次性**的（Rust 侧 take 即清空），所以取到就立刻显示，
      // 不能先取后放：中途 `return` / 组件卸载 / StrictMode 双跑都会让它永久丢失。
      // 这里刻意不看 `cancelled`：这是一次性启动提示，与组件存活无关。
      const migration = await takePortableMigration().catch((error: unknown) => {
        // 取走前 Rust 已清空状态：这里再失败就等于这份提示永久丢失，
        // 至少要留痕（否则「迁移了但没提示」无从查起）
        console.warn("[portable] 取迁移结果失败：", error);
        return null;
      });
      if (migration) await reportPortableMigration(migration);
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

        // 自定义按钮在不同平台可能回传按钮文字或 Yes/No（与 useExitHandler / tabs 一致）
        if (!cancelled && (choice === RECOVER || choice === "Yes")) {
          // 恢复**不删**草稿：
          // ① `applyRecovery` 会跳过已打开的 path，删了就把那些内容彻底丢了；
          // ② 恢复出来的 tab 在下一次编辑前不会产生新草稿，此时崩溃等于没有副本。
          const { restoredPaths } = await applyRecovery(drafts);
          restored.push(...restoredPaths);
          // 恢复**不标 handled**：内容此刻只在编辑器里（下次编辑前不会写新草稿），
          // 标成「已处理」会让下次启动的 TTL 清理把它删掉
        } else if (!cancelled && (choice === DISCARD || choice === "No")) {
          await discardDrafts(drafts);
          await markDraftsHandled(drafts);
        }
      }

      // TTL 清理必须排除「刚被恢复」的草稿：它们可能已经很旧，但内容此刻只在编辑器里
      if (!cancelled) await cleanupExpiredDrafts(Date.now(), undefined, {
        exclude: new Set(restored),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, []);
}

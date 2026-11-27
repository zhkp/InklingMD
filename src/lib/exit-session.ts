// 退出 / 会话底座（#365 / #367）
//
// 本模块负责「退出时把 draft 真正落下」与「会话标记」，是恢复流程（PR-5b 的启动面板）
// 的数据来源：
// - `flushAllDrafts({ durability })`：把每个 dirty tab 的正文写进
//   `recovery/<windowLabel>/drafts/<key>.json`；退出时用 `sync`，平时由 draft-journal 防抖写。
//   同时 flush 光标 checkpoint（`recovery/<label>/cursor.json`）；光标写失败只影响
//   光标 / 滚动能否恢复，不参与 `journalHealth`（内容副本是否可信）的判定。
// - `markCleanExit()`：先删掉本次会话的草稿（内容都已落盘），再写 `cleanExit: true`。
// - `markUncleanExit()`：保留草稿，只把 `cleanExit` 写成 false —— 下次启动据此弹恢复。

import { isTauri } from "@tauri-apps/api/core";
import { appDataRoot } from "./appDataRoot";
import { writeRecoveryFile } from "./fs";
import { flushCursorCheckpoint } from "./cursor-checkpoint";
import { useWorkspace } from "../store/workspace";
import {
  cancelPendingDrafts,
  currentSessionId,
  currentSessionStartedAt,
  currentWindowLabel,
  ensureWindowLabel,
  lastDraftWriteOk,
  lastDraftWriteOutcome,
  writeDraftNow,
} from "./draft-journal";

export type JournalHealth = "healthy" | "degraded";

/** 内容副本健康度：只由草稿正文写入结果决定；光标 checkpoint 失败不参与 */
export let journalHealth: JournalHealth = "healthy";

/** 仅供测试：重置健康度与写盘结果表（表本体在 draft-journal，clearDraft 也要清） */
export function __resetJournalHealth(): void {
  journalHealth = "healthy";
  lastDraftWriteOk.clear();
}

/**
 * 落盘所有 dirty tab 的草稿。
 *
 * `durability: "sync"` 只在退出链路用：那时进程马上就没，掉电保证必须自己给；
 * 平时的防抖写用 `none`（重做成本低，别为每次输入付 fsync）。
 */
export async function flushAllDrafts(
  options: { durability?: "sync" | "none" } = {},
): Promise<void> {
  if (!isTauri()) return;
  // 先取消挂着的防抖定时器，避免同一次输入写两遍
  cancelPendingDrafts();
  // 退出是最后一次落盘机会：把还没到 5s 节流窗口的光标 checkpoint 也刷出去。
  // 退出路径要 fsync。光标写失败只意味着「下次恢复没有光标位置」，草稿正文仍完整；
  // checkpoint 内部已自行排队重试。据此把内容判成不可恢复会让退出确认错误地
  // 提示「退出将永久丢失这些修改」，而副本其实就在磁盘上。
  await flushCursorCheckpoint("sync");
  const { openTabs } = useWorkspace.getState();
  const dirty = openTabs.filter((tab) => tab.dirty);
  if (dirty.length === 0) return;

  let failed = 0;
  await Promise.all(
    dirty.map(async (tab) => {
      const ok = await writeDraftNow(
        {
          path: tab.path,
          isUntitled: !!tab.isUntitled,
          title: tab.path.split(/[\\/]/).pop(),
          content: tab.content,
        },
        { durability: options.durability ?? "none" },
      );
      const outcome = lastDraftWriteOutcome.get(tab.path);
      // 超限时旧副本是**刻意留着**的（见 rejectOversize）：若本次之前已经写成功过，
      // 盘上仍有一份可供恢复的内容，不能把它降级成「没有副本」，否则退出确认会说反话。
      // 只有「本次超限且此前从未写成」才记 false（那才是真的没有副本）。
      const keepsOldCopy = outcome === "oversize" && lastDraftWriteOk.get(tab.path) === true;
      if (!keepsOldCopy) lastDraftWriteOk.set(tab.path, ok);
      // 单条超限是「主动跳过」，不是写盘故障：把它算成失败会让 health 误降，
      // 其它明明有副本的文档在退出确认里也会被说成「退出将永久丢失」
      if (!ok && outcome !== "oversize") failed += 1;
    }),
  );
  // 只由本次草稿写入结果决定：失败时不能承诺「有恢复副本」；
  // 后续 flush 全部成功即可恢复 healthy，一次失败不应污染整个进程后续的判定。
  journalHealth = failed === 0 ? "healthy" : "degraded";
}

/**
 * 这些 tab 里有多少条**没有**可信的恢复副本（退出确认按这个数量决定是否放行）。
 *
 * 必须逐条判定：早先的 `hasRecoverableDraft()` 是「任意一条有副本就算有」的全局口径，
 * 于是「A 超限没副本 + B 有副本」会直接跳过确认，A 的最后修改静默丢失。
 * health 非 healthy 时所有副本都不可信，按全部缺失计。
 */
export function countDraftlessTabs(paths: readonly string[]): number {
  if (paths.length === 0) return 0;
  if (journalHealth !== "healthy") return paths.length;
  return paths.filter((path) => lastDraftWriteOk.get(path) !== true).length;
}

function sessionFilePath(dir: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}session.json`;
}

async function recoveryDir(): Promise<string> {
  // 必须先等 label 就绪：干净退出路径不会写任何草稿，ensureWindowLabel 没人调过，
  // 直接用 currentWindowLabel() 会写进 recovery/main/ 并覆盖主窗口的标记
  await ensureWindowLabel();
  // #404：与 write_recovery_file 的守卫根同源（便携模式为 exe 同级 data/）
  const base = await appDataRoot();
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}recovery${sep}${currentWindowLabel()}`;
}

async function writeSessionMarker(
  cleanExit: boolean,
  durability: "sync" | "none" = "none",
): Promise<boolean> {
  if (!isTauri()) return true; // 浏览器 / E2E：没有 recovery 目录，视为成功
  let file: string;
  try {
    file = sessionFilePath(await recoveryDir());
  } catch {
    // 取不到应用数据目录（headless / 测试环境）：不因为环境缺失就阻止用户退出
    return true;
  }
  try {
    // 标记本身丢了能重写，不需要掉电保证
    // 与草稿走同一条恢复区通道（`write_recovery_file`）：同一个文件两种契约会让
    // 耐久默认值/父目录语义分叉
    await writeRecoveryFile(
      file,
      JSON.stringify({
        version: 1,
        windowLabel: currentWindowLabel(),
        // 会话身份必须一起写：下次启动靠它把「这份标记」与「这批草稿」对上，
        // 否则归档只能退化成 legacy-*，handled 永远匹配不到 → 草稿被当孤儿清掉
        sessionId: currentSessionId(),
        startedAt: currentSessionStartedAt(),
        cleanExit,
        savedAt: Date.now(),
      }),
      durability,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 正常退出：所有 tab 都已保存 → 草稿没有价值，先清掉再写 `cleanExit: true`。
 *
 * 顺序不能反：先写 cleanExit 再清草稿，中途崩溃会留下「标记正常但草稿缺失」的会话，
 * 用户既没恢复提示也没有副本。
 */
export async function markCleanExit(): Promise<boolean> {
  if (!isTauri()) return true;
  const { openTabs } = useWorkspace.getState();
  for (const tab of openTabs) {
    // 只清「已经保存」的：仍 dirty 的 tab 草稿必须留到下一次 flush
    if (!tab.dirty) {
      const { clearDraft } = await import("./draft-journal");
      await clearDraft(tab.path);
    }
  }
  return writeSessionMarker(true);
}

/**
 * 放弃并退出：保留草稿，只把 `cleanExit` 写成 false。
 * 写失败时调用方**禁止 destroy**——否则内容与标记都没落盘。
 */
export async function markUncleanExit(): Promise<boolean> {
  // 这条标记的唯一作用就是「上次异常退出，请恢复」；丢了等价于没有恢复提示 → 必须落盘
  return writeSessionMarker(false, "sync");
}

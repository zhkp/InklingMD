// 退出 / 会话的最小底座（#367，随 PR-4 落地）
//
// 本 PR 还没有 draft 正文（PR-5 才写），所以：
// - `flushAllDrafts()` 是「无内容可 flush 的立即 resolve」——不是桩，此时确实没有 draft；
// - `markCleanExit()` / `markUncleanExit()` 写 `recovery/session.json` 的 `cleanExit`，
//   PR-5 的恢复面板据此判断上次是否正常退出；
// - `journalHealth` / `lastDraftWriteOk` 先给默认值，等 PR-5 接上 journal 才有写入方。

import { isTauri } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { writeTextFile } from "./fs";

export type JournalHealth = "healthy" | "degraded";

/** journal 健康度：写失败会置 degraded，退出时据此判断「恢复副本是否可信」 */
export let journalHealth: JournalHealth = "healthy";

/** draftId → 最近一次写盘是否成功（PR-5 写入；现在为空表 = 没有 draft） */
export const lastDraftWriteOk = new Map<string, boolean>();

export function setJournalHealth(health: JournalHealth): void {
  journalHealth = health;
}

/** 是否存在可信的恢复副本（PR-5 之前恒为 false：确实没有 draft） */
export function hasRecoverableDraft(): boolean {
  return journalHealth === "healthy" && lastDraftWriteOk.size > 0;
}

/**
 * 落盘所有 draft（当前无正文 → 立即 resolve）。
 *
 * 接口先立：PR-5 接上正文后由这里真正写盘（届时会加 { durability } 入参）。
 */
export async function flushAllDrafts(): Promise<void> {
  return;
}

async function writeSessionMarker(cleanExit: boolean): Promise<boolean> {
  if (!isTauri()) return true; // 浏览器 / E2E：没有 recovery 目录，视为成功
  let file: string;
  try {
    file = await join(await appDataDir(), "recovery", "session.json");
  } catch {
    // 取不到应用数据目录（headless / 测试环境）：不因为环境缺失就阻止用户退出
    return true;
  }
  try {
    // 标记本身丢了能重写，不需要掉电保证
    await writeTextFile(file, JSON.stringify({ cleanExit, savedAt: Date.now() }), {
      createParents: true,
      durability: "none",
    });
    return true;
  } catch {
    return false;
  }
}

/** 正常退出：清会话（PR-5 会先删未 pinned 的 draft，成功后才写 cleanExit=true） */
export async function markCleanExit(): Promise<boolean> {
  return writeSessionMarker(true);
}

/**
 * 放弃并退出：保留 draft（PR-5 才有），只把 cleanExit 写成 false。
 * 写失败时调用方**禁止 destroy**——否则内容与标记都没落盘。
 */
export async function markUncleanExit(): Promise<boolean> {
  return writeSessionMarker(false);
}

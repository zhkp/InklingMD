// 光标 / 滚动 checkpoint（#365 / #378，设计 §8.2）
//
// 与草稿正文分开存：光标变化时只写一份很小的 `recovery/<label>/cursor.json`，
// 不重刷整篇文档。5s 节流 + 失焦 / 页面隐藏 / 退出时立即落盘。
//
// 实现偏差（需在 PR 描述里声明）：设计把光标放在 `session.tabs`，
// 本片用独立的 `cursor.json`；`session.tabs` 元数据（tabOrder / isDirty / draftId 等）
// 与依赖它的孤儿判定都**未实现**，留给后续片。

import { isTauri } from "@tauri-apps/api/core";
import { currentWindowLabel, ensureWindowLabel } from "./draft-journal";

export const CURSOR_THROTTLE_MS = 5_000;

interface CursorSnapshot {
  pos: number | null;
  scrollTop: number | null;
  updatedAt: number;
}

interface CursorFile {
  version: 1;
  tabs: Record<string, CursorSnapshot>;
}

/** 测试注入用；生产实现见 `defaultIo` */
export interface CursorIo {
  appDataDir(): Promise<string>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string, durability: "sync" | "none"): Promise<void>;
}

const defaultIo: CursorIo = {
  // 延迟取：部分测试的 `@tauri-apps/api/path` mock 只提供 join，
  // 顶层静态导入会让整个测试文件在收集阶段就失败
  async appDataDir() {
    const { appDataDir } = await import("@tauri-apps/api/path");
    return appDataDir();
  },
  async readTextFile(path) {
    const { readTextFile } = await import("./fs");
    return readTextFile(path);
  },
  async writeTextFile(path, content, durability) {
    const { writeRecoveryFile } = await import("./fs");
    await writeRecoveryFile(path, content, durability);
  },
};

let io: CursorIo = defaultIo;
/** 待写入的变更（path → snapshot），节流窗口内合并成一次写 */
let pending = new Map<string, CursorSnapshot>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** 串行化 flush：blur / visibilitychange / 卸载 / 退出常在同一帧并发触发 */
let flushChain: Promise<boolean> = Promise.resolve(true);

export function __setCursorIo(next: CursorIo | null): void {
  io = next ?? defaultIo;
}

export function __resetCursorCheckpoint(): void {
  pending = new Map();
  if (timer !== null) clearTimeout(timer);
  timer = null;
  io = defaultIo;
  flushChain = Promise.resolve(true);
}

function isSnapshot(value: unknown): value is CursorSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const numOrNull = (x: unknown) => x === null || typeof x === "number";
  return numOrNull(v.pos) && numOrNull(v.scrollTop) && typeof v.updatedAt === "number";
}

async function cursorPath(): Promise<string> {
  await ensureWindowLabel();
  const base = await io.appDataDir();
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}recovery${sep}${currentWindowLabel()}${sep}cursor.json`;
}

function emptyFile(): CursorFile {
  return { version: 1, tabs: Object.create(null) };
}

/**
 * 读回整表。`ok=false` 表示「读失败但文件可能存在」——此时**绝不能**按空表写回，
 * 否则一次瞬时 IO 错误就会抹掉其它所有 tab 的 checkpoint。
 * 内容损坏（JSON 解析失败）不同：整份表已不可用、救不回任何记录，按空表重建，
 * 让下一次 flush 覆盖坏文件；否则 checkpoint 会永久失效且每 5s 重试一次注定失败的读。
 */
async function readFile(): Promise<{ ok: boolean; file: CursorFile }> {
  let raw: string;
  try {
    raw = await io.readTextFile(await cursorPath());
  } catch (err) {
    const missing = err instanceof Error && /not found|不存在|ENOENT/i.test(err.message);
    // 文件不存在可以按空表写；真正的读 IO 失败必须拒绝覆盖（仍可能有完好的其它 tab）
    return { ok: missing, file: emptyFile() };
  }
  // 空文件也等价于「没有 checkpoint」
  if (raw.trim() === "") return { ok: true, file: emptyFile() };

  let parsed: Partial<CursorFile>;
  try {
    parsed = JSON.parse(raw) as Partial<CursorFile>;
  } catch {
    // 外部改写 / 磁盘损坏 / 杀软截断：按空表重建，下一次 flush 会写出可解析的新表
    return { ok: true, file: emptyFile() };
  }

  const tabs: Record<string, CursorSnapshot> = Object.create(null);
  if (parsed?.tabs && typeof parsed.tabs === "object") {
    for (const [path, value] of Object.entries(parsed.tabs)) {
      if (isSnapshot(value)) tabs[path] = value;
    }
  }
  return { ok: true, file: { version: 1, tabs } };
}

/** 重新排队：写失败后仍要有一次自动重试，不能只靠「下次用户再动光标」 */
function armRetry(): void {
  if (timer !== null || pending.size === 0) return;
  timer = setTimeout(() => {
    timer = null;
    void flushCursorCheckpoint();
  }, CURSOR_THROTTLE_MS);
}

/**
 * 节流登记一次光标变化。窗口内多次调用只保留最后一次，
 * 到点后把**所有**改动合并成一次写盘（不是每个 tab 各写一次）。
 */
export function scheduleCursorCheckpoint(
  tabPath: string,
  pos: number | null,
  scrollTop: number | null,
  now = Date.now(),
): void {
  if (!isTauri()) return;
  pending.set(tabPath, { pos, scrollTop, updatedAt: now });
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flushCursorCheckpoint();
  }, CURSOR_THROTTLE_MS);
}

/** 立即落盘（失焦 / visibilitychange / 退出）；返回 false 表示失败且已安排自动重试 */
export function flushCursorCheckpoint(durability: "sync" | "none" = "none"): Promise<boolean> {
  // 串行：并发 flush 时后者必须基于前者写完的表，不能各自 read-modify-write
  const result = flushChain.then(() => doFlush(durability));
  flushChain = result.catch(() => true as unknown as boolean);
  return result;
}

async function doFlush(durability: "sync" | "none"): Promise<boolean> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return true;

  const batch = pending;
  pending = new Map();
  try {
    const { ok, file } = await readFile();
    if (!ok) throw new Error("cursor.json 读取失败，拒绝按空表覆盖");

    for (const [path, snapshot] of batch) {
      const old = file.tabs[path];
      // `updatedAt` 的消费者：失败重试/并发合并时保留较新的那份
      if (!old || old.updatedAt <= snapshot.updatedAt) file.tabs[path] = snapshot;
    }
    await io.writeTextFile(await cursorPath(), JSON.stringify(file), durability);
    return true;
  } catch {
    // 写/读失败：状态放回队列（等待期间的新值优先），并安排一次自动重试
    pending = new Map([...batch, ...pending]);
    armRetry();
    return false;
  }
}

/** 恢复某个 tab 的光标；没有记录 / 字段不合法时返回 null（不是错误） */
export async function readCursorCheckpoint(tabPath: string): Promise<CursorSnapshot | null> {
  const { file } = await readFile();
  const snapshot = Object.prototype.hasOwnProperty.call(file.tabs, tabPath)
    ? file.tabs[tabPath]
    : undefined;
  return isSnapshot(snapshot) ? snapshot : null;
}

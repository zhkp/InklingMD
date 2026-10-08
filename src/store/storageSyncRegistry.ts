/**
 * #225 §C4（**方案 A：全量收敛**）：跨窗口 `storage` 同步的**唯一注册点**。
 *
 * 背景（issue #225 A2）：实测 `addEventListener("storage", …)` 共 5 处
 * （`settings.ts` / `shortcuts.ts` / `DeletedSnapshots.tsx` / `theme.ts` / `workspace/storageSync.ts`），
 * 各自注册已形成多种风格；只收敛 theme 会变成「第三种风格」。故：
 * - **全部** key 统一在 `registerStorageSync` / `registerStorageSyncPrefix` 登记；
 * - `window.addEventListener("storage")` 只在本模块安装**一次**（模块级单例）；
 * - 既有约定保持不变：`e.key === null`（`localStorage.clear()`）**不抹除**本窗口状态；
 * - 组件级订阅返回**取消注册**函数（`DeletedSnapshots.tsx` 走这条路）。
 */
export type StorageSyncHandler = (e: StorageEvent) => void;

interface Registration {
  /** 精确 key；prefix 注册时为空 */
  key?: string;
  /** 前缀 key（快照 `inkling-theme-snapshot:<themeId>:<hash>` 等动态 key） */
  prefix?: string;
  handler: StorageSyncHandler;
  /** 来源标签：只用于诊断与断言（「唯一注册点」的可核查性） */
  owner: string;
}

const registrations: Registration[] = [];
let installed = false;

/** 模块级单例：只安装一次 `storage` 监听 */
function installStorageSync(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;
  window.addEventListener("storage", (e: StorageEvent) => {
    // `localStorage.clear()`：其他窗口整体清空属异常路径，不主动抹掉本窗口内存状态（既有约定）
    if (!e.key) return;
    for (const reg of [...registrations]) {
      const matched = reg.key !== undefined ? reg.key === e.key : (e.key ?? "").startsWith(reg.prefix ?? "");
      if (!matched) continue;
      try {
        reg.handler(e);
      } catch (err) {
        console.error(`[storage-sync] ${reg.owner} 处理 ${e.key} 失败：`, err);
      }
    }
  });
}

/** 精确 key 登记；返回取消注册函数 */
export function registerStorageSync(key: string, handler: StorageSyncHandler, owner = "unknown"): () => void {
  installStorageSync();
  const reg: Registration = { key, handler, owner };
  registrations.push(reg);
  return () => {
    const idx = registrations.indexOf(reg);
    if (idx >= 0) registrations.splice(idx, 1);
  };
}

/** 前缀 key 登记（快照等动态 key）；返回取消注册函数 */
export function registerStorageSyncPrefix(
  prefix: string,
  handler: StorageSyncHandler,
  owner = "unknown",
): () => void {
  installStorageSync();
  const reg: Registration = { prefix, handler, owner };
  registrations.push(reg);
  return () => {
    const idx = registrations.indexOf(reg);
    if (idx >= 0) registrations.splice(idx, 1);
  };
}

/** 诊断/断言：当前登记了哪些 key（唯一注册点的可核查证据） */
export function registeredStorageSyncKeys(): string[] {
  return registrations.map((r) => r.key ?? `${r.prefix}*`);
}

/** 诊断/断言：登记来源标签与 key 的对应关系 */
export function registeredStorageSyncOwners(): { owner: string; key: string }[] {
  return registrations.map((r) => ({ owner: r.owner, key: r.key ?? `${r.prefix}*` }));
}

/** 测试用：清空登记并卸载单例（jsdom 下无 listener 泄漏问题，仅重置状态） */
export function resetStorageSyncForTests(): void {
  registrations.length = 0;
  installed = false;
}

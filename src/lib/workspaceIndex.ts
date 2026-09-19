// Quick Open 的工作区文件索引缓存层（#228）
//
// 职责：懒构建 + TTL 复用 + stale-while-revalidate + 失效 + 失败降级 + 单文件模式候选集。
// 不负责排序与渲染（分别见 quickOpenScore.ts / QuickOpenPanel.tsx）。
//
// 设计取舍：
// - **不在启动时构建**：首次打开面板才发起，不占用启动时间。
// - **不传代次**：代次由 Rust 侧分配（#227 复审 P2-2）。前端各窗口独立计数会让
//   后开窗口的请求被永久判过期，因此前端不维护、也不传代次。
// - **不做目录监听与逐文件 mtime 校验**（#228 的「兜底策略」可选实现）：TTL 重建
//   已足够覆盖 5,000 文件量级（一次遍历 50ms 量级），逐文件 mtime 校验反而更贵。

import { listWorkspaceFiles } from "./fs";

/** 缓存生存期：超期后**先返回旧结果**渲染，同时后台重建（stale-while-revalidate） */
export const INDEX_TTL_MS = 30_000;

export type WorkspaceMode = "folder" | "file" | null;

/** 一次索引读取的结果快照 */
export interface WorkspaceIndexSnapshot {
  /** 全部候选文件路径（未排序，排序见 quickOpenScore） */
  files: string[];
  /** 后端因超出上限而截断 */
  truncated: boolean;
  /** true = 返回的是过期缓存，后台正在重建；调用方可在 refresh 落定后替换列表 */
  stale: boolean;
  /** 后台重建的 promise；无过期缓存时为 null（新鲜命中或首次构建完成为 null） */
  refresh: Promise<WorkspaceIndexSnapshot> | null;
}

/** 索引的输入来源（由调用方从 store 取值，模块本身不依赖 store） */
export interface CandidateSource {
  rootPath: string | null;
  workspaceMode: WorkspaceMode;
  /** 已打开标签页的路径 */
  tabPaths: string[];
  /** 最近打开文件（最新在前） */
  recentFiles: string[];
}

interface CacheEntry {
  root: string;
  files: string[];
  truncated: boolean;
  builtAt: number;
}

let cache: CacheEntry | null = null;
/** 同 root 的在途请求，用于合并重复调用（避免连开两次面板触发两次遍历） */
let inFlight: { root: string; promise: Promise<WorkspaceIndexSnapshot> } | null = null;
/** 最近一次被请求的 root：迟到的旧 root 响应不得覆盖新 root 的缓存 */
let latestRoot: string | null = null;
/**
 * 失效世代：每次 invalidate 自增
 *
 * 仅靠清空 `cache` 拦不住「在途请求落定后写回」——在途响应是在失效**之前**扫的盘，
 * 落定却会把旧清单以新的 `builtAt` 写回缓存，等于把失效静默抹掉（TTL 内都读到旧数据）。
 * 因此 build 在发起前捕获世代号，落定时世代已变则视作过期（不写缓存 + 立刻补一次重建）。
 */
let invalidateEpoch = 0;

/**
 * 使缓存失效
 *
 * 失效来源（#228）：工作区切换（rootPath 变化）、文件树 refreshTree 完成后、
 * 文件重命名/删除、另存为新建文件。由这些位置显式调用，模块不做隐式订阅
 * （避免 import 副作用）。
 */
export function invalidateWorkspaceIndex(): void {
  cache = null;
  invalidateEpoch += 1;
}

/** 仅供单测：重置模块级状态 */
export function __resetWorkspaceIndexForTests(): void {
  cache = null;
  inFlight = null;
  latestRoot = null;
  invalidateEpoch = 0;
}

/**
 * 单文件模式候选集：已打开标签页 + 最近打开文件，去重且保序（**不扫磁盘**，#228）
 *
 * 先开放标签页再最近文件：前者是「当前正在用的」，优先级更高。
 */
export function collectSingleFileCandidates(
  tabPaths: string[],
  recentFiles: string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [...tabPaths, ...recentFiles]) {
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

function emptySnapshot(files: string[]): WorkspaceIndexSnapshot {
  return { files, truncated: false, stale: false, refresh: null };
}

/** 发起一次真实遍历并写入缓存 */
function build(root: string, now: () => number): Promise<WorkspaceIndexSnapshot> {
  if (inFlight && inFlight.root === root) return inFlight.promise;
  latestRoot = root;
  const startEpoch = invalidateEpoch;
  // 在途标记必须在**本次落定回调里**清掉，而不是挂 .finally()：
  // .finally 的清理比调用方的 await 恢复晚两个微任务，调用方紧接着的读取
  // 会误命中这个已经落定的「在途」项，于是拿到同一份旧结果而不触发新遍历。
  const promise = listWorkspaceFiles(root).then(
    (result) => {
      if (inFlight?.promise === promise) inFlight = null;
      const snapshot: WorkspaceIndexSnapshot = {
        files: result.files,
        truncated: result.truncated,
        stale: false,
        refresh: null,
      };
      // 期间发生过失效（重命名 / 删除 / 文件树刷新）：这份结果是失效**之前**扫的盘。
      // 既不写缓存，也不得当成新鲜数据返回，而是立刻补一次重建 —— 调用方沿用
      // stale-while-revalidate 的既有路径无缝替换（先渲染旧列表，新结果落定后换掉）。
      if (startEpoch !== invalidateEpoch) {
        return { ...snapshot, stale: true, refresh: build(root, now) };
      }
      // 工作区已切走：本次结果仍可返回给调用方，但不写入缓存，
      // 否则迟到的旧 root 响应会把新 root 的缓存挤掉（下次打开要多跑一次遍历）
      if (latestRoot === root) {
        cache = {
          root,
          files: result.files,
          truncated: result.truncated,
          builtAt: now(),
        };
      }
      return snapshot;
    },
    (error: unknown) => {
      // 失败同样要清在途标记，否则这个 root 会被后续调用永久合并进同一个失败请求
      if (inFlight?.promise === promise) inFlight = null;
      throw error;
    },
  );
  inFlight = { root, promise };
  return promise;
}

/**
 * 取候选文件列表（面板的唯一入口）
 *
 * - 单文件模式（`workspaceMode !== "folder"` 或无 rootPath）：**不调用命令**，
 *   直接返回「已打开标签页 + 最近文件」。
 * - 工作区模式：TTL 内命中直接返回；TTL 超期**立即**返回旧结果（`stale: true`）
 *   并附上后台重建的 `refresh`；无缓存则等待构建（失败时 reject，由面板展示错误与重试）。
 *
 * `now` 可注入，便于单测 TTL 而不依赖假定时器。
 */
export function loadCandidates(
  source: CandidateSource,
  now: () => number = Date.now,
): Promise<WorkspaceIndexSnapshot> {
  const { rootPath, workspaceMode } = source;
  if (workspaceMode !== "folder" || !rootPath) {
    return Promise.resolve(
      emptySnapshot(collectSingleFileCandidates(source.tabPaths, source.recentFiles)),
    );
  }

  const hit = cache && cache.root === rootPath ? cache : null;
  if (hit) {
    const age = now() - hit.builtAt;
    if (age < INDEX_TTL_MS) {
      return Promise.resolve({
        files: hit.files,
        truncated: hit.truncated,
        stale: false,
        refresh: null,
      });
    }
    // 过期：先返回旧结果，后台重建（失败不影响已渲染的旧结果，仅保持 stale 状态）
    const refresh = build(rootPath, now);
    return Promise.resolve({
      files: hit.files,
      truncated: hit.truncated,
      stale: true,
      refresh,
    });
  }

  return build(rootPath, now);
}

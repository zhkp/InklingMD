// 文件变更监听 Hook
// 轮询当前活跃文件的修改时间，检测到外部修改时：
// - 文件未修改（dirty=false）：confirm 询问是否重载
// - 文件有未保存修改（dirty=true）：读取磁盘最新内容，弹出冲突对话框
//   （ConflictDialog：另存副本 / 查看差异 / 丢弃重载 / 继续编辑）。
//   不再用 confirm 二选一——取消后直接保存会静默覆盖外部修改（用户口头反馈）。
// 保存后会短暂忽略变更（2 秒窗口），避免自身保存触发误报。
// 仅桌面端（Tauri）生效，浏览器 mock 环境直接跳过。
//
// 自身写盘不能误判为「外部修改」，靠三道防线兜底（issue #144）：
// - A（主修）：store 订阅里保存事件发生时，把 tab.diskMtime 登记为新的已知基线；
// - B（兜底）：轮询中 mtime 与 tab.diskMtime 在容差内 → 判定为自家写盘，静默登记基线；
// - C（语义修正）：保存忽略窗内不再整体跳过检查，而是刷新基线但跳过弹窗，
//   使窗口一过不会因为基线陈旧而补一次误报。

import { useEffect, useRef } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { useWorkspace } from "../store/workspace";
import { useConflict } from "../store/conflict";
import { askConfirmation } from "./dialogs";
import { fileMtime, readTextFile } from "./fs";
import { baseName } from "./path-utils";
import { flushAllMarkdownPublishers } from "../components/Editor/markdown-publisher";

const POLL_INTERVAL = 3000;
const SAVE_IGNORE_WINDOW = 2000;
/** mtime 比较容差（毫秒）：文件系统时间戳精度不一致，5ms 内视为同一时刻 */
const MTIME_TOLERANCE_MS = 5;

export function useFileWatcher(): void {
  const knownMtimesRef = useRef<Map<string, number>>(new Map());
  const ignoreUntilRef = useRef<number>(0);
  const lastSavedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isTauri()) return;

    let timer: number | null = null;
    let cancelled = false;

    const check = async () => {
      if (cancelled) return;
      const { openTabs, currentFile, reloadFile } = useWorkspace.getState();
      if (openTabs.length === 0) return;
      // C：保存忽略窗内不弹窗，但检查继续跑——窗内的轮询会把自家写盘后的
      // mtime 刷成新基线，窗口一过就不会因为基线陈旧而补一次误报。
      const withinSaveIgnoreWindow = Date.now() < ignoreUntilRef.current;

      const tabsToCheck = openTabs.filter((t) => !t.isUntitled);
      const isConflictOpen = Boolean(useConflict.getState().conflict);

      /**
       * 冲突流：本地有未保存修改（或复核后变脏）时，读磁盘最新内容并弹
       * ConflictDialog（三选项 + Diff）；磁盘读取失败（文件被删除等）退化为
       * 统一的确认框（丢弃当前修改并重载）。
       */
      const openConflictFlow = async (filePath: string) => {
        try {
          const diskContent = await readTextFile(filePath);
          if (cancelled) return;
          if (useWorkspace.getState().currentFile !== filePath) return;
          // issue #170 评审：readTextFile 往返期间 overlay 未渲染、编辑器仍可
          // 交互，用户这段尾部输入处于 150ms 防抖内未发布——openConflict 的
          // localContent 取自 currentContent，不 flush 会漏掉尾部输入（备份与
          // Diff 都基于陈旧快照，用户可能据此做出丢编辑决策）。此处再 flush：
          // 无新输入时 timer 为空，序列化函数零成本（markdown-publisher.ts）。
          flushAllMarkdownPublishers();
          useConflict.getState().openConflict({
            filePath,
            localContent: useWorkspace.getState().currentContent,
            diskContent,
            detectedAt: Date.now(),
          });
        } catch {
          // 磁盘读取失败（文件被删除等）：使用统一 dialog 提示
          const shouldReload = await askConfirmation(
            `「${baseName(filePath)}」已被外部修改或删除，且当前有未保存的修改。\n是否丢弃当前修改并重新加载？`,
            { title: "文件冲突", kind: "warning" },
          );
          if (shouldReload) {
            try {
              await reloadFile(filePath);
            } catch (err) {
              console.warn("reloadFile failed", err);
            }
            knownMtimesRef.current.delete(filePath);
          }
        }
      };

      /**
       * 活跃文件的外部修改决策（issue #170）：
       * 编辑器序列化有 150ms 防抖，store 的 dirty 镜像可能落后于「用户刚输入
       * 但尚未发布」的内容——直接按镜像判定会走「干净→询问重载」，重载会把
       * 这些编辑静默丢弃。决策前统一 flush（与 switchTab 入口一致），让 dirty
       * 反映真实状态；确认框停留期间防抖发布同样可能使内容变脏，重载前须
       * 复核，变脏改走冲突对话框而不是无条件覆盖。
       */
      const handleActiveFileChange = async (filePath: string) => {
        flushAllMarkdownPublishers();
        const latest = useWorkspace.getState();
        if (latest.currentFile === filePath && latest.dirty) {
          await openConflictFlow(filePath);
          return;
        }
        // 本地无修改：询问重载
        const shouldReload = await askConfirmation(
          `「${baseName(filePath)}」已被外部修改，是否重新加载？`,
          { title: "文件已被外部修改", kind: "info" },
        );
        if (!shouldReload) return;
        // 弹窗期间防抖发布可能已把编辑写进 store：重载前复核 dirty
        flushAllMarkdownPublishers();
        const now = useWorkspace.getState();
        if (now.currentFile === filePath && now.dirty) {
          await openConflictFlow(filePath);
          return;
        }
        try {
          await reloadFile(filePath);
        } catch (err) {
          console.warn("reloadFile failed", err);
        }
        knownMtimesRef.current.delete(filePath);
      };

      for (const tab of tabsToCheck) {
        if (cancelled) return;
        const filePath = tab.path;
        const isActive = filePath === currentFile;

        let mtime: number;
        try {
          mtime = await fileMtime(filePath);
          if (tab.deletedOnDisk) {
            useWorkspace.setState((current) => ({
              openTabs: current.openTabs.map((t) =>
                t.path === filePath ? { ...t, deletedOnDisk: false } : t,
              ),
            }));
          }
        } catch {
          // 获取 mtime 失败，说明文件在磁盘上可能被删除或无法访问
          if (!tab.deletedOnDisk) {
            useWorkspace.setState((current) => ({
              openTabs: current.openTabs.map((t) =>
                t.path === filePath ? { ...t, deletedOnDisk: true } : t,
              ),
            }));
          }
          continue;
        }

        const knownMtime = knownMtimesRef.current.get(filePath);
        if (knownMtime === undefined) {
          knownMtimesRef.current.set(filePath, mtime);
          continue;
        }

        if (Math.abs(mtime - knownMtime) < MTIME_TOLERANCE_MS) continue;

        // B：mtime 变了，但与 store 记录的写盘基线一致 → 自家写盘，静默登记新基线。
        // 覆盖「写盘已完成、store 已登记 diskMtime，但 A 因时序未命中」的竞态。
        if (tab.diskMtime !== undefined && Math.abs(mtime - tab.diskMtime) < MTIME_TOLERANCE_MS) {
          knownMtimesRef.current.set(filePath, mtime);
          continue;
        }

        knownMtimesRef.current.set(filePath, mtime);
        // C：忽略窗内只刷新基线，不打扰用户
        if (withinSaveIgnoreWindow) continue;

        // 如果是当前活跃文件且未打开冲突对话框，则触发相应处理
        if (isActive && !isConflictOpen) {
          await handleActiveFileChange(filePath);
        }
      }
    };

    timer = window.setInterval(check, POLL_INTERVAL);

    // 窗口重新获得焦点或页面可见时立即触发检查
    const onFocusOrVisible = () => {
      void check();
    };
    window.addEventListener("focus", onFocusOrVisible);
    document.addEventListener("visibilitychange", onFocusOrVisible);

    // 监听 store：保存后忽略一段时间；切换文件后重置已知 mtime
    let lastFile = useWorkspace.getState().currentFile;
    const unsub = useWorkspace.subscribe((s) => {
      if (s.lastSavedAt && s.lastSavedAt !== lastSavedAtRef.current) {
        lastSavedAtRef.current = s.lastSavedAt;
        ignoreUntilRef.current = Date.now() + SAVE_IGNORE_WINDOW;
        // A：保存刚写盘，磁盘 mtime 已被自己改掉。此时必须把写盘后的 mtime
        // 登记为 watcher 基线，否则 2 秒忽略窗一过，轮询必然拿新 mtime 对比
        // 旧基线，误报「文件已被外部修改」。
        for (const tab of s.openTabs) {
          if (tab.lastSavedAt === s.lastSavedAt && tab.diskMtime !== undefined) {
            knownMtimesRef.current.set(tab.path, tab.diskMtime);
          }
        }
      }
      if (s.currentFile !== lastFile) {
        lastFile = s.currentFile;
        // 切走文件时关掉残留的冲突对话框（上下文已失配）
        if (useConflict.getState().conflict) {
          useConflict.getState().dismiss();
        }
      }
    });

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onFocusOrVisible);
      document.removeEventListener("visibilitychange", onFocusOrVisible);
      unsub();
    };
  }, []);
}

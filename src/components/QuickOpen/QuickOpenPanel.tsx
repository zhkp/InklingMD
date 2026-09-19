// Quick Open 面板（#228）
//
// 键盘优先的文件快速打开：Ctrl/Cmd+P 打开 → 输入实时过滤 → ↑/↓ 选择 → Enter 打开 → Esc 关闭。
// 候选集与排序分别来自 workspaceIndex（索引缓存）与 quickOpenScore（纯函数），
// 本组件只负责「取数 → 渲染 → 键盘交互 → 打开文件」。
//
// a11y 采用 WAI-ARIA combobox 模式：焦点**始终留在输入框**，用 aria-activedescendant
// 指向高亮项。因此没有复用 useMenuA11y —— 那个 hook 是把 DOM 焦点移到 [role="menuitem"]
// 上，会把焦点从输入框夺走，导致连续输入被打断（Quick Open 的核心交互）。

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspace } from "../../store/workspace";
import { relativeToRoot } from "../../lib/path";
import {
  loadCandidates,
  type CandidateSource,
} from "../../lib/workspaceIndex";
import {
  rankQuickOpenFiles,
  type QuickOpenCandidate,
} from "../../lib/quickOpenScore";
import { IconFileText, IconX } from "../icons";
import "./QuickOpenPanel.css";

/** 渲染上限：排序后截断，避免数千行 DOM（#228 §结果上限） */
export const MAX_RENDERED_RESULTS = 200;

const LIST_ID = "quick-open-list";

function optionId(index: number): string {
  return `quick-open-option-${index}`;
}

interface QuickOpenPanelProps {
  onClose: () => void;
}

export function QuickOpenPanel({ onClose }: QuickOpenPanelProps) {
  const rootPath = useWorkspace((s) => s.rootPath);
  const workspaceMode = useWorkspace((s) => s.workspaceMode);
  const openTabs = useWorkspace((s) => s.openTabs);
  const recentFiles = useWorkspace((s) => s.recentFiles);
  const openFile = useWorkspace((s) => s.openFile);

  const [query, setQuery] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 打开单个候选失败（多为文件已被删除）：只在状态栏提示，**不隐藏列表**，用户可另选 */
  const [openError, setOpenError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /** 递增即重试：作为取数 effect 的依赖，避免额外的手动重建分支 */
  const [retryToken, setRetryToken] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开时自动聚焦输入框（键盘优先：打开即可直接输入）
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 取候选集：懒构建由索引层负责，这里只消费快照
  useEffect(() => {
    let cancelled = false;
    const source: CandidateSource = {
      rootPath,
      workspaceMode,
      tabPaths: openTabs.map((tab) => tab.path),
      recentFiles,
    };
    setLoading(true);
    setError(null);

    loadCandidates(source)
      .then((snapshot) => {
        if (cancelled) return;
        setPaths(snapshot.files);
        setTruncated(snapshot.truncated);
        setLoading(false);
        if (!snapshot.refresh) return;
        // 过期缓存已先行渲染，后台重建完成后无缝替换；
        // 重建失败保持旧结果（不把已在展示的列表变成错误态）
        void snapshot.refresh
          .then((fresh) => {
            if (cancelled) return;
            setPaths(fresh.files);
            setTruncated(fresh.truncated);
          })
          .catch(() => {});
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setPaths([]);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rootPath, workspaceMode, openTabs, recentFiles, retryToken]);

  // 候选集只在「索引 / 工作区 / 标签 / 最近文件」变化时重建；纯打字只触发重新排序。
  // 与排序拆成两个 memo 是性能要求（#228 验收：首字符到结果渲染 < 50ms）：
  // 5,000 候选时若每次按键都重建候选对象（含 5,000 次路径归一化），开销远大于排序本身。
  const candidates = useMemo<QuickOpenCandidate[]>(() => {
    const openPaths = new Set(openTabs.map((tab) => tab.path));
    // 与 Array.prototype.indexOf 同语义：同路径取首次出现（最近文件列表不应有重复，
    // 但保持与旧实现一致，避免语义漂移）
    const recentIndexes = new Map<string, number>();
    recentFiles.forEach((path, index) => {
      if (!recentIndexes.has(path)) recentIndexes.set(path, index);
    });
    return paths.map((path) => ({
      path,
      relPath: relativeToRoot(path, rootPath),
      isOpen: openPaths.has(path),
      recentIndex: recentIndexes.get(path) ?? -1,
    }));
  }, [paths, rootPath, openTabs, recentFiles]);

  const ranked = useMemo(
    () => rankQuickOpenFiles(candidates, query),
    [candidates, query],
  );

  const visible = useMemo(
    () => ranked.slice(0, MAX_RENDERED_RESULTS),
    [ranked],
  );

  // 输入或候选集变化后回到首项，避免高亮停在一个已不存在的位置；同时清掉上一条打开失败提示
  useEffect(() => {
    setActiveIndex(0);
    setOpenError(null);
  }, [query, paths]);

  // 高亮项跟随滚动（只滚最近距离，不打断用户手动滚动）
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-option-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const openAndClose = async (path: string) => {
    setOpenError(null);
    try {
      await openFile(path);
    } catch (e) {
      // 打开失败（最常见是文件已被删除）必须在**面板内**给出反馈：
      // workspace store 确实按路径记了 fileOpenErrors，但那张表只在侧边栏的
      // 文件树 / 最近文件 / 书签三处渲染，而「已删除」的路径恰恰不在文件树里，
      // 用户视线又在遮罩面板上 —— 不提示的表现就是「按 Enter 什么都没发生」。
      setOpenError(e instanceof Error ? e.message : String(e));
      return;
    }
    onClose();
  };

  /**
   * 焦点陷阱
   *
   * 本面板声明了 `aria-modal="true"`，语义上等于「背景内容不可交互」，
   * 因此必须真的把 Tab 限制在面板内；否则键盘/读屏用户会被送到被声明为
   * inert 的背景上（评审 P3-2）。
   */
  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled])',
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && panel.contains(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
      return;
    }
    if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = visible[activeIndex];
      if (target) void openAndClose(target.path);
    }
  };

  const showList = !loading && !error && visible.length > 0;
  const hiddenByLimit = ranked.length - visible.length;

  return (
    <div className="qo-backdrop" onClick={onClose}>
      <div
        className="qo-modal"
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handlePanelKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label="快速打开文件"
      >
        <div className="qo-header">
          <input
            ref={inputRef}
            className="qo-input"
            type="text"
            role="combobox"
            // 只有 placeholder 不足以构成可访问名称，读屏会念成「编辑框」；
            // 显式 aria-label 后才会念出「快速打开文件」（评审 P3-2）
            aria-label="快速打开文件"
            aria-expanded={showList}
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={
              showList ? optionId(activeIndex) : undefined
            }
            placeholder="输入文件名或路径片段…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="qo-close" onClick={onClose} title="关闭 (Esc)">
            <IconX size={15} />
          </button>
        </div>

        <div className="qo-status">
          {loading && <span>正在索引工作区…</span>}
          {!loading && error && (
            <>
              <span className="qo-error">{error}</span>
              <button
                className="qo-retry"
                onClick={() => setRetryToken((t) => t + 1)}
              >
                重试
              </button>
            </>
          )}
          {!loading && !error && openError && (
            <span className="qo-error" role="alert">
              打开失败：{openError}
            </span>
          )}
          {!loading && !error && ranked.length > 0 && (
            <span>
              {`${ranked.length} 个候选`}
              {truncated && "（索引已达上限，仅覆盖部分文件）"}
            </span>
          )}
        </div>

        {showList && (
          <div
            className="qo-results"
            role="listbox"
            id={LIST_ID}
            aria-label="候选文件"
            ref={listRef}
          >
            {visible.map((item, index) => (
              <div
                key={item.path}
                id={optionId(index)}
                data-option-index={index}
                role="option"
                aria-selected={index === activeIndex}
                className={`qo-item${index === activeIndex ? " qo-item-active" : ""}`}
                title={item.path}
                onClick={() => void openAndClose(item.path)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="qo-item-icon">
                  <IconFileText size={14} />
                </span>
                <span className="qo-item-name">{item.basename}</span>
                <span className="qo-item-dir">
                  {item.relPath === item.basename
                    ? ""
                    : item.relPath.slice(0, item.relPath.length - item.basename.length - 1)}
                </span>
              </div>
            ))}
          </div>
        )}

        {!loading && !error && visible.length === 0 && (
          <div className="qo-empty">
            {query.trim() ? "无匹配结果" : "没有可打开的文件"}
          </div>
        )}

        <div className="qo-footer">
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          {hiddenByLimit > 0 && (
            <span className="qo-limit">
              仅显示前 {MAX_RENDERED_RESULTS} 条，继续输入以缩小范围
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default QuickOpenPanel;

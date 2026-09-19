// 全局搜索面板
// 在工作区所有 .md 文件中搜索文本内容，列出命中文件 + 行号 + 预览。
// 点击命中项跳转到对应文件对应行。
// 快捷键 Ctrl/Cmd+Shift+F 打开，Esc 关闭。

import { useState, useRef, useEffect, useMemo } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { useWorkspace } from "../../store/workspace";
import {
  searchInWorkspace,
  nextGlobalSearchGeneration,
  type SearchHit,
} from "../../lib/fs";
import { relativeToRoot } from "../../lib/path";
import { IconFileText, IconX } from "../icons";
import "./GlobalSearchPanel.css";

interface GlobalSearchPanelProps {
  getEditor: () => Editor | undefined;
  onClose: () => void;
}

/** 按文件分组命中结果 */
interface GroupedResult {
  path: string;
  hits: SearchHit[];
}

/** 高亮预览文本中的匹配词 */
function highlightPreview(preview: string, query: string, useRegex: boolean, caseSensitive: boolean): React.ReactNode {
  if (!query) return preview;
  let pattern: string;
  try {
    pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(pattern, caseSensitive ? "g" : "gi");
    const parts: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(preview)) !== null) {
      if (m.index > last) parts.push(preview.slice(last, m.index));
      parts.push(
        <mark key={m.index} className="gs-highlight">
          {m[0]}
        </mark>,
      );
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < preview.length) parts.push(preview.slice(last));
    return parts;
  } catch {
    return preview;
  }
}

export function GlobalSearchPanel({ getEditor, onClose }: GlobalSearchPanelProps) {
  const rootPath = useWorkspace((s) => s.rootPath);
  const openFile = useWorkspace((s) => s.openFile);
  const [query, setQuery] = useState("");
  const [replaceText] = useState("");
  void replaceText;
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeqRef = useRef(0);

  // 打开时自动聚焦
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 卸载时删除注册待执行的取消调用，让 Rust 侧在途搜索提前退出（#163）。
  // 关闭面板（卸载）等价于发起一次「空查询、新代次」的搜索：
  // 命令入口 fetch_max 登记新代次后空查询立即返回（不扫描），
  // 在途旧扫描在检查点看到代次推进后提前退出。结果被丢弃，故 fire-and-forget。
  // （rootPath 经 store getter 读取最新值，避免闭包捕获过期路径。）
  useEffect(() => {
    return () => {
      const root = useWorkspace.getState().rootPath;
      void searchInWorkspace(root ?? "", "", false, false, nextGlobalSearchGeneration());
    };
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 防抖搜索：代次递增既作为竞态守卫（旧响应丢弃），也传给后端取消在途旧搜索（#163）
  useEffect(() => {
    const seq = nextGlobalSearchGeneration();
    searchSeqRef.current = seq;
    if (!query.trim()) {
      setHits([]);
      setTruncated(false);
      setError(null);
      setActiveIndex(0);
      setSearching(false);
      return;
    }
    if (!rootPath) {
      setError("未打开工作区");
      setSearching(false);
      return;
    }
    setSearching(true);
    setError(null);
    const timer = setTimeout(() => {
      searchInWorkspace(rootPath, query, caseSensitive, useRegex, seq)
        .then((result) => {
          if (searchSeqRef.current !== seq) return;
          setHits(result.hits);
          setTruncated(result.truncated);
          setActiveIndex(0);
          setSearching(false);
        })
        .catch((e) => {
          if (searchSeqRef.current !== seq) return;
          setError(e instanceof Error ? e.message : String(e));
          setSearching(false);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, useRegex, rootPath]);

  // 按文件分组
  const grouped = useMemo<GroupedResult[]>(() => {
    const map = new Map<string, SearchHit[]>();
    for (const h of hits) {
      const arr = map.get(h.path) ?? [];
      arr.push(h);
      map.set(h.path, arr);
    }
    return Array.from(map.entries()).map(([path, hs]) => ({ path, hits: hs }));
  }, [hits]);

  const totalHits = hits.length;

  /** 跳转到命中位置 */
  const jumpTo = async (hit: SearchHit) => {
    try {
      await openFile(hit.path);
    } catch {
      // 错误已由 workspace store 按路径记录，留在当前搜索结果即可重试
      return;
    }
    // 文件读取期间若用户选择了其他文件，旧结果不得在新编辑器中移动光标
    if (useWorkspace.getState().currentFile !== hit.path) return;
    // 等编辑器更新后定位光标
    setTimeout(() => {
      if (useWorkspace.getState().currentFile !== hit.path) return;
      const editor = getEditor();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const doc = view.state.doc;

        // 1) 文本匹配定位：找到「点击项是本文件第几处命中」，定位到对应的第 N 次出现，
        //    而不是永远跳到第一处（ProseMirror 中 paragraph/heading 是独立块节点，
        //    节点文本不含 \n，按行号累计算不出来，只能按出现次序定位）
        // 正则搜索时 query 是模式串，先从命中行预览里提取实际匹配文本再找
        let searchTarget = query;
        if (useRegex && searchTarget) {
          try {
            const re = new RegExp(searchTarget, caseSensitive ? "" : "i");
            const m = re.exec(hit.preview);
            if (m) searchTarget = m[0];
          } catch {
            // 非法正则：放弃文本定位，走块级回退
          }
        }

        const holder: { pos: number | null } = { pos: null };
        if (searchTarget) {
          // 本文件内排在点击项之前的命中数（hits 按文件内行序返回）
          const sameFileHits = hits.filter((h) => h.path === hit.path);
          const nth = Math.max(0, sameFileHits.indexOf(hit));
          const target = caseSensitive ? searchTarget : searchTarget.toLowerCase();

          let occurrence = 0;
          doc.descendants((node, pos) => {
            if (holder.pos !== null) return false;
            if (node.isText && node.text) {
              const text = caseSensitive ? node.text : node.text.toLowerCase();
              let from = 0;
              for (;;) {
                const idx = text.indexOf(target, from);
                if (idx === -1) break;
                if (occurrence === nth) {
                  holder.pos = pos + idx;
                  return false;
                }
                occurrence++;
                from = idx + Math.max(1, target.length);
              }
            }
            return true;
          });
        }

        // 2) 文本未命中（文档已编辑/正则异常）：回退按顶层块序号近似行号定位
        if (holder.pos === null) {
          let blockIndex = 1;
          doc.forEach((_node, offset) => {
            if (holder.pos !== null) return;
            if (blockIndex === hit.line) {
              holder.pos = offset + 1;
            }
            blockIndex++;
          });
        }

        try {
          const finalPos = Math.max(0, Math.min(holder.pos ?? 0, doc.content.size));
          const sel = TextSelection.near(doc.resolve(finalPos));
          view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
          view.focus();
        } catch {
          // 忽略定位失败
        }
      });
    }, 200);
  };

  // 键盘上下导航
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, Math.max(hits.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[activeIndex];
      if (hit) void jumpTo(hit);
    }
  };

  return (
    <div className="gs-backdrop" onClick={onClose}>
      <div className="gs-modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="gs-header">
          <input
            ref={inputRef}
            className="gs-input"
            placeholder="在工作区搜索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="gs-toggles">
            <label className="gs-toggle" title="区分大小写">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => setCaseSensitive(e.target.checked)}
              />
              <span>Aa</span>
            </label>
            <label className="gs-toggle" title="正则表达式">
              <input
                type="checkbox"
                checked={useRegex}
                onChange={(e) => setUseRegex(e.target.checked)}
              />
              <span>.*</span>
            </label>
          </div>
          <button className="gs-close" onClick={onClose} title="关闭 (Esc)">
            <IconX size={15} />
          </button>
        </div>
        <div className="gs-status">
          {searching && <span>搜索中…</span>}
          {!searching && error && <span className="gs-error">{error}</span>}
          {!searching && !error && query.trim() && (
            <span>
              {totalHits > 0
                ? truncated
                  ? `${grouped.length} 个文件，${totalHits} 处匹配（已达 5000 条上限，结果已截断）`
                  : `${grouped.length} 个文件，${totalHits} 处匹配`
                : "无匹配结果"}
            </span>
          )}
        </div>
        <div className="gs-results">
          {grouped.map((group) => (
            <div key={group.path} className="gs-group">
              <div className="gs-group-header" title={group.path}>
                <span className="gs-file-icon">
                  <IconFileText size={14} />
                </span>
                <span className="gs-file-name">{relativeToRoot(group.path, rootPath)}</span>
                <span className="gs-count">{group.hits.length}</span>
              </div>
              {group.hits.map((hit) => {
                const idx = hits.indexOf(hit);
                const active = idx === activeIndex;
                return (
                  <button
                    key={`${hit.path}:${hit.line}:${hit.column}`}
                    className={`gs-hit${active ? " gs-hit-active" : ""}`}
                    onClick={() => void jumpTo(hit)}
                    onMouseEnter={() => setActiveIndex(idx)}
                  >
                    <span className="gs-line">行 {hit.line}</span>
                    <span className="gs-preview">
                      {highlightPreview(hit.preview, query, useRegex, caseSensitive)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {!searching && !error && query.trim() && totalHits === 0 && (
            <div className="gs-empty">未找到匹配内容</div>
          )}
          {!query.trim() && (
            <div className="gs-empty">输入关键词开始搜索</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default GlobalSearchPanel;

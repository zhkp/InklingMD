// 查找替换面板（浮层）
// 通过 getEditor 拿到 Milkdown 编辑器实例，dispatch search meta 触发查找/导航/替换。
// 输入查找词即时搜索，Enter 下一个、Shift+Enter 上一个，Esc 关闭。
// 支持大小写敏感、正则开关，显示当前匹配序号/总数。

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import {
  searchKey,
  replaceCurrent,
  replaceAll,
  scrollToCurrent,
  type SearchOpts,
} from "./search";
import { flushActiveHydration } from "./tab-editor-cache";
import { IconChevronDown, IconChevronRight, IconX } from "../icons";
import "./SearchPanel.css";

interface Props {
  getEditor: () => Editor | undefined;
  onClose: () => void;
  /** 是否显示替换框（受控） */
  showReplace: boolean;
  onShowReplaceChange: (v: boolean) => void;
}

export function SearchPanel({ getEditor, onClose, showReplace, onShowReplaceChange }: Props) {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const [replaceNotice, setReplaceNotice] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  // 面板卸载时清除搜索状态：否则高亮残留在文档里直到切换文件（#185）
  useEffect(() => {
    return () => {
      const editor = getEditor();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        if (searchKey.getState(view.state)?.opts) {
          view.dispatch(view.state.tr.setMeta(searchKey, { type: "clear" }));
        }
      });
    };
  }, [getEditor]);

  useEffect(() => {
    findRef.current?.focus();
  }, []);

  // 防抖后的查找词：连续输入时只在停顿后触发一次全文匹配
  const [debouncedFind, setDebouncedFind] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedFind(find), 120);
    return () => clearTimeout(t);
  }, [find]);

  // 查找词或选项变化时搜索（find 经防抖，选项立即生效）。
  // 替换串不参与：它只在点击替换时使用，纳入依赖会导致每敲一字符全文重扫并拽动视口（#151）
  useEffect(() => {
    const editor = getEditor();
    if (!editor) return;
    const opts: SearchOpts = { find: debouncedFind, caseSensitive, useRegex };
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // 只补齐**本面板搜索的目标编辑器**（#431 评审）：无参 flush 会遍历所有
      // 活跃水合任务，分屏另一侧的大文档会被一次查找同步插完，重新造出长任务。
      if (debouncedFind) flushActiveHydration(view);
      view.dispatch(view.state.tr.setMeta(searchKey, debouncedFind ? { type: "set", opts } : { type: "clear" }));
      const s = searchKey.getState(view.state);
      setCount(s?.matches.length ?? 0);
      setCurrent((s?.current ?? -1) + 1);
      if (s && s.current >= 0) scrollToCurrent(view);
    });
  }, [debouncedFind, caseSensitive, useRegex, getEditor]);

  const readState = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const s = searchKey.getState(view.state);
      setCount(s?.matches.length ?? 0);
      setCurrent((s?.current ?? -1) + 1);
    });
  };

  const goNext = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(searchKey, { type: "next" }));
      const s = searchKey.getState(view.state);
      setCurrent((s?.current ?? -1) + 1);
      scrollToCurrent(view);
    });
  };

  const goPrev = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta(searchKey, { type: "prev" }));
      const s = searchKey.getState(view.state);
      setCurrent((s?.current ?? -1) + 1);
      scrollToCurrent(view);
    });
  };

  const doReplace = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      replaceCurrent(view, replace);
      readState();
      scrollToCurrent(view);
    });
  };

  const doReplaceAll = () => {
    const editor = getEditor();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const n = replaceAll(view, replace);
      readState();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      setReplaceNotice(n > 0 ? `已替换 ${n} 处` : "未找到可替换内容");
      noticeTimerRef.current = setTimeout(() => {
        setReplaceNotice(null);
      }, 2000);
    });
  };

  const handleFindKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="search-panel">
      <div className="search-row">
        <button
          className="search-toggle-expand"
          title={showReplace ? "隐藏替换" : "显示替换"}
          onClick={() => onShowReplaceChange(!showReplace)}
        >
          {showReplace ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        </button>
        <input
          ref={findRef}
          className="search-input"
          placeholder="查找"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={handleFindKey}
        />
        <button
          className={`search-flag${caseSensitive ? " active" : ""}`}
          title="区分大小写"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          className={`search-flag${useRegex ? " active" : ""}`}
          title="正则表达式"
          onClick={() => setUseRegex((v) => !v)}
        >
          .*
        </button>
        <span className="search-count">
          {count > 0 ? `${current}/${count}` : find ? "无结果" : ""}
        </span>
        <button className="search-btn" title="上一个" onClick={goPrev}>
          ↑
        </button>
        <button className="search-btn" title="下一个" onClick={goNext}>
          ↓
        </button>
        <button className="search-btn search-close-btn" title="关闭" onClick={onClose}>
          <IconX size={13} />
        </button>
      </div>
      {showReplace && (
        <div className="search-row">
          <span className="search-spacer" />
          <input
            className="search-input"
            placeholder="替换"
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <button className="search-btn" title="替换当前" onClick={doReplace}>
            替换
          </button>
          <button className="search-btn" title="全部替换" onClick={doReplaceAll}>
            全部
          </button>
          {replaceNotice && <span className="search-notice" role="status">{replaceNotice}</span>}
        </div>
      )}
    </div>
  );
}

export default SearchPanel;

// 恢复面板（#365 / #378，设计 §8.6）
//
// 纯展示 + 选择：IO 与 store 变更由调用方（设置页）注入，便于单测。
// 与启动时的三选一弹窗并存：弹窗负责「刚崩溃就要不要恢复」，面板负责「事后复查」。

import { useEffect, useMemo, useState } from "react";
import { IconX } from "../icons";
import type { RecoverableDraft } from "../../lib/session-recovery";

function fmtTime(updatedAt: number): string {
  if (!updatedAt) return "时间未知";
  const d = new Date(updatedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtSize(content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function RecoveryPanel({
  drafts,
  onRestore,
  onDiscard,
  onClose,
}: {
  drafts: RecoverableDraft[];
  onRestore: (selected: RecoverableDraft[]) => void;
  onDiscard: (selected: RecoverableDraft[]) => void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // 草稿列表刷新后，把已不在列表里的选择剔掉（避免「恢复」到已删除的条目）
  useEffect(() => {
    setChecked((prev) => {
      const alive = new Set(drafts.map((d) => d.tabPath));
      return new Set([...prev].filter((path) => alive.has(path)));
    });
  }, [drafts]);

  const selected = useMemo(
    () => drafts.filter((d) => checked.has(d.tabPath)),
    [drafts, checked],
  );

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">恢复未保存内容</span>
          <button className="settings-close" onClick={onClose} title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="settings-body">
          {drafts.length === 0 ? (
            <div className="settings-row">
              <div className="settings-label">
                <span className="settings-name">没有可恢复的副本</span>
                <span className="settings-desc">
                  正常退出时会清掉已保存的草稿；崩溃或强制结束后未保存的内容会出现在这里。
                </span>
              </div>
            </div>
          ) : (
            <>
              <div className="settings-row">
                <div className="settings-label">
                  <span className="settings-name">共 {drafts.length} 份副本</span>
                  <span className="settings-desc">
                    恢复会把内容作为「未保存」标签打开，不会直接写盘；已打开的文件只在其无本地修改时合并。
                  </span>
                </div>
                <button
                  className="settings-close"
                  onClick={() =>
                    setChecked(
                      checked.size === drafts.length
                        ? new Set()
                        : new Set(drafts.map((d) => d.tabPath)),
                    )
                  }
                >
                  {checked.size === drafts.length ? "取消全选" : "全选"}
                </button>
              </div>

              {drafts.map((draft) => (
                <label className="settings-row" key={draft.tabPath}>
                  <div className="settings-label">
                    <span className="settings-name">{draft.title || draft.tabPath}</span>
                    <span className="settings-desc">
                      {fmtTime(draft.updatedAt)} · {fmtSize(draft.content)} · {draft.tabPath}
                    </span>
                  </div>
                  <input
                    type="checkbox"
                    className="settings-toggle"
                    checked={checked.has(draft.tabPath)}
                    onChange={() => toggle(draft.tabPath)}
                  />
                </label>
              ))}

              <div className="settings-row">
                <div className="settings-label">
                  <span className="settings-desc">
                    恢复后草稿文件仍会保留，直到保存成功或你在这里丢弃它。
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button disabled={selected.length === 0} onClick={() => onDiscard(selected)}>
                    丢弃选中
                  </button>
                  <button disabled={selected.length === 0} onClick={() => onRestore(selected)}>
                    恢复选中
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

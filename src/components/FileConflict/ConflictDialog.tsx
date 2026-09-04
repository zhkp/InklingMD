// 外部文件变动冲突对话框
// 场景：useFileWatcher 检测到磁盘文件被外部修改（Git 切分支/网盘同步等），
// 且本地有未保存修改。直接 confirm 二选一太简陋：
// - 选「取消」后继续保存会静默覆盖外部修改，无备份无感知
// 本组件提供三选项（对齐用户口头反馈建议）：
// 1. 保留本地并另存副本 → 本地内容写入 *.backup.md，编辑器重载磁盘最新
// 2. 丢弃本地修改 → 直接重载磁盘最新
// 3. 查看差异 → 行级 Diff 视图，知情后再决定（另存副本/用本地覆盖磁盘/继续编辑）
import { useEffect, useMemo, useRef, useState } from "react";
import { useConflict } from "../../store/conflict";
import { useWorkspace } from "../../store/workspace";
import { writeTextFile, listDir } from "../../lib/fs";
import { diffLines, nextBackupPath } from "../../lib/diff";
import { IconAlertTriangle, IconX } from "../icons";
import { baseName } from "../../lib/path-utils";
import { showMessage } from "../../lib/dialogs";
import "./ConflictDialog.css";

/** 把本地内容另存为同目录副本文件，返回副本路径 */
async function saveLocalBackup(
  filePath: string,
  localContent: string,
): Promise<string> {
  // 列出同目录已有文件，生成不冲突的 backup 路径（一次 IO 拿全量判断）
  const dir = filePath.replace(/[\\/][^\\/]+$/, "");
  const existing = new Set<string>();
  try {
    const node = await listDir(dir);
    for (const child of node.children) existing.add(child.path.toLowerCase());
  } catch {
    // 列目录失败（如单文件模式目录已移除）：退化为无冲突检测的直接命名
  }
  const backupPath = nextBackupPath(filePath, existing);
  await writeTextFile(backupPath, localContent);
  return backupPath;
}

export function ConflictDialog() {
  const conflict = useConflict((s) => s.conflict);
  const dismiss = useConflict((s) => s.dismiss);
  const reloadFile = useWorkspace((s) => s.reloadFile);
  const setTabDiskContent = useWorkspace((s) => s.setTabDiskContent);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const diff = useMemo(() => {
    if (!conflict || !showDiff) return null;
    return diffLines(conflict.localContent, conflict.diskContent);
  }, [conflict, showDiff]);

  const overlayRef = useRef<HTMLDivElement>(null);

  /** 继续编辑：仅同步磁盘基线后关闭对话框（有意不清 conflictPending，见 handleDismiss 注释） */
  const dismissKeepEditing = () => {
    const c = useConflict.getState().conflict;
    if (!c) return;
    setTabDiskContent(c.filePath, c.diskContent);
    dismiss();
  };

  // issue #186：Esc 关闭。主视图 Esc 等价「继续编辑」（与主按钮共用 dismissKeepEditing）；
  // 差异视图 Esc 先退回选项（同顶部返回按钮）。busy 期间忽略，避免打断异步动作。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || busy) return;
      const c = useConflict.getState().conflict;
      if (!c) return;
      e.preventDefault();
      e.stopPropagation();
      if (showDiff) {
        setShowDiff(false);
        return;
      }
      dismissKeepEditing();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showDiff, busy, dismiss, setTabDiskContent]);

  // issue #186：打开对话框/切换视图时把焦点移入主操作按钮
  useEffect(() => {
    const primary = overlayRef.current?.querySelector<HTMLButtonElement>(
      ".conflict-btn-primary:not(:disabled)",
    );
    primary?.focus();
  }, [conflict, showDiff]);

  if (!conflict) return null;
  const { filePath, localContent } = conflict;

  const handleDismiss = () => {
    // 用户选择「继续编辑（稍后自行保存会覆盖磁盘）」，只同步磁盘基线：
    // setTabDiskContent 让基线追上磁盘最新内容，后续 saveCurrent 不再判定为冲突、
    // 静默落盘，也不会重复弹窗。
    // 注意：此处**有意不清除** conflictPending。用户明确选择「稍后**自行**保存」，
    // 清除标志会让自动保存 2s 后自动覆盖磁盘，与用户选择直接矛盾；保留标志 =
    // 自动保存持续暂停 + 状态栏可见 + 指示器可点击触发手动保存（issue #149）。
    // 该语义由 tests/unit/conflict-dismiss-autosave.test.tsx 锁定。
    dismissKeepEditing();
  };

  const wrap = (fn: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      dismiss();
      setShowDiff(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  /** 选项 1：本地内容另存副本，编辑器重载磁盘最新 */
  const handleBackup = wrap(async () => {
    const backupPath = await saveLocalBackup(filePath, localContent);
    // reloadFile 强制从磁盘重读（openFile 对已打开 tab 只切缓存，不会真正重载）
    await reloadFile(filePath);
    await showMessage(
      `本地修改已另存为副本：\n${backupPath}\n\n编辑器已重载磁盘最新版本。`,
      { title: "备份成功", kind: "info" },
    );
  });

  /** 选项 2：丢弃本地修改，重载磁盘最新 */
  const handleReload = wrap(async () => {
    await reloadFile(filePath);
  });

  if (showDiff && diff) {
    const changed = diff.filter((l) => l.op !== "equal");
    return (
      <div className="conflict-overlay" ref={overlayRef} role="dialog" aria-modal="true" aria-label="文件冲突差异对比">
        <div className="conflict-dialog conflict-dialog-diff">
          <div className="conflict-header">
            <span className="conflict-title">
              <IconAlertTriangle size={16} />
              差异对比 — {baseName(filePath)}
            </span>
            <button className="topbar-btn" onClick={() => setShowDiff(false)} title="返回选项" aria-label="返回选项">
              <IconX />
            </button>
          </div>
          <div className="conflict-meta">
            <span className="conflict-legend conflict-legend-local">− 本地（未保存）</span>
            <span className="conflict-legend conflict-legend-disk">+ 磁盘（外部修改）</span>
            <span className="conflict-changed-count">{changed.length} 行差异</span>
          </div>
          <div className="conflict-diff-body">
            {changed.length === 0 ? (
              <div className="conflict-diff-empty">内容一致（仅换行符或末尾空行差异）</div>
            ) : (
              diff.map((line, idx) => {
                if (line.op === "equal") return null;
                const text = line.op === "remove" ? line.local : line.disk;
                return (
                  <div key={idx} className={`conflict-diff-line conflict-diff-${line.op}`}>
                    <span className="conflict-diff-sign">{line.op === "remove" ? "−" : "+"}</span>
                    <span className="conflict-diff-text">{text === "" ? " " : text}</span>
                  </div>
                );
              })
            )}
          </div>
          {error && <div className="conflict-error">{error}</div>}
          <div className="conflict-actions">
            <button className="conflict-btn conflict-btn-primary" onClick={handleBackup} disabled={busy}>
              保留本地并另存副本
            </button>
            <button className="conflict-btn" onClick={handleReload} disabled={busy}>
              丢弃本地修改，重载磁盘
            </button>
            <button className="conflict-btn" onClick={handleDismiss} disabled={busy}>
              继续编辑（稍后自行保存会覆盖磁盘）
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="conflict-overlay" ref={overlayRef} role="dialog" aria-modal="true" aria-label="文件冲突">
      <div className="conflict-dialog">
        <div className="conflict-header">
          <span className="conflict-title">
            <IconAlertTriangle size={16} />
            文件已被外部修改
          </span>
        </div>
        <div className="conflict-body">
          <p>
            「{baseName(filePath)}」在磁盘上被其他程序修改（如 Git 切换分支、网盘同步），
            且当前编辑器中有<strong>未保存的修改</strong>。
          </p>
          <p className="conflict-hint">
            直接保存会覆盖磁盘上的外部修改；丢弃重载会丢失本地修改。
            建议先另存副本或查看差异。
          </p>
        </div>
        {error && <div className="conflict-error">{error}</div>}
        <div className="conflict-actions">
          <button className="conflict-btn conflict-btn-primary" onClick={handleBackup} disabled={busy}>
            保留本地并另存副本（.backup.md）
          </button>
          <button className="conflict-btn" onClick={() => setShowDiff(true)}>
            查看差异对比
          </button>
          <button className="conflict-btn" onClick={handleReload} disabled={busy}>
            丢弃本地修改，重载磁盘
          </button>
          <button className="conflict-btn conflict-btn-muted" onClick={handleDismiss} disabled={busy}>
            继续编辑（稍后保存将覆盖磁盘）
          </button>
        </div>
      </div>
    </div>
  );
}

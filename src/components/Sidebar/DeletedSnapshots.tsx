// 外部删除备份（快照）区块与恢复入口

import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "../../store/workspace";
import { useUI } from "../../store/ui";
import {
  DELETED_FILE_SNAPSHOTS_KEY,
  SNAPSHOTS_CHANGED_EVENT,
  clearDeletedSnapshots,
  loadDeletedSnapshots,
  probeSnapshotStorageHealth,
  removeDeletedSnapshot,
  type DeletedFileSnapshot,
} from "../../store/workspace/shared";
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconFileText, IconTrash2 } from "../icons";
import { basename } from "./treeShared";
import { askConfirmation } from "../../lib/dialogs";
import { registerStorageSync } from "../../store/storageSyncRegistry";

export function DeletedSnapshots() {
  const [snapshots, setSnapshots] = useState<DeletedFileSnapshot[]>([]);
  const [health, setHealth] = useState<{
    sizeChars: number;
    writable: boolean;
  } | null>(null);
  const openUntitledTabWithContent = useWorkspace((s) => s.openUntitledTabWithContent);
  // 折叠状态持久化到 UI store（issue #167），重挂载/切换工作区后保持
  const expanded = useUI((s) => s.sectionExpanded.snapshots);
  const toggleSectionExpanded = useUI((s) => s.toggleSectionExpanded);

  // 同步 localStorage 快照与健康状态（探测已改为只写 1 字节哨兵，开销极低）
  const refresh = useCallback(() => {
    setSnapshots(loadDeletedSnapshots());
    setHealth(probeSnapshotStorageHealth());
  }, []);

  // 事件驱动刷新（issue #153）：不再每 2 秒轮询全量重写。
  // - 挂载时读一次
  // - 同窗口内写入/恢复/清空经 SNAPSHOTS_CHANGED_EVENT 广播
  // - 其他窗口写入经原生 storage 事件同步（issue #165 快照部分）
  useEffect(() => {
    refresh();
    window.addEventListener(SNAPSHOTS_CHANGED_EVENT, refresh);
    // #225 C4：跨窗口同步统一登记到 storageSyncRegistry 单一注册点（返回取消注册）
    const unsubscribe = registerStorageSync(
      DELETED_FILE_SNAPSHOTS_KEY,
      () => refresh(),
      "deleted-snapshots",
    );
    return () => {
      window.removeEventListener(SNAPSHOTS_CHANGED_EVENT, refresh);
      unsubscribe();
    };
  }, [refresh]);

  if (snapshots.length === 0) return null;

  const handleRestore = (snapshot: DeletedFileSnapshot) => {
    openUntitledTabWithContent(snapshot.content);
    removeDeletedSnapshot(snapshot.path);
    refresh();
  };

  const handleClearAll = async () => {
    const count = snapshots.length;
    const ok = await askConfirmation(
      `确定要清除全部 ${count} 个备份快照吗？\n将永久丢失这些文件的未保存内容，且无法恢复。`,
      {
        title: "清除全部可恢复文件",
        kind: "warning",
      },
    );
    if (!ok) return;
    clearDeletedSnapshots();
    refresh();
  };

  return (
    <div className="recent-section deleted-snapshots-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button
          className="recent-header"
          style={{ flex: 1 }}
          onClick={() => toggleSectionExpanded("snapshots")}
          title="外部删除的文件残留快照"
        >
          <span className="tree-icon">
            {expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
          </span>
          <span className="recent-title snapshot-recoverable-title">
            可恢复文件 ({snapshots.length})
          </span>
          {health && !health.writable && (
            <span
              title="存储配额不足：下次删除文件时将无法创建恢复备份，建议尽快清理或恢复现有条目"
              className="snapshot-health-danger"
            >
              <IconAlertTriangle size={12} style={{ marginRight: 3 }} />
              备份存储空间不足
            </span>
          )}
          {health && health.writable && health.sizeChars > 2 * 1024 * 1024 && (
            <span
              title="当前备份快照占用较大，建议及时清理以避免配额溢出"
              className="snapshot-health-warning"
            >
              <IconAlertTriangle size={12} style={{ marginRight: 3 }} />
              备份占用较多
            </span>
          )}
        </button>
        {expanded && (
          <button
            className="sidebar-btn-icon"
            style={{ marginRight: 8, padding: 2, opacity: 0.7 }}
            onClick={handleClearAll}
            title="清除全部备份"
            aria-label="清除全部备份"
          >
            <IconTrash2 size={13} />
          </button>
        )}
      </div>

      {expanded && (
        <div className="recent-list">
          {snapshots.map((snap) => {
            const timeStr = new Date(snap.deletedAt).toLocaleTimeString();
            return (
              <div
                key={snap.path}
                className="tree-row tree-row-file"
                style={{
                  paddingLeft: "24px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
                title={`原路径：${snap.path}\n删除备份时间：${timeStr}\n点击恢复为新标签页`}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flex: 1,
                    overflow: "hidden",
                    cursor: "pointer",
                  }}
                  onClick={() => handleRestore(snap)}
                >
                  <span className="tree-icon">
                    <IconFileText size={14} />
                  </span>
                  <span
                    className="tree-name"
                    style={{ textDecoration: "line-through", opacity: 0.85 }}
                  >
                    {basename(snap.path)}
                  </span>
                </div>
                <button
                  className="sidebar-btn-icon snapshot-restore-btn"
                  onClick={() => handleRestore(snap)}
                  title="恢复为未命名新标签页"
                >
                  恢复
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

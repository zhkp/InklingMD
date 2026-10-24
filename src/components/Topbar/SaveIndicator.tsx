// 保存状态指示器：显示文件已删除 / 保存失败 / 冲突 / 保存中 / 未保存 / 已保存时间
import { useWorkspace } from "../../store/workspace";

export function SaveIndicator() {
  const dirty = useWorkspace((s) => s.dirty);
  const saving = useWorkspace((s) => s.saving);
  const saveError = useWorkspace((s) => s.saveError);
  const conflictPending = useWorkspace((s) => s.conflictPending);
  const lastSavedAt = useWorkspace((s) => s.lastSavedAt);
  const saveCurrent = useWorkspace((s) => s.saveCurrent);
  const deletedOnDisk = useWorkspace(
    (s) => s.openTabs.find((t) => t.path === s.activeTabPath)?.deletedOnDisk ?? false,
  );

  if (deletedOnDisk) {
    // #363：文件已不在磁盘原处，自动保存已暂停；点击由用户选择重新创建 / 另存为
    return (
      <button
        type="button"
        className="save-indicator save-error"
        title="文件已在磁盘上被删除或移动，自动保存已暂停。点击选择重新创建或另存为"
        onClick={() => void saveCurrent({ interactive: true })}
      >
        文件已删除（已暂停自动保存）
      </button>
    );
  }
  if (saveError) {
    return <span className="save-indicator save-error">保存失败：{saveError}</span>;
  }
  if (conflictPending) {
    // #188：冲突入口是「自动保存已暂停」的关键操作点，改真实 <button>
    // 以获得原生键盘可达性（Tab 聚焦 + Enter/Space 激活）与无障碍语义
    return (
      <button
        type="button"
        className="save-indicator save-error"
        title="文件被外部程序修改，自动保存已暂停。点击进行冲突处理"
        onClick={() => void saveCurrent({ interactive: true })}
      >
        外部冲突（已暂停自动保存）
      </button>
    );
  }
  if (saving) return <span className="save-indicator">保存中…</span>;
  if (dirty) return <span className="save-indicator">未保存</span>;
  if (lastSavedAt) {
    const t = new Date(lastSavedAt).toLocaleTimeString();
    return <span className="save-indicator save-ok">已保存 {t}</span>;
  }
  return <span className="save-indicator" />;
}

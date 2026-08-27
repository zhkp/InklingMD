// 更多功能收纳下拉菜单：全屏/禅模式、快捷键帮助、偏好设置
import { IconMaximize, IconHelpCircle, IconSettings, IconMoreHorizontal } from "../icons";

interface MoreMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zenMode: boolean;
  onToggleZen: () => void;
  onOpenShortcuts: () => void;
  onOpenSettings: () => void;
}

export function MoreMenu({
  open,
  onOpenChange,
  zenMode,
  onToggleZen,
  onOpenShortcuts,
  onOpenSettings,
}: MoreMenuProps) {
  return (
    <div className="export-menu">
      <button
        className="topbar-btn"
        onClick={() => onOpenChange(!open)}
        title="更多操作"
        aria-label="更多操作"
      >
        <IconMoreHorizontal size={15} />
      </button>
      {open && (
        <>
          <div className="export-backdrop" onClick={() => onOpenChange(false)} />
          <div className="export-dropdown">
            <button
              className={`export-item${zenMode ? " export-item-active" : ""}`}
              onClick={() => {
                onOpenChange(false);
                onToggleZen();
              }}
            >
              <IconMaximize size={14} />
              {zenMode ? "退出禅模式" : "禅模式"}
            </button>
            <div className="export-sep" />
            <button
              className="export-item"
              onClick={() => {
                onOpenChange(false);
                onOpenShortcuts();
              }}
            >
              <IconHelpCircle size={14} />
              快捷键说明
            </button>
            <button
              className="export-item"
              onClick={() => {
                onOpenChange(false);
                onOpenSettings();
              }}
            >
              <IconSettings size={14} />
              偏好设置
            </button>
          </div>
        </>
      )}
    </div>
  );
}

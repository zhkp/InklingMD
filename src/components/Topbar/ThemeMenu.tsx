// 主题下拉菜单（#225 主题清单 + #307 导入/管理）：
// 分组列表（内置 / 已导入） + 当前选中 + 明暗变体一键切换 + 导入三条路径 + 打开主题文件夹 + 移除/隐藏 + 自定义 CSS
import { useRef } from "react";
import { useTheme } from "../../store/theme";
import { themeDisplayName } from "../../theme/registry";
import { useMenuA11y } from "../../hooks/useMenuA11y";
import {
  IconSun,
  IconMoon,
  IconPalette,
  IconX,
  IconChevronDown,
  IconFolder,
  IconDownload,
  IconTrash2,
  IconArrowLeftRight,
  IconAlertTriangle,
} from "../icons";

interface ThemeMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ThemeMenu({ open, onOpenChange }: ThemeMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // #188：打开聚焦首项 + 方向键导航
  useMenuA11y({ ref: menuRef, enabled: open, focusFirstOnOpen: true });

  const themeId = useTheme((s) => s.themeId);
  const themes = useTheme((s) => s.themes);
  const mode = useTheme((s) => s.mode);
  const setTheme = useTheme((s) => s.setTheme);
  const hiddenBundled = useTheme((s) => s.hiddenBundled);
  const scanState = useTheme((s) => s.scanState);
  const scanIssues = useTheme((s) => s.scanIssues);
  const syncThemes = useTheme((s) => s.syncThemes);
  const importThemes = useTheme((s) => s.importThemes);
  const removeTheme = useTheme((s) => s.removeTheme);
  const duplicateAsUserTheme = useTheme((s) => s.duplicateAsUserTheme);
  const openThemesFolder = useTheme((s) => s.openThemesFolder);
  const loadCustomCSS = useTheme((s) => s.loadCustomCSS);
  const clearCustomCSS = useTheme((s) => s.clearCustomCSS);
  const customCSSPath = useTheme((s) => s.customCSSPath);

  const visible = themes.filter((t) => !hiddenBundled.includes(t.id));
  const builtin = visible.filter((t) => t.source === "builtin-base");
  const imported = visible.filter((t) => t.source !== "builtin-base");
  const current = themes.find((t) => t.id === themeId);
  const variant = current?.variantOf ? themes.find((t) => t.id === current.variantOf) : undefined;
  const currentIsEditable = current && current.source !== "builtin-base" && current.source !== "builtin";

  const modeIcon = (m: string) => (m === "dark" ? <IconMoon size={14} /> : <IconSun size={14} />);

  const themeButton = (t: (typeof themes)[number]) => (
    <button
      key={t.id}
      className={`export-item${t.id === themeId ? " export-item-active" : ""}`}
      role="menuitemradio"
      aria-checked={t.id === themeId}
      data-theme-option={t.id}
      data-active={t.id === themeId ? "1" : undefined}
      data-theme-source={t.source}
      onClick={() => {
        setTheme(t.id);
        onOpenChange(false);
      }}
    >
      {modeIcon(t.mode)}
      {t.name}
      {t.id === themeId && <span className="export-item-hint">当前</span>}
    </button>
  );

  return (
    <div className="export-menu">
      <button
        className="topbar-btn topbar-btn-label"
        onClick={() => onOpenChange(!open)}
        title="主题"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {mode === "dark" ? <IconMoon size={15} /> : <IconSun size={15} />}
        {themeDisplayName(themeId)}
        <IconChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="export-backdrop" onClick={() => onOpenChange(false)} />
          <div className="export-dropdown" role="menu" ref={menuRef} data-theme-menu="1">
            <div className="export-label" data-theme-group="builtin">
              内置
            </div>
            {builtin.map(themeButton)}

            <div className="export-label" data-theme-group="imported">
              已导入
            </div>
            <div data-theme-empty={imported.length === 0 ? "1" : undefined} />
            {imported.length === 0 && (
              <div className="export-item export-item-muted" role="presentation">
                <IconPalette size={14} /> 尚未导入主题
              </div>
            )}
            {imported.map(themeButton)}

            <div className="export-sep" />

            {variant && (
              <button
                className="export-item"
                role="menuitem"
                data-theme-variant="1"
                onClick={() => {
                  setTheme(variant.id);
                  onOpenChange(false);
                }}
              >
                <IconArrowLeftRight size={14} />
                切换到{variant.mode === "dark" ? "深色" : "浅色"}变体（{variant.name}）
              </button>
            )}

            <button
              className="export-item"
              role="menuitem"
              data-theme-import="css"
              onClick={() => {
                onOpenChange(false);
                void importThemes("css");
              }}
            >
              <IconDownload size={14} />
              导入主题…（.css）
            </button>
            <button
              className="export-item"
              role="menuitem"
              data-theme-import="zip"
              onClick={() => {
                onOpenChange(false);
                void importThemes("zip");
              }}
            >
              <IconDownload size={14} />
              导入主题…（.zip 压缩包）
            </button>
            <button
              className="export-item"
              role="menuitem"
              data-theme-import="folder"
              onClick={() => {
                onOpenChange(false);
                void importThemes("folder");
              }}
            >
              <IconFolder size={14} />
              导入主题…（文件夹）
            </button>

            <button
              className="export-item"
              role="menuitem"
              data-theme-open-folder="1"
              onClick={() => {
                onOpenChange(false);
                void openThemesFolder();
              }}
            >
              <IconFolder size={14} />
              打开主题文件夹
            </button>
            <button
              className="export-item"
              role="menuitem"
              data-theme-refresh="1"
              onClick={() => {
                void syncThemes();
              }}
            >
              <IconArrowLeftRight size={14} />
              {scanState === "scanning" ? "刷新中…" : "刷新主题列表"}
            </button>

            {scanIssues.length > 0 && (
              <div className="export-item export-item-muted" role="presentation" data-theme-issues="1">
                <IconAlertTriangle size={14} /> 上次扫描有 {scanIssues.length} 条提示
              </div>
            )}

            {currentIsEditable && (
              <>
                <div className="export-sep" />
                {current.source === "bundled" && (
                  <button
                    className="export-item"
                    role="menuitem"
                    data-theme-duplicate="1"
                    onClick={() => {
                      onOpenChange(false);
                      void duplicateAsUserTheme(current.id);
                    }}
                  >
                    <IconDownload size={14} />
                    复制为我的主题（预装不可原地改）
                  </button>
                )}
                <button
                  className="export-item export-item-muted"
                  role="menuitem"
                  data-theme-remove="1"
                  onClick={() => {
                    onOpenChange(false);
                    void removeTheme(current.id);
                  }}
                >
                  <IconTrash2 size={14} />
                  {current.source === "bundled" ? "隐藏主题（预装由应用管理）" : "移除主题…"}
                </button>
              </>
            )}

            <div className="export-sep" />
            <button
              className="export-item"
              role="menuitem"
              onClick={() => {
                onOpenChange(false);
                void loadCustomCSS();
              }}
            >
              <IconPalette size={14} />
              加载自定义 CSS…
            </button>
            {customCSSPath && (
              <button
                className="export-item export-item-muted"
                role="menuitem"
                data-clear-custom-css="1"
                onClick={() => {
                  clearCustomCSS();
                  onOpenChange(false);
                }}
              >
                <IconX size={14} />
                清除自定义 CSS
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// 主题下拉菜单（#225）：主题清单 + 当前选中 + 加载/清除自定义 CSS
import { useRef } from "react";
import { useTheme } from "../../store/theme";
import { themeDisplayName } from "../../theme/registry";
import { useMenuA11y } from "../../hooks/useMenuA11y";
import { IconSun, IconMoon, IconPalette, IconX, IconChevronDown } from "../icons";

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
  const loadCustomCSS = useTheme((s) => s.loadCustomCSS);
  const clearCustomCSS = useTheme((s) => s.clearCustomCSS);
  const customCSSPath = useTheme((s) => s.customCSSPath);

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
            {themes.map((t) => (
              <button
                key={t.id}
                className={`export-item${t.id === themeId ? " export-item-active" : ""}`}
                role="menuitemradio"
                aria-checked={t.id === themeId}
                data-theme-option={t.id}
                data-active={t.id === themeId ? "1" : undefined}
                onClick={() => {
                  setTheme(t.id);
                  onOpenChange(false);
                }}
              >
                {t.mode === "dark" ? <IconMoon size={14} /> : <IconSun size={14} />}
                {t.name}
              </button>
            ))}
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

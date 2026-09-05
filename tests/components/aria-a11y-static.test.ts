// #188 无障碍 CSS/结构回归防护（静态源断言）
// 键盘可达性修复中「纯视觉/纯结构」的部分（visually-hidden 方案、焦点可见性）
// 在 jsdom/happy-dom 中无法用 getComputedStyle 真实求值，按本仓库既有先例
// （DesignTokens / Issue180ThemeTokens 读源文件断言）直接对源文件做事实断言，
// 防止修复被反向回退（如 checkbox 改回 display:none、close 按钮隐藏改回）。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string): string =>
  readFileSync(resolve(process.cwd(), rel), "utf8");

describe("#188 全局搜索开关可聚焦（visually-hidden）", () => {
  const css = read("src/components/GlobalSearch/GlobalSearchPanel.css");

  it("checkbox 不再是 display:none", () => {
    // 取 .gs-toggle input 规则体，断言不含 display:none
    const rule = css.match(/\.gs-toggle\s+input\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).not.toContain("display: none");
  });

  it("采用 visually-hidden 剪裁 + focus-visible 焦点环", () => {
    expect(css).toContain("clip-path: inset(50%)");
    expect(css).toContain(".gs-toggle input:focus-visible + span");
  });
});

describe("#188 标签页键盘可达", () => {
  const tabsCss = read("src/components/Tabs/TabsBar.css");
  const tabsTsx = read("src/components/Tabs/TabsBar.tsx");

  it("tablist / tab / aria-selected / roving tabIndex 语义存在", () => {
    expect(tabsTsx).toContain('role="tablist"');
    expect(tabsTsx).toContain('role="tab"');
    expect(tabsTsx).toContain("aria-selected={active}");
    expect(tabsTsx).toContain("tabIndex={active ? 0 : -1}");
  });

  it("Enter/Space 与方向键可激活 tab", () => {
    expect(tabsTsx).toContain('e.key === "Enter" || e.key === " "');
    expect(tabsTsx).toContain('"ArrowRight"');
    expect(tabsTsx).toContain('"ArrowLeft"');
  });

  it("关闭按钮在键盘聚焦时可见（不再是 opacity:0）", () => {
    expect(tabsCss).toContain(".tab:focus-within .tab-close");
    expect(tabsCss).toContain(".tab-close:focus-visible");
    expect(tabsCss).toContain(".tab:focus-visible");
  });
});

describe("#188 冲突指示器是真实按钮", () => {
  const appCss = read("src/App.css");

  it("button.save-indicator 有样式重置与焦点环", () => {
    expect(appCss).toContain("button.save-indicator {");
    expect(appCss).toContain("button.save-indicator:focus-visible");
  });
});

describe("#188 菜单系统 ARIA 语义", () => {
  it("下拉与右键菜单项带 role=menuitem，触发器带 aria-haspopup/aria-expanded", () => {
    const tree = read("src/components/Sidebar/TreeContextMenu.tsx");
    const tab = read("src/components/Tabs/TabContextMenu.tsx");
    const exportMenu = read("src/components/Topbar/ExportMenu.tsx");
    const moreMenu = read("src/components/Topbar/MoreMenu.tsx");

    expect(tree).toContain('role="menuitem"');
    expect(tab).toContain('role="menuitem"');
    expect(exportMenu).toContain('role="menuitem"');
    expect(moreMenu).toContain('role="menuitem"');
    expect(exportMenu).toContain('role="menu" ref={menuRef}');
    expect(exportMenu).toContain("aria-haspopup=\"menu\"");
    expect(exportMenu).toContain("aria-expanded={open}");
    expect(moreMenu).toContain("aria-haspopup=\"menu\"");
  });

  it("顶栏任一菜单打开时支持 Esc 关闭", () => {
    const topbar = read("src/components/Topbar/EditorTopbar.tsx");
    expect(topbar).toContain("window.addEventListener(\"keydown\", onKey)");
    expect(topbar).toContain('if (e.key !== "Escape") return;');
  });
});

// 快捷键帮助面板（模态）
// 集中展示编辑器与应用级的所有快捷键，方便用户查阅。
// 通过 Mod-/ 触发，Esc 或点击遮罩关闭。
// 视图与应用分组里的快捷键走 useShortcuts store，反映用户自定义结果。

import { useEffect } from "react";
import {
  useShortcuts,
  formatBinding,
  type ShortcutId,
} from "../../store/shortcuts";
import { IconX } from "../icons";
import "./ShortcutsHelp.css";

interface ShortcutGroup {
  title: string;
  items: { keys: string; desc: string }[];
}

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl";
const ALT = MAC ? "⌥" : "Alt";
const SHIFT = MAC ? "⇧" : "Shift";

// 应用级快捷键 ID → 描述（用于从 store 取动态绑定）
// 新增 ShortcutId 时必须同步补这里，否则 Record<ShortcutId, string> 会直接编译失败
// （属可被 tsc 拦住的失败模式，比运行时漏展示更早暴露）。
const APP_SHORTCUT_DESC: Record<ShortcutId, string> = {
  find: "查找替换（源码模式下用编辑器内置查找）",
  toggleSidebar: "切换侧边栏",
  toggleOutline: "切换大纲面板",
  showShortcuts: "显示快捷键帮助",
  openSettings: "打开偏好设置",
  toggleSourceMode: "切换源代码模式",
  quickOpen: "快速打开文件",
  pastePlainText: "粘贴为纯文本（跳过 Smart Paste 转换）",
};

const STATIC_GROUPS: ShortcutGroup[] = [
  {
    title: "文本格式",
    items: [
      { keys: `${MOD}+B`, desc: "加粗" },
      { keys: `${MOD}+I`, desc: "斜体" },
      { keys: `${MOD}+E`, desc: "行内代码" },
      { keys: `${MOD}+${ALT}+X`, desc: "删除线" },
      { keys: `${MOD}+K`, desc: "插入链接（粘贴 URL 时自动）" },
    ],
  },
  {
    title: "块级元素",
    items: [
      { keys: `${MOD}+${ALT}+1 … 6`, desc: "转为 H1 ~ H6" },
      { keys: `${MOD}+${ALT}+0`, desc: "转为段落" },
      { keys: `${MOD}+${ALT}+7`, desc: "有序列表" },
      { keys: `${MOD}+${ALT}+8`, desc: "无序列表" },
      { keys: `${MOD}+${ALT}+C`, desc: "代码块" },
      { keys: `${MOD}+${SHIFT}+B`, desc: "引用块" },
    ],
  },
  {
    title: "列表与表格",
    items: [
      { keys: `Tab / ${MOD}+]`, desc: "缩进列表项 / 下一个表格单元" },
      { keys: `${SHIFT}+Tab / ${MOD}+[`, desc: "提升列表项 / 上一个表格单元" },
      { keys: `${SHIFT}+Enter`, desc: "硬换行" },
    ],
  },
  {
    title: "文件与编辑",
    items: [
      { keys: `${MOD}+S`, desc: "保存当前文件" },
      { keys: `${MOD}+F`, desc: "查找替换（当前文件）" },
      { keys: `${MOD}+R`, desc: "替换（当前文件）" },
      { keys: `${MOD}+${SHIFT}+F`, desc: "全局搜索（工作区所有文件）" },
      { keys: `${MOD}+Z`, desc: "撤销" },
      { keys: `${MOD}+${SHIFT}+Z`, desc: "重做" },
      { keys: `${MOD}+X / C / V`, desc: "剪切 / 复制 / 粘贴" },
    ],
  },
  {
    title: "视图与布局",
    items: [
      { keys: `F11`, desc: "禅模式（隐藏所有 UI，纯编辑）" },
      { keys: `Esc`, desc: "退出禅模式" },
      { keys: `${MOD}+滚轮`, desc: "放大 / 缩小文档（50% ~ 300%）" },
      { keys: `${MOD}+0`, desc: "重置缩放到 100%" },
    ],
  },
];

interface ShortcutsHelpProps {
  onClose: () => void;
  /** 打开自定义面板 */
  onCustomize?: () => void;
}

export function ShortcutsHelp({ onClose, onCustomize }: ShortcutsHelpProps) {
  const getBinding = useShortcuts((s) => s.getBinding);

  // 视图与应用分组走 store 动态绑定
  const appGroup: ShortcutGroup = {
    title: "视图与应用",
    items: (
      Object.keys(APP_SHORTCUT_DESC) as ShortcutId[]
    ).map((id) => ({
      keys: formatBinding(getBinding(id)),
      desc: APP_SHORTCUT_DESC[id],
    })),
  };

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const allGroups = [...STATIC_GROUPS, appGroup];

  return (
    <div className="shortcuts-backdrop" onClick={onClose}>
      <div
        className="shortcuts-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="快捷键帮助"
      >
        <div className="shortcuts-header">
          <span className="shortcuts-title">快捷键</span>
          <button className="shortcuts-close" onClick={onClose} title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="shortcuts-body">
          {allGroups.map((g) => (
            <section key={g.title} className="shortcuts-section">
              <h3 className="shortcuts-section-title">{g.title}</h3>
              <ul className="shortcuts-list">
                {g.items.map((it) => (
                  <li key={`${g.title}-${it.desc}`} className="shortcuts-row">
                    <span className="shortcuts-desc">{it.desc}</span>
                    <kbd className="shortcuts-keys">{it.keys}</kbd>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="shortcuts-footer">
          <span className="shortcuts-hint">
            {MAC ? "⌘ = Command, ⌥ = Option, ⇧ = Shift" : "Ctrl = Control, Alt, Shift"}
          </span>
          {onCustomize && (
            <button className="shortcuts-customize" onClick={onCustomize}>
              自定义…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ShortcutsHelp;

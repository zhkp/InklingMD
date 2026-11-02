// 偏好设置面板（模态）
// 集中展示可由用户开关的编辑器行为，直接读写 settings store，实时生效。
// 包含：专注模式、打字机模式、公式自动编号、代码块语法高亮主题。

import { useEffect, useState } from "react";
import { useSettings, type CodeBlockTheme } from "../../store/settings";
import { IconX } from "../icons";
import "./SettingsPanel.css";
import { RecoveryPanel } from "../Recovery/RecoveryPanel";
import {
  applyRecovery,
  discardDrafts,
  listDrafts,
  type RecoverableDraft,
} from "../../lib/session-recovery";

const CODE_THEME_OPTIONS: { value: CodeBlockTheme; label: string }[] = [
  { value: "oneDark", label: "One Dark（深色）" },
  { value: "light", label: "浅色（彩色高亮）" },
  { value: "none", label: "无高亮" },
];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const formulaAutoNumber = useSettings((s) => s.formulaAutoNumber);
  const codeBlockTheme = useSettings((s) => s.codeBlockTheme);
  const focusMode = useSettings((s) => s.focusMode);
  const typewriterMode = useSettings((s) => s.typewriterMode);
  const autoPair = useSettings((s) => s.autoPair);
  const spellcheck = useSettings((s) => s.spellcheck);
  const setFormulaAutoNumber = useSettings((s) => s.setFormulaAutoNumber);
  const setCodeBlockTheme = useSettings((s) => s.setCodeBlockTheme);
  const setFocusMode = useSettings((s) => s.setFocusMode);
  const setTypewriterMode = useSettings((s) => s.setTypewriterMode);
  const setAutoPair = useSettings((s) => s.setAutoPair);
  const setSpellcheck = useSettings((s) => s.setSpellcheck);
  const reset = useSettings((s) => s.reset);

  // 恢复面板：打开时才读盘（正常情况下 recovery/ 目录可能还不存在）
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryDrafts, setRecoveryDrafts] = useState<RecoverableDraft[]>([]);

  // Esc 键关闭面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">偏好设置</span>
          <button className="settings-close" onClick={onClose} title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="settings-body">
          <label className="settings-row">
            <div className="settings-label">
              <span className="settings-name">专注模式</span>
              <span className="settings-desc">弱化非当前段落，聚焦当前内容</span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={focusMode}
              onChange={(e) => setFocusMode(e.target.checked)}
            />
          </label>

          <label className="settings-row">
            <div className="settings-label">
              <span className="settings-name">打字机模式</span>
              <span className="settings-desc">当前编辑行始终保持在视窗垂直居中</span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={typewriterMode}
              onChange={(e) => setTypewriterMode(e.target.checked)}
            />
          </label>

          <label className="settings-row">
            <div className="settings-label">
              <span className="settings-name">公式自动编号</span>
              <span className="settings-desc">块级公式按文档顺序自动编号 (1)(2)…</span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={formulaAutoNumber}
              onChange={(e) => setFormulaAutoNumber(e.target.checked)}
            />
          </label>

          <label className="settings-row">
            <div className="settings-label">
              <span className="settings-name">自动配对补全</span>
              <span className="settings-desc">输入括号/引号自动配对，光标置中；选中文字输入符号则包裹</span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={autoPair}
              onChange={(e) => setAutoPair(e.target.checked)}
            />
          </label>

          <label className="settings-row">
            <div className="settings-label">
              <span className="settings-name">拼写检查</span>
              <span className="settings-desc">浏览器原生拼写检查（红波浪线）</span>
            </div>
            <input
              type="checkbox"
              className="settings-toggle"
              checked={spellcheck}
              onChange={(e) => setSpellcheck(e.target.checked)}
            />
          </label>

          <div className="settings-row settings-row-select">
            <div className="settings-label">
              <span className="settings-name">代码块语法高亮主题</span>
              <span className="settings-desc">独立于应用明暗模式的代码配色</span>
            </div>
            <select
              className="settings-select"
              value={codeBlockTheme}
              onChange={(e) => setCodeBlockTheme(e.target.value as CodeBlockTheme)}
            >
              {CODE_THEME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="settings-row">
            <div className="settings-label">
              <span className="settings-name">恢复未保存内容</span>
              <span className="settings-desc">
                查看崩溃 / 强制结束后留下的草稿副本，可选择性恢复或丢弃（超过 7 天的会自动清理）。
              </span>
            </div>
            <button
              onClick={async () => {
                setRecoveryDrafts(await listDrafts());
                setRecoveryOpen(true);
              }}
            >
              查看副本
            </button>
          </div>
        </div>
        {recoveryOpen && (
          <RecoveryPanel
            drafts={recoveryDrafts}
            onClose={() => setRecoveryOpen(false)}
            onRestore={async (selected) => {
              // 恢复**不删**草稿：已打开且 dirty 的 tab 不会被合并（内容只在草稿里），
              // 新建的恢复 tab 在下一次编辑前也没有新副本——删了就是净丢内容。
              // 草稿由「保存成功」或 TTL 清理收尾（与启动弹窗同一契约）。
              await applyRecovery(selected);
              setRecoveryOpen(false);
            }}
            onDiscard={async (selected) => {
              await discardDrafts(selected);
              setRecoveryDrafts(await listDrafts());
            }}
          />
        )}
        <div className="settings-footer">
          <button className="settings-reset" onClick={reset}>
            恢复默认
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsPanel;

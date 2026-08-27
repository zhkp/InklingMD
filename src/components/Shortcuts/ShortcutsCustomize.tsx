// 快捷键自定义面板（模态）
// 列出应用级可自定义快捷键，点击按键输入框进入捕获模式，按下组合键即完成绑定。
// 自定义按钮通过 ShortcutsHelp 底部入口打开。冲突检测在捕获时即时反馈。

import { useState, useEffect } from "react";
import {
  useShortcuts,
  SHORTCUT_DEFS,
  RESERVED_SHORTCUTS,
  formatBinding,
  captureFromEvent,
  type ShortcutId,
} from "../../store/shortcuts";
import { getSourceModeConflictBindings } from "../../lib/codemirror-shared";
import { IconX } from "../icons";
import "./ShortcutsCustomize.css";

// 源码模式 CM 内建键位占用的组合（模块级只算一次）
const sourceModeConflicts = getSourceModeConflictBindings();

export function ShortcutsCustomize({ onClose }: { onClose: () => void }) {
  const overrides = useShortcuts((s) => s.overrides);
  const getBinding = useShortcuts((s) => s.getBinding);
  const setBinding = useShortcuts((s) => s.setBinding);
  const resetBinding = useShortcuts((s) => s.resetBinding);
  const resetAll = useShortcuts((s) => s.resetAll);

  const [capturing, setCapturing] = useState<ShortcutId | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 捕获模式：监听全局 keydown，捕获下一次按键组合
  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Esc 取消捕获
      if (e.key === "Escape") {
        setCapturing(null);
        setError(null);
        return;
      }
      const binding = captureFromEvent(e);
      if (!binding) return; // 仅按修饰键，等待下一个按键

      // 1. 保留组合黑名单冲突检测
      const reserved = RESERVED_SHORTCUTS.find((r) => r.binding === binding);
      if (reserved) {
        setError(`该组合为固定快捷键（${reserved.desc}），请换一个组合`);
        return;
      }

      // 2. 自定义快捷键冲突检测：与其他快捷键的绑定相同则拒绝
      const conflict = SHORTCUT_DEFS.find(
        (d) => d.id !== capturing && getBinding(d.id) === binding,
      );
      if (conflict) {
        setError(`与「${conflict.desc}」冲突，请换一个组合`);
        return;
      }

      // 3. 源码模式 CM 内建键位冲突检测：绑到这些组合会在源码编辑时双重触发
      if (sourceModeConflicts.includes(binding)) {
        setError("该组合已被源代码模式编辑器内置键位占用，请换一个组合");
        return;
      }
      setError(null);
      setBinding(capturing, binding);
      setCapturing(null);
    };
    // 捕获阶段优先于其他监听
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, getBinding, setBinding]);

  return (
    <div className="sc-backdrop" onClick={onClose}>
      <div
        className="sc-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="自定义快捷键"
      >
        <div className="sc-header">
          <span className="sc-title">自定义快捷键</span>
          <button className="sc-close" onClick={onClose} title="关闭">
            <IconX size={15} />
          </button>
        </div>
        <div className="sc-body">
          {SHORTCUT_DEFS.map((d) => {
            const binding = getBinding(d.id);
            const isCustom = !!overrides[d.id];
            const isCapturing = capturing === d.id;
            return (
              <div key={d.id} className="sc-row">
                <div className="sc-label">
                  <span className="sc-name">{d.desc}</span>
                  {!isCustom && <span className="sc-tag">默认</span>}
                </div>
                <div className="sc-actions">
                  <button
                    className={`sc-binding${isCapturing ? " sc-binding-capturing" : ""}`}
                    onClick={() => {
                      setCapturing(d.id);
                      setError(null);
                    }}
                    title={isCapturing ? "按下组合键，Esc 取消" : "点击修改"}
                  >
                    {isCapturing ? "按下组合键…" : formatBinding(binding)}
                  </button>
                  {isCustom && (
                    <button
                      className="sc-reset"
                      onClick={() => {
                        resetBinding(d.id);
                        setError(null);
                      }}
                      title="恢复默认"
                    >
                      ↺
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {error && <div className="sc-error">{error}</div>}
        </div>
        <div className="sc-footer">
          <span className="sc-hint">点击按键输入框并按下组合键，Esc 取消捕获</span>
          <button className="sc-reset-all" onClick={resetAll}>
            恢复全部默认
          </button>
        </div>
      </div>
    </div>
  );
}

export default ShortcutsCustomize;

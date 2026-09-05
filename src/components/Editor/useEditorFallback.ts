import { useEffect, useState } from "react";
import type { Editor } from "@milkdown/kit/core";

/**
 * 慢启动提示阈值：loading 持续超过该值仍未就绪时亮「仍在加载」提示。
 * 阈值只触发提示，绝不触发降级卸载（issue #172）。
 */
export const SLOW_START_HINT_MS = 3000;

export interface EditorFallbackControl {
  /** 是否渲染只读降级 textarea（仅两种真失败时置真，见下方 effect 注释） */
  fallback: boolean;
  /** create() 超过阈值仍在进行：仅提示、不卸载 <Milkdown/>（issue #172） */
  slowStart: boolean;
  /** 编辑器工厂同步抛错（真失败 a）。由 useEditor 的工厂在 catch 里调用 */
  markFactoryFailed: () => void;
}

/**
 * 编辑器加载降级决策（issue #172）。
 *
 * 旧实现把「loading 持续超过 3 秒」一律当作失败 → setFallback(true) 卸载
 * <Milkdown/>。但 loading 长时间为 true 有两种截然不同的原因：
 *   a) 工厂同步抛错返回 undefined —— create 永远不会被调用，@milkdown/react
 *      的 loading 永不结束（真失败，应降级）；
 *   b) 工厂成功、editor.create() 在途 —— 大文件/低性能机器可能很慢（伪失败，
 *      终会就绪）。
 * 旧实现把 b 也卸载：@milkdown/react 卸载时会对仍在 create() 的 editor 调
 * destroy()；create 随后完成 → loading=false → 复查 getEditor() 非空 →
 * 重挂载 → 编辑器从零重建，慢启动形成「加载失败」闪烁 + 双倍初始化。
 *
 * 修复：
 *   - b 只亮 slowStart 提示，不卸载，create 完成后自然出现编辑器；
 *   - a 由工厂 catch 里 markFactoryFailed() 显式上报，立即降级，无需等超时；
 *   - loading=false 后 getEditor() 仍为空 → create 异步阶段抛错（真失败 c），降级。
 */
export function useEditorFallback(
  loading: boolean,
  getEditor: () => Editor | undefined,
): EditorFallbackControl {
  const [factoryFailed, setFactoryFailed] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [slowStart, setSlowStart] = useState(false);

  useEffect(() => {
    if (factoryFailed) {
      // 真失败 a：工厂同步抛错 → create 永远不会发生，loading 永不结束，直接降级
      setSlowStart(false);
      setFallback(true);
      return;
    }
    if (loading) {
      // 工厂成功、create() 在途（可能很慢）：超过阈值只亮提示，绝不卸载
      // <Milkdown/>（issue #172，原因见文件头注释）
      const timer = setTimeout(() => setSlowStart(true), SLOW_START_HINT_MS);
      return () => clearTimeout(timer);
    }
    // loading 已结束：create() 成功必须已把实例写入 editorRef（useGetEditor 的
    // .then 里赋值）；仍为空说明 create 异步阶段抛错（真失败 c）→ 降级
    setSlowStart(false);
    setFallback(getEditor() === undefined);
  }, [loading, getEditor, factoryFailed]);

  return {
    fallback,
    slowStart,
    markFactoryFailed: () => setFactoryFailed(true),
  };
}

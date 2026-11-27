// 公式自动编号插件
// 启用后给块级公式（math_display）按文档出现顺序设置 number attr (1,2,3...)，
// NodeView 读取 number 渲染 \tag{n}。关闭时清为 null。
// 通过 appendTransaction 在文档变更后自动校正编号，无需用户手动维护。
// 开关切换时由 Editor 组件 dispatch 一个带 recalc meta 的空 tr 触发重算。
//
// 性能：仅在 docChanged 或收到 recalc meta 时遍历文档；
// 未启用且文档中已无编号残留时直接短路，避免每个 transaction 的全树扫描。

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { useSettings } from "../../store/settings";
import { hydrationMetaKey, type HydrationMeta } from "./tab-editor-cache";
import { SKIP_MARKDOWN_PUBLISH_META } from "./markdown-publisher";

export const formulaNumberingKey = new PluginKey("inkling-formula-numbering");

interface FormulaNumberingMeta {
  /** 强制重算（功能开关切换时触发） */
  recalc?: boolean;
}

/** 收集需要修正的 math_display 节点位置与目标 attrs */
interface PendingFix {
  pos: number;
  attrs: Record<string, unknown>;
}

/** 文档是否包含任何 math_display 节点（短路用，遇到即返回） */
function hasMathDisplay(doc: import("@milkdown/kit/prose/model").Node): boolean {
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === "math_display") {
      found = true;
      return false; // 命中即停
    }
    return true;
  });
  return found;
}

/**
 * 重新计算所有 math_display 节点的 number attr。
 * 返回待修正项数组（空数组表示无需变更）。
 */
function collectFixes(doc: import("@milkdown/kit/prose/model").Node, enabled: boolean): PendingFix[] {
  const fixes: PendingFix[] = [];
  let counter = 0;
  doc.descendants((node, pos) => {
    if (node.type.name !== "math_display") return true;
    counter++;
    const expected: number | null = enabled ? counter : null;
    if (node.attrs.number !== expected) {
      fixes.push({ pos, attrs: { ...node.attrs, number: expected } });
    }
    return true;
  });
  return fixes;
}

export const formulaNumberingPlugin = () =>
  new Plugin({
    key: formulaNumberingKey,
    appendTransaction: (trs, _oldState, newState) => {
      // 渐进式水合的中间分片跳过全树重算，等末片到齐再统一校验/编号。
      // 缓存命中的末片默认跳过——doc 来自同一个编辑器缓存，编号本来已写好；
      // 但缓存时的编号开关与当前设置不一致、或缓存来自中断的首开水合时必须校正
      // （否则在 B 上切换开关后切回 A，A 仍是旧编号，#431 评审 B3）。
      const hydration = trs.reduce<HydrationMeta | undefined>(
        (found, tr) => found ?? tr.getMeta(hydrationMetaKey),
        undefined,
      );
      if (hydration?.hydrating) {
        if (!hydration.done) return null;
        if (hydration.fromCache && !hydration.renumberFormulas) return null;
      }
      // 仅在文档变更或显式 recalc 时重算，避免纯选区移动也全树遍历
      const docChanged = trs.some((t) => t.docChanged);
      const recalc = trs.some((t) => (t.getMeta(formulaNumberingKey) as FormulaNumberingMeta | undefined)?.recalc);
      if (!docChanged && !recalc) return null;
      const enabled = useSettings.getState().formulaAutoNumber;
      // 快速短路：文档无公式节点时无需任何处理
      if (!hasMathDisplay(newState.doc)) return null;
      const fixes = collectFixes(newState.doc, enabled);
      if (fixes.length === 0) return null;
      const tr = newState.tr;
      // 编号只改运行时 attr，不进入 Markdown 输出：不进撤销历史，也不触发全文发布
      tr.setMeta("addToHistory", false);
      tr.setMeta(SKIP_MARKDOWN_PUBLISH_META, true);
      // 从后往前 setNodeMarkup，避免位置偏移影响（atom 节点改 attr 不改尺寸，但稳妥起见逆序）
      for (let i = fixes.length - 1; i >= 0; i -= 1) {
        const f = fixes[i];
        tr.setNodeMarkup(f.pos, undefined, f.attrs);
      }
      return tr;
    },
  });

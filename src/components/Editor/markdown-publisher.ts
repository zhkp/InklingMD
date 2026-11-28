// Markdown 源码发布插件
// 全文序列化防抖 150ms：避免每次按键都 O(n) 序列化整篇文档
// （万行文档输入掉帧主因之一，issue #31）。blur/销毁时立即 flush 保证不丢内容。

import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView } from "@milkdown/kit/prose/view";
import { isSamePath } from "../../lib/path-utils";
import { hydrationMetaKey } from "./tab-editor-cache";

export interface MarkdownPublisherDeps {
  /** 将当前 doc 序列化为 Markdown 源码 */
  serialize: (doc: Node) => string;
  getLastSynced: () => string;
  setLastSynced: (markdown: string) => void;
  onChange: (markdown: string) => void;
  /** 该编辑器当前挂载的文档路径（实例跨 tab 复用，必须每次实时读取） */
  getFilePath: () => string;
}

const publisherKey = new PluginKey<{ userDocSeq: number }>("inkling-markdown-publisher");

/**
 * 只改运行时属性、不改变 Markdown 输出的同步事务标记（如公式编号 number attr）。
 * 这类事务不应触发全文序列化（#431 评审 B3）。
 */
export const SKIP_MARKDOWN_PUBLISH_META = "inkling-skip-markdown-publish";

// 存活编辑器的 flush 注册表：保存路径在读取 store 前统一 flush，
// 避免防抖窗口内 Ctrl/Cmd+S 读到旧内容（PR #34 review）。
// 按 EditorView 索引，交互路径只 flush 自己那份，避免顺手序列化分屏的全文（#431 评审）。
interface PublisherEntry {
  flush: () => void;
  /** 实时读取当前挂载路径：实例跨 tab 复用，注册时不能固化 */
  getFilePath: () => string;
}
const pendingFlushes = new Map<EditorView, PublisherEntry>();
const tabCancelTimers = new WeakMap<EditorView, () => void>();

export function flushAllMarkdownPublishers(): void {
  for (const entry of [...pendingFlushes.values()]) entry.flush();
}

/** 只 flush 指定编辑器的待发编辑（切 tab / 进源码模式等单编辑器交互路径） */
export function flushMarkdownPublisherFor(view: EditorView): void {
  pendingFlushes.get(view)?.flush();
}

/**
 * 只 flush 当前挂载在指定文档上的待发编辑（store 侧切 tab/关闭/保存路径使用）。
 * 分屏停在别的文件时不会被顺带全文序列化（#431 评审 B7）。
 */
export function flushMarkdownPublishersForPath(path: string): void {
  for (const entry of [...pendingFlushes.values()]) {
    if (isSamePath(entry.getFilePath(), path)) entry.flush();
  }
}

/** 切 tab 替换 doc 前取消未触发的防抖定时器，避免串写到新 tab */
export function cancelPendingMarkdownPublish(view: EditorView): void {
  tabCancelTimers.get(view)?.();
}

function isHeadingIdSyncTr(tr: { getMeta: (key: string) => unknown }): boolean {
  const rawMeta = (tr as unknown as { meta?: Record<string, unknown> }).meta;
  if (!rawMeta) return false;
  for (const k of Object.keys(rawMeta)) {
    if (k === "MILKDOWN_HEADING_ID" || k.startsWith("MILKDOWN_HEADING_ID$")) {
      return true;
    }
  }
  return false;
}

export const markdownPublisherPlugin = (deps: MarkdownPublisherDeps) =>
  new Plugin({
    key: publisherKey,
    state: {
      init: () => ({ userDocSeq: 0 }),
      apply: (tr, prev) => {
        const skip = Boolean(
          tr.getMeta(hydrationMetaKey)?.hydrating ||
            isHeadingIdSyncTr(tr) ||
            tr.getMeta(SKIP_MARKDOWN_PUBLISH_META) === true,
        );
        // 用户文档变更单独计数（#431 评审 P1）：一次 view 更新可能同时包含用户编辑
        // 事务与 heading-id 补写事务（appendTransaction 同批应用）。只跳过后者的
        // 序列化，不能把同批的用户编辑一起吞掉，否则保存/切 tab 前 store 里是旧内容。
        if (skip || !tr.docChanged) return prev;
        return { userDocSeq: prev.userDocSeq + 1 };
      },
    },
    view: (view) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let lastUserDocSeq = publisherKey.getState(view.state)?.userDocSeq ?? 0;
      // 打开文件时以「解析后 doc 的实际序列化结果」为基线，而非原始文件内容。
      // 否则编辑器初始化的首个 flush 会因序列化规范化差异（如末尾换行）把
      // 从未编辑的文档误判为变更、经 onChange 标 dirty，导致关闭 tab 时
      // 误弹未保存确认（E2E「关闭 tab」失败根因）。
      try {
        deps.setLastSynced(deps.serialize(view.state.doc));
      } catch {
        // 序列化失败保持原基线，flush 时再兜底
      }
      const cancelTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const flush = () => {
        // 无待发编辑（timer 为 null）直接跳过：保存路径的 flush 不应
        // 对每个挂载编辑器重跑全文序列化（万行文档的大停顿，PR #34）。
        // 注意不能再按源码模式跳过：源码模式下 PM doc 不会变化，
        // timer 非空必然意味着进入源码模式前的待发编辑，必须发布
        if (!timer) return;
        cancelTimer();
        let markdown: string;
        try {
          markdown = deps.serialize(view.state.doc);
        } catch (e) {
          console.error("Markdown 序列化失败：", e);
          return;
        }
        // 编辑器内部产生的变更才回调；外部 value 同步进来的不回调
        if (markdown !== deps.getLastSynced()) {
          deps.setLastSynced(markdown);
          deps.onChange(markdown);
        }
      };
      tabCancelTimers.set(view as EditorView, () => {
        cancelTimer();
        lastUserDocSeq = publisherKey.getState(view.state)?.userDocSeq ?? lastUserDocSeq;
      });
      view.dom.addEventListener("blur", flush);
      pendingFlushes.set(view as EditorView, {
        flush,
        getFilePath: deps.getFilePath,
      });
      return {
        update: (nextView, prevState) => {
          const userDocSeq =
            publisherKey.getState(nextView.state)?.userDocSeq ?? lastUserDocSeq;
          const userEdited = userDocSeq !== lastUserDocSeq;
          lastUserDocSeq = userDocSeq;
          // 本批没有用户文档变更（纯水合 / heading-id 补写 / 编号 recalc / 选区移动）：
          // 不发布。同一批若还带了用户编辑，userDocSeq 已变化，照常发布。
          if (!userEdited) return;
          if (nextView.state.doc === prevState.doc) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(flush, 150);
        },
        destroy: () => {
          tabCancelTimers.delete(view as EditorView);
          pendingFlushes.delete(view as EditorView);
          view.dom.removeEventListener("blur", flush);
          flush();
        },
      };
    },
  });

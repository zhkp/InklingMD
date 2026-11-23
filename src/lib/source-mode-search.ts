// 源码模式查找替换的命令路由（issue #29）
// 全局快捷键（App.tsx）在源码模式下不再弹出 WYSIWYG SearchPanel / 提示退出，
// 而是通过这里把 Ctrl+F / Ctrl+R 定向到当前激活 tab 对应的 CodeMirror 实例，
// 打开 CM 内置查找/替换面板。分屏时按 filePath 精确命中，不误触隐藏编辑器。
//
// 同一模块还提供替换引用口径的补齐（issue #428）：CM 的
// RegExpQuery.getReplacement 只认 `$n` / `$&` / `$$`，`$<name>` 会整串写进正文，
// 与 WYSIWYG 不一致。展开规则已抽到 lib/regex-replacement，这里把 CM 查询实例
// 的 getReplacement 换成同一套口径，使面板按钮、Mod-r、全部替换自动共用一条路径。

import { EditorState, Transaction, type Extension } from "@codemirror/state";
import { SearchQuery, setSearchQuery } from "@codemirror/search";
import { expandReplacementReferences } from "./regex-replacement";

type SourceModeSearchRunner = (opts: { replace: boolean }) => void;

const registry = new Map<string, SourceModeSearchRunner>();

/** SourceModeEditor 挂载时注册自己的命令执行器 */
export function registerSourceModeSearch(filePath: string, run: SourceModeSearchRunner) {
  registry.set(filePath, run);
}

/** SourceModeEditor 卸载时注销 */
export function unregisterSourceModeSearch(filePath: string) {
  registry.delete(filePath);
}

/**
 * 对指定文件路径的源码模式编辑器打开查找/替换面板。
 * 未注册（非源码模式或实例未挂载）时返回 false，调用方自行兜底。
 */
export function runSourceModeSearch(
  filePath: string | null | undefined,
  opts: { replace: boolean },
): boolean {
  if (!filePath) return false;
  const run = registry.get(filePath);
  if (!run) return false;
  run(opts);
  return true;
}

/** CM 内一次匹配的形态（RegExpCursor / RegExpQuery.matchAll 的产出） */
interface RegexMatchResult {
  from: number;
  to: number;
  match: RegExpExecArray;
}

/**
 * CM 内部的 QueryType（RegExpQuery / StringQuery）里本模块会碰到的两个成员。
 * 该类型未在 @codemirror/search 的 .d.ts 导出：SearchState 持有的是它的实例，
 * 替换命令（含面板按钮）只通过 getReplacement 取值，其余匹配方法原样委托。
 */
interface QueryTypeLike {
  spec: SearchQuery;
  getReplacement(result: RegexMatchResult): string;
}

/** SearchQuery.create()/unquote() 未被 .d.ts 声明，按运行时形状访问 */
type InternalSearchQuery = SearchQuery & { unquote(text: string): string };

const baseCreateQueryType = (
  SearchQuery.prototype as unknown as { create(this: SearchQuery): QueryTypeLike }
).create;

/** 上游若移除 create()，不拦事务、退回 CM 原口径（用例会红，不会静默崩面板） */
const hasQueryTypeFactory = typeof baseCreateQueryType === "function";
let warnedMissingFactory = false;

/**
 * 只替换 QueryType 的 getReplacement，其余（匹配、高亮、matchAll）原样委托。
 * 用 Proxy 而不是手写转发对象：上游新增方法时不会被这层包壳吞掉。
 */
function withExpandedReplacement(inner: QueryTypeLike): QueryTypeLike {
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === "getReplacement") {
        return (result: RegexMatchResult) =>
          expandReplacementReferences(
            // 先按 CM 口径解掉 `\n` / `\r` / `\t` / `\\` 转义，再展开引用
            (target.spec as InternalSearchQuery).unquote(target.spec.replace),
            {
              text: result.match[0],
              captures: result.match.slice(1),
              groups: result.match.groups ?? {},
            },
          );
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 带上替换引用口径的查询。CM 面板 commit 时 new 的是基类 SearchQuery，
 * 故这里覆写 create()（SearchState 唯一取 QueryType 的入口），
 * 再配合下面的 transactionFilter 把面板/命令塞进来的基类查询升级成本类。
 */
class NamedGroupSearchQuery extends SearchQuery {
  create(): QueryTypeLike {
    const inner = baseCreateQueryType.call(this);
    // 非正则查询的替换串不做任何 `$` 展开，保持 CM 原口径（与 WYSIWYG 一致）
    return this.regexp ? withExpandedReplacement(inner) : inner;
  }
}

/**
 * 源码模式注册：让 CM 查找面板的替换与 WYSIWYG 共用同一套引用展开口径
 * （面板「替换」/「全部替换」按钮、Enter、Mod-r 都只认 state 里的查询实例，
 *  故在这里升级查询，而不是另写一套替换命令）。
 *
 * filter 的契约是「返回事务 spec」，返回 null 等于取消事务：不改动时必须原样返回 tr。
 * 只升级「纯设置查询」的事务（无文档改动、无选区）——面板 commit 与
 * openSearchPanel 都是这种形态；带改动的替换事务不经过这里。
 */
export function namedGroupReplacementSupport(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!hasQueryTypeFactory) {
      if (!warnedMissingFactory) {
        warnedMissingFactory = true;
        console.warn(
          "[search] @codemirror/search 的 SearchQuery.create 缺失，源码模式替换引用退回上游口径",
        );
      }
      return tr;
    }
    if (tr.docChanged || tr.selection) return tr;
    let patched = false;
    const effects = tr.effects.map((effect) => {
      if (!effect.is(setSearchQuery) || effect.value instanceof NamedGroupSearchQuery) {
        return effect;
      }
      const query = effect.value;
      patched = true;
      return setSearchQuery.of(
        new NamedGroupSearchQuery({
          search: query.search,
          caseSensitive: query.caseSensitive,
          literal: query.literal,
          regexp: query.regexp,
          replace: query.replace,
          wholeWord: query.wholeWord,
          test: query.test,
        }),
      );
    });
    if (!patched) return tr;
    // 面板 commit 只带 effects；userEvent / scrollIntoView 一并沿用，避免丢语义
    const userEvent = tr.annotation(Transaction.userEvent);
    return {
      effects,
      scrollIntoView: tr.scrollIntoView,
      ...(userEvent ? { userEvent } : {}),
    };
  });
}


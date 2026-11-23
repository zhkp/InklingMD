// 正则替换引用展开（两种编辑模式共用一套口径，issue #380 / #428）
//
// WYSIWYG（ProseMirror 自研查找面板）与源码模式（CodeMirror 内置面板）各自
// 实现替换时会分裂出两套语义：CM 的 RegExpQuery.getReplacement 只认
// `$n` / `$&` / `$$`，`$<name>` 整串原样写进正文。同一份文档、同一个查找正则
// 与替换串因此结果不同，故把展开规则抽到这里，两边都调用它。
//
// 展开规则（两模式统一口径；与 JS String.replace 的差异：未知组保留字面量、
// 不支持 $`（匹配前文本）与 $'（匹配后文本）两个特例、三位以上 $ 引用按两位处理）：
// - `$$` → `$`，`$&` → 整段匹配；
// - `$n` / `$nn` → 位置捕获组；组不存在时保留字面量，两位编号回退到一位；
// - `$<name>` → 命名捕获组；组已定义但未参与匹配展开为空串，名称不存在保留字面量；
// - 其余 `$` 原样保留。
// 逐字符解析而不是再次调用 String.replace，避免捕获文本中的 `$` 被递归解释。

/** 一次匹配提供给替换展开的信息（与具体编辑器无关） */
export interface ReplacementMatch {
  /** 整段匹配文本（对应 `$&`） */
  text: string;
  /** 位置捕获组，下标 0 对应 `$1` */
  captures: (string | undefined)[];
  /** 命名捕获组（`(?<name>…)`），无命名组时为空对象 */
  groups: Record<string, string | undefined>;
}

export function expandReplacementReferences(
  replacement: string,
  match: ReplacementMatch,
): string {
  let expanded = "";
  for (let i = 0; i < replacement.length; i += 1) {
    if (replacement[i] !== "$" || i + 1 >= replacement.length) {
      expanded += replacement[i];
      continue;
    }

    const next = replacement[i + 1];
    if (next === "$" || next === "&") {
      expanded += next === "$" ? "$" : match.text;
      i += 1;
      continue;
    }

    if (next === "<") {
      const close = replacement.indexOf(">", i + 2);
      if (close >= 0) {
        const name = replacement.slice(i + 2, close);
        if (Object.prototype.hasOwnProperty.call(match.groups, name)) {
          expanded += match.groups[name] ?? "";
          i = close;
          continue;
        }
      }
      // Leave unknown $<...> text to the normal scan so valid references
      // inside it (such as $1 or a nested $<name>) are still expanded.
      expanded += "$";
      continue;
    }

    if (next >= "0" && next <= "9") {
      const second = replacement[i + 2];
      const hasTwoDigits = second >= "0" && second <= "9";
      const reference = hasTwoDigits ? next + second : next;
      const groupNumber = Number(reference);

      // $0 and $00 are literal. $01 follows the JS replacement rule: use
      // group 1 when it exists, otherwise preserve the whole token.
      if (next === "0") {
        if (hasTwoDigits && groupNumber > 0 && groupNumber <= match.captures.length) {
          expanded += match.captures[groupNumber - 1] ?? "";
          i += 2;
        } else {
          expanded += `$${reference}`;
          i += hasTwoDigits ? 2 : 1;
        }
        continue;
      }

      if (groupNumber <= match.captures.length) {
        expanded += match.captures[groupNumber - 1] ?? "";
        i += hasTwoDigits ? 2 : 1;
      } else if (hasTwoDigits && Number(next) <= match.captures.length) {
        // $10/$11 fall back to $1 + "0"/"1" when that two-digit group is absent.
        expanded += `${match.captures[Number(next) - 1] ?? ""}${second}`;
        i += 2;
      } else {
        expanded += `$${reference}`;
        i += hasTwoDigits ? 2 : 1;
      }
      continue;
    }

    expanded += "$";
  }
  return expanded;
}

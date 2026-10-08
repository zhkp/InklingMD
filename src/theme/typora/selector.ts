/**
 * #306 §C1/§C2/§4.2：选择器三分类前缀收敛（结构化改写，禁止正则改选择器）。
 *
 * A. 可加前缀：`#write h1` / `.md-fences` / 裸标签 `table` → `.editor-scroll .milkdown …`
 * B. 根级收敛：`html` / `body` / `:root` / 裸 `*` / `#write` / 文档根别名类
 *    → 剥离根级 compound 后整体收敛为 `.editor-scroll .milkdown`
 * C. 丢弃：CM5/CM 类（G1）、Typora 窗口级 UI 标识（Epic 非目标）、原生嵌套 `&`（降级）
 *
 * 不变量 I1（G6）：A/B 两类的输出前缀**恒为 2 段** `.editor-scroll .milkdown`，
 * 绝不产出 `.editor-scroll .milkdown .editor .ProseMirror` 这种 3–4 段形态。
 */
import selectorParser from "postcss-selector-parser";
import type { ThemeDiagnostic } from "./types";

/** 编辑区内容前缀（与基线 `App.css:419` 起的形态一致，G6-I1） */
export const EDITOR_PREFIX = ".editor-scroll .milkdown";

/**
 * Typora 文档级类名 → 本应用等价类名（依据：真实 DOM 探针；见兼容性矩阵「映射依据」列）。
 * 只登记「本应用确有对应节点」的类；无对应的类保持原样（前缀后不命中，登记为降级）。
 */
export const DOC_CLASS_MAP: Readonly<Record<string, string>> = {
  "md-fences": "code-block",
  "md-lang": "code-block-lang",
  "md-inline-math": "math-inline",
  "md-math-block": "math-display",
  "mathjax-block": "math-display",
  "md-mathjax-midline": "math-display",
  "md-diagram-panel": "mermaid-block",
  "md-diagram": "mermaid-block",
  "md-toc": "toc-block",
  "md-meta-block": "frontmatter-block",
  "md-image": "milkdown-image-wrap",
  "md-alert": "callout-block",
  "md-footnote": "footnote-ref",
};

/** Typora 文档级类名 → 本应用**属性**选择器（本应用该节点没有类名）。 */
export const DOC_CLASS_ATTR_MAP: Readonly<Record<string, { attr: string; value: string }>> = {
  "md-task-list-item": { attr: "data-item-type", value: "task" },
};

/** Typora 标签 → 本应用等价标签（`tt` 是 Typora 时代的行内代码写法）。 */
export const TAG_MAP: Readonly<Record<string, string>> = {
  tt: "code",
};

/** 文档根别名（B 类）：剥离后整体收敛为编辑区前缀。 */
const ROOT_ALIAS_CLASSES = new Set([
  "typora-export",
  "enable-diagrams",
  "typora-node",
  "html-for-mac",
  "mac-seamless-mode",
  "typora-sourceview-on",
]);
const ROOT_ALIAS_TAGS = new Set(["html", "body"]);
const ROOT_ALIAS_IDS = new Set(["write"]);

/**
 * Typora 窗口级 UI 标识（Epic 明确非目标：不实现窗口级 UI 皮肤）。
 * 命中即丢弃整条选择器并登记（这些规则在本应用 DOM 里不可能有对应节点）。
 */
const UI_ID_PATTERNS: readonly RegExp[] = [
  /^typora-/,
  /^top-titlebar$/,
  /^megamenu-/,
  /^recent-file-panel/,
  /^toc-dropmenu$/,
  /^md-searchpanel/,
  /^md-notification/,
  /^spell-check-panel/,
  /^file-info-/,
  /^sidebar-/,
  /^footer-/,
  /^ty-/,
  /^w-(full|pin|unpin)$/,
  /^toggle-sourceview-btn$/,
  /^info-panel-/,
];
const UI_CLASS_PATTERNS: readonly RegExp[] = [
  /^btn/,
  /^dropdown/,
  /^file-(list|node|library)/,
  /^megamenu/,
  /^outline/,
  /^sidebar-/,
  /^typora-/,
  /^ty-/,
  /^modal-/,
  /^mac-/,
  /^context-menu/,
  /^ty-table-edit$/,
  /^code-tooltip$/,
  /^auto-suggest/,
  /^export-detail$/,
  /^pin-outline$/,
  /^nav-group/,
  /^anchor$/,
  /^md-(focus|focus-container|rawblock|rawblock-control|rawblock-container|rawblock-tooltip|rawblock-on-edit)$/,
  /^on-focus-mode$/,
  /^task-list$/,
];

/** 命中即丢弃（分类 C）：CM5/CM 类（G1：语法高亮归 codeBlockTheme，主题不得越权）。 */
const CM_CLASS_PATTERN = /^(cm-|CodeMirror)/;

const PSEUDO_FUNCS = new Set([":is", ":not", ":where", ":has", ":matches"]);

const makeDiag = (
  kind: ThemeDiagnostic["kind"],
  target: string,
  reason: string,
): ThemeDiagnostic => ({ kind, target, reason });

/** 单个 compound 的判定结果。 */
interface LeadingStripResult {
  /** 需要剥离的根级前缀节点数（含其后的 combinator） */
  strippedRoots: number;
  /** 被丢弃的根级附加条件（如 `body.typora-export` 里的 `.typora-export` 之外的杂项） */
  droppedExtras: string[];
  /** 需要**随根一起搬到前缀上**的 `:has()` 条件（`#write:has(> table)`，见 §4.3） */
  carriedHas: string[];
  /** 剥离后紧接着的是 `>` 直系子组合子（需要按 §4.3 做「真实内容根」翻译） */
  directChildAfterRoot: boolean;
}

/**
 * 判断一个 compound 是否「纯根级别名」。`#write:has(> table)` 里的 `:has()` 不阻止判定，
 * 而是作为「根的条件」被搬到前缀上（`carriedHas`）。
 * 注意：裸 `*` 只在**整条选择器仅此一个 compound** 时才算根级别名（分类 B）；
 * `#write *` 这类「后代通配」必须保留 `*`，否则语义从「所有后代」退化为「仅容器本身」。
 */
function leadingCompoundIsRoot(
  nodes: selectorParser.Node[],
  soleCompound: boolean,
): { isRoot: boolean; hasPseudos: selectorParser.Pseudo[] } {
  const hasPseudos: selectorParser.Pseudo[] = [];
  if (nodes.length === 0) return { isRoot: false, hasPseudos };
  let isRoot = true;
  for (const node of nodes) {
    if (node.type === "tag") {
      if (!ROOT_ALIAS_TAGS.has(node.value.toLowerCase())) isRoot = false;
    } else if (node.type === "id") {
      if (!ROOT_ALIAS_IDS.has(node.value)) isRoot = false;
    } else if (node.type === "universal") {
      if (!soleCompound) isRoot = false;
    } else if (node.type === "pseudo") {
      if (node.toString() === ":root") continue;
      if (node.value === ":has") hasPseudos.push(node as selectorParser.Pseudo);
      else isRoot = false;
    } else if (node.type === "class") {
      if (!ROOT_ALIAS_CLASSES.has(node.value)) isRoot = false;
    } else {
      isRoot = false;
    }
  }
  return { isRoot, hasPseudos };
}

/** 把选择器按 compound 分组（不含 combinator）。 */
function splitCompounds(sel: selectorParser.Selector): {
  compounds: selectorParser.Node[][];
  combinators: selectorParser.Combinator[];
} {
  const compounds: selectorParser.Node[][] = [[]];
  const combinators: selectorParser.Combinator[] = [];
  for (const node of sel.nodes) {
    if (node.type === "combinator") {
      combinators.push(node);
      compounds.push([]);
    } else {
      compounds[compounds.length - 1].push(node);
    }
  }
  return { compounds, combinators };
}

/** 剥离前导根级 compound（含 `#write`/`html`/`body`/`:root`/根别名类）。 */
function stripLeadingRoots(sel: selectorParser.Selector): LeadingStripResult {
  const { compounds, combinators } = splitCompounds(sel);
  const soleCompound = compounds.length === 1;
  let idx = 0;
  const droppedExtras: string[] = [];
  const carriedHas: string[] = [];
  while (idx < compounds.length) {
    const info = leadingCompoundIsRoot(compounds[idx], soleCompound);
    if (!info.isRoot) break;
    for (const p of info.hasPseudos) carriedHas.push(p.toString());
    idx += 1;
  }
  if (idx === 0) {
    // 混合形态（如 `body.custom h1`）：首个 compound 含根别名但不纯 → 仍收敛，附加条件登记丢弃
    const first = compounds[0];
    const aliasNodes = first.filter(
      (n) => n.type !== "pseudo" && leadingCompoundIsRoot([n], false).isRoot,
    );
    if (aliasNodes.length > 0) {
      for (const n of first) {
        if (n.type === "pseudo") {
          const value = (n as selectorParser.Pseudo).value;
          if (value === ":has") carriedHas.push(n.toString());
          else if (!aliasNodes.includes(n) && n.toString() !== ":root") droppedExtras.push(n.toString());
          continue;
        }
        if (!aliasNodes.includes(n)) droppedExtras.push(n.toString());
      }
      idx = 1;
    }
  }
  if (idx === 0) {
    return { strippedRoots: 0, droppedExtras: [], carriedHas: [], directChildAfterRoot: false };
  }
  // 剥离后紧接的是 `>` 吗？（`#write > h1`；见 §4.3 的真实内容根翻译）
  const directChildAfterRoot = idx < compounds.length && combinators[idx - 1]?.value === ">";
  // 只删 compound 自身：其后的 combinator（`>` / `+` / ` `）语义属于「前缀 → 文档元素」，必须保留
  for (let i = 0; i < idx; i++) {
    for (const node of compounds[i]) node.remove();
  }
  // 剥离多个根级 compound 会留下连续 combinator（`html body h1` → `␣␣h1`）→ 只保留最后一个
  let lead: selectorParser.Node | undefined = sel.first;
  while (
    lead &&
    lead.type === "combinator" &&
    lead.next() &&
    lead.next()!.type === "combinator"
  ) {
    const next: selectorParser.Node | undefined = lead.next() ?? undefined;
    lead.remove();
    lead = next;
  }
  return { strippedRoots: idx, droppedExtras, carriedHas, directChildAfterRoot };
}

/** 按 DOC_CLASS_MAP / DOC_CLASS_ATTR_MAP / TAG_MAP 改写 compound 内的类名与标签。 */
function applyDocMapping(sel: selectorParser.Selector): void {
  sel.walk((node) => {
    if (node.type === "class" && DOC_CLASS_MAP[node.value]) {
      node.replaceWith(selectorParser.className({ value: DOC_CLASS_MAP[node.value] }));
    } else if (node.type === "class" && DOC_CLASS_ATTR_MAP[node.value]) {
      const spec = DOC_CLASS_ATTR_MAP[node.value];
      node.replaceWith(
        selectorParser.attribute({
          attribute: spec.attr,
          operator: "=",
          value: spec.value,
          quoteMark: null,
          raws: { value: spec.value },
        }),
      );
    } else if (node.type === "tag" && TAG_MAP[node.value.toLowerCase()]) {
      node.value = TAG_MAP[node.value.toLowerCase()];
    }
  });
}

/**
 * §4.3 直系子翻译：Typora 的 `#write` **就是内容块的父亲**；本应用 `.milkdown` 与内容块之间
 * 还有内容根（真实 DOM：`div.milkdown > div.ProseMirror.editor > h1`）。
 * 故把「紧随剥离后根名的 `>`」翻译为 `> * >` =「内容根的直系子」：
 * - 保持「一层」语义（不扩散到更深的同名元素）；
 * - 不会误命中内容根本身（`.milkdown > div` 会打到 `.ProseMirror`）。
 * 仅改组合子结构，**不增加 class/attr/id 计数**（G6-I1 的「前缀恒 2 段」仍然成立）。
 */
function insertContentRootLevel(sel: selectorParser.Selector): boolean {
  const lead = sel.first;
  if (!lead || lead.type !== "combinator" || lead.value !== ">") return false;
  lead.spaces = { before: lead.spaces?.before ?? " ", after: " " };
  const star = selectorParser.universal({ value: "*" });
  star.spaces = { before: "", after: "" };
  const gt = selectorParser.combinator({ value: ">" });
  gt.spaces = { before: " ", after: " " };
  const next = lead.next();
  if (next) next.spaces = { ...next.spaces, before: "" };
  sel.insertAfter(lead, star);
  sel.insertAfter(star, gt);
  return true;
}

/** 在 selector 最前面插入 `prefix`（含空格 combinator；`carriedPseudos` 追加到最后一个 compound）。 */
function prependPrefix(
  sel: selectorParser.Selector,
  prefix: string,
  carriedPseudos: readonly string[] = [],
): void {
  const parsed = selectorParser().astSync(prefix + carriedPseudos.join(""));
  const prefixNodes = parsed.first ? parsed.first.nodes.map((n) => n.clone()) : [];
  const anchor = sel.first ?? null;
  if (!anchor) {
    for (const node of prefixNodes) sel.append(node);
    return;
  }
  // 锚点原有的前导空白有两类来源，要区别对待：
  // ① 选择器列表里 `, ` 之后的那个空格（列表的**非首项**）→ 转移给前缀，避免双空格；
  // ② 前缀自身或函数首参残留的空白 → 清掉（否则出现 `:is( .editor-…` 这种脏输出）。
  const leadingSpace = anchor.spaces?.before ?? "";
  const isFirstInList = !sel.prev();
  for (const node of prefixNodes) sel.insertBefore(anchor, node as selectorParser.ClassName);
  if (anchor.type === "combinator") {
    // 剥离根级 compound 后，剩下的第一个节点可能就是 combinator（如 `#write > h1`）：
    // 不再插入空格组合子（两个组合子相邻会让 stringify 吞掉 `>`），保留其自带空白即可。
    anchor.spaces = { ...anchor.spaces, before: leadingSpace || " " };
    return;
  }
  if (!isFirstInList && leadingSpace && prefixNodes.length > 0) {
    prefixNodes[0].spaces = { ...prefixNodes[0].spaces, before: leadingSpace };
  }
  anchor.spaces = { ...anchor.spaces, before: "" };
  sel.insertBefore(anchor, selectorParser.combinator({ value: " " }));
}

/**
 * 判定选择器**本层**（不含 `:is()` 等函数内层——内层由 rewritePseudos 递归处理）是否含
 * CM 类 / UI 标识；命中即整条丢弃。
 */
function findForbidden(
  sel: selectorParser.Selector,
): { kind: "cm" | "ui"; token: string } | null {
  let found: { kind: "cm" | "ui"; token: string } | null = null;
  for (const node of sel.nodes) {
    if (found) break;
    if (node.type === "class") {
      if (CM_CLASS_PATTERN.test(node.value)) found = { kind: "cm", token: `.${node.value}` };
      // 根级别名（.typora-export 等）不是 UI 标识：它们属于分类 B 的收敛对象
      const ui = ROOT_ALIAS_CLASSES.has(node.value)
        ? undefined
        : UI_CLASS_PATTERNS.find((re) => re.test(node.value));
      if (!found && ui) found = { kind: "ui", token: `.${node.value}` };
    } else if (node.type === "id") {
      const ui = UI_ID_PATTERNS.find((re) => re.test(node.value));
      if (!found && ui) found = { kind: "ui", token: `#${node.value}` };
    }
  }
  return found;
}

/**
 * 递归处理 `:is()/:not()/:where()/:has()` 内层参数（§C2：加在**每个内层参数**上）。
 * 返回 false 表示「内层参数被清空」→ 调用方必须丢弃整条选择器：
 * `:not()` 变成空函数是非法 CSS，且 `:is()` 失去全部参数会让规则语义反转。
 */
function rewritePseudos(
  sel: selectorParser.Selector,
  report: (d: ThemeDiagnostic) => void,
  depth: number,
): boolean {
  let ok = true;
  sel.walkPseudos((pseudo) => {
    if (!PSEUDO_FUNCS.has(pseudo.value) || !pseudo.nodes || depth > 6) return;
    // `:has()` 的内层是**相对选择器**（相对主体元素匹配）→ 不加前缀，只做直系子翻译；
    // `:is()/:not()/:where()` 的内层是绝对选择器 → 逐个加前缀（§C2）。
    const relative = pseudo.value === ":has";
    for (const inner of [...pseudo.nodes]) {
      if (inner.type !== "selector") continue;
      if (!rewriteSelectorNode(inner, report, depth + 1, relative)) inner.remove();
    }
    const remaining = pseudo.nodes.filter((n) => n.type === "selector");
    if (remaining.length === 0) {
      report(
        makeDiag(
          "dropped-selector",
          sel.toString().trim(),
          `${pseudo.value}() 内层参数全部不可映射 → 丢弃整条选择器（保留空函数会产生非法/反转语义）`,
        ),
      );
      ok = false;
    }
  });
  return ok;
}

/** 改写单个复合选择器；返回 false 表示丢弃（会就地修改 AST）。
 * `relative = true`：`:has()` 的内层参数（相对选择器）——不加前缀、不剥根，只做直系子翻译。 */
function rewriteSelectorNode(
  sel: selectorParser.Selector,
  report: (d: ThemeDiagnostic) => void,
  depth: number,
  relative = false,
): boolean {
  const original = sel.toString().trim();

  if (original.includes("&")) {
    report(
      makeDiag(
        "dropped-selector",
        original,
        "原生嵌套（`&`）：本层不展开 → 丢弃（§C2 既定降级）",
      ),
    );
    return false;
  }

  const forbidden = findForbidden(sel);
  if (forbidden?.kind === "cm") {
    report(
      makeDiag(
        "dropped-selector",
        original,
        `含代码编辑器类 ${forbidden.token}（G1）：语法高亮归 codeBlockTheme，主题 .cm-*/.CodeMirror-* 一律丢弃`,
      ),
    );
    return false;
  }
  if (forbidden?.kind === "ui") {
    report(
      makeDiag(
        "dropped-selector",
        original,
        `含 Typora 窗口级 UI 标识 ${forbidden.token}（Epic 非目标：不实现窗口级 UI 皮肤）`,
      ),
    );
    return false;
  }

  if (relative) {
    // `:has(> X)`：主体是被收敛的根（`.milkdown`）→ 内层的 `>` 同样需要真实内容根翻译
    applyDocMapping(sel);
    if (insertContentRootLevel(sel)) {
      report(
        makeDiag(
          "scoped-root",
          `:has(${original})`,
          "§4.3 直系子翻译（`:has()` 内层相对选择器）：`> X` → `> * > X`（相对内容根而非 `.milkdown`），内层不加前缀（相对选择器语义）",
        ),
      );
    }
    return rewritePseudos(sel, report, depth);
  }

  const strip = stripLeadingRoots(sel);
  if (strip.strippedRoots > 0 && strip.droppedExtras.length > 0) {
    report(
      makeDiag(
        "scoped-root",
        original,
        `根级复合条件 ${strip.droppedExtras.join("")} 在本应用无对应 → 丢弃该条件，仅保留编辑区收敛`,
      ),
    );
  } else if (strip.strippedRoots > 0) {
    report(
      makeDiag("scoped-root", original, "根级选择器收敛到编辑区容器 `.editor-scroll .milkdown`（2 段）"),
    );
  }

  applyDocMapping(sel);
  if (strip.directChildAfterRoot && insertContentRootLevel(sel)) {
    report(
      makeDiag(
        "scoped-root",
        original,
        "§4.3 直系子翻译：`#write > X` → `前缀 > * > X`（本应用 `.milkdown` 与内容块之间隔着内容根 `.ProseMirror`）→ 命中内容根的直系子，且不再误命中内容根本身",
      ),
    );
  }
  // 搬过来的 `:has()` 内层由 rewritePseudos 的相对分支统一做直系子翻译（此处只搬运，不重复翻译）
  prependPrefix(sel, EDITOR_PREFIX, strip.carriedHas);
  return rewritePseudos(sel, report, depth);
}

/**
 * 改写一整条选择器列表。返回 `null` 表示该规则应被整体丢弃（全部选择器都不可映射）。
 */
export function rewriteSelectorList(
  selectorList: string,
  onDiagnostic?: (d: ThemeDiagnostic) => void,
): string | null {
  const report = onDiagnostic ?? (() => {});
  let keptCount = 0;
  let output = "";
  try {
    output = selectorParser((root) => {
      const selectors = root.nodes.filter(
        (n): n is selectorParser.Selector => n.type === "selector",
      );
      for (const sel of selectors) {
        if (rewriteSelectorNode(sel, report, 0)) keptCount += 1;
        else sel.remove();
      }
    }).processSync(selectorList);
  } catch (error) {
    report(
      makeDiag(
        "dropped-selector",
        selectorList,
        `选择器解析失败（${(error as Error).message}）→ 丢弃该规则（§C2/§C7 降级）`,
      ),
    );
    return null;
  }
  if (keptCount === 0) {
    if (!output.trim()) {
      report(makeDiag("dropped-selector", selectorList, "全部选择器均不可映射 → 丢弃该规则"));
    }
    return null;
  }
  const trimmed = output.trim();
  return trimmed.length > 0 ? trimmed : null;
}

import { describe, expect, it } from "vitest";
import {
  EDITOR_PREFIX,
  rewriteSelectorList,
} from "../../src/theme/typora/selector";
import type { ThemeDiagnostic } from "../../src/theme/typora/types";

/** 便捷：收集诊断并返回改写结果 */
function rewrite(selector: string): { out: string | null; diags: ThemeDiagnostic[] } {
  const diags: ThemeDiagnostic[] = [];
  const out = rewriteSelectorList(selector, (d) => diags.push(d));
  return { out, diags };
}

/** I1（G6）：输出选择器的 class/attr/id 计数不得超过基线对应规则（基线 = 前缀 + 原选择器） */
function specificityParts(selector: string): { classes: number; attrs: number; ids: number } {
  const stripped = selector.replace(/\[[^\]]*\]/g, (m) => " ".repeat(m.length));
  const classes = (selector.match(/\[/g) ?? []).length;
  const ids = (stripped.match(/#[\w-]+/g) ?? []).length;
  const classCount = (stripped.match(/\.[\w-]+/g) ?? []).length;
  return { classes: classCount, attrs: classes, ids };
}

describe("#306 S11 选择器三分类前缀收敛（§C1/§C2）", () => {
  describe("分类 A：可加前缀（含裸标签、#write 后代、文档级类名映射）", () => {
    const cases: [string, string | null][] = [
      ["#write h1", `${EDITOR_PREFIX} h1`],
      ["#write > h1", `${EDITOR_PREFIX} > h1`],
      // 紧凑写法（`#write>h3`）归一为「前缀 + 空格 + `>`」形态，与带空格写法输出一致
      ["#write>h3:before", `${EDITOR_PREFIX} >h3:before`],
      ["#write p", `${EDITOR_PREFIX} p`],
      ["#write ol li", `${EDITOR_PREFIX} ol li`],
      ["#write table thead th", `${EDITOR_PREFIX} table thead th`],
      ["#write strong", `${EDITOR_PREFIX} strong`],
      ["table", `${EDITOR_PREFIX} table`],
      ["img", `${EDITOR_PREFIX} img`],
      ["a", `${EDITOR_PREFIX} a`],
      ["hr", `${EDITOR_PREFIX} hr`],
      ["tt", `${EDITOR_PREFIX} code`],
      [".md-fences", `${EDITOR_PREFIX} .code-block`],
      [".md-lang", `${EDITOR_PREFIX} .code-block-lang`],
      ["#write pre.md-meta-block", `${EDITOR_PREFIX} pre.frontmatter-block`],
      [".md-toc", `${EDITOR_PREFIX} .toc-block`],
      [".md-diagram-panel", `${EDITOR_PREFIX} .mermaid-block`],
      ["sup.md-footnote", `${EDITOR_PREFIX} sup.footnote-ref`],
      ["#write .md-footnote", `${EDITOR_PREFIX} .footnote-ref`],
      [".md-inline-math script", `${EDITOR_PREFIX} .math-inline script`],
      ["h1.md-focus", null],
      [".not-a-typora-class h2", `${EDITOR_PREFIX} .not-a-typora-class h2`],
      [".md-task-list-item > input", `${EDITOR_PREFIX} [data-item-type=task] > input`],
    ];
    it.each(cases)("%s → %s", (input, expected) => {
      expect(rewrite(input).out).toBe(expected);
    });
  });

  describe("分类 B：根级收敛为 2 段编辑区前缀", () => {
    const cases: [string, string][] = [
      ["#write", EDITOR_PREFIX],
      ["body", EDITOR_PREFIX],
      ["html", EDITOR_PREFIX],
      [":root", EDITOR_PREFIX],
      ["*", EDITOR_PREFIX],
      ["#write *", `${EDITOR_PREFIX} *`],
      ["html body", EDITOR_PREFIX],
      ["html body h1", `${EDITOR_PREFIX} h1`],
      ["body p", `${EDITOR_PREFIX} p`],
      [":root h1", `${EDITOR_PREFIX} h1`],
      [".typora-export h1", `${EDITOR_PREFIX} h1`],
      [".enable-diagrams pre.md-fences[lang=\"mermaid\"]", `${EDITOR_PREFIX} pre.code-block[lang="mermaid"]`],
      ["html.typora-export h1", `${EDITOR_PREFIX} h1`],
    ];
    it.each(cases)("%s → %s", (input, expected) => {
      expect(rewrite(input).out).toBe(expected);
    });

    it("根级收敛必须留下诊断（矩阵登记来源）", () => {
      const { diags } = rewrite("body");
      expect(diags.map((d) => d.kind)).toContain("scoped-root");
    });

    it("根级复合条件（body.custom）丢弃附加条件并登记", () => {
      const { out, diags } = rewrite("body.custom h1");
      expect(out).toBe(`${EDITOR_PREFIX} h1`);
      expect(diags.some((d) => d.kind === "scoped-root" && d.reason.includes(".custom"))).toBe(true);
    });
  });

  describe("分类 C：丢弃（CM5/CM 类、Typora 窗口级 UI、原生嵌套）", () => {
    const dropped: string[] = [
      ".cm-s-inner",
      ".CodeMirror",
      ".md-fences .CodeMirror",
      "#write .CodeMirror-code > *",
      ".on-focus-mode .CodeMirror.cm-s-inner:not(.CodeMirror-focused) *",
      "#typora-sidebar",
      ".mac-seamless-mode #typora-sidebar",
      "#top-titlebar",
      ".megamenu-menu-panel",
      ".outline-item",
      ".btn-default",
      ".dropdown-menu>li>a:hover",
      "#write > h3.md-focus:before",
      ".task-list",
      ".anchor",
      "& h1",
      ".md-rawblock-container",
    ];
    it.each(dropped)("丢弃：%s", (input) => {
      const { out, diags } = rewrite(input);
      expect(out).toBeNull();
      expect(diags.some((d) => d.kind === "dropped-selector")).toBe(true);
    });

    it("混合列表里只丢弃不可映射项，其余保留", () => {
      const { out } = rewrite(".btn-default, #write h1, .cm-s-inner");
      expect(out).toBe(`${EDITOR_PREFIX} h1`);
    });
  });

  describe("§C2 边界：:is()/:not() 内层参数与条件规则", () => {
    it(":is() 的每个内层参数都要加前缀", () => {
      const { out } = rewrite(":is(h1, h2)");
      expect(out).toBe(
        `${EDITOR_PREFIX} :is(${EDITOR_PREFIX} h1, ${EDITOR_PREFIX} h2)`,
      );
    });

    it(":not() 内层同样加前缀，且不影响外层", () => {
      const { out } = rewrite("#write h1:not(.foo)");
      expect(out).toBe(`${EDITOR_PREFIX} h1:not(${EDITOR_PREFIX} .foo)`);
    });

    it("内层的 CM 类被丢弃时保留其它参数", () => {
      const { out } = rewrite(":is(.cm-s-inner, h1)");
      expect(out).toBe(`${EDITOR_PREFIX} :is(${EDITOR_PREFIX} h1)`);
    });
  });

  describe("I1 不变量（G6）：输出前缀恒为 2 段，且特异性不超过基线形态", () => {
    const inputs = [
      "#write",
      "body",
      "html body h1",
      "#write > h3:before",
      ".md-fences",
      "table",
      "#write table thead th",
      ":is(h1, h2)",
      "#write blockquote p:first-child",
    ];
    it.each(inputs)("%s 的输出不含 .editor / .ProseMirror 段且前缀为 2 段", (input) => {
      const { out } = rewrite(input);
      expect(out).not.toBeNull();
      expect(out!).not.toContain(".editor ");
      expect(out!).not.toContain(".ProseMirror");
      // 前缀后必须紧跟空白或组合子（`#write>h3` 这类紧凑写法会产出 `prefix>h3`）
      expect(out === EDITOR_PREFIX || /^\.editor-scroll \.milkdown[\s>+~]/.test(out!)).toBe(true);
      // 前缀只有两个 class（.editor-scroll .milkdown）
      const prefixSegments = out!.slice(0, EDITOR_PREFIX.length).split(/\s+/);
      expect(prefixSegments).toEqual([".editor-scroll", ".milkdown"]);
    });

    it("前缀深度不变量：输出的 class 计数不超过「前缀 + 原选择器」的朴素形态", () => {
      const input = "#write table thead th";
      const naive = `${EDITOR_PREFIX} ${input.replace("#write ", "")}`;
      const { out } = rewrite(input);
      const a = specificityParts(out!);
      const b = specificityParts(naive);
      expect(a.classes).toBeLessThanOrEqual(b.classes);
      expect(a.ids).toBeLessThanOrEqual(b.ids);
      expect(a.attrs).toBeLessThanOrEqual(b.attrs);
      expect(a.ids).toBe(0);
    });
  });
});

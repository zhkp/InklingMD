// 公式节点预期计数（Node 侧，#375 评审 R5-2 / R5-终审 F2）
//
// 这是**测量前提**，不能靠手写正则猜：编辑器用的是 remark-math 管线
// （`src/components/Editor/math.ts`），它把每条行内 `$...$` 解析成
// `inlineMath`、每个块级 `$$...$$` 解析成 `math`，各自挂一个 NodeView。
// 手写状态机在「闭合 $$ 与内容同行」「缩进代码块」「表格跨格」「$$meta」
// 等形态上必然与真实解析器分叉：低估会让 waitFormulaSettled 提前判完成，
// 高估会让整轮被假判 UNMEASURED。
//
// 三个解析包已在 devDependencies 显式声明（不再依赖 remark-math 的传递依赖
// 与 pnpm 提升策略）。用动态 `import()` 而不是 `require()`：这些包是 ESM-only，
// Playwright 会把测试文件转成 CJS，静态 import 会退化成 require(esm)，
// 而 require(esm) 只在 Node ≥22.12 默认可用；动态 import 在 CJS/ESM 两种
// 宿主下都稳定，且不依赖 Node 版本开关。
//
// 本文件只在 Node 侧被 open 场景与单测 import，不进浏览器（与
// tests/perf/metrics.ts 里要被 page.evaluate 序列化的函数严格分离）。

interface MathNode {
  type: string;
  children?: MathNode[];
}

type Pipeline = {
  fromMarkdown: (
    value: string,
    options: { extensions: unknown[]; mdastExtensions: unknown[] },
  ) => MathNode;
  math: () => unknown;
  mathFromMarkdown: () => unknown;
};

let pipelinePromise: Promise<Pipeline> | null = null;

function loadPipeline(): Promise<Pipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const [fromMarkdownMod, mathMod, mdastMod] = await Promise.all([
        import("mdast-util-from-markdown"),
        import("micromark-extension-math"),
        import("mdast-util-math"),
      ]);
      return {
        fromMarkdown: fromMarkdownMod.fromMarkdown as Pipeline["fromMarkdown"],
        math: mathMod.math as Pipeline["math"],
        mathFromMarkdown: mdastMod.mathFromMarkdown as Pipeline["mathFromMarkdown"],
      };
    })();
  }
  return pipelinePromise;
}

async function parseMathTree(markdown: string): Promise<MathNode> {
  const { fromMarkdown, math, mathFromMarkdown } = await loadPipeline();
  return fromMarkdown(markdown, {
    extensions: [math()],
    mdastExtensions: [mathFromMarkdown()],
  });
}

/** 按节点类型拆分的计数，供 open 场景做独立对账（防止预期值被高估） */
export async function mathNodeBreakdown(markdown: string): Promise<{
  math: number;
  inlineMath: number;
}> {
  const tree = await parseMathTree(markdown);
  let block = 0;
  let inline = 0;
  const walk = (node: MathNode): void => {
    if (node.type === "math") block += 1;
    if (node.type === "inlineMath") inline += 1;
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return { math: block, inlineMath: inline };
}

/**
 * 数出 remark-math 会为这段 markdown 生成的 `math` + `inlineMath` 节点数。
 *
 * 与生产管线共用 remark-math 的 micromark 扩展 + mdast 扩展，`singleDollarTextMath`
 * 保持缺省（true），与编辑器 `$...$` 口径一致；内置 fixture 不含 frontmatter /
 * GFM 表格里的 `$`，因此在这个范围内与编辑器实际挂载数逐一对齐（open 场景
 * measured 轮会再从页面数一遍 NodeView 做交叉校验）。
 */
export async function countExpectedMathNodes(
  markdown: string,
): Promise<number> {
  const { math: block, inlineMath: inline } =
    await mathNodeBreakdown(markdown);
  return block + inline;
}

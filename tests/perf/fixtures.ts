// 性能 Benchmark 的 fixture 生成器（issue #216）
//
// 三条硬约束：
// 1. 确定性：同 (FIXTURE_VERSION, lines, kind) 必须产出字节级一致的内容——
//    无随机数、无时间戳、无 Date。否则同一份 baseline 会对应不同内容，比较失去意义。
// 2. 版本化：只要本文件的生成规则发生变化，必须 FIXTURE_VERSION + 1；
//    baseline 记录 version + hash，任一不匹配即整份作废（见 report.mjs）。
// 3. 不落盘：内容运行时生成。50k 行档约 3MB，固化进仓库会拖慢 checkout 且极易与 baseline 失配。

import { createHash } from "node:crypto";

/** fixture 生成规则版本：改动生成逻辑时必须 +1 */
export const FIXTURE_VERSION = 1;

export type FixtureKind = "rich" | "plain";

export interface FixtureSpec {
  /** 目标行数（生成的 Markdown 行数，严格等于该值） */
  lines: number;
  /** rich = 含 9 类结构；plain = 同长度纯文本对照 */
  kind: FixtureKind;
}

const pad = (n: number): string => String(n).padStart(5, "0");

/**
 * 一个完整结构节：覆盖普通段落 / 标题 / 加粗斜体删除线 / 行内代码 / 链接 /
 * 无序+嵌套+有序列表 / 引用 / 表格 / 代码块 / 图片占位 / 行内与块级公式 / 分隔线。
 * 节内编号唯一且可解析（bench-00042 之类），供 search 场景做必然命中的关键词。
 */
function section(n: number): string[] {
  const id = pad(n);
  return [
    `## 基准章节 bench-${id}`,
    "",
    `这是第 ${n} 节的正文段落，含 **加粗**、*斜体*、~~删除线~~、\`行内代码\` 与 [链接](https://example.com/bench/${id})，用于模拟真实文档的富文本密度。`,
    "",
    `- 无序列表项 A bench-${id}`,
    `  - 嵌套列表项 B bench-${id}`,
    `1. 有序列表项 C bench-${id}`,
    "",
    `> 引用块 bench-${id}：用于测量块级容器的渲染与滚动开销。`,
    "",
    "| 列一 | 列二 | 列三 |",
    "| --- | --- | --- |",
    `| bench-${id} | 数值 ${n} | 说明 |`,
    "",
    "```ts",
    `const bench${id} = ${n};`,
    "```",
    "",
    `![图片占位](assets/bench-${id}.png)`,
    "",
    `行内公式 $E = mc^2$ 与块级公式：`,
    "$$",
    `\\int_0^1 x^2 dx = ${n}`,
    "$$",
    "",
    "---",
    "",
  ];
}

/** 纯文本对照：同行数、同量级字符，但不含任何 Markdown 结构标记 */
function buildPlain(lines: number): string {
  const out: string[] = [];
  let n = 1;
  while (out.length + 2 <= lines) {
    out.push(
      `第 ${pad(n)} 段纯文本内容，用于对照文档长度与结构复杂度对渲染与滚动的影响，不含任何 Markdown 结构标记。`,
      "",
    );
    n += 1;
  }
  if (out.length < lines) out.push(`尾部纯文本段落 ${pad(n)}`);
  return out.join("\n");
}

/**
 * 生成指定行数与类型的 fixture。
 *
 * 行数控制策略：整节铺满（不在节中间截断，避免切出不闭合的代码围栏/公式块
 * 导致解析行为失真），剩余不足一节的行数用普通段落补齐，保证最终行数严格等于 lines。
 */
export function buildFixture(spec: FixtureSpec): string {
  const { lines, kind } = spec;
  if (lines <= 0) return "";
  if (kind === "plain") return buildPlain(lines);

  const sectionLines = section(1).length;
  const out: string[] = [];
  let n = 1;
  while (out.length + sectionLines <= lines) {
    out.push(...section(n));
    n += 1;
  }
  let remaining = lines - out.length;
  while (remaining > 0) {
    if (remaining === 1) {
      out.push(`尾部段落 bench-${pad(n)}`);
      remaining -= 1;
    } else {
      out.push(`尾部段落 bench-${pad(n)}`, "");
      remaining -= 2;
      n += 1;
    }
  }
  return out.join("\n");
}

/** 内容指纹：用于 baseline 失效判定（取 sha256 前 12 位） */
export function fixtureHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

/** 实际行数（与生成入参校验用） */
export function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length;
}

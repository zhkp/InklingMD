// 性能 Benchmark 的 fixture 生成器（issue #216）
//
// 三条硬约束：
// 1. 确定性：同 (FIXTURE_VERSION, lines, kind) 必须产出字节级一致的内容——
//    无随机数、无时间戳、无 Date。否则同一份 baseline 会对应不同内容，比较失去意义。
// 2. 版本化：只要本文件的生成规则发生变化，必须 FIXTURE_VERSION + 1；
//    baseline 记录 version + hash，任一不匹配即整份作废（见 report.mjs）。
// 3. 不落盘：内容运行时生成。50k 行档约 3MB，固化进仓库会拖慢 checkout 且极易与 baseline 失配。

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

/**
 * fixture 生成规则版本：改动生成逻辑时必须 +1。
 * v2（评审 P1-2 修复）：新增 mermaid 代码块、图片改为真实可解码的 data URI。
 */
export const FIXTURE_VERSION = 2;

export type FixtureKind = "rich" | "plain";

export interface FixtureSpec {
  /** 目标行数（生成的 Markdown 行数，严格等于该值） */
  lines: number;
  /** rich = 含结构元素；plain = 同长度纯文本对照 */
  kind: FixtureKind;
}

const pad = (n: number): string => String(n).padStart(5, "0");

/** 每 N 节插入一个 mermaid 块：本项目最重的渲染元素，缺失就测不出真实压测负载 */
const MERMAID_EVERY = 10;
/** 每 N 节插入一张图片：控制体积（每张 data URI 约 1.6KB） */
const IMAGE_EVERY = 5;

/**
 * 生成一张真实可解码的 PNG 的 data URI。
 *
 * 为什么不用 `assets/bench-x.png` 相对路径（v1 的做法）：mock 环境下该路径必然 404，
 * 图片解码与图片布局根本没进入测量——评审 P1-2 指出这是"假覆盖"。
 * 为什么不内联一段 base64 字面量：256x192 的 PNG 有 1.6KB base64，
 * 写死在源码里既难维护也看不出是什么；用 zlib 现场编码，可复现且自解释。
 */
function buildImageDataUri(): string {
  const width = 256;
  const height = 192;

  const crcTable = ((): Int32Array => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c;
    }
    return table;
  })();

  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([length, typeAndData, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB

  // 每行 = 1 字节 filter(0) + width 个 RGB 三元组
  // 刻意用纯色：逐像素渐变会让 deflate 压不动（实测单张 data URI 长达 10 万字符，
  // 7 张就把 fixture 撑到 750KB）；纯色可压到几百字节，而"解码 + 布局"这一开销仍然真实存在。
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3;
      raw[p] = 60;
      raw[p + 1] = 120;
      raw[p + 2] = 200;
    }
  }

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const IMAGE_DATA_URI = buildImageDataUri();

/** 一个 mermaid 代码块（沿用项目现有懒渲染路径，#204 治过它的滚动冻结） */
function mermaidBlock(n: number): string[] {
  const id = pad(n);
  return [
    "```mermaid",
    "flowchart TD",
    `    A[进入 bench-${id}] --> B{是否需要重算}`,
    "    B -->|是| C[重建布局与缓存]",
    "    B -->|否| D[直接返回]",
    "    C --> D",
    "```",
  ];
}

/**
 * 一个完整结构节：覆盖普通段落 / 标题 / 加粗斜体删除线 / 行内代码 / 链接 /
 * 无序+嵌套+有序列表 / 引用 / 表格 / 代码块 / 图片 / 行内与块级公式 / 分隔线，
 * 并按固定间隔插入 mermaid 块与真实图片。
 * 节内编号唯一且可解析（bench-00042 之类），供 search 场景做必然命中的关键词。
 * 注意：有间隔插入的元素，故各节行数不等长（见 buildFixture 的逐节判断）。
 */
function section(n: number): string[] {
  const id = pad(n);
  const lines: string[] = [
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
  ];

  if (n % IMAGE_EVERY === 0) {
    lines.push(`![图片 bench-${id}](${IMAGE_DATA_URI})`, "");
  }

  if (n % MERMAID_EVERY === 0) {
    lines.push(...mermaidBlock(n), "");
  }

  lines.push(
    "行内公式 $E = mc^2$ 与块级公式：",
    "$$",
    `\\int_0^1 x^2 dx = ${n}`,
    "$$",
    "",
    "---",
    "",
  );

  return lines;
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
 * 由于 mermaid / 图片按间隔插入，各节行数不等长，因此逐节判断「加下一节是否超行数」。
 */
export function buildFixture(spec: FixtureSpec): string {
  const { lines, kind } = spec;
  if (lines <= 0) return "";
  if (kind === "plain") return buildPlain(lines);

  const out: string[] = [];
  let n = 1;
  for (;;) {
    const next = section(n);
    if (out.length + next.length > lines) break;
    out.push(...next);
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

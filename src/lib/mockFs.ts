import type { FileNode, RemoteImage } from "./fs";

/** mock 文件树（浏览器开发用） */
export const MOCK_TREE: FileNode = {
  name: "mock-workspace",
  path: "/mock-workspace",
  is_dir: true,
  children: [
    {
      name: "notes",
      path: "/mock-workspace/notes",
      is_dir: true,
      children: [
        {
          name: "readme.md",
          path: "/mock-workspace/notes/readme.md",
          is_dir: false,
          children: [],
        },
        {
          name: "todo.md",
          path: "/mock-workspace/notes/todo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "html-demo.md",
          path: "/mock-workspace/notes/html-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "footnote-demo.md",
          path: "/mock-workspace/notes/footnote-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "outline-demo.md",
          path: "/mock-workspace/notes/outline-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "frontmatter-demo.md",
          path: "/mock-workspace/notes/frontmatter-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "math-demo.md",
          path: "/mock-workspace/notes/math-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "callout-demo.md",
          path: "/mock-workspace/notes/callout-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "toc-demo.md",
          path: "/mock-workspace/notes/toc-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "link-demo.md",
          path: "/mock-workspace/notes/link-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "link-anchor-demo.md",
          path: "/mock-workspace/notes/link-anchor-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "attachment.txt",
          path: "/mock-workspace/notes/attachment.txt",
          is_dir: false,
          children: [],
        },
        {
          name: "link-html-demo.md",
          path: "/mock-workspace/notes/link-html-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "link-file-demo.md",
          path: "/mock-workspace/notes/link-file-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "link-relative.md",
          path: "/mock-workspace/notes/link-relative.md",
          is_dir: false,
          children: [],
        },
        {
          name: "my note.md",
          path: "/mock-workspace/notes/my note.md",
          is_dir: false,
          children: [],
        },
        {
          name: "toc-long.md",
          path: "/mock-workspace/notes/toc-long.md",
          is_dir: false,
          children: [],
        },
        {
          name: "export-demo.md",
          path: "/mock-workspace/notes/export-demo.md",
          is_dir: false,
          children: [],
        },
        {
          name: "export-missing.md",
          path: "/mock-workspace/notes/export-missing.md",
          is_dir: false,
          children: [],
        },
        {
          name: "export-mermaid-bad.md",
          path: "/mock-workspace/notes/export-mermaid-bad.md",
          is_dir: false,
          children: [],
        },
      ],
    },
    {
      name: "intro.md",
      path: "/mock-workspace/intro.md",
      is_dir: false,
      children: [],
    },
  ],
};

/**
 * 锚点 E2E 用的填充正文（#299）。
 *
 * 目的：把标题组推到首屏之外。否则目标标题初始就可见，"点击后是否滚动"无从观测，
 * `scrollTop` 增量恒为 0，断言会退化成恒真——这正是 #299 要消灭的形态。
 */
const LINK_ANCHOR_FILLER = Array.from(
  { length: 30 },
  (_, i) => `填充段落 ${String(i + 1).padStart(2, "0")}：用于把标题组推到首屏之外。`,
).join("\n\n");

/**
 * 锚点 fixture（#299 / #297 共用）。约束：
 * - 链接**全部是纯 `#frag`**：`workspace-file` 形态与自链接住在 `link-relative.md`（#296），
 *   因为该形态的执行臂要到 #296 才落地，本文件若带上会让 #299/#297 批次出现必然失败的用例；
 * - 目标标题包含四类 slug 形态：中文同文本、含标点、重复标题、带小数点；
 * - 编码锚点的空格必须写成 `%20`（CommonMark 的行内链接 destination 不允许裸空格）。
 */
const LINK_ANCHOR_DEMO = `# 链接锚点示例

锚点链接（全部为纯 #frag）：

- [中文同文本](#理解问题与方法)
- [含标点标题](#hello-world)
- [重复含标点标题-1](#hello-world-1)
- [重复含标点标题 GitHub 原形](#Hello,%20World!-1)
- [重复中文标题](#重复标题)
- [重复中文标题-1](#重复标题-1)
- [重复中文标题 Milkdown 真实 id 形](#重复标题-#2)
- [版本号标题](#v20-release)
- [编码锚点](#%E7%90%86%E8%A7%A3%E9%97%AE%E9%A2%98%E4%B8%8E%E6%96%B9%E6%B3%95)
- [不存在的锚点](#不存在的锚点)

${LINK_ANCHOR_FILLER}

## 理解问题与方法

目标一：中文同文本锚点。

## Hello, World!

第一处含标点标题。

## 重复标题

第一处重复标题。

## 重复标题

第二处重复标题。

## Hello, World!

第二处含标点标题。

## v2.0 release

版本号标题（slug 为 v20-release）。
`;

/**
 * 导航守卫 fixture（#298）。
 *
 * href 覆盖三类导航风险（绝对 URL / 同源根路径 / 锚点）以及 #360 的窄口径相对值：
 * - `https://example.com`：裸点击若不被阻断会真的把 WebView 导航走；
 * - `/readme.md`：导航到同源路径（SPA 会整页重载）；
 * - `#重复标题-1`：即使没有同 id 元素，浏览器也会改 `location.hash`；
 * - `readme.md` / `nope-html.md`：自 #360 起 render 模式仅对 `<a href>` 保留相对值，
 *   由 `link-relative-path.spec.ts` 的 R11–R13 覆盖（打开 / 裸点击不导航 / 目标不存在）；
 *   `src` / `xlink:href` 的相对值仍会被丢弃。
 *
 * 外层用 `<div>` 让整段成为 HTML 块，确保走 html-view 的 contenteditable=false 子树。
 *
 * `href=""` 是设计 §3 末行「DOM href 与 mark href 都为空 → 绝不回落到当前 URL」的固定装置：
 * 空串能通过 `isSafeUrl`，`<a href="">` 的默认行为是整页重载，因此在 contenteditable=false
 * 子树里**可被变异打红**（与 link mark 的 file:// 不同，后者被 Chromium 抑制激活）。
 */
const LINK_HTML_DEMO = `# HTML 链接示例

HTML 块内的链接（渲染为真实 a 标签）：

<div class="html-link-demo">
  <a href="https://example.com">HTML 外链</a>
  <a href="/readme.md">HTML 根路径链接</a>
  <a href="#重复标题-1">HTML 锚点链接</a>
  <a href="">HTML 空链接</a>
  <a href="readme.md">HTML 相对链接</a>
  <a href="nope-html.md">HTML 相对链接-不存在</a>
</div>

## 重复标题

第一处重复标题。

## 重复标题

第二处重复标题。
`;

/**
 * 被上游 `sanitizeLinkHref` 抹掉 DOM href 的形态（#298 / F5）。
 *
 * `file:` 不在 SAFE_PROTOCOLS 里，渲染出的 `<a>` 的 href 是空串，但 link mark 的
 * `attrs.href` 保留 `file:///…`；点击处理必须回落到 mark 才能给出「不支持 file://」提示。
 * 这也是唯一能在浏览器端验证该回落的固定装置。
 */
const LINK_FILE_DEMO = `# 本地文件链接示例

本地文件：[本地文件](file:///C:/tmp/inkling-demo.md)
`;

/**
 * 相对路径 → 工作区打开（#296）的固定装置。
 *
 * 链接覆盖：同目录、上一级、带锚点、自链接、不存在、非 md、越界、百分号编码空格。
 * 目标标题必须落在首屏之外（复用 `LINK_ANCHOR_FILLER`），否则「自链接是否滚动」无法观测。
 * **不要**写成绝对路径：本文件的目的是验证相对路径归算与 openFile 通路。
 */
const LINK_RELATIVE_DEMO = `# 相对路径链接示例

- [同目录](readme.md)
- [上级](../intro.md)
- [带锚点](link-anchor-demo.md#hello-world)
- [自链接（相对+锚点）](link-relative.md#相对小节)
- [不存在](nope.md)
- [非 md](attachment.txt)
- [越界](../../outside.md)
- [空格](my%20note.md)

${LINK_ANCHOR_FILLER}

## 相对小节

自链接目标段落。
`;

/** 百分号编码空格的目标文件（#296） */
const MY_NOTE = `# 带空格文件名

通过 %20 解码后打开。`;

/**
 * TOC 跳转的固定装置（#358）。
 *
 * `toc-demo.md` 只有 3 个标题、目标都在首屏，`scrollTop` 恒为 0，无法验证「点击目录项
 * 是否真的跳转」。本文件用 `LINK_ANCHOR_FILLER` 把目标标题推到首屏之外，并把 `[TOC]`
 * 放在填充正文之前，保证目录项与目标标题不在同一屏。
 */
const TOC_LONG_DEMO = `# 长目录示例

[TOC]

${LINK_ANCHOR_FILLER}

## 第一节

第一节内容。

## 目标标题

目标段落内容。
`;

/**
 * 导出可移植性 / 导出快照夹具（#372 + #373）。
 *
 * 覆盖真实文档里会让导出走偏的每一种形态：
 * - **本地图片**（相对路径 PNG/JPG/SVG）→ 桌面端会被 `resolveImageSrc` 改写成 asset 运行时地址，
 *   导出必须换成可移植形式（#372）；另留一张远程图作「保持原语义」的对照。
 * - **带语言的长代码块**（200 行）→ CodeMirror 只渲染视口内的行，克隆 DOM 会静默截断，
 *   导出必须以文档为准重建完整源码（#373）。
 * - **首屏外的代码块与 Mermaid** → 懒挂载（IntersectionObserver）+ 空闲预渲染都还没跑，
 *   DOM 里只有占位/空壳，导出必须主动补齐或可见降级（#373）。
 *
 * `EXPORT_FILLER` 把后半段推到首屏之外；不要缩减它，否则「非首屏」这个前提不成立，
 * 相关断言会退化成恒真。
 */
const EXPORT_FILLER = Array.from(
  { length: 40 },
  (_, i) => `填充段落 ${String(i + 1).padStart(2, "0")}：用于把后续块推到首屏之外。`,
).join("\n\n");

/** 长代码块：行数必须远超 CodeMirror 视口渲染量，否则截断无从观测 */
const EXPORT_LONG_CODE = Array.from(
  { length: 200 },
  (_, i) => `const line${String(i + 1).padStart(3, "0")} = ${i + 1};`,
).join("\n");

const EXPORT_DEMO = `---
title: 导出夹具
tags: [export, portable]
---

# 导出可移植性夹具

正文带 **加粗**、*斜体*、\`行内代码\` 与 [外链](https://example.com)。

## 本地图片

![绿色方块](assets/green.png)

![红色方块](assets/red.jpg)

![矢量图形](assets/shape.svg)

![远程图片](https://example.com/remote.png)

## 首屏 Mermaid

\`\`\`mermaid
flowchart LR
  A[开始] --> B[结束]
\`\`\`

## 带语言的长代码块

\`\`\`typescript
${EXPORT_LONG_CODE}
\`\`\`

${EXPORT_FILLER}

## 非首屏代码块（懒挂载未触发）

\`\`\`python
print("below the fold")
\`\`\`

## 非首屏 Mermaid（视口外）

\`\`\`mermaid
sequenceDiagram
  客户端->>服务端: 请求
  服务端-->>客户端: 响应
\`\`\`
`;

/**
 * 降级夹具：一张读得到的本地图 + 一张读不到的本地图。
 * 用来钉「不静默缺图」——导出必须给出可见告知，而不是产出一份看起来正常、
 * 实际少一张图的文件（#372 验收项）。
 */
const EXPORT_MISSING = `# 缺失资源降级夹具

![存在的图片](assets/green.png)

![缺失的图片](assets/gone.png)
`;

/**
 * Mermaid 失败兜底夹具：源码无法解析。
 * 编辑器侧渲染失败、导出侧补渲染同样失败——产物必须带完整源码兜底，
 * 而不是一块空白（#373 验收项）。
 */
const EXPORT_MERMAID_BAD = `# Mermaid 失败兜底

\`\`\`mermaid
this is not a mermaid diagram
\`\`\`
`;

export const MOCK_FILE_CONTENT: Record<string, string> = {
  "/mock-workspace/notes/readme.md":
    "# Readme\n\n这是浏览器 mock 环境的示例文件。\n\n- 桌面端会调用真实文件系统\n- 浏览器端用此 mock 验证 UI\n",
  "/mock-workspace/notes/todo.md":
    "# Todo\n\n- [x] 任务1\n- [ ] 任务2\n- [ ] 任务3\n",
  "/mock-workspace/intro.md":
    "# InklingMD 简介\n\n一个所见即所得的 Markdown 编辑器。\n",
  "/mock-workspace/notes/html-demo.md":
    "# HTML 嵌入示例\n\n行内标签：<kbd>Ctrl</kbd> + <kbd>S</kbd> 保存，<span style=\"color:red\">红色文字</span>，<mark>高亮</mark>。\n\n块级嵌入：\n\n<details><summary>点击展开</summary>这里是折叠内容。</details>\n\n<blockquote style=\"border-left:3px solid #0969da\">自定义引用样式</blockquote>\n",
  "/mock-workspace/notes/footnote-demo.md":
    "# 脚注示例\n\nMarkdown 是一种轻量级标记语言[^1]，由 John Gruber 创建[^gruber]。\n\n它通过简单的纯文本语法实现富文本排版[^2]。\n\n[^1]: 轻量级指解析快、易读写。\n\n[^2]: 富文本排版包括标题、列表、表格、公式等。\n\n[^gruber]: John Gruber，Daring Fireball 博客作者，2004 年发布 Markdown。\n",
  "/mock-workspace/notes/outline-demo.md":
    "# 一级标题\n\n正文段落。\n\n## 二级标题\n\n二级正文。\n\n### 三级标题\n\n三级正文。\n",
  "/mock-workspace/notes/frontmatter-demo.md":
    "---\ntitle: 测试文档\ntags: [e2e, frontmatter]\n---\n\n# Front Matter 示例\n\n正文内容。\n",
  "/mock-workspace/notes/math-demo.md":
    "# 数学公式示例\n\n行内公式：$E = mc^2$。\n\n块级公式：\n\n$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n",
  "/mock-workspace/notes/callout-demo.md":
    "# Callout 示例\n\n> [!NOTE]\n> 这是一个提示框\n\n> [!WARNING]\n> 这是一个警告\n\n> [!TIP]\n> 这是一个技巧\n",
  "/mock-workspace/notes/toc-demo.md":
    "# TOC 示例\n\n[TOC]\n\n## 二级标题 A\n\n内容 A。\n\n## 二级标题 B\n\n内容 B。\n",
  "/mock-workspace/notes/link-demo.md":
    "# 链接示例\n\n外部链接：[Example](https://example.com)\n\n锚点链接：[跳转标题](#锚点目标)\n\n## 锚点目标\n\n目标段落内容。\n",
  "/mock-workspace/notes/link-anchor-demo.md": LINK_ANCHOR_DEMO,
  "/mock-workspace/notes/link-html-demo.md": LINK_HTML_DEMO,
  "/mock-workspace/notes/link-file-demo.md": LINK_FILE_DEMO,
  "/mock-workspace/notes/link-relative.md": LINK_RELATIVE_DEMO,
  "/mock-workspace/notes/my note.md": MY_NOTE,
  "/mock-workspace/notes/toc-long.md": TOC_LONG_DEMO,
  "/mock-workspace/notes/export-demo.md": EXPORT_DEMO,
  "/mock-workspace/notes/export-missing.md": EXPORT_MISSING,
  "/mock-workspace/notes/export-mermaid-bad.md": EXPORT_MERMAID_BAD,
};

/** mock 磁盘身份（与 Rust `FileStat` 同形状：微秒 mtime + 字节数） */
export interface MockFileStat {
  mtimeUs: number;
  size: number;
}

/**
 * mock 文件磁盘身份表（#362 mock 保真）。
 *
 * 目的：`fileStat` / `readDocument` / `fileMtime` 必须有**稳定的真实 stat**，
 * 否则「两次读取之间文件没变」与「文件被外部改写」在浏览器里无法区分，
 * 成对读取与基线比对会退化成恒真断言。
 *
 * 同步点（与 Rust 侧读写一一对应）：writeTextFile / createFile / renamePath / deletePath。
 */
export const MOCK_FILE_STAT: Record<string, MockFileStat> = {};

/** mock 时钟起点（2024-01-01T00:00:00Z）：不依赖真实时间，用例可复现 */
const MOCK_EPOCH_US = Date.UTC(2024, 0, 1) * 1000;
let mockClockUs = MOCK_EPOCH_US;

/** 单调递增的 mock mtime（每次写 +1ms） */
function nextMockMtimeUs(): number {
  mockClockUs += 1_000;
  return mockClockUs;
}

/** 与 Rust 侧 `meta.len()` 同口径：UTF-8 字节数，不是 UTF-16 字符数 */
export function mockUtf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** 写入/覆盖后刷新 stat */
export function touchMockStat(path: string, content: string): void {
  MOCK_FILE_STAT[path] = { mtimeUs: nextMockMtimeUs(), size: mockUtf8Length(content) };
}

/** 重命名/移动：stat 随内容迁移（目录按前缀一并迁移） */
export function rebaseMockStat(from: string, to: string): void {
  for (const key of Object.keys(MOCK_FILE_STAT)) {
    if (key === from || key.startsWith(from + "/")) {
      MOCK_FILE_STAT[to + key.slice(from.length)] = MOCK_FILE_STAT[key];
      delete MOCK_FILE_STAT[key];
    }
  }
}

/** 删除：连同子路径一起移除（目录递归删除同语义） */
export function dropMockStat(path: string): void {
  for (const key of Object.keys(MOCK_FILE_STAT)) {
    if (key === path || key.startsWith(path + "/")) delete MOCK_FILE_STAT[key];
  }
}

// 初始 fixture 的 stat：内容表建立即登记，保证「刚打开就已存在基线」
for (const [path, content] of Object.entries(MOCK_FILE_CONTENT)) {
  touchMockStat(path, content);
}

/** 递归查找路径对应的节点（返回引用，可就地修改） */
export function findNode(root: FileNode, path: string): FileNode | null {
  if (root.path === path) return root;
  for (const child of root.children) {
    const found = findNode(child, path);
    if (found) return found;
  }
  return null;
}

/** 查找路径所属的父节点及其在 children 中的索引 */
export function findParent(
  root: FileNode,
  path: string,
): { parent: FileNode; index: number } | null {
  for (const child of root.children) {
    if (child.path === path) return { parent: root, index: root.children.indexOf(child) };
    const found = findParent(child, path);
    if (found) return found;
  }
  return null;
}

/** 递归更新节点及其子项的 path 前缀（重命名/移动后路径变化） */
export function rebasePath(node: FileNode, oldPrefix: string, newPrefix: string): void {
  node.path = newPrefix + node.path.slice(oldPrefix.length);
  for (const child of node.children) rebasePath(child, oldPrefix, newPrefix);
}

/** 从路径拆出父路径与文件名（POSIX 风格，与 joinPath/dirname 配套） */
export function splitPath(p: string): { dir: string; base: string } {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return { dir: "", base: p };
  return { dir: p.slice(0, idx), base: p.slice(idx + 1) };
}

/**
 * 递归收集 mock 目录树下的 Markdown 文件路径（浏览器端的索引数据源，#228）
 *
 * 与 Rust 侧保持同一契约：只收 `.md` / `.markdown`（大小写不敏感）、按路径升序。
 * 真实环境额外的默认黑名单与 `.gitignore` 过滤在 Rust 侧完成；mock 树中不存在
 * 这两类目录，因此**不重复实现一份过滤逻辑**（避免出现第二份真值源）。
 * 从 `MOCK_TREE` 派生而非另建一份列表，保证 mock 与文件树始终一致。
 */
export function collectMockMarkdownFiles(root: string): string[] {
  const node = findNode(MOCK_TREE, root);
  if (!node || !node.is_dir) return [];
  const out: string[] = [];
  const walk = (current: FileNode): void => {
    for (const child of current.children) {
      if (child.is_dir) walk(child);
      else if (/\.(md|markdown)$/i.test(child.name)) out.push(child.path);
    }
  };
  walk(node);
  return out.sort();
}

/** mock 二进制文件表（浏览器无真实 fs；图片粘贴落盘记录在这里） */
export const MOCK_BINARY_FILES = new Map<string, Uint8Array>();

async function sha256HexOf(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 与 Rust find_asset_by_hash 同语义：只看目录的直接子文件，先比大小再比哈希 */
export async function findMockBinaryByHash(
  dirPath: string,
  size: number,
  sha256: string,
): Promise<string | null> {
  const prefix = dirPath.replace(/\/+$/, "") + "/";
  const names = [...MOCK_BINARY_FILES.keys()]
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"))
    .sort();
  for (const path of names) {
    const data = MOCK_BINARY_FILES.get(path)!;
    if (data.byteLength !== size) continue;
    if ((await sha256HexOf(data)) === sha256.toLowerCase()) return path.slice(prefix.length);
  }
  return null;
}

/**
 * 浏览器 mock 的远程图片下载：用 fetch（no-referrer）模拟 Rust 端的判定逻辑，
 * 让 E2E 可以通过 page.route 构造成功 / 403 / 非图片等响应。
 */
export async function mockDownloadRemoteImage(url: string): Promise<RemoteImage> {
  const { RemoteImageError } = await import("./fs");
  if (!/^https?:\/\//i.test(url)) throw new RemoteImageError("bad-url", `不支持的地址: ${url}`);
  let resp: Response;
  try {
    resp = await fetch(url, { referrerPolicy: "no-referrer", credentials: "omit" });
  } catch (e) {
    throw new RemoteImageError("network", String(e));
  }
  if (resp.status === 403) throw new RemoteImageError("forbidden", "HTTP 403");
  if (!resp.ok) throw new RemoteImageError("http-status", `HTTP ${resp.status}`);
  const type = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("svg")) throw new RemoteImageError("svg", type);
  if (!type.startsWith("image/")) throw new RemoteImageError("not-image", type);
  return { data: new Uint8Array(await resp.arrayBuffer()), mime: type.split(";")[0].trim() };
}

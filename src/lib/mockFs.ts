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
          name: "attachment.txt",
          path: "/mock-workspace/notes/attachment.txt",
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
};

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

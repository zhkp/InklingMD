// Smart Paste 真实来源 fixture：输入 HTML → 期望 Markdown 快照 + 往返保真（#219 验收）
//
// 5 类来源（#219 验收标准逐项对应）：
//   github-readme   GitHub 渲染后的 README（标题锚点、徽章、任务列表、highlight-source 代码块）
//   tech-blog       技术博客（整页结构、导航/页脚/脚本、带语言与不带语言的 <pre>）
//   word-export     Word 导出 HTML（mso 样式、条件注释、MsoListParagraph 列表、表格）
//   table-page      带表格页面（对齐、合并单元格降级、tfoot、caption、布局表格）
//   remote-images   含远程图片页面（http/https/svg/data/相对路径/危险地址）
//
// 快照：tests/fixtures/smart-paste/<name>.md（首次运行生成，之后逐字比对；有意修改转换
// 规则时用 `vitest -u` 更新并在 review 中审阅 diff）。
//
// 往返保真：期望 Markdown → 真实 Milkdown parser → markdown-publisher 同款 serializer →
// 再 parse，两次解析的节点结构必须等价，且二次序列化幂等（反复保存不改写文件）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sanitizeHTML } from "../../src/components/Editor/html-view";
import { htmlToMarkdown } from "../../src/components/Editor/html-to-markdown";
import { smartPastePlugin } from "../../src/components/Editor/smart-paste";
import {
  countNodes,
  createHarness,
  findNode,
  structure,
  type Harness,
} from "../fixtures/smartPasteHarness";

const FIXTURE_DIR = resolve(__dirname, "../fixtures/smart-paste");
const FIXTURES = ["github-readme", "tech-blog", "word-export", "table-page", "remote-images"] as const;
type FixtureName = (typeof FIXTURES)[number];

function loadHtml(name: FixtureName): string {
  return readFileSync(resolve(FIXTURE_DIR, `${name}.html`), "utf8");
}

function convert(name: FixtureName): string {
  return htmlToMarkdown(sanitizeHTML(loadHtml(name), { mode: "paste" }));
}

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 30_000);

afterAll(async () => {
  await h.destroy();
});

describe("fixture 快照：输入 HTML → 期望 Markdown", () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      await expect(convert(name)).toMatchFileSnapshot(resolve(FIXTURE_DIR, `${name}.md`));
    });
  }
});

describe("fixture 往返保真：parse → serialize → re-parse 结构等价", () => {
  for (const name of FIXTURES) {
    it(name, () => {
      const doc = h.parse(convert(name));
      const md2 = h.serialize(doc);
      const doc2 = h.parse(md2);
      expect(structure(doc2)).toEqual(structure(doc));
      expect(doc2.textContent).toBe(doc.textContent);
      expect(h.serialize(doc2)).toBe(md2);
    });
  }
});

describe("fixture 语义断言（快照之外的关键结构）", () => {
  it("github-readme：标题/徽章链接/任务列表/shell 代码块/表格/相对链接", () => {
    const doc = h.parse(convert("github-readme"));
    expect(findNode(doc, "heading")?.attrs.level).toBe(1);
    expect(findNode(doc, "heading")?.textContent).toBe("InklingMD");
    expect(findNode(doc, "code_block")?.attrs.language).toBe("shell");
    expect(findNode(doc, "code_block")?.textContent).toBe("pnpm install\npnpm tauri dev");
    expect(countNodes(doc, "table")).toBe(1);
    const checked: unknown[] = [];
    doc.descendants((n) => {
      if (n.type.name === "list_item" && n.attrs.checked != null) checked.push(n.attrs.checked);
      return true;
    });
    expect(checked).toEqual([true, false]);
    const hrefs: string[] = [];
    doc.descendants((n) => {
      for (const m of n.marks) if (m.type.name === "link") hrefs.push(m.attrs.href);
      return true;
    });
    // 相对链接保留原样
    expect(hrefs).toContain("docs/math.md");
    expect(hrefs).toContain("/zhkp/InklingMD/blob/main/CONTRIBUTING.md");
    // 复制按钮、SVG 图标不进入文档
    expect(doc.textContent).not.toMatch(/Copy|Copied/);
  });

  it("tech-blog：正文结构完整，导航/页脚/脚本/按钮/iframe 不进入文档", () => {
    const md = convert("tech-blog");
    const doc = h.parse(md);
    expect(findNode(doc, "code_block")?.attrs.language).toBe("typescript");
    expect(countNodes(doc, "code_block")).toBe(2);
    expect(countNodes(doc, "blockquote")).toBe(1);
    expect(countNodes(doc, "hr")).toBe(1);
    expect(countNodes(doc, "ordered_list")).toBe(2);
    for (const junk of ["dataLayer", "pageview", "分享", "评论区", "font-family", "trackPage"]) {
      expect(md).not.toContain(junk);
    }
  });

  it("word-export：标题、粗斜体、列表、表格保留，mso 噪音与条件注释不进入文档", () => {
    const md = convert("word-export");
    const doc = h.parse(md);
    expect(countNodes(doc, "heading")).toBe(3);
    expect(countNodes(doc, "bullet_list")).toBe(1);
    expect(countNodes(doc, "table")).toBe(1);
    expect(md).toContain("**下一年度**");
    expect(md).toContain("*重点工作*");
    for (const junk of ["mso", "MsoNormal", "Symbol", "宋体", "<o:p", "o:p>", "supportLists", "·"]) {
      expect(md).not.toContain(junk);
    }
  });

  it("table-page：数据表转 GFM 表格，布局表格按块展开", () => {
    const doc = h.parse(convert("table-page"));
    expect(countNodes(doc, "table")).toBe(1);
    // 表头 1 行 + 数据 4 行 + tfoot 1 行
    expect(countNodes(doc, "table_row") + countNodes(doc, "table_header_row")).toBe(6);
    expect(findNode(doc, "bullet_list")).toBeTruthy();
    expect(doc.textContent).toContain("数据来源：MDN。");
  });

  it("remote-images：远程图片保留地址，危险地址被拦截，无 src 的图片丢弃", () => {
    const doc = h.parse(convert("remote-images"));
    const srcs: string[] = [];
    doc.descendants((n) => {
      if (n.type.name === "image") srcs.push(n.attrs.src);
      return true;
    });
    expect(srcs).toEqual([
      "https://cdn.example.com/shots/main.png",
      "http://img.example.org/legacy/photo.jpg",
      "https://cdn.example.com/icons/logo.svg",
      expect.stringMatching(/^data:image\/png;base64,/),
      "images/local.png",
      "https://cdn.example.com/shots/main-thumb.png",
    ]);
    expect(srcs.join()).not.toMatch(/javascript|text\/html|lazy/);
  });
});

describe("真实粘贴链路：fixture 经 Smart Paste 插件粘贴后与期望 Markdown 解析结果一致", () => {
  for (const name of FIXTURES) {
    it(name, async () => {
      const editor = await createHarness({
        plugins: (parse) => [smartPastePlugin({ parseMarkdown: parse })],
      });
      try {
        expect(editor.paste({ "text/html": loadHtml(name), "text/plain": "fallback" })).toBe(true);
        const expected = h.parse(convert(name));
        expect(structure(editor.view.state.doc)).toEqual(structure(expected));
        // 往返：markdown-publisher 同款 serializer 输出再 parse，结构不变
        const reparsed = editor.parse(editor.markdown());
        expect(structure(reparsed)).toEqual(structure(editor.view.state.doc));
      } finally {
        await editor.destroy();
      }
    });
  }
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportOutline, copyMarkdown, waitForImages } from "../../src/lib/exporter";
import { extractMarkdownOutline } from "../../src/lib/outline";
import { useWorkspace } from "../../src/store/workspace";
import { ISSUE_382_OUTLINE_MARKDOWN } from "../fixtures/issue382Outline";

describe("exporter lib unit tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  /** 拦截 downloadBlob 的产物，返回 exportOutline 实际写出的 Blob */
  function captureOutlineDownload() {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:mock-url";
    });
    (
      globalThis as unknown as { URL: { createObjectURL: unknown; revokeObjectURL: unknown } }
    ).URL.createObjectURL = createObjectURL;
    (
      globalThis as unknown as { URL: { createObjectURL: unknown; revokeObjectURL: unknown } }
    ).URL.revokeObjectURL = vi.fn();

    let clicked = false;
    let downloadedFileName = "";
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === "a") {
        el.click = () => {
          clicked = true;
          downloadedFileName = (el as HTMLAnchorElement).download;
        };
      }
      return el;
    });

    return {
      blobs,
      createObjectURL,
      clicked: () => clicked,
      fileName: () => downloadedFileName,
    };
  }

  it("copyMarkdown should write content to clipboard", async () => {
    useWorkspace.setState({ currentContent: "# Test Content\n\nHello World" });
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: writeTextSpy,
      },
      configurable: true,
      writable: true,
    });

    const success = await copyMarkdown();
    expect(success).toBe(true);
    expect(writeTextSpy).toHaveBeenCalledWith("# Test Content\n\nHello World");
  });

  it("waitForImages：已完结但加载失败的图片不拖满超时", async () => {
    const img = document.createElement("img");
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 0 });
    const root = { querySelectorAll: () => [img] } as unknown as ParentNode;
    vi.useFakeTimers();
    try {
      let settled = false;
      void waitForImages(root, 3000).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(settled, "complete 的坏图应立即结算，而不是等满 3s").toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exportOutline should parse outline structure and trigger download in browser", async () => {
    const md = `${ISSUE_382_OUTLINE_MARKDOWN}\n# foo_bar_baz`;
    useWorkspace.setState({
      currentContent: md,
      currentFile: "/notes/sample.md",
    });

    const download = captureOutlineDownload();

    await exportOutline();

    expect(download.clicked()).toBe(true);
    expect(download.fileName()).toBe("sample-outline.md");
    expect(download.createObjectURL).toHaveBeenCalled();
    expect(download.blobs).toHaveLength(1);

    const exportedMarkdown = await download.blobs[0].text();
    expect(exportedMarkdown).toContain("\n- foo_bar_baz\n");
    expect(exportedMarkdown).toContain("\n# foo_bar_baz");
    const sidebarHeadings = extractMarkdownOutline(md);
    const expectedMarkdown = [
      "# sample 目录",
      "",
      ...sidebarHeadings.map(
        (heading) => `${"  ".repeat(heading.level - 1)}- ${heading.text}`,
      ),
      "",
      "---",
      "",
      "## 原始标题结构",
      "",
      ...sidebarHeadings.map(
        (heading) => `${"#".repeat(heading.level)} ${heading.text}`,
      ),
    ].join("\n");
    expect(exportedMarkdown).toBe(expectedMarkdown);
  });

  it("exportOutline 不改写标题里的字面 * / ~~ 与行内代码字符", async () => {
    useWorkspace.setState({
      currentContent: [
        "# 2 * 3 * 4 = 24",
        "## A ~~ x ~~ B",
        "### 使用 `a*` 和 `b*` 通配",
        "#### 5*3*2",
        "##### **bold *italic***",
        "###### ~a~~",
      ].join("\n"),
      currentFile: "/notes/literal.md",
    });

    const download = captureOutlineDownload();
    await exportOutline();

    expect(download.blobs).toHaveLength(1);
    // 期望值直接按渲染口径写成字面量，不从解析函数推导，避免实现与断言同源漂移
    const exportedMarkdown = await download.blobs[0].text();
    expect(exportedMarkdown).toBe(
      [
        "# literal 目录",
        "",
        "- 2 * 3 * 4 = 24",
        "  - A ~~ x ~~ B",
        "    - 使用 a* 和 b* 通配",
        "      - 532",
        "        - bold italic",
        "          - ~a~~",
        "",
        "---",
        "",
        "## 原始标题结构",
        "",
        "# 2 * 3 * 4 = 24",
        "## A ~~ x ~~ B",
        "### 使用 a* 和 b* 通配",
        "#### 532",
        "##### bold italic",
        "###### ~a~~",
      ].join("\n"),
    );
  });

  it("exportOutline 的链接目标含成对括号时只留可见文本", async () => {
    useWorkspace.setState({
      currentContent: "# [guide](https://example.com/path_(part))",
      currentFile: "/notes/link.md",
    });

    const download = captureOutlineDownload();
    await exportOutline();

    expect(download.blobs).toHaveLength(1);
    // 关键点：不能出现 `guide)`（未处理成对括号时会把内层 `)` 之后的内容留在文本里）
    expect(await download.blobs[0].text()).toBe(
      [
        "# link 目录",
        "",
        "- guide",
        "",
        "---",
        "",
        "## 原始标题结构",
        "",
        "# guide",
      ].join("\n"),
    );
  });

  it("exportOutline 按全文链接定义表解析引用式链接", async () => {
    useWorkspace.setState({
      currentContent: [
        "# [ref text][ref]",
        "## [shortcut]",
        "### [undefined-ref][nope]",
        "",
        "[ref]: https://example.com/ref",
        "[shortcut]: https://example.com/shortcut",
      ].join("\n"),
      currentFile: "/notes/ref.md",
    });

    const download = captureOutlineDownload();
    await exportOutline();

    expect(download.blobs).toHaveLength(1);
    // 不能出现 `[ref text][ref]` / `[shortcut]`；未定义的引用按字面量保留
    expect(await download.blobs[0].text()).toBe(
      [
        "# ref 目录",
        "",
        "- ref text",
        "  - shortcut",
        "    - [undefined-ref][nope]",
        "",
        "---",
        "",
        "## 原始标题结构",
        "",
        "# ref text",
        "## shortcut",
        "### [undefined-ref][nope]",
      ].join("\n"),
    );
  });
});

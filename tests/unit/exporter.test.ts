import { describe, it, expect, vi, beforeEach } from "vitest";
import { exportOutline, copyMarkdown, waitForImages } from "../../src/lib/exporter";
import { useWorkspace } from "../../src/store/workspace";

describe("exporter lib unit tests", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

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
    const md = "# Title 1\n\nText\n\n## Subtitle 1.1\n\n### Sub 1.1.1\n\n# Title 2";
    useWorkspace.setState({
      currentContent: md,
      currentFile: "/notes/sample.md",
    });

    // Mock URL.createObjectURL and click
    const createObjectURLMock = vi.fn().mockReturnValue("blob:mock-url");
    const revokeObjectURLMock = vi.fn();
    (globalThis as unknown as { URL: { createObjectURL: unknown; revokeObjectURL: unknown } }).URL.createObjectURL = createObjectURLMock;
    (globalThis as unknown as { URL: { createObjectURL: unknown; revokeObjectURL: unknown } }).URL.revokeObjectURL = revokeObjectURLMock;

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

    await exportOutline();

    expect(clicked).toBe(true);
    expect(downloadedFileName).toBe("sample-outline.md");
    expect(createObjectURLMock).toHaveBeenCalled();
  });
});

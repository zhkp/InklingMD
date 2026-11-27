// 图片上传的「目标文档仍是同一份」护栏（#431 评审）
//
// 编辑器实例跨 tab 复用（#426）后，上传/落盘期间文档可能被换掉：
// - 切 tab：路径变化 → 旧代码已覆盖；
// - **外部重载**（`reloadFile`）：路径不变、只把 `revision` +1，旧代码只比路径
//   会放行，于是 pending 的图片被插进重载后的新内容里，落点还是旧偏移。
import { beforeEach, describe, expect, it } from "vitest";
import {
  revisionOf,
  stillSameDocument,
} from "../../src/components/Editor/image-upload";
import { useWorkspace } from "../../src/store/workspace";

const DOC = "/workspace/note.md";

function seedTabs(path: string, revision = 0): void {
  useWorkspace.setState({
    openTabs: [
      {
        path,
        content: "# doc",
        dirty: false,
        diskContent: "# doc",
        revision,
      },
    ] as never,
  });
}

beforeEach(() => {
  seedTabs(DOC, 0);
});

describe("stillSameDocument", () => {
  it("路径与 revision 都没变 → 允许插入", () => {
    expect(
      stillSameDocument({
        view: { isDestroyed: false },
        documentPath: DOC,
        revision: revisionOf(DOC),
        getDocumentPath: () => DOC,
      }),
    ).toBe(true);
  });

  it("同路径被外部重载（revision +1）→ 必须放弃，不能插进新内容", () => {
    const captured = revisionOf(DOC);
    seedTabs(DOC, captured + 1); // 模拟 reloadFile
    expect(
      stillSameDocument({
        view: { isDestroyed: false },
        documentPath: DOC,
        revision: captured,
        getDocumentPath: () => DOC,
      }),
    ).toBe(false);
  });

  it("切到别的 tab（路径变化）→ 必须放弃", () => {
    expect(
      stillSameDocument({
        view: { isDestroyed: false },
        documentPath: DOC,
        revision: revisionOf(DOC),
        getDocumentPath: () => "/workspace/other.md",
      }),
    ).toBe(false);
  });

  it("编辑器已销毁 → 必须放弃", () => {
    expect(
      stillSameDocument({
        view: { isDestroyed: true },
        documentPath: DOC,
        revision: revisionOf(DOC),
        getDocumentPath: () => DOC,
      }),
    ).toBe(false);
  });

  it("不在 openTabs 的路径（未保存草稿）revision 视为 0，不会误判", () => {
    expect(revisionOf("/workspace/untitled-1")).toBe(0);
  });

  it("接线：insertImages 捕获调用时的 revision 并交给护栏", async () => {
    // 只读源码断言：`stillSameDoc` 必须由 captured revision 驱动，
    // 否则「reload 后仍放行」的缺陷会悄悄回来。
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/components/Editor/image-upload.ts", "utf8");
    expect(src).toContain("const documentRevision = revisionOf(documentPath);");
    expect(src).toMatch(/stillSameDocument\(\{[\s\S]*?revision: documentRevision/);
  });
});

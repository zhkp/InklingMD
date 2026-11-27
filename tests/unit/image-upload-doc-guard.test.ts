// 图片上传的「目标文档仍是同一份」护栏（#431 评审）
//
// 编辑器实例跨 tab 复用（#426）后，上传/落盘期间文档可能被换掉。身份不能按路径判：
// - 切 tab：当前路径对应另一个 docId → 拒绝；
// - 外部重载（`reloadFile`）：同一路径、docId 不变，但 `revision` +1 → 拒绝；
// - 草稿另存为：路径从 untitled-N 换成真实路径，docId 不变、revision 不变
//   → 必须放行，否则已 preventDefault 的粘贴会被静默丢弃。
import { beforeEach, describe, expect, it } from "vitest";
import {
  documentIdentityOf,
} from "../../src/components/Editor/document-identity";
import { stillSameDocument } from "../../src/components/Editor/image-upload";
import { useWorkspace } from "../../src/store/workspace";

const DOC = "/workspace/note.md";
const OTHER = "/workspace/other.md";

interface SeedTab {
  path: string;
  docId: string;
  revision?: number;
}

function seedTabs(...tabs: SeedTab[]): void {
  useWorkspace.setState({
    openTabs: tabs.map((t) => ({
      path: t.path,
      docId: t.docId,
      content: "# doc",
      dirty: false,
      revision: t.revision ?? 0,
    })) as never,
  });
}

function sameDoc(args: {
  identityDocId: string;
  revision: number;
  documentPath: string;
  currentPath: string;
  destroyed?: boolean;
}): boolean {
  return stillSameDocument({
    view: { isDestroyed: args.destroyed ?? false },
    identity: { docId: args.identityDocId, revision: args.revision },
    documentPath: args.documentPath,
    getDocumentPath: () => args.currentPath,
  });
}

beforeEach(() => {
  seedTabs({ path: DOC, docId: "doc-note" }, { path: OTHER, docId: "doc-other" });
});

describe("stillSameDocument（docId + revision）", () => {
  it("路径与 revision 都没变 → 允许插入", () => {
    expect(
      sameDoc({
        identityDocId: "doc-note",
        revision: 0,
        documentPath: DOC,
        currentPath: DOC,
      }),
    ).toBe(true);
  });

  it("同路径被外部重载（revision +1）→ 必须放弃，不能插进新内容", () => {
    const captured = documentIdentityOf(DOC)!;
    seedTabs({ path: DOC, docId: captured.docId, revision: captured.revision + 1 });
    expect(
      sameDoc({
        identityDocId: captured.docId,
        revision: captured.revision,
        documentPath: DOC,
        currentPath: DOC,
      }),
    ).toBe(false);
  });

  it("切到别的 tab（不同 docId）→ 必须放弃", () => {
    expect(
      sameDoc({
        identityDocId: "doc-note",
        revision: 0,
        documentPath: DOC,
        currentPath: OTHER,
      }),
    ).toBe(false);
  });

  it("草稿另存为（路径变化、docId 不变）→ 必须放行，粘贴不能被丢弃", () => {
    // 另存为：同一 tab 对象 spread 后换 path，docId/revision 保留
    seedTabs({ path: DOC, docId: "doc-untitled", revision: 0 });
    expect(
      sameDoc({
        identityDocId: "doc-untitled",
        revision: 0,
        documentPath: "untitled-1",
        currentPath: DOC,
      }),
    ).toBe(true);
  });

  it("另存为的 store/渲染窗口：view 还指着旧路径，也能按 docId 找回同一份文档", () => {
    // store 已把 tab 迁到新路径，但 React 尚未把新 filePath 写进 view 的 getter
    seedTabs({ path: DOC, docId: "doc-untitled", revision: 0 });
    expect(
      sameDoc({
        identityDocId: "doc-untitled",
        revision: 0,
        documentPath: "untitled-1",
        currentPath: "untitled-1",
      }),
    ).toBe(true);
    // 同一 docId 若已被重载（revision +1），窗口内同样必须拒绝
    seedTabs({ path: DOC, docId: "doc-untitled", revision: 1 });
    expect(
      sameDoc({
        identityDocId: "doc-untitled",
        revision: 0,
        documentPath: "untitled-1",
        currentPath: "untitled-1",
      }),
    ).toBe(false);
  });

  it("同路径被关闭后重开（新 docId）→ 必须放弃", () => {
    seedTabs({ path: DOC, docId: "doc-reopened" });
    expect(
      sameDoc({
        identityDocId: "doc-note",
        revision: 0,
        documentPath: DOC,
        currentPath: DOC,
      }),
    ).toBe(false);
  });

  it("文档 tab 被关闭（当前路径查无身份）→ 必须放弃", () => {
    seedTabs({ path: OTHER, docId: "doc-other" });
    expect(
      sameDoc({
        identityDocId: "doc-note",
        revision: 0,
        documentPath: DOC,
        currentPath: DOC,
      }),
    ).toBe(false);
  });

  it("编辑器已销毁 → 必须放弃", () => {
    expect(
      sameDoc({
        identityDocId: "doc-note",
        revision: 0,
        documentPath: DOC,
        currentPath: DOC,
        destroyed: true,
      }),
    ).toBe(false);
  });

  it("未登记路径（空路径降级）没有身份可比，退回路径判等", () => {
    expect(documentIdentityOf("")).toBeNull();
    expect(
      stillSameDocument({
        view: { isDestroyed: false },
        identity: null,
        documentPath: "",
        getDocumentPath: () => "",
      }),
    ).toBe(true);
    expect(
      stillSameDocument({
        view: { isDestroyed: false },
        identity: null,
        documentPath: "",
        getDocumentPath: () => DOC,
      }),
    ).toBe(false);
  });
});

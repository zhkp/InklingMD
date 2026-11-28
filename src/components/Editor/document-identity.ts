// 文档身份查询（#431 评审）
//
// 路径不能当身份：另存为/外部改名会换 path 但仍是同一份文档；同路径重载
// 会换内容（revision +1）。异步任务（图片上传/远程图片落盘）共用这份查询。

import { useWorkspace } from "../../store/workspace";

/** 文档身份 + revision：同一标签页另存为只换路径（docId 不变），外部重载 revision +1 */
export interface DocumentIdentity {
  docId: string;
  revision: number;
}

/** 读取指定路径 tab 的文档身份（tab 不存在或未登记 docId 返回 null） */
export function documentIdentityOf(path: string): DocumentIdentity | null {
  const tab = useWorkspace.getState().openTabs.find((t) => t.path === path);
  if (!tab?.docId) return null;
  return { docId: tab.docId, revision: tab.revision ?? 0 };
}

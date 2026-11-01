// workspace store 的组合类型定义
// 各 slice 接口在各自文件中声明，这里组合出完整 WorkspaceState，
// 对外（src/store/workspace.ts）保持原有的 useWorkspace / OpenTab 接口不变。

import type { FileTreeSlice } from "./fileTree";
import type { TabsSlice } from "./tabs";
import type { BookmarksSlice } from "./bookmarks";
import type { RecentsSlice } from "./recents";
import type { EolStyle } from "../../lib/eol";

/** 单个打开的标签页 */
export interface OpenTab {
  /** 文件完整路径（未命名草稿用 untitled-N 虚拟路径） */
  path: string;
  /** 文件内容 */
  content: string;
  /** 是否未保存 */
  dirty: boolean;
  /** 最近一次保存时间戳（ms），null 表示从未保存 */
  lastSavedAt: number | null;
  /** 最近从磁盘读取/写入时的原始内容（用于外部修改冲突检测） */
  diskContent?: string;
  /** 最近从磁盘读取/写入时的文件 mtime 毫秒时间戳（用于保存冲突快速路径） */
  diskMtime?: number;
  /** 编辑位置记忆：光标在文档中的偏移（null 表示未记录） */
  cursorPos: number | null;
  /** 编辑位置记忆：编辑器滚动条垂直偏移（null 表示未记录） */
  scrollTop: number | null;
  /** 未命名草稿：尚未保存到磁盘的新建文件，保存时弹另存为对话框 */
  isUntitled?: boolean;
  /** 文件在磁盘上已被外部删除或不存在 */
  deletedOnDisk?: boolean;
  /** 自动保存等后台保存检测到冲突时置为 true */
  conflictPending?: boolean;
  /** 该标签页自身的保存进行中标志（issue #148：保存互斥按 tab 生效，
   *  避免某个 tab 的另存为/冲突对话框挂起期间吞掉其他 tab 的保存） */
  saving?: boolean;
  /** 该标签页是否处于源代码模式（issue #19） */
  sourceMode?: boolean;
  /** 版本修订计数（reloadFile 强制刷新 DOM 时自增） */
  revision?: number;
  /** 磁盘文件的换行风格（读取时检测；未命名草稿 / 无换行文件为 undefined，#368） */
  eol?: EolStyle;
  /** 原文件为混合换行（保存转换时据此告警，#368） */
  eolMixed?: boolean;
}

/** 完整工作区状态：各领域 slice 的交集组合 */
export type WorkspaceState = FileTreeSlice & TabsSlice & BookmarksSlice & RecentsSlice;

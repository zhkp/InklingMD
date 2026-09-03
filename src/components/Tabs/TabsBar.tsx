// 多标签页栏
// 类似 VSCode：每个打开的文件一个 tab，点击切换、中键/×关闭。
// 关闭未保存文件时弹出确认，避免数据丢失。
// 右键弹出上下文菜单（关闭其他/关闭右侧/全部关闭/复制路径）。
// 支持拖拽重排标签页顺序。

import { useEffect, useRef, useState } from "react";
import { useWorkspace, type OpenTab } from "../../store/workspace";
import { flushAllMarkdownPublishers } from "../Editor/markdown-publisher";
import { TabContextMenu } from "./TabContextMenu";
import { IconX } from "../icons";
import { baseName } from "../../lib/path-utils";
import { askConfirmation } from "../../lib/dialogs";
import "./TabsBar.css";

/** tab 显示名：未命名草稿显示「未命名 N」，普通文件显示文件名 */
function tabLabel(tab: OpenTab): string {
  if (tab.isUntitled) {
    const m = tab.path.match(/(\d+)$/);
    return m ? `未命名 ${m[1]}` : "未命名";
  }
  return baseName(tab.path);
}

/** 取文件所在目录的各级名称（兼容 POSIX 与 Windows 路径） */
function parentSegments(path: string): string[] {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  segments.pop();
  return segments;
}

/**
 * 为同名文件生成最短可区分的目录后缀。
 * 普通标签不增加说明；直属父目录仍冲突时才逐级向上扩展。
 */
function tabPathDescriptions(tabs: OpenTab[]): Map<string, string> {
  const groups = new Map<string, OpenTab[]>();

  for (const tab of tabs) {
    if (tab.isUntitled) continue;
    const label = tabLabel(tab);
    groups.set(label, [...(groups.get(label) ?? []), tab]);
  }

  const descriptions = new Map<string, string>();
  for (const sameNameTabs of groups.values()) {
    if (sameNameTabs.length < 2) continue;

    const paths = sameNameTabs.map((tab) => ({
      tab,
      parents: parentSegments(tab.path),
    }));

    for (const current of paths) {
      for (let depth = 1; depth <= current.parents.length; depth += 1) {
        const suffix = current.parents.slice(-depth).join("/");
        const unique = paths.every((other) =>
          other === current
            || other.parents.slice(-depth).join("/") !== suffix
        );
        if (!unique) continue;

        descriptions.set(current.tab.path, `…/${suffix}`);
        break;
      }

      // 极少数路径只能靠完整父路径区分（如绝对路径与同名相对路径）。
      if (!descriptions.has(current.tab.path) && current.parents.length > 0) {
        const normalizedParent = current.tab.path
          .replace(/\\/g, "/")
          .replace(/\/+[^/]+$/, "");
        descriptions.set(current.tab.path, normalizedParent);
      }
    }
  }

  return descriptions;
}

export function TabsBar() {
  // 仅订阅 tab 的展示字段（path/dirty/isUntitled），避免 content 每次按键变化时重渲染。
  // useWorkspace 默认用 Object.is 比较，这里返回 string 快照，内容变化时快照不变。
  const tabsSig = useWorkspace((s) =>
    s.openTabs.map((t) => `${t.path}|${t.dirty ? "1" : "0"}|${t.isUntitled ? "1" : "0"}`).join("\n"),
  );
  const activeTabPath = useWorkspace((s) => s.activeTabPath);
  const switchTab = useWorkspace((s) => s.switchTab);
  const closeTab = useWorkspace((s) => s.closeTab);
  const reorderTabs = useWorkspace((s) => s.reorderTabs);
  // tabsSig 仅作为重渲染触发器；实际渲染从 store 读取最新 openTabs
  void tabsSig;
  const openTabs = useWorkspace.getState().openTabs;

  // 右键菜单状态
  const [menu, setMenu] = useState<{ tab: OpenTab; x: number; y: number } | null>(null);
  // 拖拽状态：正在拖拽的 tab path，以及拖拽悬停的目标 path
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  // 横向滚动条已隐藏，改用滚轮滚动 tab 条（垂直滚轮转横向，触控板横向滑动原生生效）
  const barRef = useRef<HTMLDivElement | null>(null);
  // issue #187：按 path 登记 tab 元素，激活变化时把目标 tab 滚入视野
  const tabElements = useRef(new Map<string, HTMLDivElement>());
  const empty = openTabs.length === 0;
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!raw) return;
      e.preventDefault();
      // deltaMode 为行/页时（Firefox 等）delta 非像素，需按行高/页宽换算，否则滚动量过小
      const scale =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 32
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? el.clientWidth
            : 1;
      el.scrollLeft += raw * scale;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [empty]);

  // issue #187：新激活的 tab 可能在横向滚动区之外（滚动条还被隐藏），
  // 用户看不到当前激活的是哪个文件。激活变化时滚入视野；
  // inline: "nearest" 保证已在视野内时不发生多余滚动
  useEffect(() => {
    if (!activeTabPath) return;
    tabElements.current
      .get(activeTabPath)
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTabPath]);

  if (openTabs.length === 0) return null;

  const pathDescriptions = tabPathDescriptions(openTabs);

  const handleClose = async (tab: OpenTab) => {
    // 先 flush 防抖窗口内的发布，关闭决策看到真实 dirty 与内容，
    // 否则窗口内关闭会静默丢弃未发布编辑（PR #34）
    flushAllMarkdownPublishers();
    const fresh =
      useWorkspace.getState().openTabs.find((t) => t.path === tab.path) ?? tab;
    if (fresh.dirty) {
      const ok = await askConfirmation(
        `「${tabLabel(fresh)}」有未保存的修改，确定关闭吗？`,
        { title: "未保存修改确认", kind: "warning" },
      );
      if (!ok) return;
    }
    closeTab(fresh.path);
  };

  return (
    <div className="tabs-bar" ref={barRef}>
      <div className="tabs-list">
        {openTabs.map((tab) => {
            const active = tab.path === activeTabPath;
            const isDragOver = dragOverPath === tab.path && dragPath !== null;
            const pathDescription = pathDescriptions.get(tab.path);
            const title = tab.deletedOnDisk
              ? `${tab.path} (已在磁盘上被删除)`
              : tab.path;
            return (
              <div
                key={tab.path}
                ref={(el) => {
                  if (el) tabElements.current.set(tab.path, el);
                  else tabElements.current.delete(tab.path);
                }}
                className={`tab${active ? " tab-active" : ""}${isDragOver ? " tab-drag-over" : ""}${pathDescription ? " tab-disambiguated" : ""}${tab.deletedOnDisk ? " tab-deleted-on-disk" : ""}`}
                title={title}
              draggable
              onDragStart={(e) => {
                setDragPath(tab.path);
                e.dataTransfer.effectAllowed = "move";
                // Firefox 需要 setData 才能触发拖拽
                e.dataTransfer.setData("text/plain", tab.path);
              }}
              onDragEnd={() => {
                setDragPath(null);
                setDragOverPath(null);
              }}
              onDragOver={(e) => {
                if (dragPath === null || dragPath === tab.path) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverPath(tab.path);
              }}
              onDragLeave={() => {
                if (dragOverPath === tab.path) setDragOverPath(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragPath && dragPath !== tab.path) {
                  reorderTabs(dragPath, tab.path);
                }
                setDragPath(null);
                setDragOverPath(null);
              }}
              onClick={() => {
                flushAllMarkdownPublishers();
                switchTab(tab.path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tab, x: e.clientX, y: e.clientY });
              }}
              onMouseDown={(e) => {
                // 中键关闭
                if (e.button === 1) {
                  e.preventDefault();
                  handleClose(tab);
                }
              }}
            >
              <span className="tab-name">{tabLabel(tab)}</span>
              {pathDescription && (
                <span className="tab-description">{pathDescription}</span>
              )}
              {tab.dirty && <span className="tab-dirty" title="未保存">●</span>}
              <button
                className="tab-close"
                title="关闭"
                onClick={(e) => {
                  e.stopPropagation();
                  handleClose(tab);
                }}
              >
                <IconX size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {menu && (
        <TabContextMenu
          tab={menu.tab}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

export default TabsBar;

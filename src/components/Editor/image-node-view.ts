// 图片节点视图
// 支持：相对路径解析、行内显示、缩放（拖拽右下角手柄）、对齐（右键菜单）。
// width / align 编码进 markdown title，格式 "width=300,align=center"，
// 保持源码为标准 markdown 语法，重开文件可恢复属性。
// commonmark image 是 inline 节点，dom 用 inline-block 的 span 包裹 img，
// 既能行内排列又能附加缩放手柄与对齐样式。

import type { NodeView } from "@milkdown/kit/prose/view";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import { $view } from "@milkdown/kit/utils";
import { imageSchema } from "@milkdown/kit/preset/commonmark";
import { resolveImageSrc } from "../../lib/fs";
import { clampMenuPosition } from "../../hooks/useContextMenuClamping";

/** 图片对齐方式 */
type ImageAlign = "left" | "center" | "right";

/** 从 title 解析 width 与 align */
function parseImageMeta(title: string | null | undefined): {
  width: number | null;
  align: ImageAlign | null;
  cleanTitle: string | null;
} {
  if (!title) return { width: null, align: null, cleanTitle: null };
  let width: number | null = null;
  let align: ImageAlign | null = null;
  // 按 ", " 或 "," 分割，识别 width=N 与 align=xxx
  const parts = title.split(/,\s*|，/);
  const others: string[] = [];
  for (const p of parts) {
    const wm = p.match(/^width\s*=\s*(\d+)$/i);
    const am = p.match(/^align\s*=\s*(left|center|right)$/i);
    if (wm) width = parseInt(wm[1], 10);
    else if (am) align = am[1].toLowerCase() as ImageAlign;
    else if (p.trim()) others.push(p.trim());
  }
  return { width, align, cleanTitle: others.length ? others.join(", ") : null };
}

/** 把 width/align 编码回 title */
function encodeImageMeta(width: number | null, align: ImageAlign | null, cleanTitle: string | null): string | null {
  const segs: string[] = [];
  if (width != null) segs.push(`width=${width}`);
  if (align) segs.push(`align=${align}`);
  if (cleanTitle) segs.push(cleanTitle);
  return segs.length ? segs.join(", ") : null;
}

/**
 * 模块级单例游标（issue #184）：同一时间只允许一份图片右键菜单打开。
 * 打开新菜单前先关闭当前持有者（可能是其他图片节点残留的菜单）。
 */
let activeMenuOwner: ImageNodeView | null = null;

export class ImageNodeView implements NodeView {
  dom: HTMLSpanElement;
  private img: HTMLImageElement;
  private handle: HTMLSpanElement;
  private node: Node;
  private view: PMView;
  private getPos: () => number | undefined;
  private documentPath: string;
  private source: string | null = null;
  private sourceGeneration = 0;
  private destroyed = false;
  private width: number | null = null;
  private align: ImageAlign | null = null;
  private cleanTitle: string | null = null;
  /** 当前打开的右键菜单（issue #184：单例持有，销毁/再次右键时清理） */
  private contextMenu: HTMLElement | null = null;
  /** 当前菜单对应的 document 级 mousedown close 监听（随菜单一起清理） */
  private contextMenuCloseListener: ((ev: MouseEvent) => void) | null = null;

  constructor(
    node: Node,
    view: PMView,
    getPos: () => number | undefined,
    documentPath: string,
  ) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.documentPath = documentPath;

    this.dom = document.createElement("span");
    this.dom.className = "milkdown-image-wrap";
    this.dom.setAttribute("data-image-wrap", "");

    this.img = document.createElement("img");
    this.img.className = "milkdown-image";
    this.img.loading = "lazy";
    // #162：远程图片不携带 Referer，避免文档 URL/打开上下文泄露给外部图床
    this.img.setAttribute("referrerpolicy", "no-referrer");
    this.dom.appendChild(this.img);

    // 缩放手柄
    this.handle = document.createElement("span");
    this.handle.className = "image-resize-handle";
    this.handle.contentEditable = "false";
    this.handle.title = "拖拽缩放";
    this.handle.addEventListener("mousedown", this.onResizeStart);
    this.dom.appendChild(this.handle);

    // 右键菜单：对齐
    this.dom.addEventListener("contextmenu", this.onContextMenu);

    this.render();
  }

  private render() {
    const src = this.node.attrs.src ?? "";
    this.renderSource(src);
    this.img.alt = this.node.attrs.alt ?? "";

    const meta = parseImageMeta(this.node.attrs.title);
    this.width = meta.width;
    this.align = meta.align;
    this.cleanTitle = meta.cleanTitle;
    if (this.cleanTitle) this.img.title = this.cleanTitle;
    else this.img.removeAttribute("title");

    // 宽度
    if (this.width != null) this.img.style.width = `${this.width}px`;
    else this.img.style.width = "";

    // 对齐：center/right 时改为 block + margin，left/默认保持 inline-block
    this.dom.classList.remove("align-center", "align-right", "align-left");
    if (this.align === "center") {
      this.dom.classList.add("align-center");
      this.dom.style.display = "block";
      this.dom.style.margin = "0 auto";
      this.dom.style.textAlign = "center";
    } else if (this.align === "right") {
      this.dom.classList.add("align-right");
      this.dom.style.display = "block";
      this.dom.style.margin = "0 0 0 auto";
    } else {
      this.dom.style.display = "inline-block";
      this.dom.style.margin = "";
      this.dom.style.textAlign = "";
      if (this.align === "left") this.dom.classList.add("align-left");
    }
  }

  /** 异步解析本地路径；generation 防止旧 Promise 覆盖较新的 src */
  private renderSource(src: string) {
    if (src === this.source) return;
    this.source = src;
    const generation = ++this.sourceGeneration;
    this.img.removeAttribute("src");
    if (!src) return;

    void resolveImageSrc(src, this.documentPath)
      .then((resolved) => {
        if (this.destroyed || generation !== this.sourceGeneration) return;
        this.img.src = resolved;
      })
      .catch((error) => {
        if (this.destroyed || generation !== this.sourceGeneration) return;
        console.error("图片路径解析失败:", src, error);
        // 保留原始地址作为降级，远程 WebView 环境仍可能自行解析成功。
        this.img.src = src;
      });
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent() {
    return true;
  }

  ignoreMutation() {
    return true;
  }

  /** 更新节点的 title 属性（编码 width/align） */
  private updateNodeAttrs(width: number | null, align: ImageAlign | null) {
    const pos = this.getPos();
    if (pos == null) return;
    const title = encodeImageMeta(width, align, this.cleanTitle);
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, undefined, {
        ...this.node.attrs,
        title,
      }),
    );
  }

  /** 拖拽缩放 */
  private onResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = this.img.offsetWidth || this.img.naturalWidth || 100;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const w = Math.max(40, Math.round(startWidth + dx));
      this.img.style.width = `${w}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      const finalWidth = Math.max(40, Math.round(this.img.offsetWidth));
      this.width = finalWidth;
      this.updateNodeAttrs(finalWidth, this.align);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  /**
   * 关闭当前打开的右键菜单（issue #184）：
   * 移除菜单 DOM、document 级 mousedown close 监听，并清理单例游标。
   * 幂等——无菜单时为空操作。
   */
  private closeContextMenu(): void {
    if (this.contextMenu) {
      if (this.contextMenu.parentNode) {
        this.contextMenu.parentNode.removeChild(this.contextMenu);
      }
      this.contextMenu = null;
    }
    if (this.contextMenuCloseListener) {
      document.removeEventListener("mousedown", this.contextMenuCloseListener);
      this.contextMenuCloseListener = null;
    }
    if (activeMenuOwner === this) activeMenuOwner = null;
  }

  /** 右键菜单：对齐与重置 */
  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 单例保护（issue #184）：同一时间只有一份菜单——
    // 先关其他图片节点残留的菜单，再关本实例已打开的菜单
    if (activeMenuOwner && activeMenuOwner !== this) {
      activeMenuOwner.closeContextMenu();
    }
    this.closeContextMenu();

    const menu = document.createElement("div");
    menu.className = "image-context-menu";

    const makeItem = (label: string, onClick: () => void) => {
      const btn = document.createElement("button");
      btn.className = "image-context-item";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        onClick();
        // 走统一清理路径（原实现只移除 DOM，document 级监听泄漏）
        this.closeContextMenu();
      });
      menu.appendChild(btn);
    };

    makeItem("左对齐", () => this.updateNodeAttrs(this.width, "left"));
    makeItem("居中", () => this.updateNodeAttrs(this.width, "center"));
    makeItem("右对齐", () => this.updateNodeAttrs(this.width, "right"));
    const sep = document.createElement("div");
    sep.className = "image-context-sep";
    menu.appendChild(sep);
    makeItem("重置大小", () => {
      this.width = null;
      this.updateNodeAttrs(null, this.align);
    });

    // 定位菜单并进行视口边界钳制
    menu.style.position = "fixed";
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    document.body.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const { x: clampedX, y: clampedY } = clampMenuPosition(
      e.clientX,
      e.clientY,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    );
    menu.style.left = `${clampedX}px`;
    menu.style.top = `${clampedY}px`;

    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as globalThis.Node)) {
        this.closeContextMenu();
      }
    };
    this.contextMenu = menu;
    this.contextMenuCloseListener = close;
    activeMenuOwner = this;
    setTimeout(() => {
      // 定时器触发前菜单可能已被清理（节点销毁/再次右键）——
      // 仅当当前菜单仍是本次创建的这份时才挂 close 监听，
      // 避免给已关闭的菜单残留 document 级监听器
      if (this.contextMenu === menu) {
        document.addEventListener("mousedown", close);
      }
    }, 0);
  };

  destroy() {
    this.destroyed = true;
    this.sourceGeneration += 1;
    // issue #184：节点销毁时一并清理打开中的菜单与 document 级监听，
    // 避免删除图片/切文件后菜单永久残留、监听器泄漏
    this.closeContextMenu();
    this.handle.removeEventListener("mousedown", this.onResizeStart);
    this.dom.removeEventListener("contextmenu", this.onContextMenu);
  }
}

/** 图片 NodeView 插件：相对路径转可加载 URL + 缩放 + 对齐 */
export const imageView = (documentPath: string) =>
  $view(imageSchema.node, () => (node, view, getPos) =>
    new ImageNodeView(node, view, getPos, documentPath),
  );

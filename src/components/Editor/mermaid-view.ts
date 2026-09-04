// Mermaid 图表渲染
// 拦截语言为 mermaid 的代码块，渲染为 SVG 图表而非 CodeMirror 高亮。
// markdown 源码保持 ```mermaid 代码块，便于迁移和版本控制。
// 由 code-block-view 在创建 CodeMirror 视图前判断 language 调用本模块渲染。
//
// 编辑入口：点击右上角「编辑」按钮或双击图表（缩放为 100% 时）→ 切换到 textarea 编辑源码；
// 失焦或 Ctrl/Cmd+Enter 提交并重新渲染，Esc 放弃修改。
//
// 下载：点击「下载」按钮导出 SVG 文件（桌面端弹保存对话框，浏览器端直接下载）。
// 缩放：鼠标悬停图表时 Ctrl/Cmd+滚轮缩放 SVG（0.5~3x），不触发文档缩放。
// 平移：缩放大于 100% 时，按住鼠标拖动平移图表查看各区域；双击重置缩放与平移。
//
// 性能（v2.3.1）：图表延迟到进入视口（含 300px 预载边距）时才渲染。
// 万行文档可含数十张图，打开即全量渲染会让主线程连续阻塞近 10 秒
// （每张 ~150ms），期间滚动/输入全部冻结；视口外仅保留占位容器。
//
// 性能（v2.3.2）：仅懒渲染会把渲染开销转移到滚动时（滚到未渲染图表
// 处逐张 ~150ms 卡顿）。新增空闲预渲染：打开文档后视口外的图表按
// 文档顺序排入队列，requestIdleCallback 空闲时段逐张后台渲染——
// 打开快、滚动也顺（通常滚到前已预渲染完），滚得快时仍即时渲染兜底。
//
// 性能（v2.3.3）：v2.3.2 打开大文档后仍有两个问题——
// 1) 窗口抖动：视口上方的图表后台渲染后变高，浏览器滚动锚定为保持
//    可见内容稳定反复补偿 scrollTop，表现为持续跳动。修复：空闲队列
//    执行时跳过整体位于视口上方的图表（交给视口路径滚到再渲染），
//    上方布局不再变化，锚定补偿随之消失。
// 2) 滚动掉帧：重复图表（同一文档粘贴多处，压测文件 60 张仅 8 种源码）
//    每张仍花 ~150ms 全量渲染，打开后 ~9s 的预渲染风暴与滚轮操作撞车。
//    修复：按源码缓存渲染结果（SVG + 实测高度），重复图表命中缓存
//    仅做 DOM 注入（~2ms）；创建时先按缓存高度预留占位高度，
//    占位 → 渲染的高度跳变接近 0，后台渲染不再引起布局位移。

import type { NodeView } from "@milkdown/kit/prose/view";
import type { Node } from "@milkdown/kit/prose/model";
import type { EditorView as PMView } from "@milkdown/kit/prose/view";
import { isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "../../lib/fs";
/**
 * 专为 Mermaid 渲染定制的 SVG 安全过滤：
 * 使用 DOMParser text/html 惰性解析以避免 innerHTML 赋值期的 script/img-onerror 活跃执行，
 * 同时天然保留 foreignObject 与 HTML 语义，
 * 移除 <script> 等危险标签及 on* 事件处理器 / javascript: 等危险协议，
 * 并通过 document.importNode 导入主文档，100% 保留 Mermaid 渲染出的原生 DOM。
 */
export function sanitizeMermaidSvg(svgHtml: string): globalThis.Node {
  const doc = new DOMParser().parseFromString(svgHtml, "text/html");
  const root = doc.querySelector("svg") || doc.body.firstElementChild;
  if (!root) {
    const span = document.createElement("span");
    return span;
  }

  // 移除危险标签：script, iframe, embed, object, form, base
  const dangerousTags = ["script", "iframe", "embed", "object", "form", "base"];
  for (const tag of dangerousTags) {
    const nodes = root.querySelectorAll(tag);
    nodes.forEach((n) => n.remove());
  }

  // 过滤属性（防御控制字符绕过及各类危险协议与 SMIL animate 注入）
  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const elem of elements) {
    const elemTag = elem.tagName.toLowerCase();
    for (const attr of Array.from(elem.attributes)) {
      const name = attr.name.toLowerCase();
      // 去除 \t, \n, \r 等浏览器在解析 URL 时会自动剥离的控制字符
      const val = attr.value.replace(/[\t\n\r]/g, "").trim().toLowerCase();
      const isSmilDangerous =
        (elemTag === "animate" || elemTag === "set") &&
        name === "attributename" &&
        (val.startsWith("on") || val === "href" || val === "xlink:href");
      if (
        name.startsWith("on") ||
        isSmilDangerous ||
        val.includes("javascript:") ||
        val.includes("vbscript:") ||
        /^data:(?!image\/)/.test(val) ||
        val.includes("expression(")
      ) {
        elem.removeAttribute(attr.name);
      }
    }
  }

  return document.importNode(root, true);
}

// issue #168：mermaid 懒加载——首次遇到图表节点才动态导入（复用
// code-block-view 语言的既有范式），~3.1MB vendor_mermaid 不再进入启动
// 加载图；Promise 缓存，后续渲染复用。缓存命中的渲染无需加载模块。
type MermaidModule = typeof import("mermaid").default;
let mermaidModulePromise: Promise<MermaidModule> | null = null;
function loadMermaid(): Promise<MermaidModule> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid").then((m) => m.default);
  }
  return mermaidModulePromise;
}

// 初始化一次 Mermaid 运行时
//
// 关键配置说明（v2.0.1 防多行节点文字底部裁切）：
// - flowchart.htmlLabels: true —— 保留 <br/> 多行换行能力
// - flowchart.padding: 20 —— 节点内边距加大（默认 15），给多行文字留呼吸空间
// - flowchart.useMaxWidth: false —— 不按容器宽度缩放回流，避免宽度变化触发高度重算偏差
// - themeVariables.fontSize —— 锁定字号，避免继承编辑器大字号导致测量与渲染不一致
// 配合 App.css 中对 .mermaid .nodeLabel 的 line-height 锁定（1.25），
// 使 mermaid 测量阶段与最终渲染阶段的文字高度一致，rect 不再偏矮、文字不再溢出底边。
export const MERMAID_CONFIG = {
  startOnLoad: false,
  theme: "default",
  securityLevel: "strict",
  flowchart: {
    htmlLabels: true,
    padding: 20,
    useMaxWidth: false,
  },
  themeVariables: {
    fontSize: "14px",
  },
} as const;

let initialized = false;
/** issue #168：加载模块并确保已初始化，返回 mermaid 实例 */
async function ensureMermaid(): Promise<MermaidModule> {
  const mermaid = await loadMermaid();
  if (!initialized) {
    mermaid.initialize(MERMAID_CONFIG);
    initialized = true;
  }
  return mermaid;
}

/**
 * 渲染结果缓存（v2.3.3）：按源码缓存 SVG 字符串与实测渲染高度。
 * 同一文档常有多处粘贴同一图表（压测文件 60 张仅 8 种源码），
 * 命中缓存时跳过 mermaid.parse/layout（每张 ~150ms），仅做 DOM 注入；
 * 缓存高度同时用于创建时预留占位高度，占位 → 渲染高度跳变接近 0。
 */
interface MermaidCacheEntry {
  svg: string;
  height: number;
}
const svgCache = new Map<string, MermaidCacheEntry>();
const SVG_CACHE_MAX = 32;
function cacheGet(src: string): MermaidCacheEntry | undefined {
  const hit = svgCache.get(src);
  if (hit) {
    // LRU 触碰：移到末尾，淘汰时从最旧端删除
    svgCache.delete(src);
    svgCache.set(src, hit);
  }
  return hit;
}
function cachePut(src: string, entry: MermaidCacheEntry): void {
  if (svgCache.has(src)) svgCache.delete(src);
  svgCache.set(src, entry);
  if (svgCache.size > SVG_CACHE_MAX) {
    const oldest = svgCache.keys().next().value;
    if (oldest !== undefined) svgCache.delete(oldest);
  }
}

/**
 * 创建时的占位高度：命中缓存用实测高度（跳变为 0），
 * 未见过的源码按行数粗估，仅为缩小首次渲染的布局位移。
 */
function estimateRenderHeight(src: string): number {
  const cached = cacheGet(src);
  if (cached) return cached.height;
  const lines = src.split("\n").length;
  return Math.min(640, Math.max(96, lines * 44 + 56));
}

/**
 * 空闲预渲染队列（v2.3.2）：视口外图表按创建（文档）顺序排队，
 * requestIdleCallback 逐张后台渲染，每张渲染 ~150ms 超出单帧预算，
 * 每个空闲槽只渲染一张，避免连续阻塞。
 */
const idleRenderQueue: Array<() => void> = [];
let idlePumpScheduled = false;
/** 最近一次滚动时间：滚动进行中暂停后台预渲染，避免与滚动争抢主线程 */
let lastScrollAt = 0;
let scrollMarkInstalled = false;
function ensureScrollMark(): void {
  if (scrollMarkInstalled) return;
  scrollMarkInstalled = true;
  document.addEventListener(
    "scroll",
    () => {
      lastScrollAt = performance.now();
    },
    { passive: true, capture: true },
  );
}
function pumpIdleRenderQueue(): void {
  if (idlePumpScheduled) return;
  idlePumpScheduled = true;
  const run = () => {
    idlePumpScheduled = false;
    const task = idleRenderQueue.shift();
    if (!task) return;
    task();
    if (idleRenderQueue.length) pumpIdleRenderQueue();
  };
  const schedule = () => {
    // 滚动停歇 250ms 后才继续预渲染，滚动中只让位给视口即时渲染
    if (performance.now() - lastScrollAt < 250 && idleRenderQueue.length) {
      setTimeout(schedule, 250);
      return;
    }
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(run);
    } else {
      setTimeout(run, 64);
    }
  };
  ensureScrollMark();
  schedule();
}

/** Mermaid 缩放范围与步进 */
const MERMAID_ZOOM_MIN = 0.5;
const MERMAID_ZOOM_MAX = 3;
const MERMAID_ZOOM_STEP = 0.1;
const MERMAID_ZOOM_DEFAULT = 1;

/**
 * 下载 Mermaid SVG 字符串为文件。
 * 桌面端走保存对话框 + writeBinary_file；浏览器端用 a 标签触发下载。
 */
async function downloadSvgFile(svg: string): Promise<void> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `mermaid-${stamp}.svg`;
  if (isTauri()) {
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "SVG", extensions: ["svg"] }],
    });
    if (!path) return;
    const buf = new Uint8Array(await blob.arrayBuffer());
    await writeBinaryFile(path, buf);
  } else {
    // 浏览器端：a 标签触发下载
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/**
 * 带有 sequence 校验的 Mermaid 异步渲染包装器（供 NodeView 及单测调用）
 */
export async function renderMermaidWithSeq(
  code: string,
  seq: number,
  getCurrentSeq: () => number,
): Promise<string | null> {
  // 缓存命中无需加载 mermaid 模块（issue #168）
  const cached = cacheGet(code)?.svg;
  if (cached) {
    if (seq !== getCurrentSeq()) return null;
    return cached;
  }
  const mermaid = await ensureMermaid();
  if (seq !== getCurrentSeq()) return null;
  try {
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await mermaid.render(id, code);
    const svg = result.svg;
    if (svg) {
      cachePut(code, { svg, height: estimateRenderHeight(code) });
    }
    if (seq !== getCurrentSeq()) return null;
    return svg ?? null;
  } catch (err) {
    console.warn("mermaid.render error:", err);
    return null;
  }
}

/**
 * 创建 Mermaid 图表 NodeView。
 * 调用方需先判断 node.attrs.language === "mermaid"。
 */
export function createMermaidView(
  node: Node,
  view: PMView,
  getPos: () => number | undefined,
): NodeView {
  // issue #168：mermaid 模块延迟到首次渲染时加载，构造仅搭建占位 DOM

  const container = document.createElement("div");
  container.className = "mermaid-block";
  container.setAttribute("data-mermaid", "");

  const diagram = document.createElement("div");
  diagram.className = "mermaid-render";
  // 创建即预留占位高度：命中缓存为精确高度，后台/滚入渲染时布局不再跳变
  diagram.style.minHeight = `${estimateRenderHeight(node.textContent)}px`;
  container.appendChild(diagram);

  // 工具栏：编辑 + 下载按钮（hover 显现）
  const toolbar = document.createElement("div");
  toolbar.className = "mermaid-toolbar";
  toolbar.contentEditable = "false";
  container.appendChild(toolbar);

  const editBtn = document.createElement("button");
  editBtn.className = "mermaid-edit-btn";
  editBtn.type = "button";
  editBtn.textContent = "编辑";
  toolbar.appendChild(editBtn);

  const downloadBtn = document.createElement("button");
  downloadBtn.className = "mermaid-download-btn";
  downloadBtn.type = "button";
  downloadBtn.textContent = "下载";
  downloadBtn.title = "下载为 SVG 文件";
  toolbar.appendChild(downloadBtn);

  // 源码编辑器（textarea，默认隐藏）
  const editor = document.createElement("textarea");
  editor.className = "mermaid-editor";
  editor.spellcheck = false;
  editor.placeholder = "输入 Mermaid 图表代码（如 graph TD; A-->B）";
  editor.style.display = "none";
  container.appendChild(editor);

  let current = node;
  let lastValue = "__init__";
  let lastSvg = ""; // 缓存最近一次成功渲染的 SVG 字符串，供下载使用
  let editing = false;
  // 是否尚未完成首次渲染：首渲染占位高度（粗估/缓存）只增不减——
  // 实测偏矮时保持占位高度，注入瞬间零布局跳变；编辑重渲染则用实测
  // 高度（源码可能改小图表，旧占位不再有效）
  let firstRender = true;
  let zoom = MERMAID_ZOOM_DEFAULT; // 当前缩放倍率
  let panX = 0; // 平移 X（像素，缩放后坐标系）
  let panY = 0; // 平移 Y

  /** 应用缩放与平移到 SVG 元素（transform 不触发布局重排，性能好） */
  const applyZoom = () => {
    const svg = diagram.querySelector("svg");
    if (!svg) return;
    svg.style.transformOrigin = "center";
    // translate 叠加在 scale 之上：先以中心缩放，再整体平移 panX/panY
    svg.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    // zoomable：可缩放（Ctrl+滚轮）；pannable：可拖动（zoom > 1）
    diagram.classList.toggle("zoomable", true);
    diagram.classList.toggle("pannable", zoom > MERMAID_ZOOM_DEFAULT);
  };

  /** 重置缩放与平移到默认值 */
  const resetZoomPan = () => {
    zoom = MERMAID_ZOOM_DEFAULT;
    panX = 0;
    panY = 0;
    applyZoom();
  };

  let renderSeq = 0;

  const render = async (value: string) => {
    if (value === lastValue) return;
    lastValue = value;
    const currentSeq = ++renderSeq;
    if (!value.trim()) {
      diagram.innerHTML = "";
      lastSvg = "";
      diagram.setAttribute("data-placeholder", "输入 Mermaid 图表代码");
      diagram.classList.remove("has-error");
      return;
    }
    try {
      const svg = await renderMermaidWithSeq(value, currentSeq, () => renderSeq);
      if (currentSeq !== renderSeq) return;
      if (!svg) {
        // 渲染失败时显示错误信息
        diagram.innerHTML = `<pre class="mermaid-error">Mermaid 语法错误，点击「编辑」修改</pre>`;
        lastSvg = "";
        diagram.removeAttribute("data-placeholder");
        diagram.classList.add("has-error");
        return;
      }
      diagram.innerHTML = "";
      // 对 Mermaid 生成的 SVG 过滤危险 script/事件属性
      diagram.appendChild(sanitizeMermaidSvg(svg));
      lastSvg = svg;
      if (firstRender) {
        resetZoomPan();
      } else {
        // 重渲染时图表尺寸可能发生变化，重置 pan 偏移量（设为 0,0）但保留用户的 zoom 缩放等级
        panX = 0;
        panY = 0;
        applyZoom();
      }
      // 实测渲染高度写回缓存并锁定本实例 min-height：
      // 同源码后续实例创建即预留精确高度，重渲染也不收缩跳变。
      // 首渲染取 max(占位, 实测)：占位偏大时保持不缩，注入零跳变
      const reserved = firstRender ? estimateRenderHeight(value) : 0;
      const height = diagram.offsetHeight;
      const hit = cacheGet(value);
      if (hit) hit.height = height;
      const appliedHeight = firstRender ? Math.max(height, reserved) : height;
      firstRender = false;
      diagram.style.minHeight = `${appliedHeight}px`;
      diagram.removeAttribute("data-placeholder");
      diagram.classList.remove("has-error");
    } catch {
      if (currentSeq !== renderSeq) return;
      // 渲染失败时显示错误信息
      diagram.innerHTML = `<pre class="mermaid-error">Mermaid 语法错误，点击「编辑」修改</pre>`;
      lastSvg = "";
      diagram.removeAttribute("data-placeholder");
      diagram.classList.add("has-error");
    }
  };

  // 视口懒渲染 + 空闲预渲染（v2.3.2）：
  // - 进入视口（含 300px 预载边距）→ 立即渲染，保证滚到即见；
  // - 视口外 → 排入空闲队列后台逐张预渲染，避免滚动到时才渲染卡顿；
  // - IntersectionObserver 不可用（如 jsdom 单测环境）时退回立即渲染。
  let firstRenderDone = false;
  const renderFirst = () => {
    if (firstRenderDone) return;
    firstRenderDone = true;
    io?.disconnect();
    io = null;
    // 用最新节点内容渲染（视口外内容变更只更新 current，不渲染）
    void render(current.textContent);
  };
  let io: IntersectionObserver | null = null;
  // happy-dom / jsdom 等测试环境中 IntersectionObserver 只是空桩或不存在，
  // 此时直接触发首渲染保证测试和无 IO 环境正常工作
  const hasWorkingIO =
    typeof IntersectionObserver !== "undefined" &&
    typeof (IntersectionObserver.prototype as any)?.observe === "function";

  if (hasWorkingIO) {
    try {
      io = new IntersectionObserver(
        (entries) => {
          if (!entries.some((e) => e.isIntersecting)) return;
          renderFirst();
        },
        { rootMargin: "300px" },
      );
      io.observe(container);
      // 尚未进入视口：排入空闲预渲染队列（按文档顺序），后台逐张渲染。
      // 已被视口路径渲染过或容器已销毁（切文档）时自动跳过。
      idleRenderQueue.push(() => {
        if (firstRenderDone || !container.isConnected || container.offsetParent === null) return;
        // v2.3.3：整体位于视口上方的图表不预渲染——上方内容渲染后变高，
        // 浏览器滚动锚定会反复补偿 scrollTop，表现为窗口持续抖动；
        // 这类图表交给视口路径（滚回到 300px 边距内）时再渲染。
        const rect = container.getBoundingClientRect();
        if (rect.bottom < 0) return;
        renderFirst();
      });
      pumpIdleRenderQueue();
    } catch {
      renderFirst();
    }
  } else {
    renderFirst();
  }

  const enterEdit = () => {
    if (editing) return;
    editing = true;
    editor.value = current.textContent;
    editor.style.display = "block";
    diagram.style.display = "none";
    editBtn.textContent = "完成";
    // 延迟聚焦以确保已可见
    requestAnimationFrame(() => editor.focus());
  };

  const exitEdit = (commit: boolean) => {
    if (!editing) return;
    editing = false;
    editor.style.display = "none";
    diagram.style.display = "";
    editBtn.textContent = "编辑";
    if (!commit) {
      // 放弃修改，按当前节点内容重新渲染
      lastValue = "__force__";
      void render(current.textContent);
      return;
    }
    const newValue = editor.value;
    if (newValue === current.textContent) {
      lastValue = "__force__";
      void render(newValue);
      return;
    }
    // 写回 code_block 节点的文本内容
    const pos = getPos();
    if (pos == null) {
      lastValue = "__force__";
      void render(newValue);
      return;
    }
    const start = pos + 1; // 节点内容起始（跳过节点本身的开标签）
    const end = pos + current.nodeSize - 1; // 节点内容结束
    const schema = view.state.schema;
    const text = newValue ? schema.text(newValue) : null;
    const tr = text
      ? view.state.tr.replaceWith(start, end, text)
      : view.state.tr.delete(start, end);
    view.dispatch(tr);
  };

  editBtn.addEventListener("mousedown", (e) => {
    // 阻止 ProseMirror 抢焦点
    e.preventDefault();
    e.stopPropagation();
  });
  editBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (editing) exitEdit(true);
    else enterEdit();
  });
  downloadBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  downloadBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!lastSvg) return;
    await downloadSvgFile(lastSvg);
  });
  container.addEventListener("dblclick", (e) => {
    // 双击图表区域：
    // - 已放大（zoom > 1）时重置缩放与平移到 100%
    // - 未放大时进入编辑模式
    e.preventDefault();
    e.stopPropagation();
    if (editing) return;
    if (zoom > MERMAID_ZOOM_DEFAULT) {
      resetZoomPan();
      return;
    }
    enterEdit();
  });
  editor.addEventListener("blur", () => exitEdit(true));
  editor.addEventListener("keydown", (e) => {
    // Ctrl/Cmd+Enter 提交
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      exitEdit(true);
      return;
    }
    // Esc 放弃修改
    if (e.key === "Escape") {
      e.preventDefault();
      exitEdit(false);
    }
  });

  // Ctrl/Cmd+滚轮缩放图表：阻止冒泡，避免触发文档缩放
  // 仅在非编辑模式响应；编辑模式让 textarea 正常滚动
  container.addEventListener("wheel", (e) => {
    if (editing) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const next = e.deltaY < 0 ? zoom + MERMAID_ZOOM_STEP : zoom - MERMAID_ZOOM_STEP;
    zoom = Math.min(MERMAID_ZOOM_MAX, Math.max(MERMAID_ZOOM_MIN, Math.round(next * 10) / 10));
    applyZoom();
  }, { passive: false });

  // 拖动平移：缩放大于 100% 时，按住鼠标拖动图表查看各区域。
  // 仅在非编辑模式响应；mousedown 阻止冒泡防止 ProseMirror 抢焦点/选中文本。
  // mousemove/mouseup 挂在 window 上，避免拖出图表区域后失效。
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  const onMouseMove = (e: MouseEvent) => {
    if (!dragging) return;
    panX = panStartX + (e.clientX - dragStartX);
    panY = panStartY + (e.clientY - dragStartY);
    applyZoom();
  };
  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    diagram.classList.remove("dragging");
  };

  diagram.addEventListener("mousedown", (e) => {
    if (editing) return;
    // 仅放大时可拖动（zoom = 1 时图表完整显示，拖动无意义）
    if (zoom <= MERMAID_ZOOM_DEFAULT) return;
    // 排除点击工具栏按钮等子元素
    if ((e.target as HTMLElement).closest(".mermaid-toolbar")) return;
    e.preventDefault();
    e.stopPropagation();
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    diagram.classList.add("dragging");
  });
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  return {
    dom: container,
    update: (next: Node) => {
      if (next.type !== current.type) return false;
      if (next.attrs.language !== "mermaid") return false;
      current = next;
      // 编辑中不覆盖编辑器内容，避免打断输入；
      // 尚未进入视口（io 未清空）时也不渲染，待可见后以最新内容首次渲染
      if (!editing && !io) void render(next.textContent);
      return true;
    },
    // 仅编辑模式下拦截事件（避免 ProseMirror 抢 textarea 焦点）；
    // 非编辑模式不拦截，使节点可被选中后用 Backspace/Delete 删除
    stopEvent: () => editing,
    ignoreMutation: () => true,
    destroy: () => {
      // 标记自增以中断未完成的异步渲染
      renderSeq++;
      // 断开视口观察，清理 window 上的拖动监听器，避免内存泄漏
      io?.disconnect();
      io = null;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    },
  };
}

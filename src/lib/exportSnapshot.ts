// #373：导出 / 富文本复制用的 DOM 快照
//
// 问题：原来直接克隆**正在编辑的** `view.dom`，只摘掉根上的三个属性，于是产物里
// 带着整套编辑态控件——代码块语言下拉、CodeMirror 行号栏与 `contenteditable`、
// Mermaid 工具栏与源码 textarea、图片缩放手柄、块拖拽手柄、未渲染的占位块。
// HTML / PDF / PNG / 剪贴板四路共用同一份 DOM，四路都不该有这些。
//
// 口径：
// - **只改克隆**，绝不动用户正在编辑的 DOM；不改文档、不改选区、不抢焦点、不滚动。
// - 清理是**结构性删除**，不是 CSS 隐藏——产物 DOM 本身必须干净。
// - 控件承载的**内容**改以 ProseMirror 文档为准重建：CodeMirror 按视口虚拟化行，
//   克隆里的 `.cm-content` 只有渲染过的那几行，长代码块会静默截断；未挂载的块只有
//   占位 `<pre>`；Mermaid 视口外根本不渲染。文档才是唯一完整来源。
// - 异步渲染（Mermaid / KaTeX）**主动补齐但有界**：超时或失败一律可见降级，
//   绝不静默导出空块，也绝不无限等待。

import type { Node } from "@milkdown/kit/prose/model";

/**
 * 单张 Mermaid 的渲染等待上限。
 * 依据：实测单张 layout ~150ms（mermaid-view 头注释），冷启动还要动态加载
 * ~3.1MB 的 vendor_mermaid（#168 懒加载）。4s 已覆盖「冷启动 + 大图」的宽上界。
 */
const MERMAID_PER_ITEM_MS = 4000;
/**
 * 一次导出的 Mermaid 渲染总预算。
 * 依据：长文档可能有几十张视口外未渲染的图表（mermaid-view 的空闲队列会跳过
 * 视口上方的图表，故导出时它们可能仍是占位）。串行渲染 15s ≈ 100 张的余量；
 * 超预算即改走源码兜底——导出必须有界。
 */
const MERMAID_TOTAL_MS = 15000;
/** KaTeX 首屏渲染的等待上限：只在确实还有占位时才轮询，等不到就降级 */
const MATH_WAIT_MS = 1500;
const MATH_POLL_MS = 50;

/** 编辑态控件：产物里结构性删除（元素本身不是文档内容） */
const CHROME_SELECTOR = [
  ".code-block-toolbar", // 代码块语言下拉
  ".code-block-cm", // CodeMirror 宿主（行号栏 / contenteditable / 光标）
  ".code-block-placeholder", // 懒挂载纯文本占位
  ".frontmatter-cm", // frontmatter 的 CodeMirror 宿主
  ".mermaid-toolbar", // Mermaid「编辑」「下载」按钮
  ".mermaid-editor", // Mermaid 源码 textarea
  ".mermaid-error", // Mermaid 编辑器内的报错提示
  ".image-resize-handle", // 图片缩放手柄
  ".image-context-menu", // 图片右键菜单
  ".math-editor", // 公式内联编辑 textarea
  ".inkling-block-handle", // 块拖拽手柄
  ".inkling-drop-indicator", // 块拖拽落点指示线
  ".ProseMirror-widget",
  ".ProseMirror-separator",
  ".ProseMirror-cursor",
].join(", ");

/** 编辑态 / 瞬时 class：元素本身是文档内容，只摘 class 不删元素 */
const CHROME_CLASSES = [
  "ProseMirror",
  "ProseMirror-focused",
  "ProseMirror-hideselection",
  "ProseMirror-selectednode",
  "search-match", // 查找高亮（瞬时 UI，不该进产物）
  "search-match-current",
  "inkling-focused", // 编辑模式的当前块高亮
];

const CHROME_CLASS_SELECTOR = CHROME_CLASSES.map((c) => `.${c}`).join(", ");

/** 需要由文档重建的 NodeView 块（其余 NodeView 的克隆已经是干净内容） */
const WIDGET_NODE_NAMES = new Set(["code_block", "frontmatter"]);

export interface ExportSnapshot {
  /** 清理完成的正文根元素（原 `view.dom` 的克隆）。资源地址仍是原样，交给 #372 处理器改写 */
  root: HTMLElement;
  /** 可读降级告知（Mermaid 超时 / 公式未渲染等）。必须让用户看见，不静默 */
  notes: string[];
}

export interface ExportSnapshotInput {
  /** 正在编辑的 ProseMirror DOM：**只读**，本模块不修改它 */
  liveRoot: HTMLElement;
  /** 文档根节点：代码块 / frontmatter 的源码以此为准 */
  doc: Node;
  /** `pos` → 该节点在 `liveRoot` 里的 DOM，等价于 `view.nodeDOM(pos)` */
  nodeDOM: (pos: number) => globalThis.Node | null;
  /**
   * 等待异步渲染（KaTeX）结束后重新取当前文档与位置映射。
   * 等待期间用户仍可编辑；若只用工位读取前捕获的值，「旧文档的位置 + 新 DOM
   * 的元素」会按错位下标重建块。生产调用方（exporter）必须提供。
   */
  getState?: () => { doc: Node; nodeDOM: (pos: number) => globalThis.Node | null };
}

export interface ExportSnapshotOptions {
  /** 单张 Mermaid 渲染上限（ms） */
  perMermaidMs?: number;
  /** 一次导出的 Mermaid 渲染总预算（ms） */
  totalMermaidMs?: number;
  /** KaTeX 占位的等待上限（ms） */
  mathWaitMs?: number;
  /**
   * Mermaid 渲染注入点：返回**可直接插入产物的已过滤 SVG 节点**，失败返回 null。
   * 默认复用 mermaid-view 的带缓存渲染 + 安全过滤（不另立一套渲染/过滤口径）。
   */
  renderMermaid?: (code: string) => Promise<globalThis.Node | null>;
}

/**
 * 生成导出用的正文快照。四路导出（HTML / PDF / PNG / 富文本复制）共用这一个入口，
 * 避免每种格式各清一遍、口径漂移。
 */
export async function buildExportSnapshot(
  input: ExportSnapshotInput,
  options: ExportSnapshotOptions = {},
): Promise<ExportSnapshot> {
  await waitMathRendered(input.liveRoot, options.mathWaitMs ?? MATH_WAIT_MS);

  // 等待是异步的：文档与位置映射在克隆前重新读，保证两棵树的节点下标同代。
  const state = input.getState?.() ?? { doc: input.doc, nodeDOM: input.nodeDOM };
  const clone = input.liveRoot.cloneNode(true) as HTMLElement;
  const notes: string[] = [];

  const mermaids: WidgetBlock[] = [];
  const { blocks, unmapped } = collectWidgetBlocks(state, input.liveRoot, clone);
  for (const block of blocks) {
    if (block.node.attrs.language === "mermaid") {
      mermaids.push(block);
      continue;
    }
    if (block.node.type.name === "frontmatter") rebuildFrontmatter(block.el, block.node);
    else rebuildCodeBlock(block.el, block.node);
  }
  if (unmapped > 0) {
    // 定位不到的块会在 stripChrome 里连 CM 宿主一起被删掉——那等于静默丢内容。
    // 宁可少一块也要说出来（#373 的核心口径就是「不静默」）。
    notes.push(`有 ${unmapped} 个代码块 / 属性区无法在导出产物中定位，其内容可能缺失`);
  }
  notes.push(...(await rebuildMermaidBlocks(mermaids, options)));
  notes.push(...rebuildUnrenderedMath(clone));

  stripChrome(clone);
  return { root: clone, notes };
}

interface WidgetBlock {
  node: Node;
  el: HTMLElement;
}

/**
 * 收集需要按文档重建的块，并把每个文档节点对应到**克隆树**上的元素。
 *
 * 用「子节点下标路径」定位，而不是按 class 配对：NodeView 的 DOM 与文档节点一一对应，
 * 但 DOM 上没有任何位置标记，按 class 顺序配对会在「用户的原始 HTML 块里恰好也写了
 * 同名 class」时整体错位。`cloneNode(true)` 保持子节点顺序与数量，故下标路径在两棵
 * 树上恒等。
 */
function collectWidgetBlocks(
  state: { doc: Node; nodeDOM: (pos: number) => globalThis.Node | null },
  liveRoot: HTMLElement,
  clone: HTMLElement,
): { blocks: WidgetBlock[]; unmapped: number } {
  const blocks: WidgetBlock[] = [];
  let unmapped = 0;
  state.doc.descendants((node, pos) => {
    if (!WIDGET_NODE_NAMES.has(node.type.name)) return;
    const el = cloneElementAt(liveRoot, clone, state.nodeDOM(pos));
    if (el) blocks.push({ node, el });
    else unmapped += 1;
  });
  return { blocks, unmapped };
}

function cloneElementAt(
  liveRoot: HTMLElement,
  clone: HTMLElement,
  live: globalThis.Node | null,
): HTMLElement | null {
  if (!live || live.nodeType !== 1) return null;
  const path: number[] = [];
  let cur: Element | null = live as Element;
  while (cur !== liveRoot) {
    const parent: Element | null = cur.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  let el: Element | null = clone;
  for (const i of path) el = el ? el.children[i] ?? null : null;
  return el as HTMLElement | null;
}

/**
 * 代码块 → 完整的 `<pre><code class="language-x">`。
 *
 * 源码取自 ProseMirror 文档而非克隆 DOM：CodeMirror 按视口**虚拟化行**，
 * `.cm-content` 里只有渲染过的那几行，长代码块直接克隆会静默截断；
 * 未挂载的块则只有占位 `<pre>`。语言取自 `node.attrs.language`（下拉框只是它的镜像）。
 *
 * 代价：不再带 CodeMirror 的语法高亮着色。原来那种「视口内有色、视口外整段丢失」
 * 是更严重的缺陷，且高亮依赖 CM 运行时注入的未分层样式，产物里本就不可靠。
 */
function rebuildCodeBlock(el: HTMLElement, node: Node): void {
  const pre = buildCodePre(node.textContent, languageToken(node.attrs.language));
  const host = el.querySelector(".code-block-cm");
  if (host) host.replaceWith(pre);
  else el.appendChild(pre);
}

/** frontmatter → 保留标签，把内嵌 CodeMirror 换成完整 YAML 的 `<pre>` */
function rebuildFrontmatter(el: HTMLElement, node: Node): void {
  const host = el.querySelector(".frontmatter-cm");
  if (!host) return;
  const value = typeof node.attrs.value === "string" ? node.attrs.value : "";
  host.replaceWith(buildCodePre(value, ""));
}

function buildCodePre(text: string, language: string): HTMLPreElement {
  const pre = document.createElement("pre");
  pre.className = "code-block-export";
  const code = document.createElement("code");
  if (language) code.className = `language-${language}`;
  code.textContent = text;
  pre.appendChild(code);
  return pre;
}

/** 语言标记 → class 名：围栏 info 可能是 `js title=x`，只取首 token 并剔除非法字符 */
function languageToken(language: unknown): string {
  const raw = typeof language === "string" ? language.trim() : "";
  return (raw.split(/\s+/)[0] ?? "").replace(/[^A-Za-z0-9+#._-]/g, "");
}

/**
 * Mermaid：已渲染的直接复用克隆里的 SVG（与用户在编辑器里看到的一致，且零渲染成本），
 * 未渲染的按文档源码**主动渲染**，限时；超时或失败导出完整源码兜底。
 *
 * 串行而非并行：mermaid 渲染会在 body 下挂临时容器，且单张 ~150ms 已占满帧预算，
 * 并行只会让主线程连续阻塞（mermaid-view v2.3.2 的空闲队列同理）。
 */
async function rebuildMermaidBlocks(
  blocks: WidgetBlock[],
  options: ExportSnapshotOptions,
): Promise<string[]> {
  const notes: string[] = [];
  const pending = blocks.filter(({ el, node }) => !reuseRenderedMermaid(el, node.textContent));
  if (pending.length === 0) return notes;

  const per = options.perMermaidMs ?? MERMAID_PER_ITEM_MS;
  const total = options.totalMermaidMs ?? MERMAID_TOTAL_MS;
  const deadline = Date.now() + total;
  const render = options.renderMermaid ?? defaultRenderMermaid;

  for (const { el, node } of pending) {
    const diagram = mermaidDiagramHost(el);
    const code = node.textContent;
    if (!code.trim()) {
      // 空图表：编辑器里显示「输入 Mermaid 图表代码」占位，产物里没有编辑入口，
      // 换成中性说明，不留一块空白
      diagram.textContent = "（空的 Mermaid 图表）";
      continue;
    }
    const svg = await renderWithin(render, code, per, deadline);
    if (svg) {
      diagram.appendChild(svg);
      continue;
    }
    const pre = document.createElement("pre");
    pre.className = "mermaid-export-fallback";
    pre.textContent = code;
    diagram.appendChild(pre);
    notes.push("Mermaid 图表未能在限定时间内渲染，已改为导出图表源码");
  }
  return notes;
}

/**
 * 复用编辑器里已渲染好的图表：只摘掉**编辑态**痕迹——Ctrl+滚轮缩放写的
 * `transform`、创建时预留的占位 `min-height`、空图占位属性与错误态 class。
 * 返回 false 表示这块还没渲染（或渲染失败/过期），需要走主动渲染：
 * - 处于编辑态时图表被 `display:none` 隐藏，克隆里留着就是一块看不见的图；
 * - `data-source` 记录这份 SVG 对应的源码，源码刚改、重渲染尚未完成时必须重渲染。
 */
function reuseRenderedMermaid(el: HTMLElement, source: string): boolean {
  const diagram = el.querySelector<HTMLElement>(".mermaid-render");
  if (!diagram || diagram.classList.contains("has-error")) return false;
  const svg = diagram.querySelector("svg");
  if (!svg) return false;
  if (diagram.style.display === "none") return false;
  const rendered = diagram.dataset.source;
  if (rendered !== undefined && rendered !== source) return false;
  svg.style.removeProperty("transform");
  svg.style.removeProperty("transform-origin");
  diagram.style.removeProperty("min-height");
  diagram.removeAttribute("data-placeholder");
  diagram.removeAttribute("data-source");
  diagram.classList.remove("zoomable", "pannable", "dragging");
  return true;
}

function mermaidDiagramHost(el: HTMLElement): HTMLElement {
  const existing = el.querySelector<HTMLElement>(".mermaid-render");
  if (existing) {
    clearChildren(existing);
    existing.removeAttribute("style");
    existing.removeAttribute("data-placeholder");
    existing.removeAttribute("data-source");
    existing.classList.remove("has-error", "zoomable", "pannable", "dragging");
    return existing;
  }
  const created = document.createElement("div");
  created.className = "mermaid-render";
  el.prepend(created);
  return created;
}

/**
 * 默认渲染器：复用 mermaid-view 已导出的带缓存渲染与安全过滤，不另立口径。
 * `seq` 传恒等值（`0 === 0`）：导出是一次性快照，不存在「被后续渲染取代」的过期语义；
 * 缓存命中时它连 mermaid 模块都不加载（#168）。
 */
async function defaultRenderMermaid(code: string): Promise<globalThis.Node | null> {
  const { renderMermaidWithSeq, sanitizeMermaidSvg } = await import(
    "../components/Editor/mermaid-view"
  );
  const svg = await renderMermaidWithSeq(code, 0, () => 0);
  return svg ? sanitizeMermaidSvg(svg) : null;
}

/** 限时渲染：单张上限与总预算取小者；超时返回 null 交由调用方降级 */
async function renderWithin(
  render: (code: string) => Promise<globalThis.Node | null>,
  code: string,
  perItemMs: number,
  deadline: number,
): Promise<globalThis.Node | null> {
  const budget = Math.min(perItemMs, deadline - Date.now());
  if (budget <= 0) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      render(code).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), budget);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 克隆前等 KaTeX 渲染完（有界）。
 * 公式 NodeView 构造即异步渲染、无视口懒加载，只有 katex chunk **首次加载**那几百毫秒
 * 里会留下 `.math-placeholder`。没有占位时本函数一次查询即返回，不引入任何等待。
 */
async function waitMathRendered(liveRoot: HTMLElement, timeoutMs: number): Promise<void> {
  if (!hasPendingMath(liveRoot)) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, MATH_POLL_MS));
    if (!hasPendingMath(liveRoot)) return;
  }
}

/** 是否还有「有源码但没渲染出来」的公式（空公式不算：它本来就没有可渲染的内容） */
function hasPendingMath(root: ParentNode): boolean {
  return (
    root.querySelectorAll(
      '[data-math-inline]:not([data-value=""]) .math-placeholder, [data-math-display]:not([data-value=""]) .math-placeholder',
    ).length > 0
  );
}

/**
 * 公式兜底：等过之后仍未渲染的，用 `data-value` 里的 LaTeX 源码顶替占位文案。
 * 占位文案是「双击编辑公式」这类编辑器提示，进产物既丢内容又露编辑态；
 * 源码至少可读、可复制到别处重排。空公式则清空占位（本来就没有内容可显示）。
 */
function rebuildUnrenderedMath(clone: HTMLElement): string[] {
  const notes: string[] = [];
  const hosts = Array.from(
    clone.querySelectorAll<HTMLElement>("[data-math-inline], [data-math-display]"),
  );
  for (const host of hosts) {
    // 导出时正处于内联编辑：host 已被清空、只剩 textarea（data-value 还是旧值）。
    // stripChrome 会摘掉 textarea，不补内容就会导出**空块**——等于丢用户内容。
    const editor = host.querySelector<HTMLTextAreaElement>(".math-editor");
    if (editor) {
      const value = editor.value;
      if (!value.trim()) clearChildren(host);
      else {
        host.textContent = value;
        notes.push("数学公式在导出时处于编辑状态，已改为导出 LaTeX 源码");
      }
      continue;
    }
    const placeholder = host.querySelector(".math-placeholder");
    if (!placeholder) continue;
    const value = host.getAttribute("data-value") ?? "";
    if (!value) {
      placeholder.remove();
      continue;
    }
    placeholder.textContent = value;
    notes.push("数学公式未能在限定时间内渲染，已改为导出 LaTeX 源码");
  }
  return dedupe(notes);
}

/** 摘掉编辑态控件与属性（结构性删除，不靠 CSS 隐藏） */
function stripChrome(clone: HTMLElement): void {
  for (const el of Array.from(clone.querySelectorAll(CHROME_SELECTOR))) el.remove();

  for (const el of [clone, ...Array.from(clone.querySelectorAll(CHROME_CLASS_SELECTOR))]) {
    el.classList.remove(...CHROME_CLASSES);
  }
  // contenteditable：产物是静态的，任何可编辑属性都是编辑态残留
  for (const el of [clone, ...Array.from(clone.querySelectorAll("[contenteditable]"))]) {
    el.removeAttribute("contenteditable");
  }
  clone.removeAttribute("role");
  // 公式的「双击编辑」提示是编辑器交互 affordance；图片的 title 来自 markdown，必须保留
  for (const el of Array.from(
    clone.querySelectorAll<HTMLElement>("[data-math-inline], [data-math-display]"),
  )) {
    el.removeAttribute("title");
  }
  // 懒加载是编辑器的性能手段；产物是静态的，PNG 的离屏容器里 lazy 图片根本不会加载
  for (const img of Array.from(clone.querySelectorAll("img[loading]"))) {
    img.removeAttribute("loading");
  }
}

function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)];
}

// HTML 嵌入渲染
// commonmark 预设的 htmlSchema 是 inline atom 节点，默认把 HTML 当纯文本展示。
// 本文件用 $view 覆盖其 NodeView，通过白名单 DOMParser 真正渲染受支持的 HTML 标签。
//
// 安全：白名单标签 + 白名单属性 + 白名单 CSS 属性，过滤 script/on*/javascript: 等危险内容。
// 性能：解析结果按 value 缓存（LRU 200 条），相同 value 不重复解析；update 比对 value 不变直接跳过。
// markdown 源码保持原始 HTML 文本，可被 GitHub 等直接消费。

import { $view } from "@milkdown/kit/utils";
import type { NodeView, NodeViewConstructor } from "@milkdown/kit/prose/view";
import type { Node as PMNode } from "@milkdown/kit/prose/model";
import { htmlSchema } from "@milkdown/kit/preset/commonmark";

/** 允许的行内/块级标签白名单 */
const ALLOWED_TAGS = new Set([
  // 行内
  "span", "a", "b", "i", "u", "s", "em", "strong", "code", "kbd", "sub", "sup",
  "small", "mark", "br", "abbr", "cite", "q", "time", "var", "samp",
  // 块级（在 inline atom 内用 inline-block 呈现）
  "div", "p", "details", "summary", "blockquote", "pre", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "table", "thead", "tbody", "tr", "th", "td",
  // 图片与 SVG 图形（移除 style 标签，禁止直接注入 style 块）
  "img", "svg", "g", "path", "circle", "rect", "line", "polygon", "polyline", "ellipse", "text", "tspan", "defs", "use", "clippath", "marker", "foreignobject",
  "lineargradient", "radialgradient", "stop", "pattern", "mask", "filter", "fegaussianblur", "feoffset", "femerge", "femergenode", "fecomposite", "fecomponenttransfer", "fefunca", "fefuncr", "fefuncg", "fefuncb"
]);

const SVG_NS = "http://www.w3.org/2000/svg";

/** 允许的全局属性白名单 */
const ALLOWED_GLOBAL_ATTRS = new Set([
  "class", "style", "title", "id", "lang", "dir", "role", "aria-label", "aria-hidden", "aria-describedby", "tabindex",
  // SVG 常用属性
  "viewbox", "xmlns", "xmlns:xlink", "xlink:href", "width", "height", "fill", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-opacity", "fill-opacity", "fill-rule", "clip-rule",
  "d", "cx", "cy", "r", "rx", "ry", "x", "y", "dx", "dy", "x1", "y1", "x2", "y2", "points",
  "transform", "font-family", "font-size", "font-weight", "text-anchor",
  "dominant-baseline", "alignment-baseline", "marker-start", "marker-end", "marker-mid",
  "markerwidth", "markerheight", "refx", "refy", "orient", "markerunits",
  "offset", "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod",
  "maskunits", "maskcontentunits", "patternunits", "patterntransform",
  "preserveaspectratio", "clippathunits", "overflow", "version", "baseprofile",
]);

/** 特定标签的额外允许属性 */
const ALLOWED_TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height"]),
  use: new Set(["xlink:href", "href"]),
  time: new Set(["datetime"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  details: new Set(["open"]),
};

/** 允许的 CSS 属性白名单（小写） */
const ALLOWED_CSS_PROPS = new Set([
  "color", "background-color", "background", "font-weight", "font-style",
  "font-size", "font-family", "text-decoration", "text-align", "text-transform",
  "line-height", "letter-spacing", "word-spacing", "white-space",
  "border", "border-color", "border-radius", "border-width", "border-style",
  "padding", "padding-left", "padding-right", "padding-top", "padding-bottom",
  "margin", "margin-left", "margin-right", "margin-top", "margin-bottom",
  "display", "width", "height", "max-width", "max-height", "min-width", "min-height",
  "overflow", "cursor", "opacity", "box-shadow", "vertical-align", "list-style",
  "text-indent", "word-break", "overflow-wrap", "text-shadow",
]);

/** 危险属性前缀（on* 事件处理器） */
function isDangerousAttr(name: string): boolean {
  return name.toLowerCase().startsWith("on");
}

/**
 * 检查 URL 是否安全（禁止 javascript: data: 协议，允许 http/https/mailto/锚点/相对路径）
 *
 * allowRelative（仅粘贴路径开启，#219）：无协议头的相对路径（`docs/a.md`、`./x.png`）
 * 按原样保留（与 Typora 一致）。判定前先按 URL 解析器的做法剔除 C0 控制字符与空白，
 * 防止 `java\nscript:` 这类「拆开协议头」的写法被误当成相对路径放行。
 */
export function isSafeUrl(url: string, allowRelative = false): boolean {
  const trimmed = url.trim().toLowerCase();
  if (trimmed === "") return true;
  // 锚点、相对路径、协议白名单
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("?")) return true;
  if (/^(https?:|mailto:|tel:)/i.test(trimmed)) return true;
  // data: 仅允许图片类型
  if (/^data:image\//i.test(trimmed)) return true;
  if (allowRelative) {
    // eslint-disable-next-line no-control-regex
    const compact = trimmed.replace(/[\u0000-\u0020\u007f]+/g, "");
    return !/^[a-z][a-z0-9+.-]*:/.test(compact);
  }
  return false;
}

/**
 * 反转义 CSS 字符串（处理 Unicode 16进制转义如 \72 或 \000072 以及字符转义 \( ），并移除注释
 */
export function unescapeCss(str: string): string {
  // 移除 CSS 注释 /* ... */
  const withoutComments = str.replace(/\/\*[\s\S]*?\*\//g, "");
  // CSS 转义：\72, \000072 (1-6位16进制加可选空格) 或 \( 非16进制字符
  return withoutComments.replace(/\\(?:([0-9a-fA-F]{1,6})\s?|([\s\S]))/g, (_, hex, char) => {
    if (hex) {
      const code = parseInt(hex, 16);
      if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
        return "\uFFFD";
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return "\uFFFD";
      }
    }
    return char || "";
  });
}

/** 过滤 style 字符串，仅保留白名单 CSS 属性，移除危险值（expression/url(javascript:)） */
function sanitizeStyle(style: string): string {
  const decls: string[] = [];
  for (const raw of style.split(";")) {
    const idx = raw.indexOf(":");
    if (idx === -1) continue;
    const prop = raw.slice(0, idx).trim().toLowerCase();
    const val = raw.slice(idx + 1).trim();
    if (!prop || !val) continue;
    if (!ALLOWED_CSS_PROPS.has(prop)) continue;
    // 拦截 CSS 注入：expression()、javascript:、behavior、@import、url() 外链（先 unescapeCss 反转义）
    const valUnescaped = unescapeCss(val).toLowerCase();
    if (valUnescaped.includes("expression(")) continue;
    if (valUnescaped.includes("javascript:")) continue;
    if (valUnescaped.includes("behavior:")) continue;
    if (valUnescaped.includes("-moz-binding")) continue;
    if (valUnescaped.includes("@import")) continue;
    if (valUnescaped.includes("url(") || valUnescaped.includes("image(")) continue;
    decls.push(`${prop}: ${val}`);
  }
  return decls.join("; ");
}

/** 块级标签集合（用于判断渲染容器 display） */
const BLOCK_TAG_PATTERN = /<\s*(div|p|details|summary|blockquote|pre|ul|ol|li|h[1-6]|hr|table|thead|tbody|tr|th|td)\b/i;

/** LRU 缓存：value -> sanitized DocumentFragment 克隆。限制 200 条避免内存膨胀 */
const SANITIZE_CACHE = new Map<string, globalThis.Node>();
const CACHE_LIMIT = 200;

function cacheGet(key: string): globalThis.Node | undefined {
  const node = SANITIZE_CACHE.get(key);
  if (node !== undefined) {
    // 命中则移到末尾（Map 保持插入顺序，删后重插即 LRU）
    SANITIZE_CACHE.delete(key);
    SANITIZE_CACHE.set(key, node);
  }
  return node;
}

function cacheSet(key: string, node: globalThis.Node): void {
  if (SANITIZE_CACHE.size >= CACHE_LIMIT) {
    // 淘汰最旧（首个）
    const oldest = SANITIZE_CACHE.keys().next().value;
    if (oldest !== undefined) SANITIZE_CACHE.delete(oldest);
  }
  SANITIZE_CACHE.set(key, node);
}

/** 判断 HTML 片段是否包含块级标签（决定外层容器用 block 还是 inline） */
function containsBlockTag(html: string): boolean {
  return BLOCK_TAG_PATTERN.test(html);
}

/**
 * 粘贴模式（#219）下整棵丢弃（连同子节点）的标签：脚本/样式/嵌入对象/表单控件/
 * 文档元信息等——它们要么是攻击面，要么是「不可编辑的网页结构」，文本内容也不该进文档。
 */
const PASTE_DROP_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "frame", "frameset", "object",
  "embed", "applet", "head", "title", "meta", "link", "base", "textarea", "select",
  "option", "optgroup", "button", "canvas", "video", "audio", "source", "track", "map",
  "area", "svg", "math", "xml", "dialog", "datalist", "output", "progress", "meter",
]);

/**
 * 粘贴模式下改写为 div 的未知块级容器：保留「块边界」再递归取子节点，
 * 否则相邻两个 `<section>` 直接拆包会把两段文字粘成一段。
 */
const PASTE_BLOCK_CONTAINERS = new Set([
  "section", "article", "main", "header", "footer", "nav", "aside", "figure",
  "figcaption", "address", "center", "dl", "dt", "dd", "caption", "form",
  "fieldset", "legend", "hgroup", "body", "html", "search", "menu", "listing",
]);

/** 粘贴模式额外放行的标签（渲染白名单之外、但对结构转换有意义且无害） */
const PASTE_EXTRA_TAGS = new Set(["del", "strike", "ins", "tfoot", "input"]);

/** 粘贴模式额外放行的标签属性 */
const PASTE_EXTRA_TAG_ATTRS: Record<string, Set<string>> = {
  ol: new Set(["start"]),
  input: new Set(["type", "checked"]),
};

export interface SanitizeOptions {
  /**
   * render（默认）：HTML 嵌入渲染路径，未知标签连同子节点丢弃，结果带 LRU 缓存。
   * paste：粘贴路径（#219）——危险标签整棵丢弃；未知块级容器改写为 div、未知行内
   * 标签拆包保留子节点（「无法映射的块级容器：递归取子节点」）；相对链接保留；
   * 不进缓存（粘贴内容一次性，不应挤占渲染缓存）。
   */
  mode?: "render" | "paste";
}

/**
 * 解析并过滤 HTML 字符串为安全的 DocumentFragment。
 * 用 DOMParser（不执行脚本、不加载资源）解析，白名单遍历克隆。
 * 导出供测试验证白名单过滤逻辑。
 */
export function sanitizeHTML(value: string, options: SanitizeOptions = {}): globalThis.Node {
  const paste = options.mode === "paste";
  if (!paste) {
    const cached = cacheGet(value);
    if (cached) return cached.cloneNode(true);
  }

  // DOMParser 解析不执行 script，比 innerHTML 安全
  const doc = new DOMParser().parseFromString(value, "text/html");
  const fragment = document.createDocumentFragment();

  // 递归过滤克隆节点
  const appendChildren = (src: Element, target: globalThis.Node, inSvg: boolean): void => {
    for (const child of Array.from(src.childNodes)) {
      if (child.nodeType === globalThis.Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(child.textContent ?? ""));
      } else if (child.nodeType === globalThis.Node.ELEMENT_NODE) {
        cloneFiltered(child as Element, target, inSvg);
      }
    }
  };

  const cloneFiltered = (src: Element, parent: globalThis.Node, isInsideSvg = false): void => {
    const rawTag = src.tagName;
    let lowerTag = rawTag.toLowerCase();
    if (paste) {
      if (PASTE_DROP_TAGS.has(lowerTag)) return;
      // 任务列表复选框之外的 input 一律丢弃
      if (lowerTag === "input" && (src.getAttribute("type") ?? "").toLowerCase() !== "checkbox") return;
      if (!ALLOWED_TAGS.has(lowerTag) && !PASTE_EXTRA_TAGS.has(lowerTag)) {
        if (PASTE_BLOCK_CONTAINERS.has(lowerTag)) {
          lowerTag = "div";
        } else {
          // 未知行内标签（font、o:p、g-emoji、label…）：拆包，子节点并入父节点
          appendChildren(src, parent, false);
          return;
        }
      }
    } else if (!ALLOWED_TAGS.has(lowerTag)) {
      return; // 不在白名单的标签直接丢弃（不保留子节点，避免结构混乱）
    }

    const inSvg = isInsideSvg ? lowerTag !== "foreignobject" : lowerTag === "svg";
    // SVG 元素必须用 SVG 命名空间创建，foreignObject 内部的 HTML 元素用标准 HTML 命名空间
    const el = inSvg
      ? document.createElementNS(SVG_NS, rawTag)
      : document.createElement(lowerTag);

    // 过滤属性
    for (const attr of Array.from(src.attributes)) {
      const rawName = attr.name;
      const lowerName = rawName.toLowerCase();
      if (isDangerousAttr(lowerName)) continue;
      const allowed =
        ALLOWED_GLOBAL_ATTRS.has(lowerName) ||
        ALLOWED_TAG_ATTRS[lowerTag]?.has(lowerName) ||
        (paste && PASTE_EXTRA_TAG_ATTRS[lowerTag]?.has(lowerName));
      if (!allowed) continue;

      let val = attr.value;
      // href/src/xlink:href 做协议检查
      if ((lowerName === "href" || lowerName === "src" || lowerName === "xlink:href") && !isSafeUrl(val, paste)) continue;
      // style 单独过滤
      if (lowerName === "style") {
        val = sanitizeStyle(val);
        if (!val) continue;
      }
      el.setAttribute(rawName, val);
    }

    // a 标签强制安全：外链加 rel=noopener，target=_blank 时补充
    if (lowerTag === "a" && el.getAttribute("target") === "_blank") {
      el.setAttribute("rel", "noopener noreferrer");
    }

    parent.appendChild(el);

    // 递归子节点：如果当前节点是 foreignObject，则其内部子节点进入 HTML 命名空间（isInsideSvg = false）
    const nextInSvg = lowerTag === "foreignobject" ? false : inSvg;
    appendChildren(src, el, nextInSvg);
  };

  appendChildren(doc.body, fragment, false);

  if (paste) return fragment;
  // 缓存原始 fragment（非克隆）
  cacheSet(value, fragment);
  return fragment.cloneNode(true);
}

/** 创建 HTML 节点 NodeView：白名单渲染受支持的 HTML 标签 */
function createHtmlView(): NodeViewConstructor {
  return (node: PMNode): NodeView => {
    const value = (node.attrs.value as string) ?? "";
    const isBlock = containsBlockTag(value);

    // 外层容器：inline atom 节点需 inline 容器保持文档结构合法；
    // 块级 HTML 用 inline-block 呈现块级视觉但不破坏段落结构
    const dom = document.createElement("span");
    dom.className = "html-inline";
    dom.setAttribute("data-type", "html");
    dom.setAttribute("data-value", value);
    if (isBlock) {
      dom.style.display = "inline-block";
      dom.classList.add("html-block");
    }

    let current = value;
    const render = (v: string) => {
      dom.innerHTML = "";
      if (!v.trim()) return;
      try {
        const fragment = sanitizeHTML(v);
        dom.appendChild(fragment);
      } catch {
        // 解析失败回退为纯文本展示
        dom.textContent = v;
      }
    };
    render(current);

    return {
      dom,
      // atom 节点不提供 contentDOM
      ignoreMutation: () => true,
      stopEvent: () => false,
      update: (next: PMNode) => {
        if (next.type.name !== "html") return false;
        const nextValue = (next.attrs.value as string) ?? "";
        if (nextValue === current) return true; // 值未变，跳过重渲染
        current = nextValue;
        render(nextValue);
        return true;
      },
      destroy: () => {},
    };
  };
}

/** 覆盖 commonmark htmlSchema 的 NodeView，启用 HTML 真实渲染 */
export const htmlView = $view(htmlSchema.node, () => createHtmlView());

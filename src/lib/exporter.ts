// 导出功能：HTML / PDF / PNG / 富文本复制
//
// 四路共用同一条产出管线（#372 + #373 一起设计，避免每种格式各清一遍、口径漂移）：
//   ① `buildExportSnapshot`：克隆编辑器 DOM，**结构性清除**编辑态控件；代码块 /
//      frontmatter / Mermaid 的内容改以 ProseMirror 文档为准重建
//      （CodeMirror 按视口虚拟化行、Mermaid 视口外不渲染，克隆 DOM 都不完整）。
//   ② `ExportResourceProcessor`：把 `asset:` / `asset.localhost` 运行时地址换成可移植形式。
//   ③ 各格式按自己的**落点**决定 inline 还是 sidecar：只有桌面端 HTML 导出有磁盘落点，
//      PDF（about:blank 新窗口）/ PNG（离屏容器）/ 剪贴板（外部程序）一律内联。
//
// HTML：内联**当前文档的样式表**（含当前主题），打包成独立可打开的 html 文件；
//       桌面端超过内联预算的大资源旁挂到 `<name>_assets/` 并写相对路径。
// PDF：在新窗口打开 HTML 并调用浏览器打印（用户选「另存为 PDF」）。
// 这样不依赖外部 Pandoc，绿色版开箱即用。
// #226：独立文档的主题跟随与「打印不裁切」口径见 `./exportTheme.ts`。

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { flushAllMarkdownPublishers } from "../components/Editor/markdown-publisher";
import { useWorkspace } from "../store/workspace";
import { createDir, resolvePathFromDocument, writeBinaryFile } from "./fs";
import { showMessage } from "./dialogs";
import { parseOutline } from "./outline";
import {
  buildThemedStandaloneHTML,
  collectDocumentCss,
  currentThemeDescriptor,
} from "./exportTheme";
import { buildExportSnapshot } from "./exportSnapshot";
import {
  ExportResourceProcessor,
  findRuntimeUrls,
  formatResourceWarnings,
  processDomResources,
  type ResourceMode,
} from "./exportResources";

/** 离屏/新窗口里等待图片加载解码的上限（沿用 PNG 导出既有的 3s 实测口径） */
const IMAGE_WAIT_MS = 3000;

/** 一次导出的备料结果：正文克隆 + 该次导出的资源处理器 */
interface PreparedExport {
  /** 已清理编辑态控件、已完成资源可移植化改写的正文根元素（克隆，不是编辑器的 DOM） */
  root: HTMLElement;
  processor: ExportResourceProcessor;
  /** 快照阶段的可读降级告知（Mermaid / 公式未渲染） */
  notes: string[];
}

/**
 * 产出导出正文：① 清理编辑态控件并按文档重建内容 → ② 资源可移植化改写。
 *
 * `mode` 由落点决定：只有桌面端 HTML 导出能把大资源旁挂到磁盘，其余三路一律内联。
 * sidecar 模式必须**先**拿到最终保存路径：旁挂目录名跟随用户实际保存的文件名
 * （对话框里可能改名），落点不同目录名就不同。
 */
async function prepareExportBody(
  getEditor: () => Editor | undefined,
  mode: ResourceMode,
  sidecarDir?: string,
): Promise<PreparedExport | null> {
  const editor = getEditor();
  if (!editor) return null;
  const view = editor.action((ctx) => ctx.get(editorViewCtx));
  if (!view) return null;

  const snapshot = await buildExportSnapshot({
    liveRoot: view.dom,
    doc: view.state.doc,
    nodeDOM: (pos) => view.nodeDOM(pos),
    // 等待 KaTeX 的那一两秒里用户仍可能继续打字：克隆前的文档/位置必须重新读，
    // 否则「旧文档的位置 + 新 DOM 的元素」会按错位的下标重建块。
    getState: () => ({ doc: view.state.doc, nodeDOM: (pos) => view.nodeDOM(pos) }),
  });
  const processor = new ExportResourceProcessor({
    mode,
    documentPath: useWorkspace.getState().currentFile ?? "",
    sidecarDir,
  });
  await processDomResources(snapshot.root, processor);
  return { root: snapshot.root, processor, notes: snapshot.notes };
}

/** 当前文件名（去掉扩展名），作为导出文件默认名 */
function getBaseName(): string {
  const f = useWorkspace.getState().currentFile;
  if (!f) return "untitled";
  return f.split(/[\\/]/).pop()!.replace(/\.md$/i, "") || "untitled";
}

/** 保存对话框返回的路径 → 去掉目录与 `.html` 后缀的文件名（旁挂目录以此命名） */
function savedBaseName(path: string): string {
  return path.split(/[\\/]/).pop()!.replace(/\.html?$/i, "") || "untitled";
}

/**
 * 生成导出用的独立 HTML 文档（#226 §4.2）：
 * - 内联**当前文档的样式表**（原样、保持顺序，含各表的 `@layer` 归属）→ 主题/自定义 CSS 一并跟随；
 * - 样式表里的 `url()`（主题字体、背景图）同样经处理器改写，否则产物离开应用即缺字体（#372）；
 * - 层序声明与 `index.html` 同句；纸张骨架未分层且只写结构属性（不盖主题颜色）；
 * - 正文包回 `.editor-scroll > .milkdown`，并在 `<html>` 上写 `data-theme` / `data-theme-id`。
 */
async function buildStandaloneHTML(
  prepared: PreparedExport,
  bodyHTML: string,
  title: string,
): Promise<string> {
  const sheets = await collectExportCss(prepared.processor);
  return buildThemedStandaloneHTML(bodyHTML, title, sheets, currentThemeDescriptor(), escapeHTML);
}

/** 收集当前文档的样式表并做资源可移植化改写 */
async function collectExportCss(processor: ExportResourceProcessor): Promise<string[]> {
  const { sheets, skipped } = await collectDocumentCss();
  if (skipped.length > 0) {
    // 不静默：取不到样式表时给出可排查线索（导出产物会少那部分样式）
    console.warn(`[export] ${skipped.length} 个样式表未能内联：${skipped.join("; ")}`);
  }
  const out: string[] = [];
  for (const sheet of sheets) out.push(await processor.processCss(sheet));
  return out;
}

/**
 * 导出结束后的统一告知：资源降级 + 快照降级 + 兜底探针命中，全部可见。
 * 「静默产出不完整的导出」比多一次弹窗糟糕得多（#372/#373 验收口径）。
 */
async function reportDegradation(prepared: PreparedExport, artifact: string): Promise<void> {
  const lines = [
    ...prepared.processor.warnings.map((w) => `${w.ref}：${w.reason}`),
    ...prepared.notes,
    ...findRuntimeUrls(artifact).map(
      (url) => `${url}：仍指向应用运行时地址，离开本应用后无法加载`,
    ),
  ];
  const unique = [...new Set(lines)];
  if (unique.length === 0) return;
  try {
    await showMessage(formatResourceWarnings(unique), { kind: "warning" });
  } catch {
    // 告知失败不改变导出/复制结果：产物已经写出，不能因为弹窗异常再报一次失败
  }
}

/**
 * 把超过内联预算的大资源写到 HTML 旁的 `<name>_assets/`。
 * HTML 因此仍可独立分发（整个目录一起拷走即可），又不必把大图 base64 进文本。
 */
async function writeSidecars(
  htmlPath: string,
  sidecarDir: string,
  prepared: PreparedExport,
): Promise<void> {
  const { sidecars, warnings } = prepared.processor;
  if (sidecars.length === 0) return;
  let dirPath: string;
  try {
    dirPath = await resolvePathFromDocument(htmlPath, sidecarDir);
  } catch (e) {
    // 路径解析失败时 HTML 已经写出：不能整次导出抛错，逐条登记不落盘的资源
    const reason = `旁挂资源目录路径解析失败（${e instanceof Error ? e.message : String(e)}）`;
    for (const file of sidecars) warnings.push({ ref: file.relativeUrl, reason });
    return;
  }
  try {
    await createDir(dirPath);
  } catch {
    // 目录已存在即可（重复导出到同一位置）；真正的权限/IO 问题会在下面的写入里报出来
  }
  for (const file of sidecars) {
    let target: string;
    try {
      target = await resolvePathFromDocument(htmlPath, ...file.relativePath.split("/"));
    } catch (e) {
      warnings.push({
        ref: file.relativeUrl,
        reason: `旁挂资源路径解析失败（${e instanceof Error ? e.message : String(e)}）`,
      });
      continue;
    }
    try {
      await writeBinaryFile(target, file.data);
    } catch (e) {
      warnings.push({
        ref: file.relativeUrl,
        reason: `写入旁挂资源失败（${e instanceof Error ? e.message : String(e)}）`,
      });
    }
  }
}

/**
 * 等待容器内所有 `<img>` 加载/解码完成（带超时保护）。
 * 导出产物里的本地图片已内联为 data URL，解码很快；远程图片受网络影响，
 * 故必须有超时——导出不能无限等待。
 */
export async function waitForImages(root: ParentNode, timeoutMs: number): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  if (images.length === 0) return;
  const tasks = images.map((img) => {
    const decode = () => ("decode" in img ? img.decode().catch(() => {}) : Promise.resolve());
    // `complete` 已为 true 但 `naturalWidth === 0` 是**加载失败**：load/error 事件
    // 早已错过，再挂监听只会白等满超时（每张坏图 3s）
    if (img.complete) return decode();
    return new Promise<void>((resolve) => {
      const onFinish = () => {
        img.removeEventListener("load", onFinish);
        img.removeEventListener("error", onFinish);
        void decode().then(resolve);
      };
      img.addEventListener("load", onFinish);
      img.addEventListener("error", onFinish);
    });
  });
  await Promise.race([
    Promise.all(tasks),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 导出为 HTML 文件（保存到用户选择的位置） */
export async function exportHTML(
  getEditor: () => Editor | undefined,
): Promise<void> {
  flushAllMarkdownPublishers();
  const name = getBaseName();
  const desktop = isTauri();
  // 先问落点再备料：用户取消时不该白读一遍全部图片字节。
  const path = desktop
    ? await save({
        defaultPath: `${name}.html`,
        filters: [{ name: "HTML", extensions: ["html"] }],
      })
    : null;
  if (desktop && !path) return; // 用户取消：不产生任何文件

  // 旁挂目录名跟随**最终保存的文件名**：用户可能在对话框里改名，
  // 目录若仍按文档名，就会出现 `final.html` + `report_assets/` 的错配，
  // 且两份不同文档同名导出时会共用同一个目录、互相覆盖同名资源。
  const sidecarDir = `${(desktop && path ? savedBaseName(path) : name)}_assets`;

  const prepared = await prepareExportBody(getEditor, desktop ? "sidecar" : "inline", sidecarDir);
  if (!prepared) return;
  const bodyHTML = prepared.root.innerHTML;
  if (!bodyHTML) return;
  const fullHTML = await buildStandaloneHTML(prepared, bodyHTML, name);

  if (desktop) {
    // 导出产物「丢了能重做」，不必掉电保证：省掉数据 + 目录两次 fsync
    await invoke<void>("write_text_file", {
      filePath: path,
      content: fullHTML,
      durability: "none",
    });
    await writeSidecars(path!, sidecarDir, prepared);
  } else {
    // 浏览器：触发下载
    downloadBlob(new Blob([fullHTML], { type: "text/html" }), `${name}.html`);
  }
  await reportDegradation(prepared, fullHTML);
}

/** 导出为 PDF：打开 HTML 新窗口并调用浏览器打印 */
export async function exportPDF(
  getEditor: () => Editor | undefined,
): Promise<void> {
  flushAllMarkdownPublishers();
  // 新窗口（about:blank）没有磁盘落点 → 只能内联；内联后图片也就不再依赖 asset 协议
  const prepared = await prepareExportBody(getEditor, "inline");
  if (!prepared) return;
  const bodyHTML = prepared.root.innerHTML;
  if (!bodyHTML) return;
  const name = getBaseName();
  const fullHTML = await buildStandaloneHTML(prepared, bodyHTML, name);

  // 新窗口打开并等待完全加载后打印，避免白屏
  const win = window.open("", "_blank");
  if (!win) {
    await showMessage("无法打开新窗口，请检查浏览器弹窗拦截设置", { kind: "error" });
    return;
  }
  win.document.open();
  win.document.write(fullHTML);
  win.document.close();
  const triggerPrint = async () => {
    try {
      // 打印前确保资源就位（#372 验收项）：`load` 之后仍显式等一次图片解码
      await waitForImages(win.document, IMAGE_WAIT_MS);
      if (win.closed) return;
      win.focus();
      win.print();
    } catch {}
  };
  if (win.document.readyState === "complete") {
    setTimeout(() => void triggerPrint(), 100);
  } else {
    win.addEventListener("load", () => setTimeout(() => void triggerPrint(), 100), {
      once: true,
    });
  }
  await reportDegradation(prepared, fullHTML);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 复制当前 Markdown 源码到剪贴板（纯文本） */
export async function copyMarkdown(): Promise<boolean> {
  flushAllMarkdownPublishers();
  const content = useWorkspace.getState().currentContent;
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    return false;
  }
}

/** 检查系统是否安装 pandoc（仅桌面端有效） */
export async function checkPandoc(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("pandoc_check");
  } catch {
    return false;
  }
}

/**
 * 导出为 Word（.docx），走 Pandoc
 * - 仅桌面端可用：浏览器端无法调用本地 pandoc
 * - 未安装 pandoc 时返回错误，由调用方提示用户安装
 */
export async function exportDocx(): Promise<{
  ok: boolean;
  error?: string;
}> {
  flushAllMarkdownPublishers();
  if (!isTauri()) {
    return { ok: false, error: "Word 导出仅在桌面端可用（需调用 Pandoc）" };
  }
  const installed = await checkPandoc();
  if (!installed) {
    return {
      ok: false,
      error: "未检测到 Pandoc，请先安装：https://pandoc.org/installing.html",
    };
  }
  const content = useWorkspace.getState().currentContent;
  if (!content) return { ok: false, error: "无内容可导出" };
  const name = getBaseName();
  const currentFile = useWorkspace.getState().currentFile;

  try {
    const resourceDir = currentFile
      ? await resolvePathFromDocument(currentFile)
      : null;
    const path = await save({
      defaultPath: `${name}.docx`,
      filters: [{ name: "Word 文档", extensions: ["docx"] }],
    });
    if (!path) return { ok: false };

    await invoke<void>("pandoc_export_docx", {
      markdown: content,
      outputPath: path,
      resourceDir,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 复制编辑器渲染结果为富文本（text/html + text/plain 回退） */
export async function copyRichText(
  getEditor: () => Editor | undefined,
): Promise<boolean> {
  flushAllMarkdownPublishers();
  // 剪贴板内容会被粘进任意外部程序：既不能带编辑器控件（#373），也不能带 asset 运行时
  // 地址（#372）——外部程序里没有这个协议，图片会整片丢失。没有磁盘落点，故一律内联。
  const prepared = await prepareExportBody(getEditor, "inline");
  if (!prepared) return false;
  const html = prepared.root.innerHTML;
  if (!html) return false;
  const text = useWorkspace.getState().currentContent;
  try {
    const htmlBlob = new Blob([html], { type: "text/html" });
    const textBlob = new Blob([text], { type: "text/plain" });
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": htmlBlob,
        "text/plain": textBlob,
      }),
    ]);
  } catch {
    // ClipboardItem 不支持时回退到纯文本
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
  }
  // 告知放在剪贴板写入的 try 之外：弹窗失败不能再走进 catch，
  // 用纯文本覆盖已经写好的富文本。
  await reportDegradation(prepared, html);
  return true;
}

/**
 * 导出为 PNG 长图：用 html2canvas 把编辑器渲染结果截图。
 * - 在离屏容器中以「只读展示样式」渲染一份完整文档副本，避免编辑态属性干扰
 * - 为离屏容器注入 .editor-scroll .milkdown 类及 data-theme，保持与当前主题及编辑器样式一致
 * - 增加所有 <img> 元素 decode/load 异步就绪等待与超时机制，避免长图导出时图片空白
 * - 仅桌面端保存到用户选择路径；浏览器端触发下载
 */
export async function exportPNG(
  getEditor: () => Editor | undefined,
): Promise<void> {
  flushAllMarkdownPublishers();
  const { default: html2canvas } = await import("html2canvas");
  // 离屏容器没有磁盘落点 → 只能内联。内联同时解决了 asset 地址取不到的问题（#372）：
  // html2canvas 要把图片画进 canvas，而 asset 协议在打包后连 fetch 都被 CSP 挡掉。
  const prepared = await prepareExportBody(getEditor, "inline");
  if (!prepared) return;
  const bodyHTML = prepared.root.innerHTML;
  if (!bodyHTML) return;
  const name = getBaseName();

  // 获取当前主题模式
  const currentTheme = document.documentElement.getAttribute("data-theme") || "light";

  // 离屏三层结构对齐真实编辑器 DOM：[data-theme] > .editor-scroll > .milkdown。
  // App.css 的排版规则都是 ".editor-scroll .milkdown ..." / "[data-theme=dark] .editor-scroll ..."
  // 后代选择器，必须复刻真实嵌套层级才能命中（同一元素挂两个类无法匹配后代选择器），
  // 这样 Callout/代码块/Mermaid/表格等自定义块在导出图中保留边框与配色。
  const themeRoot = document.createElement("div");
  themeRoot.setAttribute("data-theme", currentTheme);
  // #226：连同 `data-theme-id` 一起复刻（与真实编辑器 DOM 属性一致；它只是元数据锚点，
  // 但少了它，将来任何按 `[data-theme-id=…]` 写的规则在导出图里都会静默失效 → 现在起对齐）。
  // 注意：**不再注入第二份主题 CSS**（A-4 禁止）——离屏容器在同一文档内，
  // `<head>` 里已有的 `#inkling-theme`（`.editor-scroll .milkdown …` 后代选择器）天然命中它。
  const currentThemeId = document.documentElement.getAttribute("data-theme-id");
  if (currentThemeId) themeRoot.setAttribute("data-theme-id", currentThemeId);
  themeRoot.style.cssText =
    "position:fixed;left:-99999px;top:0;width:820px;box-sizing:border-box;";

  const scroll = document.createElement("div");
  scroll.className = "editor-scroll";

  const milkdown = document.createElement("div");
  milkdown.className = "milkdown";
  milkdown.innerHTML = bodyHTML;

  scroll.appendChild(milkdown);
  themeRoot.appendChild(scroll);
  document.body.appendChild(themeRoot);

  // 等待离屏容器内所有图片加载/解码完成（带 3s 超时保护）
  await waitForImages(themeRoot, IMAGE_WAIT_MS);

  try {
    // 背景色取 .milkdown 实际计算的 --editor-bg（跟随主题），取不到时回退白底
    const computedBg = getComputedStyle(milkdown).backgroundColor;
    const bgColor = computedBg && computedBg !== "rgba(0, 0, 0, 0)" && computedBg !== "transparent"
      ? computedBg
      : "#ffffff";
    const canvas = await html2canvas(themeRoot, {
      backgroundColor: bgColor,
      scale: 2, // 2 倍清晰度
      useCORS: true,
      logging: false,
    });
    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob 失败"))),
        "image/png",
      ),
    );

    if (isTauri()) {
      const path = await save({
        defaultPath: `${name}.png`,
        filters: [{ name: "PNG 图片", extensions: ["png"] }],
      });
      if (!path) return;
      const buf = new Uint8Array(await blob.arrayBuffer());
      await writeBinaryFile(path, buf);
    } else {
      downloadBlob(blob, `${name}.png`);
    }
  } finally {
    document.body.removeChild(themeRoot);
  }
  await reportDegradation(prepared, bodyHTML);
}

/**
 * 导出文档大纲：只保留标题层级，生成只含标题的 markdown 文件，可作为目录使用。
 * - 标题层级用缩进列表表示，便于一眼看出层级关系
 * - 同时输出原始 # 语法，兼容 GitHub 等渲染器
 */
export async function exportOutline(): Promise<void> {
  flushAllMarkdownPublishers();
  const content = useWorkspace.getState().currentContent;
  if (!content) return;
  const name = getBaseName();
  const headings = parseOutline(content);

  // 用缩进列表表示层级：H1 顶层，每深一级缩进 2 空格
  const lines: string[] = [`# ${name} 目录`, ""];
  for (const h of headings) {
    const indent = "  ".repeat(Math.max(0, h.level - 1));
    lines.push(`${indent}- ${h.text}`);
  }
  // 末尾附原始标题语法，便于直接作为新文档骨架
  lines.push("", "---", "", "## 原始标题结构", "");
  for (const h of headings) {
    lines.push(`${"#".repeat(h.level)} ${h.text}`);
  }
  const md = lines.join("\n");

  if (isTauri()) {
    const path = await save({
      defaultPath: `${name}-outline.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
    await invoke<void>("write_text_file", {
      filePath: path,
      content: md,
      durability: "none",
    });
  } else {
    downloadBlob(new Blob([md], { type: "text/markdown" }), `${name}-outline.md`);
  }
}

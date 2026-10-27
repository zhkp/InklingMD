// 导出功能：HTML / PDF
// HTML：取编辑器渲染后的 DOM + 内联**当前文档的样式表**（含当前主题），打包成独立可打开的 html 文件
// PDF：在新窗口打开 HTML 并调用浏览器打印（用户选「另存为 PDF」）
// 这样不依赖外部 Pandoc，绿色版开箱即用。
// #226：独立文档的主题跟随与「打印不裁切」口径见 `./exportTheme.ts`。

import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { flushAllMarkdownPublishers } from "../components/Editor/markdown-publisher";
import { useWorkspace } from "../store/workspace";
import { resolvePathFromDocument, writeBinaryFile } from "./fs";
import { showMessage } from "./dialogs";
import { parseOutline } from "./outline";
import {
  buildThemedStandaloneHTML,
  collectDocumentCss,
  currentThemeDescriptor,
} from "./exportTheme";

/** 从编辑器获取渲染后的 HTML 内容 */
function getEditorHTML(getEditor: () => Editor | undefined): string {
  const editor = getEditor();
  if (!editor) return "";
  const html = editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    // 克隆编辑器 DOM，移除 ProseMirror 的编辑态属性
    const clone = view.dom.cloneNode(true) as HTMLElement;
    clone.removeAttribute("contenteditable");
    clone.removeAttribute("role");
    clone.classList.remove("ProseMirror");
    return clone.innerHTML;
  });
  return html;
}

/** 当前文件名（去掉扩展名），作为导出文件默认名 */
function getBaseName(): string {
  const f = useWorkspace.getState().currentFile;
  if (!f) return "untitled";
  return f.split(/[\\/]/).pop()!.replace(/\.md$/i, "") || "untitled";
}

/**
 * 生成导出用的独立 HTML 文档（#226 §4.2）：
 * - 内联**当前文档的样式表**（原样、保持顺序，含各表的 `@layer` 归属）→ 主题/自定义 CSS 一并跟随；
 * - 层序声明与 `index.html` 同句；纸张骨架未分层且只写结构属性（不盖主题颜色）；
 * - 正文包回 `.editor-scroll > .milkdown`，并在 `<html>` 上写 `data-theme` / `data-theme-id`。
 */
async function buildStandaloneHTML(bodyHTML: string, title: string): Promise<string> {
  const { sheets, skipped } = await collectDocumentCss();
  if (skipped.length > 0) {
    // 不静默：取不到样式表时给出可排查线索（导出产物会少那部分样式）
    console.warn(`[export] ${skipped.length} 个样式表未能内联：${skipped.join("; ")}`);
  }
  return buildThemedStandaloneHTML(bodyHTML, title, sheets, currentThemeDescriptor(), escapeHTML);
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 导出为 HTML 文件（保存到用户选择的位置） */
export async function exportHTML(
  getEditor: () => Editor | undefined,
): Promise<void> {
  flushAllMarkdownPublishers();
  const bodyHTML = getEditorHTML(getEditor);
  if (!bodyHTML) return;
  const name = getBaseName();
  const fullHTML = await buildStandaloneHTML(bodyHTML, name);

  if (isTauri()) {
    const path = await save({
      defaultPath: `${name}.html`,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!path) return;
    // 导出产物「丢了能重做」，不必掉电保证：省掉数据 + 目录两次 fsync
    await invoke<void>("write_text_file", {
      filePath: path,
      content: fullHTML,
      durability: "none",
    });
  } else {
    // 浏览器：触发下载
    downloadBlob(new Blob([fullHTML], { type: "text/html" }), `${name}.html`);
  }
}

/** 导出为 PDF：打开 HTML 新窗口并调用浏览器打印 */
export async function exportPDF(
  getEditor: () => Editor | undefined,
): Promise<void> {
  flushAllMarkdownPublishers();
  const bodyHTML = getEditorHTML(getEditor);
  if (!bodyHTML) return;
  const name = getBaseName();
  const fullHTML = await buildStandaloneHTML(bodyHTML, name);

  // 新窗口打开并等待完全加载后打印，避免白屏
  const win = window.open("", "_blank");
  if (!win) {
    await showMessage("无法打开新窗口，请检查浏览器弹窗拦截设置", { kind: "error" });
    return;
  }
  win.document.open();
  win.document.write(fullHTML);
  win.document.close();
  const triggerPrint = () => {
    try {
      win.focus();
      win.print();
    } catch {}
  };
  if (win.document.readyState === "complete") {
    setTimeout(triggerPrint, 100);
  } else {
    win.addEventListener("load", () => setTimeout(triggerPrint, 100), { once: true });
  }
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
  const html = getEditorHTML(getEditor);
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
    return true;
  } catch {
    // ClipboardItem 不支持时回退到纯文本
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
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
  const bodyHTML = getEditorHTML(getEditor);
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
  const images = Array.from(themeRoot.querySelectorAll("img"));
  if (images.length > 0) {
    const imgPromises = images.map((img) => {
      if (img.complete && img.naturalWidth !== 0) {
        return "decode" in img ? img.decode().catch(() => {}) : Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const onFinish = () => {
          img.removeEventListener("load", onFinish);
          img.removeEventListener("error", onFinish);
          resolve();
        };
        img.addEventListener("load", onFinish);
        img.addEventListener("error", onFinish);
      });
    });
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, 3000));
    await Promise.race([Promise.all(imgPromises), timeoutPromise]);
  }

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

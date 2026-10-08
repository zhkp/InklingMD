/**
 * #306 流水线第 0 步：读入即规范化（N11-1 / N12）。
 *
 * 为什么必须有这一步：
 * - `@charset` 与 `@import` 同为**表首限定** at-rule，被包进 `@layer theme { … }` 会失效；
 * - Tauri 的 `read_text_file`（`fs::read` + `String::from_utf8`，`src-tauri/src/commands/mod.rs`）
 *   **不剥 BOM** → U+FEFF 会落在首字符（在 `@charset` 之前）使「首个 at-rule」判定失配，
 *   且 U+FEFF 属 non-ASCII，CSS 词法上会被当作名称起始字符；
 * - 统一 LF 后，内容哈希才可跨平台稳定（同一主题带/不带 BOM 不能算成两个 hash，
 *   否则 G9 快照一致性被破坏）。
 */
import type { ThemeDiagnostic } from "./types";

export interface NormalizeResult {
  css: string;
  diagnostics: ThemeDiagnostic[];
}

/** 剥 BOM（U+FEFF，可重复出现）+ 剥表首 `@charset` + 统一 LF。 */
export function normalizeThemeCss(raw: string): NormalizeResult {
  const diagnostics: ThemeDiagnostic[] = [];
  let css = raw;

  // ① BOM：只在流首剥离（CSS 规范只允许流首出现 BOM）
  let bomCount = 0;
  while (css.startsWith("\uFEFF")) {
    css = css.slice(1);
    bomCount += 1;
  }
  if (bomCount > 0) {
    diagnostics.push({
      kind: "normalize-bom",
      target: "\\uFEFF",
      reason: `剥除流首 BOM（${bomCount} 处）：BOM 落在 @charset 之前会让「表首 at-rule」判定失配，且 U+FEFF 会被 CSS 词法当作名称起始字符`,
    });
  }

  // ② 表首 @charset（允许前导空白/注释——宽于规范，避免"差一个空格就残留"）
  const charsetMatch = /^\s*(?:\/\*[\s\S]*?\*\/\s*)*@charset\s+(?:"[^"]*"|'[^']*')\s*;/.exec(css);
  if (charsetMatch) {
    css = css.slice(charsetMatch[0].length).replace(/^\s*\n/, "");
    diagnostics.push({
      kind: "normalize-charset",
      target: "@charset",
      reason: "剥除表首 @charset：它随 @layer 包裹会失效甚至影响该块解析；编码已由读入路径（UTF-8）确定",
    });
  }

  // ③ 统一 LF（CRLF / 孤立 CR 都归一）
  if (css.includes("\r")) {
    css = css.replace(/\r\n?/g, "\n");
    diagnostics.push({
      kind: "normalize-eol",
      target: "\\r\\n",
      reason: "行尾统一为 LF：内容哈希与改写产物需跨平台一致",
    });
  }

  return { css, diagnostics };
}

/**
 * 主题内容哈希（G9 快照 key 的 `<hash>` 段）。
 * FNV-1a 64-bit，基于**规范化后的 UTF-8 字节**：纯函数、无平台差异、无加密依赖。
 */
export function hashThemeCss(normalizedCss: string): string {
  const bytes =
    typeof TextEncoder === "undefined"
      ? fallbackUtf8Bytes(normalizedCss)
      : new TextEncoder().encode(normalizedCss);
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  let hash = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    hash = (hash ^ BigInt(bytes[i])) & MASK;
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}

/** 无 TextEncoder 环境（极旧 WebView / 某些测试环境）的 UTF-8 兜底。 */
function fallbackUtf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return out;
}

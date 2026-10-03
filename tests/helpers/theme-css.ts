/**
 * #224 主题样式断言共享工具：
 * - 入口清单（tests/fixtures/theme-entries.json）是唯一真值源；
 * - 极简 glob（仅支持 ** 与 *，匹配仓库内 CSS 入口）；
 * - 注释按「空格掩码」处理（保留行号，不改变声明结构）；
 * - 花括号配平切块（#223 A-1：不再依赖「顶格 }」正则，@layer 包裹/缩进后仍正确）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

export interface ThemeEntries {
  tokenDefinitionFiles: string[];
  themeBlocks: { file: string; light: string; dark: string };
  hardcodeScanFiles: string[];
  forbiddenHardcodedColors: string[];
  sourceScanFiles: string[];
  linkDialogClasses: string[];
  requiredTokens: string[];
  themeColorTokens: string[];
  layers: {
    layerStatement: {
      file: string;
      elementId: string;
      order: string[];
    };
    base: { entry: string; wrap: "source" | "import-layer" | "plugin-transform" }[];
    themeStyleElementId: string;
    userStyleElementId: string;
  };
  s9AllowMarkers: string[];
  injectionFunctions: { file: string; names: string[] }[];
  innerHTMLAllowlist: string[];
  buildAssets: { cssCount: number; requiredChunks: string[] };
}

const root = process.cwd();

export function readFixture(): ThemeEntries {
  return JSON.parse(
    readFileSync(resolve(root, "tests/fixtures/theme-entries.json"), "utf8"),
  ) as ThemeEntries;
}

/** 极简 glob：** 匹配任意层级，* 匹配段内任意字符（不含分隔符）。 */
export function expandGlob(pattern: string): string[] {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§DOUBLE§")
        .replace(/\*/g, "[^/]*")
        .replace(/§DOUBLE§/g, ".*") +
      "$",
  );
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = resolve(dir, name);
      const rel = relative(root, full).split(sep).join("/");
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        walk(full);
      } else if (st.isFile() && re.test(rel)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

export function expandEntries(patterns: string[]): string[] {
  return [...new Set(patterns.flatMap((p) => (p.includes("*") ? expandGlob(p) : [p])))].sort();
}

export function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

/** 注释 → 等长空格掩码（保留换行与行列结构）。 */
export function maskComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** 花括号配平：取「精确选择器 + {」对应块的内容（找不到返回 null）。 */
export function balancedBlock(css: string, selector: string): string | null {
  const masked = maskComments(css);
  const needle = `${selector} {`;
  const start = masked.indexOf(needle);
  if (start === -1) return null;
  let depth = 0;
  const open = start + needle.length - 1;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") {
      depth--;
      if (depth === 0) return masked.slice(open + 1, i);
    }
  }
  return null;
}

export function tokensInBlock(css: string, selector: string): Set<string> {
  const block = balancedBlock(css, selector);
  if (!block) return new Set();
  return new Set(
    [...block.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]),
  );
}

export function declaredTokens(source: string): Set<string> {
  return new Set(
    [...maskComments(source).matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:/gm)].map(
      (m) => m[1],
    ),
  );
}

export function referencedTokens(source: string): string[] {
  return [...maskComments(source).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]);
}

/** S1：清单内全部 CSS 文件的 token 定义并集（跨文件）。 */
export function definitionUnion(fixture: ThemeEntries): Set<string> {
  const set = new Set<string>();
  for (const f of expandEntries(fixture.tokenDefinitionFiles)) {
    if (!existsSync(resolve(root, f))) {
      throw new Error(`清单登记的样式入口不存在：${f}`);
    }
    for (const t of declaredTokens(readSrc(f))) set.add(t);
  }
  return set;
}

/**
 * S9：返回违反「hex/rgba 仅允许出现在 token 定义行」的行。
 * 多行 token 声明（--x: … ; 跨行）按声明状态机整体放行；
 * s9-allow 标记：独立注释行豁免其下一条非空行，行内标记豁免本行。
 */
export function s9Offenders(raw: string): { line: number; text: string }[] {
  const masked = maskComments(raw);
  const rawLines = raw.split("\n");
  const lines = masked.split("\n");
  const exempt = new Set<number>();
  rawLines.forEach((l, i) => {
    if (/s9-allow/.test(l)) {
      exempt.add(i);
      if (/^\s*\/\*/.test(l)) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        exempt.add(j);
      }
    }
  });
  const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\(/g;
  const out: { line: number; text: string }[] = [];
  let inTokenDecl = false;
  lines.forEach((line, i) => {
    if (/^\s*--[\w-]+\s*:/.test(line)) inTokenDecl = true;
    colorRe.lastIndex = 0;
    if (colorRe.test(line) && !inTokenDecl && !exempt.has(i)) {
      out.push({ line: i + 1, text: rawLines[i].trim() });
    }
    if (inTokenDecl && line.includes(";")) inTokenDecl = false;
  });
  return out;
}

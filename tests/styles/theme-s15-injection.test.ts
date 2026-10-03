import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { readFixture, readSrc } from "../helpers/theme-css";

// #224 S15（N11-2/N14）：主题/自定义 CSS 的「注入函数」体内禁止 innerHTML 赋值，
// 必须 textContent 或 CSSOM（防 </style><script> 逃逸）。
// 定位口径是函数级，不是全仓 grep；与主题注入无关的 12 处既有 innerHTML 用
// innerHTMLAllowlist 显式豁免（新增文件用 innerHTML 会让第二个用例失败）。
function extractFunctionBody(source: string, name: string): string | null {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = source.match(re);
  if (!m || m.index === undefined) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return null;
}

describe("S15 注入函数必须 textContent/CSSOM（N11-2，函数级口径）", () => {
  const fixture = readFixture();

  for (const { file, names } of fixture.injectionFunctions) {
    const source = readSrc(file);
    for (const name of names) {
      it(`${file} :: ${name}() 不含 innerHTML 赋值`, () => {
        const body = extractFunctionBody(source, name);
        expect(body, `${name} 未找到（函数改名后须同步 theme-entries.json）`).toBeTruthy();
        expect(body).not.toMatch(/\.innerHTML\s*=/);
        // 注入函数既然写 CSS，就必须走 textContent
        expect(body).toMatch(/\.textContent\s*=/);
      });
    }
  }

  it("innerHTML 豁免清单与磁盘实际一致（新增使用点须显式评审登记）", () => {
    const filesWithInnerHTML = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = resolve(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
          if (name === "node_modules" || name === "dist") continue;
          walk(full);
        } else if (st.isFile() && /\.(ts|tsx)$/.test(name)) {
          if (/\.innerHTML\s*=/.test(readFileSync(full, "utf8"))) {
            filesWithInnerHTML.add(
              relative(resolve(process.cwd()), full).split("\\").join("/"),
            );
          }
        }
      }
    };
    walk(resolve(process.cwd(), "src"));
    const allow = new Set(fixture.innerHTMLAllowlist);
    const unlisted = [...filesWithInnerHTML].filter((f) => !allow.has(f));
    const stale = [...allow].filter((f) => !filesWithInnerHTML.has(f));
    expect(unlisted, `存在未登记 innerHTML 使用点：${unlisted.join(", ")}`).toEqual([]);
    expect(stale, `豁免清单含已不存在的文件（请清理）：${stale.join(", ")}`).toEqual([]);
  });
});

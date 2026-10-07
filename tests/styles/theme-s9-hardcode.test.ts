import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  readFixture,
  expandEntries,
  readSrc,
  s9Offenders,
} from "../helpers/theme-css";

// #224 S9 + 未登记守卫 + 白名单同步。
describe("S9 零硬编码色 + 入口登记守卫 + 白名单同步（#223/#224）", () => {
  const fixture = readFixture();

  it("S9 tokenDefinitionFiles 内所有 hex/rgba 只出现在 --token 定义行（先剥注释口径）", () => {
    for (const rel of expandEntries(fixture.tokenDefinitionFiles)) {
      const offenders = s9Offenders(readSrc(rel));
      expect(offenders, `${rel} 存在非 token 定义行的硬编码色值：\n${offenders
        .map((o) => `  L${o.line}: ${o.text}`)
        .join("\n")}`).toEqual([]);
    }
  });

  it("s9-allow 豁免标记只能引用清单登记的 marker（issue-i1 存量 --bg 白块）", () => {
    for (const rel of expandEntries(fixture.tokenDefinitionFiles)) {
      const raw = readSrc(rel);
      const markers = [...raw.matchAll(/s9-allow:\s*([\w-]+)/g)].map((m) => m[1]);
      for (const m of markers) {
        expect(fixture.s9AllowMarkers, `${rel} 使用了未登记的 s9-allow 标记：${m}`).toContain(m);
      }
    }
  });

  it("未登记守卫：src 下所有 .css 必须被 tokenDefinitionFiles 覆盖（新增样式入口须登记）", () => {
    const registered = new Set(expandEntries(fixture.tokenDefinitionFiles));
    // 直接从磁盘枚举 src 下全部 CSS
    const actual = new Set<string>();
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".")) continue;
        const full = resolve(dir, name);
        const st = statSync(full);
        const prefix = resolve(process.cwd()) + "/";
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && name.endsWith(".css"))
          actual.add(full.slice(prefix.length).split("\\").join("/"));
      }
    };
    walk(resolve(process.cwd(), "src"));
    const unregistered = [...actual].filter((f) => !registered.has(f));
    expect(unregistered, `未登记的样式入口：${unregistered.join(", ")}`).toEqual([]);
  });

  it("白名单 src/theme/token-whitelist.json 与 App.css 定义保持同步（分类无遗漏）", () => {
    const whitelist = JSON.parse(
      readFileSync(resolve(process.cwd(), "src/theme/token-whitelist.json"), "utf8"),
    ) as {
      base: string[];
      shell: string[];
      content: string[];
      existingNamesByLayer: { shell: string[]; content: string[] };
    };
    const appCss = readSrc(fixture.themeBlocks.file);
    const appTokens = new Set(
      [...appCss.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1]),
    );
    const listed = new Set([
      ...whitelist.base,
      ...whitelist.shell,
      ...whitelist.content,
    ]);
    // App.css 定义的每个 token 都必须在白名单中有归属
    const missing = [...appTokens].filter((t) => !listed.has(t));
    expect(missing, `白名单缺少 token 归属：${missing.join(", ")}`).toEqual([]);
    // 白名单不应有 App.css 未定义的幽灵 token
    const ghosts = [...listed].filter((t) => !appTokens.has(t));
    expect(ghosts, `白名单存在未定义 token：${ghosts.join(", ")}`).toEqual([]);
    // 分类自洽：shell 桶 = --shell-* 前缀 + existingNamesByLayer.shell（不改名的外壳层现有名）
    const shellExisting = new Set(whitelist.existingNamesByLayer.shell);
    for (const t of whitelist.shell) {
      expect(
        t.startsWith("--shell-") || shellExisting.has(t),
        `shell 桶分类错误：${t}`,
      ).toBe(true);
    }
    // content 桶 = --content-*/--code-block-* 前缀 + existingNamesByLayer.content
    const contentExisting = new Set(whitelist.existingNamesByLayer.content);
    for (const t of whitelist.content) {
      expect(
        t.startsWith("--content-") || t.startsWith("--code-block-") || contentExisting.has(t),
        `content 桶分类错误：${t}`,
      ).toBe(true);
    }
    // 三桶互斥（同一 token 不得跨桶）
    const seen = new Set<string>();
    for (const t of [...whitelist.base, ...whitelist.shell, ...whitelist.content]) {
      expect(seen.has(t), `token 跨界重复归属：${t}`).toBe(false);
      seen.add(t);
    }
  });
});

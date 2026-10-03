import { describe, it, expect } from "vitest";
import {
  readFixture,
  expandEntries,
  readSrc,
  maskComments,
} from "../helpers/theme-css";

// #224 S13 源级部分（E2E 部分见 theme-layers.spec.ts，含 N17 公式触发）：
// 18 个 base 入口必须全部入层——
//   wrap=source        ：文件整体 @layer base { … } 源码包裹；
//   wrap=import-layer  ：wrapper CSS 仅含 @import "…" layer(base)（@import 须在表首）。
// 层序 statement 必须在 index.html 内联、且位于任何 script/样式表之前（N1 唯一落点）。
describe("S13 源级：18 个 base 入口全部入层 + statement 落点（N1/N2/N17）", () => {
  const fixture = readFixture();
  const layers = fixture.layers;

  it("base 入口展开后恰好 18 个（1 App.css + 14 组件 CSS + 3 vendor 插件包裹）", () => {
    const sourceEntries = layers.base.filter((b) => b.wrap === "source");
    const pluginEntries = layers.base.filter((b) => b.wrap === "plugin-transform");
    const resolvedSource = expandEntries(sourceEntries.map((e) => e.entry));
    expect(resolvedSource).toHaveLength(15);
    expect(pluginEntries).toHaveLength(3);
    expect(resolvedSource.length + pluginEntries.length).toBe(18);
  });

  it("wrap=source 的文件首条规则为 @layer base 开块、文件以其闭块收尾", () => {
    for (const e of layers.base.filter((b) => b.wrap === "source")) {
      for (const rel of expandEntries([e.entry])) {
        const masked = maskComments(readSrc(rel));
        const trimmed = masked.trim();
        expect(trimmed.startsWith("@layer base {"), `${rel} 未以 @layer base { 开头`).toBe(true);
        expect(trimmed.endsWith("}"), `${rel} 未以层块闭括号收尾`).toBe(true);
      }
    }
  });

  it("wrap=plugin-transform 的 3 个 vendor 目标均被 vite.config.ts 的 themeBaseLayerPlugin 登记包裹", () => {
    const viteConfig = readSrc("vite.config.ts");
    expect(viteConfig).toContain("inkling-theme-base-layer");
    for (const e of layers.base.filter((b) => b.wrap === "plugin-transform")) {
      // 清单里的入口文件名必须出现在插件匹配器列表中（S13 源级代理；运行时由 E2E/S16 兜底）
      const file = e.entry.split("/").pop()!;
      expect(viteConfig).toContain(file);
    }
  });

  it("index.html 内联层序 statement 内容为 @layer base, theme, user（且仅此一个内联样式块）", () => {
    // 先剥 HTML 注释（注释文本里也写了 <style> 字样，不能让它干扰匹配）
    const html = readSrc("index.html").replace(/<!--[\s\S]*?-->/g, "");
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)];
    expect(styles).toHaveLength(1);
    expect(styles[0][1].replace(/\s+/g, " ").trim()).toBe("@layer base, theme, user;");
    expect(styles[0][0]).toContain(`id="${layers.layerStatement.elementId}"`);
  });

  it("N1：层序 statement 位于 <script> 之前（唯一落点，不在 App.css 首行）", () => {
    const html = readSrc("index.html").replace(/<!--[\s\S]*?-->/g, "");
    const statementIdx = html.indexOf(`id="${layers.layerStatement.elementId}"`);
    const scriptIdx = html.indexOf("<script");
    expect(statementIdx).toBeGreaterThan(-1);
    expect(scriptIdx).toBeGreaterThan(-1);
    expect(statementIdx).toBeLessThan(scriptIdx);
    const appCss = readSrc("src/App.css");
    // App.css 首行起不得是层序 statement（N1 防回归）
    expect(maskComments(appCss).trimStart().startsWith("@layer base,")).toBe(false);
  });
});

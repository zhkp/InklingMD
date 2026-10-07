import { describe, it, expect } from "vitest";
import {
  readFixture,
  expandEntries,
  readSrc,
  definitionUnion,
} from "../helpers/theme-css";

// #224 S3/S4：由主题入口清单驱动，不再硬编码单个文件路径。
describe("UI/UX Design Tokens & Layout 验证（#224 S3/S4）", () => {
  const fixture = readFixture();

  it("S3 必备 token 在 tokenDefinitionFiles 的定义并集中声明", () => {
    const defined = definitionUnion(fixture);
    const missing = fixture.requiredTokens.filter((t) => !defined.has(t));
    expect(missing).toEqual([]);
  });

  it("S4 错误色统一走 --danger，hardcodeScanFiles 不得硬编码 #cf222e（允许定义行与 var 回退）", () => {
    // #228 复审 P3-③：.qo-error / .gs-error 曾硬编码 #cf222e，深色主题下偏暗；
    // 顺手对齐 .mermaid-error。此断言覆盖到具体文件，防止回退。
    for (const rel of fixture.hardcodeScanFiles) {
      const css = readSrc(rel);
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
      const offenders = withoutComments
        .split("\n")
        .filter((line) => line.includes("#cf222e"))
        // 允许：变量定义本身，以及 var(--danger, #cf222e) 的回退值
        .filter(
          (line) =>
            !line.includes("--danger:") &&
            !line.includes("var(--danger") &&
            !line.includes("--callout-accent:"),
        );
      expect(offenders, `${rel} 仍有硬编码错误色：${offenders.join(" | ")}`).toEqual([]);
    }
  });

  it("清单的 glob 展开包含全部 14 个组件 CSS 且 App.css 在列", () => {
    const files = expandEntries(fixture.tokenDefinitionFiles);
    expect(files).toContain("src/App.css");
    expect(files.filter((f) => f.startsWith("src/components/") && f.endsWith(".css"))).toHaveLength(14);
  });
});

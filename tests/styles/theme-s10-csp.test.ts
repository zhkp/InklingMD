import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #224 S10（#309/G7/G7-c）：asset 协议 CSP token 完整性。
// 该问题只在打包产物暴露（dev 无 CSP、E2E 跑浏览器非 asset 协议），CI 无法靠
// 运行时行为兜住，必须由源级静态断言保证。
function tauriConf(): { security: { csp: string; dangerousDisableAssetCspModification?: unknown } } {
  const conf = JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
  );
  return conf.app;
}

function directives(): Map<string, string[]> {
  const csp: string = tauriConf().security.csp;
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length) map.set(tokens[0], tokens.slice(1));
  }
  return map;
}

describe("S10 CSP asset 协议 token 完整性（G7/G7-c/#309）", () => {
  const csp = directives();

  it("img-src 同时包含两平台 asset token（asset: 与 http://asset.localhost）与 data:", () => {
    const img = csp.get("img-src") ?? [];
    expect(img).toContain("asset:");
    expect(img).toContain("http://asset.localhost");
    expect(img).toContain("data:");
    expect(img).toContain("'self'");
  });

  it("font-src 已声明且包含 'self' / data: / asset: / http://asset.localhost，但不含 https:（不放开远程字体）", () => {
    const font = csp.get("font-src");
    expect(font, "font-src 必须显式声明（否则回落 default-src 拦掉本地与 base64 字体）").toBeTruthy();
    expect(font).toContain("'self'"); // KaTeX 20 条 @font-face 走同源 /assets
    expect(font).toContain("data:");
    expect(font).toContain("asset:");
    expect(font).toContain("http://asset.localhost");
    expect(font).not.toContain("https:");
  });

  // #310 评审阻塞项 2：index.html 的内联层序 statement 会让 Tauri codegen 给该
  // <style> 注入 nonce 占位符，运行期 `replace_csp_nonce` 随即把 'nonce-…' 追加进
  // style-src；而 CSP3 规定指令里出现 nonce 时 'unsafe-inline' 失效 →
  // 所有运行时注入的 <style> 被拦（CodeMirror style-mod、自定义 CSS、mermaid 的
  // SVG 内 <style>）。故必须显式关闭 style-src 的 CSP 修改。
  // 依据：tauri-utils-2.9.3/src/html2.rs:67-77（can_modify("style-src") 门控）、
  //       tauri-2.11.5/src/manager/mod.rs:96-104（replace_csp_nonce 仅在可修改时执行）。
  it("style-src 不得进入 nonce 模式：index.html 有内联 <style> 时必须关闭 style-src 的 CSP 修改", () => {
    const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8").replace(
      /<!--[\s\S]*?-->/g,
      "",
    );
    expect(/<style[\s>]/.test(html), "层序 statement 必须仍在 index.html 内联（N1）").toBe(true);

    const disabled = tauriConf().security.dangerousDisableAssetCspModification;
    const styleModificationDisabled =
      disabled === true || (Array.isArray(disabled) && disabled.includes("style-src"));
    expect(
      styleModificationDisabled,
      '缺少 security.dangerousDisableAssetCspModification: ["style-src"]：层序 statement 会让 release 的 style-src 进入 nonce 模式，运行时 <style> 全部失效',
    ).toBe(true);
    expect(csp.get("style-src"), "style-src 必须保留 'unsafe-inline'").toContain(
      "'unsafe-inline'",
    );
  });
});

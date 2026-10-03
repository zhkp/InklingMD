import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// #224 S10（#309/G7/G7-c）：asset 协议 CSP token 完整性。
// 该问题只在打包产物暴露（dev 无 CSP、E2E 跑浏览器非 asset 协议），CI 无法靠
// 运行时行为兜住，必须由源级静态断言保证。
function directives(): Map<string, string[]> {
  const conf = JSON.parse(
    readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
  );
  const csp: string = conf.app.security.csp;
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
});

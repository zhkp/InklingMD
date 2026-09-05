// #162 asset 静态 scope 收缩 回归防护
// tauri.conf.json 的 assetProtocol.scope 是静态放行（运行时 allow_asset_dir 之外的第二层）。
// Tauri v2.11 语义：$DATA/$TEMP 分别展开为「通用数据目录」（Windows 即整个 %APPDATA%，
// 覆盖所有应用）与系统临时目录——过宽。$APPDATA/$APPLOCALDATA 才是应用专属目录。
// 此测试防止 scope 被重新放宽或误加回通用变量。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadScope(): string[] {
  const raw = readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8");
  const conf = JSON.parse(raw) as {
    app?: {
      security?: {
        assetProtocol?: { scope?: string[] };
      };
    };
  };
  const scope = conf.app?.security?.assetProtocol?.scope ?? [];
  expect(scope.length).toBeGreaterThan(0); // 配置结构意外变化时给出明确失败
  return scope;
}

describe("#162 asset 静态 scope", () => {
  it("只保留应用专属目录，不含通用数据/临时目录变量", () => {
    const scope = loadScope();

    // 应用专属目录保留（图片/附件若落在应用数据目录内仍可加载）
    expect(scope).toContain("$APPDATA/**");
    expect(scope).toContain("$APPLOCALDATA/**");

    // 过宽的通用变量必须移除（$DATA=整个 %APPDATA%、$TEMP=系统临时目录）
    expect(scope).toEqual(["$APPDATA/**", "$APPLOCALDATA/**"]);
    for (const entry of scope) {
      expect(entry).not.toMatch(/^\$(DATA|LOCALDATA|TEMP|CONFIG|CACHE|HOME)\//);
    }
  });

  it("不再覆盖其他应用的共享数据目录（防回归放宽）", () => {
    const scope = loadScope();
    // $DATA/$TEMP 等共享/系统目录一旦加回即视为失败
    expect(scope.some((s) => s.startsWith("$DATA/") || s.startsWith("$TEMP/"))).toBe(false);
  });
});

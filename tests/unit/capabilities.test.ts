// capabilities 配置防回归测试
// 此测试确保权限配置不回退

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import defaultCap from "../../src-tauri/capabilities/default.json";

function readCapabilities() {
  return defaultCap;
}

describe("capabilities/default.json ACL 权限配置（v1.2.10 防回归）", () => {
  const caps = readCapabilities();
  const permissions: string[] = caps.permissions;
  const permissionDefinitions = readFileSync(
    resolve(process.cwd(), "src-tauri/permissions/app-commands.toml"),
    "utf8",
  );
  const definedCommands = new Map(
    permissionDefinitions
      .split("[[permission]]")
      .slice(1)
      .map((block) => {
        const identifier = block.match(/identifier\s*=\s*"([^"]+)"/)?.[1] ?? "";
        const command = block.match(/commands\.allow\s*=\s*\["([^"]+)"\]/)?.[1] ?? "";
        return [identifier, command] as const;
      }),
  );

  it("包含 dialog:allow-message（alert() 映射需要）", () => {
    expect(permissions).toContain("dialog:allow-message");
  });

  it("包含 dialog:allow-ask（confirm() 映射需要）", () => {
    expect(permissions).toContain("dialog:allow-ask");
  });

  it("保留 dialog:allow-open 和 dialog:allow-save", () => {
    expect(permissions).toContain("dialog:allow-open");
    expect(permissions).toContain("dialog:allow-save");
  });

  it("包含 window destroy 与 close 权限（窗口退出逻辑需要）", () => {
    expect(permissions).toContain("core:window:allow-destroy");
    expect(permissions).toContain("core:window:allow-close");
  });

  it("包含全部 14 个自定义 app command 权限及对应 command 定义", () => {
    const expected = new Map([
      ["allow-list-dir", "list_dir"],
      ["allow-read-text-file", "read_text_file"],
      ["allow-write-text-file", "write_text_file"],
      ["allow-write-binary-file", "write_binary_file"],
      ["allow-file-mtime", "file_mtime"],
      ["allow-rename-path", "rename_path"],
      ["allow-delete-path", "delete_path"],
      ["allow-create-file", "create_file"],
      ["allow-create-dir", "create_dir"],
      ["allow-asset-dir", "allow_asset_dir"],
      ["allow-search-in-workspace", "search_in_workspace"],
      ["allow-pandoc-check", "pandoc_check"],
      ["allow-pandoc-export-docx", "pandoc_export_docx"],
      ["allow-take-pending-file", "take_pending_file"],
    ]);

    for (const [identifier, command] of expected) {
      expect(permissions).toContain(identifier);
      expect(definedCommands.get(identifier)).toBe(command);
    }
  });
});

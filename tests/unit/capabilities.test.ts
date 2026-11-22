// capabilities 配置防回归测试
// 此测试确保权限配置不回退
//
// #404 复核：lib.rs 的 `invoke_handler` 与 ACL 白名单必须逐条对齐。
// 之前只逐个断言「已列出的权限在不在」，漏掉了「注册了命令却没给权限」这一类——
// 于是 `save_document` / `write_recovery_file` 等 5 条命令在运行时被 ACL 直接拦截
// （实测报 `Command save_document not allowed by ACL`），单测却全绿。
// 这里改成从 lib.rs 解析已注册命令，双向比对。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import defaultCap from "../../src-tauri/capabilities/default.json";

function readCapabilities() {
  return defaultCap;
}

/**
 * `save_document` → `allow-save-document`（Tauri 的 app command 权限命名规则）。
 *
 * 例外：命令名自带 `allow_` 前缀时去掉它 —— `allow_asset_dir` → `allow-asset-dir`
 * （与 `permissions/app-commands.toml` 头部注释的例外规则逐字对应）。
 * 这条规则只在「没有其它 `allow_*` 命令」时是单射的，下面有专门断言守住这个前提。
 */
function permissionIdOf(command: string): string {
  return `allow-${command.replace(/^allow_/, "").replace(/_/g, "-")}`;
}

/** 从 lib.rs 的 `generate_handler![...]` 解析实际注册的命令名（去掉模块前缀） */
function registeredCommands(): string[] {
  const libRs = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
  const block = libRs.match(/generate_handler!\[([\s\S]*?)\]\s*\)/)?.[1] ?? "";
  expect(block.length).toBeGreaterThan(0);
  return block
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => line.split(","))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("::").pop() ?? line);
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

  it("invoke_handler 里每个 command 都有 ACL 权限（否则运行时被拦截）", () => {
    const registered = registeredCommands();
    // 兜底：解析失败（正则被改动）时不能静默通过
    expect(registered.length).toBeGreaterThanOrEqual(25);

    const missingDefinition = registered.filter(
      (command) => definedCommands.get(permissionIdOf(command)) !== command,
    );
    expect(
      missingDefinition,
      `permissions/app-commands.toml 缺少这些命令的 [[permission]]：${missingDefinition.join(", ")}`,
    ).toEqual([]);

    const missingCapability = registered.filter(
      (command) => !permissions.includes(permissionIdOf(command)),
    );
    expect(
      missingCapability,
      `capabilities/default.json 未引用这些命令权限：${missingCapability.join(", ")}`,
    ).toEqual([]);
  });

  it("app command 权限无冗余定义，且 identifier 与 command 命名一致", () => {
    for (const [identifier, command] of definedCommands) {
      expect(permissionIdOf(command), `identifier 与命令名不一致：${identifier}`).toBe(identifier);
    }
    // 反向：toml 里不得有「谁都不注册」的权限（漂移的另一半）
    const registered = new Set(registeredCommands());
    const orphaned = [...definedCommands.values()].filter((command) => !registered.has(command));
    expect(orphaned, `permissions 定义了未注册的命令：${orphaned.join(", ")}`).toEqual([]);
    // [[permission]] 块数必须等于去重后的 identifier 数：重复 identifier 会被 Map 静默去重，
    // 那样「无冗余」就变成了假通过
    const blockCount = permissionDefinitions.split("[[permission]]").length - 1;
    expect(blockCount, "存在重复的 [[permission]] 块").toBe(definedCommands.size);

    const appPermissions = permissions.filter((id) => id.startsWith("allow-"));
    const dangling = appPermissions.filter((id) => !definedCommands.has(id));
    expect(dangling, `capabilities 引用了未定义的权限：${dangling.join(", ")}`).toEqual([]);
    const missingCapability = [...definedCommands.keys()].filter((id) => !permissions.includes(id));
    expect(missingCapability, `权限未在 capabilities 中引用：${missingCapability.join(", ")}`).toEqual(
      [],
    );
  });

  it("除 allow_asset_dir 外没有别的 allow_ 前缀命令（permissionIdOf 的前提）", () => {
    // `permissionIdOf` 会剥掉 `allow_` 前缀，两条命令若都以此开头就可能撞成同一个 identifier
    const allowPrefixed = registeredCommands().filter(
      (command) => command.startsWith("allow_") && command !== "allow_asset_dir",
    );
    expect(
      allowPrefixed,
      `新增 allow_ 前缀命令需先为它显式定义 identifier 规则：${allowPrefixed.join(", ")}`,
    ).toEqual([]);
  });

  it("保留既有关键命令权限（历史回归）", () => {
    const expected = new Map([
      ["allow-list-dir", "list_dir"],
      ["allow-read-text-file", "read_text_file"],
      ["allow-write-text-file", "write_text_file"],
      ["allow-write-binary-file", "write_binary_file"],
      ["allow-read-binary-file", "read_binary_file"],
      ["allow-file-mtime", "file_mtime"],
      ["allow-rename-path", "rename_path"],
      ["allow-delete-path", "delete_path"],
      ["allow-create-file", "create_file"],
      ["allow-create-dir", "create_dir"],
      ["allow-asset-dir", "allow_asset_dir"],
      ["allow-search-in-workspace", "search_in_workspace"],
      ["allow-list-workspace-files", "list_workspace_files"],
      ["allow-pandoc-check", "pandoc_check"],
      ["allow-pandoc-export-docx", "pandoc_export_docx"],
      ["allow-take-pending-file", "take_pending_file"],
      // Smart Paste 远程图片落盘（#220）
      ["allow-download-remote-image", "download_remote_image"],
      ["allow-find-asset-by-hash", "find_asset_by_hash"],
      // 主题导入（#307）
      ["allow-scan-theme-dir", "scan_theme_dir"],
      ["allow-copy-path", "copy_path"],
      ["allow-extract-zip", "extract_zip"],
      ["allow-resource-themes-dir", "resource_themes_dir"],
      // 应用数据根（#404）
      ["allow-app-data-root", "app_data_root"],
      ["allow-take-portable-migration", "take_portable_migration"],
    ]);

    for (const [identifier, command] of expected) {
      expect(permissions).toContain(identifier);
      expect(definedCommands.get(identifier)).toBe(command);
    }
  });
});

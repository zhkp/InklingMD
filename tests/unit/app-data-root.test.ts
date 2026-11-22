// #404：应用数据根的唯一取值点 + 迁移提示文案。
//
// 这层锁的是「便携模式的落点」：themes / recovery 必须与 Rust 侧
// `resolve_app_data_dir` 同源，否则便携包的数据仍写系统目录（issue 的原始症状），
// 或前端算出的路径被 `write_recovery_file` 的守卫判成越界。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

import {
  appDataRoot,
  portableMigrationMessage,
  takePortableMigration,
  type PortableMigration,
} from "../../src/lib/appDataRoot";
import { themesRoot } from "../../src/lib/themeFiles";

/** 便携模式的实际形态：数据在 exe 同级 */
const PORTABLE_ROOT = "D:\\Portable\\InklingMD\\data";

const EMPTY_REPORT: PortableMigration = {
  from: "C:\\Users\\x\\AppData\\Roaming\\com.inklingmd.editor",
  to: PORTABLE_ROOT,
  copied: [],
  failed: [],
  skipped: [],
  warnings: [],
};

beforeEach(() => {
  invokeMock.mockReset();
  isTauriMock.mockReturnValue(true);
});

describe("#404 应用数据根", () => {
  it("走 `app_data_root` 命令，而不是前端的 appDataDir() 猜测", async () => {
    invokeMock.mockResolvedValue(PORTABLE_ROOT);

    await expect(appDataRoot()).resolves.toBe(PORTABLE_ROOT);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("app_data_root");
  });

  it("themes 目录拼在应用数据根下：便携模式落 exe 同级 data/themes", async () => {
    invokeMock.mockResolvedValue(PORTABLE_ROOT);

    // 真实链路：themesRoot → appDataRoot → invoke("app_data_root") → join/normalize
    await expect(themesRoot()).resolves.toBe("D:/Portable/InklingMD/data/themes");
  });

  it("取不到根时把错误抛给调用方（不静默落到错误目录）", async () => {
    invokeMock.mockRejectedValue(new Error("取应用数据目录失败"));

    await expect(appDataRoot()).rejects.toThrow("取应用数据目录失败");
  });
});

describe("#404 便携迁移提示", () => {
  it("取迁移结果走 `take_portable_migration`，没有迁移时为 null", async () => {
    invokeMock.mockResolvedValue(null);

    await expect(takePortableMigration()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("take_portable_migration");
  });

  it("浏览器预览不调用 Tauri 命令", async () => {
    isTauriMock.mockReturnValue(false);

    await expect(takePortableMigration()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("把 Rust 报告原样交给调用方（copied / failed / skipped / warnings 都不吞）", async () => {
    const report: PortableMigration = {
      ...EMPTY_REPORT,
      copied: ["themes", "recovery"],
      skipped: ["themes/link.css: 符号链接，未迁移"],
      warnings: ["主题目录未加入 asset 白名单"],
    };
    invokeMock.mockResolvedValue(report);

    await expect(takePortableMigration()).resolves.toEqual(report);
  });

  // 首句是用户唯一会读的一句：`copied` 为空还写「已复制」等于把失败伪装成成功
  it("全部复制成功 → info，首句明说已复制", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      copied: ["themes", "recovery"],
    });

    expect(kind).toBe("info");
    expect(text.split("\n")[0]).toContain("已把系统目录的应用数据复制到便携目录");
    expect(text).toContain("themes、recovery");
    expect(text).toContain(PORTABLE_ROOT);
  });

  it("全部失败 → error，首句不得声称已复制", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      failed: ["themes: 复制失败 磁盘已满"],
    });

    expect(kind).toBe("error");
    const headline = text.split("\n")[0];
    expect(headline).toBe("便携模式数据迁移未完成。");
    expect(headline).not.toContain("已把");
    expect(text).toContain("磁盘已满");
  });

  it("部分失败 → error，首句区分「部分」", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      copied: ["recovery"],
      failed: ["themes: 复制失败 磁盘已满"],
    });

    expect(kind).toBe("error");
    expect(text.split("\n")[0]).toBe("便携模式数据迁移部分失败。");
  });

  it("一个字节都没复制（已有数据不合并）→ warning，首句不替原因下结论", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      skipped: ["themes: 便携目录已有数据，未合并（需要的话请手动复制旧位置的内容）"],
    });

    expect(kind).toBe("warning");
    expect(text.split("\n")[0]).toBe("便携模式：本次没有复制任何数据。");
    expect(text).toContain("未合并");
  });

  it("没复制的原因是符号链接 → 首句仍只说「没有复制」，不得谎称「已有数据」", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      skipped: ["themes: 旧位置是符号链接，未跟随复制（如需搬走请直接复制链接目标）"],
    });

    expect(kind).toBe("warning");
    expect(text.split("\n")[0]).toBe("便携模式：本次没有复制任何数据。");
    expect(text.split("\n")[0]).not.toContain("已有数据");
    expect(text).toContain("符号链接");
  });

  it("复制成功但有启动警告（如 asset scope 放行失败）→ warning，首句仍是「已复制」", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      copied: ["themes"],
      warnings: ["主题目录未加入 asset 白名单，主题里的图片/字体将无法加载"],
    });

    expect(kind).toBe("warning");
    // 启动问题不是「数据没搬」，首句不能这么说
    expect(text.split("\n")[0]).toBe("便携模式：已把系统目录的应用数据复制到便携目录。");
    expect(text).toContain("主题目录未加入 asset 白名单");
  });

  it("复制成功但有条目被跳过 → warning，首句说清「部分条目没有复制」", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      copied: ["themes"],
      skipped: ["recovery: 便携目录已有数据，未合并（需要的话请手动复制旧位置的内容）"],
    });

    expect(kind).toBe("warning");
    expect(text.split("\n")[0]).toBe("便携模式：已复制应用数据，但有部分条目没有复制。");
    expect(text).toContain("recovery");
  });

  it("来源为空时不输出空的「来源：」行（取不到旧目录 / 旧目录即便携目录）", () => {
    const { text, kind } = portableMigrationMessage({
      from: "",
      to: PORTABLE_ROOT,
      copied: [],
      failed: [],
      skipped: [],
      warnings: ["取旧数据目录失败，本次未迁移旧数据: 拒绝访问"],
    });

    expect(kind).toBe("warning");
    expect(text).not.toContain("来源：\n");
    expect(text.split("\n").some((line) => line.trim() === "来源：")).toBe(false);
    expect(text).toContain(PORTABLE_ROOT);
  });

  it("只有启动问题（什么都没迁）→ warning，首句与「数据迁移」区分开", () => {
    const { text, kind } = portableMigrationMessage({
      ...EMPTY_REPORT,
      warnings: ["主题目录未加入 asset 白名单，主题里的图片/字体将无法加载"],
    });

    expect(kind).toBe("warning");
    expect(text.split("\n")[0]).toBe("便携模式已启动，但有以下启动问题。");
    expect(text).toContain("asset 白名单");
  });
});

// 报告形状是 Rust → IPC → TS 的跨语言契约：任何一侧改名都必须在测试里红，
// 否则前端会把 undefined 静默当成空数组（弹窗少一行，没人发现）
describe("#404 迁移报告字段契约（Rust ↔ TS 逐字同名）", () => {
  const FIELDS = ["from", "to", "copied", "failed", "skipped", "warnings"];

  it("Rust PortableMigration 的字段与 TS 接口一致", () => {
    const rustSource = readFileSync(
      resolve(process.cwd(), "src-tauri/src/app_paths.rs"),
      "utf8",
    );
    const structBody =
      rustSource.match(/pub struct PortableMigration \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const rustFields = [...structBody.matchAll(/^\s*pub (\w+):/gm)].map((match) => match[1]);

    const tsSource = readFileSync(resolve(process.cwd(), "src/lib/appDataRoot.ts"), "utf8");
    const interfaceBody =
      tsSource.match(/export interface PortableMigration \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const tsFields = [...interfaceBody.matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1]);

    // 解析失败要显式失败，不能「两个空数组相等」蒙过去
    expect(rustFields.length).toBeGreaterThan(0);
    expect(tsFields.length).toBeGreaterThan(0);
    expect([...rustFields].sort()).toEqual([...FIELDS].sort());
    expect([...tsFields].sort()).toEqual([...FIELDS].sort());
  });
});

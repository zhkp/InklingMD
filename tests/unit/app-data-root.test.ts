// #404：应用数据根的唯一取值点。
//
// 这层锁的是「便携模式的落点」：themes / recovery 必须与 Rust 侧
// `resolve_app_data_dir` 同源，否则便携包的数据仍写系统目录（issue 的原始症状），
// 或前端算出的路径被 `write_recovery_file` 的守卫判成越界。

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(() => true),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

vi.mock("../../src/lib/fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/fs")>();
  return { ...actual, createDir: vi.fn(async () => undefined) };
});

import { appDataRoot, takePortableMigration } from "../../src/lib/appDataRoot";
import { themesRoot } from "../../src/lib/themeFiles";

/** 便携模式的实际形态：数据在 exe 同级 */
const PORTABLE_ROOT = "D:\\Portable\\InklingMD\\data";

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

  it("把 Rust 报告原样交给调用方（copied / failed / skipped 都不吞）", async () => {
    const report = {
      from: "C:\\Users\\x\\AppData\\Roaming\\com.inklingmd.editor",
      to: PORTABLE_ROOT,
      copied: ["themes", "recovery"],
      failed: [],
      skipped: ["themes/link.css: 符号链接，未迁移"],
    };
    invokeMock.mockResolvedValue(report);

    await expect(takePortableMigration()).resolves.toEqual(report);
  });
});

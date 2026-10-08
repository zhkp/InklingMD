// #225 §3/§3.1/§3.2/C3/C7：应用级主题身份与清单的单测（含旧值迁移与 G11 复用）。
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_DARK_ID,
  BUILTIN_LIGHT_ID,
  DEFAULT_THEME_ID,
  getTheme,
  isBuiltinThemeId,
  isSnapshotEligible,
  listThemes,
  registerThemes,
  resetRegisteredThemes,
  resolveLegacyThemeId,
  themeDisplayName,
  themeModeOf,
  userThemeFromFileName,
  type AppTheme,
} from "../../src/theme/registry";

afterEach(() => {
  resetRegisteredThemes();
});

describe("#225 §3.1 themeId 身份", () => {
  it("内置基线固定为 builtin:light / builtin:dark，且默认主题是 builtin:light", () => {
    expect(BUILTIN_LIGHT_ID).toBe("builtin:light");
    expect(BUILTIN_DARK_ID).toBe("builtin:dark");
    expect(DEFAULT_THEME_ID).toBe(BUILTIN_LIGHT_ID);
    expect(isBuiltinThemeId(BUILTIN_DARK_ID)).toBe(true);
    expect(isBuiltinThemeId("user:vue")).toBe(false);
  });

  it("清单恒含两套内置基线且顺序稳定（其余按 id 排序）", () => {
    registerThemes([
      { id: "user:zebra", name: "Zebra", mode: "light", source: "user" },
      { id: "bundled:night", name: "Night", mode: "dark", source: "bundled" },
    ]);
    expect(listThemes().map((t) => t.id)).toEqual([
      BUILTIN_LIGHT_ID,
      BUILTIN_DARK_ID,
      "bundled:night",
      "user:zebra",
    ]);
  });

  it("内置基线不可被注册覆盖（幂等补齐不得改写基线的 mode）", () => {
    registerThemes([{ id: BUILTIN_DARK_ID, name: "伪造", mode: "light", source: "user" }]);
    expect(getTheme(BUILTIN_DARK_ID)?.name).toBe("深色");
    expect(themeModeOf(BUILTIN_DARK_ID)).toBe("dark");
  });

  it("mode 派生：描述符优先；描述符缺失时按 `-dark` 后缀回退（不抛错）", () => {
    registerThemes([{ id: "user:vue-dark", name: "Vue Dark", mode: "dark", source: "user" }]);
    expect(themeModeOf("user:vue-dark")).toBe("dark");
    expect(themeModeOf("user:unknown-dark")).toBe("dark");
    expect(themeModeOf("user:unknown")).toBe("light");
  });

  it("user:* 描述符由 G11 归一化派生（同一实现，不另立规则）", () => {
    const t = userThemeFromFileName("vue-dark.css");
    expect(t?.id).toBe("user:vue-dark");
    expect(t?.mode).toBe("dark");
    expect(t?.source).toBe("user");
    expect(userThemeFromFileName("notes.txt")).toBeUndefined();
  });

  it("G11 边界（冻结口径）：mode 后缀只认 `-dark`/`-light`，空格形态走启发式", () => {
    // 「Vue Dark.css」不含连字符后缀 → 不吃后缀规则（G11-4 优先级第 1 项失配）→ 无内容可判 → light
    const spaced = userThemeFromFileName("Vue Dark.css");
    expect(spaced?.id).toBe("user:vue-dark"); // slug 归一化仍把空格折成 `-`
    expect(spaced?.mode).toBe("light");
  });

  it("显示名：描述符 → 归一化文件名兜底", () => {
    expect(themeDisplayName(BUILTIN_LIGHT_ID)).toBe("浅色");
    expect(themeDisplayName("user:my-theme")).toBe("my-theme");
  });
});

describe("#225 C7 迁移：旧值（light/dark）→ themeId", () => {
  it("light / dark 映射为 builtin:light / builtin:dark", () => {
    expect(resolveLegacyThemeId("light")).toBe(BUILTIN_LIGHT_ID);
    expect(resolveLegacyThemeId("dark")).toBe(BUILTIN_DARK_ID);
    expect(resolveLegacyThemeId(" dark ")).toBe(BUILTIN_DARK_ID);
  });

  it("新格式原样通过（仅当清单里存在）", () => {
    expect(resolveLegacyThemeId("builtin:dark")).toBe(BUILTIN_DARK_ID);
    expect(resolveLegacyThemeId("user:vue")).toBeUndefined(); // 清单未注册 → 交由调用方回落
    registerThemes([{ id: "user:vue", name: "Vue", mode: "light", source: "user" }]);
    expect(resolveLegacyThemeId("user:vue")).toBe("user:vue");
  });

  it("空值 / 垃圾值 → undefined（不误当成主题）", () => {
    expect(resolveLegacyThemeId(null)).toBeUndefined();
    expect(resolveLegacyThemeId("")).toBeUndefined();
    expect(resolveLegacyThemeId("purple")).toBeUndefined();
  });
});

describe("#225 G9 P2-4：快照适用性", () => {
  it("仅 bundled:* / user:* 走快照", () => {
    expect(isSnapshotEligible("bundled:night")).toBe(true);
    expect(isSnapshotEligible("user:vue")).toBe(true);
    expect(isSnapshotEligible("builtin:light")).toBe(false);
    expect(isSnapshotEligible("builtin:github")).toBe(false);
  });
});

describe("#225：内置主题的 CSS 载体是契约化事实", () => {
  it("builtin:light/dark 声明 css.kind = none（样式由 App.css 变量块 + data-theme 提供）", () => {
    for (const t of listThemes().filter((x: AppTheme) => isBuiltinThemeId(x.id))) {
      expect(t.css).toEqual({ kind: "none" });
      expect(t.source).toBe("builtin-base");
    }
  });
});

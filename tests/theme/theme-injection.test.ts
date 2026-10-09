// #225 §4.2/§4.3（G3/G5/N5/N8/N11-2）：注入管线与首帧同步路径的单测。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAYER_STATEMENT_ID,
  THEME_STYLE_ID,
  USER_STYLE_ID,
  flushThemeInjection,
  injectThemeCss,
  injectUserCss,
  readInjectedThemeCss,
  readInjectedUserCss,
  readThemeIdAttribute,
  resetInjectionStateForTests,
  splitLeadingImports,
  writeThemeAttributes,
} from "../../src/theme/inject";
import {
  bootstrapFirstFrameTheme,
  applyTheme,
  currentThemeId,
  currentThemeMode,
  unloadThemeStyles,
} from "../../src/theme/session";
import {
  BUILTIN_DARK_ID,
  BUILTIN_LIGHT_ID,
  registerThemes,
  resetRegisteredThemes,
} from "../../src/theme/registry";
import {
  readSnapshot,
  readSnapshotState,
  snapshotKey,
  writeStoredThemeId,
  writeThemesIndex,
} from "../../src/theme/snapshot";

const USER_THEME = { id: "user:vue", name: "Vue", mode: "light" as const, source: "user" as const, hash: "abcd1234" };

function styleEl(id: string): HTMLStyleElement | null {
  const el = document.getElementById(id);
  return el instanceof HTMLStyleElement ? el : null;
}

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-id");
  resetInjectionStateForTests();
  resetRegisteredThemes();
  // 层序 statement 之外的注入元素应由被测代码创建（不预置），仅保留 statement 以贴近真实首帧
  const stmt = document.createElement("style");
  stmt.id = LAYER_STATEMENT_ID;
  stmt.textContent = "@layer base, theme, user;";
  document.head.appendChild(stmt);
});

afterEach(() => {
  resetInjectionStateForTests();
  resetRegisteredThemes();
});

describe("#225 §4.2：主题样式注入（@layer theme / 微任务 / 幂等 / 卸载）", () => {
  it("主题 CSS 包进 @layer theme，并推迟到微任务才写入 DOM（N8）", async () => {
    injectThemeCss("#write h1 { color: red }");
    // 同步阶段：DOM 里还没有主题样式（微任务尚未冲刷）
    expect(styleEl(THEME_STYLE_ID)).toBeNull();
    await Promise.resolve();
    const css = readInjectedThemeCss();
    expect(css).toContain("@layer theme {");
    expect(css).toContain("#write h1 { color: red }");
  });

  it("flushThemeInjection 可同步冲刷（测试/E2E 用），多次调用只保留最后一次", () => {
    injectThemeCss("a{}");
    injectThemeCss("b{}");
    flushThemeInjection();
    expect(readInjectedThemeCss()).toContain("b{}");
    expect(readInjectedThemeCss()).not.toContain("a{}");
  });

  it("幂等：内容相同时不重建元素（避免无谓样式重算与 DOM 抖动）", () => {
    injectThemeCss("same{}");
    flushThemeInjection();
    const first = styleEl(THEME_STYLE_ID);
    injectThemeCss("same{}");
    flushThemeInjection();
    expect(styleEl(THEME_STYLE_ID)).toBe(first);
  });

  it("卸载：css = null → 移除样式元素（不残留上一个主题的规则）", () => {
    injectThemeCss("x{}");
    flushThemeInjection();
    expect(styleEl(THEME_STYLE_ID)).not.toBeNull();
    injectThemeCss(null);
    flushThemeInjection();
    expect(styleEl(THEME_STYLE_ID)).toBeNull();
  });

  it("N11-2：`</style><script>` 逃逸载荷只作为**文本**存在，不会生成脚本节点", () => {
    const payload = "#a{color:red}</style><script>window.__x=1</script>";
    injectThemeCss(payload);
    flushThemeInjection();
    const el = styleEl(THEME_STYLE_ID)!;
    // 文本原样保留（说明没被 HTML 解析/转义），但**没有**产生任何子元素或脚本节点
    expect(el.textContent).toContain("</style><script>");
    expect(el.children).toHaveLength(0);
    expect(el.childNodes).toHaveLength(1);
    expect(el.childNodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __x?: number }).__x).toBeUndefined();
  });
});

describe("#225 §4.3-2/G6：自定义 CSS 注入 @layer user（最高层，N3 不剥 !important）", () => {
  it("包进 @layer user 且保留 !important", () => {
    injectUserCss("#write h1 { color: red !important }");
    const css = readInjectedUserCss()!;
    expect(css).toContain("@layer user {");
    expect(css).toContain("!important");
  });

  it("表首 @import 提到 layer 之外（@import 属表首限定，包进 layer 会失效）", () => {
    const { imports, rest } = splitLeadingImports('@import "a.css";\n@import url(b.css);\n#x{color:red}');
    expect(imports).toEqual(['@import "a.css";', "@import url(b.css);"]);
    expect(rest).toBe("#x{color:red}");
    injectUserCss('@import "a.css";\n#x{color:red}');
    const css = readInjectedUserCss()!;
    expect(css.indexOf('@import "a.css";')).toBeLessThan(css.indexOf("@layer user {"));
  });

  it("清除自定义 CSS → 元素移除", () => {
    injectUserCss("x{}");
    expect(styleEl(USER_STYLE_ID)).not.toBeNull();
    injectUserCss(null);
    expect(styleEl(USER_STYLE_ID)).toBeNull();
  });
});

describe("#225 §4.2 / S7：注入次序（theme 先、user 后 → 自定义 CSS 天然最高层）", () => {
  it("先注入主题再注入自定义 CSS：DOM 中 theme 在 user 之前，statement 仍在最前", () => {
    injectThemeCss("theme-css{}");
    flushThemeInjection();
    injectUserCss("user-css{}");
    const ids = [...document.head.querySelectorAll("style")].map((el) => el.id);
    expect(ids[0]).toBe(LAYER_STATEMENT_ID);
    const iTheme = ids.indexOf(THEME_STYLE_ID);
    const iUser = ids.indexOf(USER_STYLE_ID);
    expect(iTheme).toBeGreaterThan(0);
    expect(iTheme).toBeLessThan(iUser);
  });

  it("已存在的主题样式是**原地更新**（不重新 append），不会挤到自定义 CSS 之后", () => {
    injectThemeCss("theme-a{}");
    flushThemeInjection();
    injectUserCss("user-css{}");
    const before = [...document.head.querySelectorAll("style")].map((el) => el.id);
    injectThemeCss("theme-b{}"); // 切主题
    flushThemeInjection();
    const after = [...document.head.querySelectorAll("style")].map((el) => el.id);
    expect(after).toEqual(before);
    expect(readInjectedThemeCss()).toContain("theme-b{}");
    expect(after.indexOf(THEME_STYLE_ID)).toBeLessThan(after.indexOf(USER_STYLE_ID));
  });
});

describe("#225 §3.2/C3：data-theme 与 data-theme-id 同步落盘", () => {
  it("一次同步写同时写入两个属性", () => {
    writeThemeAttributes("user:vue", "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe("user:vue");
    expect(readThemeIdAttribute()).toBe("user:vue");
  });
});

describe("#225 §4.3（G3）：首帧同步路径", () => {
  it("旧值迁移：存储里的 \"dark\" → builtin:dark，且首帧属性已就位", () => {
    writeStoredThemeId("dark");
    const r = bootstrapFirstFrameTheme();
    expect(r.themeId).toBe(BUILTIN_DARK_ID);
    expect(r.mode).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe(BUILTIN_DARK_ID);
  });

  it("内置基线无独立样式表 → 不注入主题样式（css.kind = none）", () => {
    writeStoredThemeId("light");
    bootstrapFirstFrameTheme();
    flushThemeInjection();
    expect(styleEl(THEME_STYLE_ID)).toBeNull();
    expect(currentThemeId()).toBe(BUILTIN_LIGHT_ID);
  });

  it("未知 themeId（清单/快照未就绪）→ 本帧不切换，回落内置基线 + 状态位留痕（P2-3）", () => {
    writeStoredThemeId("user:ghost");
    const r = bootstrapFirstFrameTheme();
    expect(r.themeId).toBe(BUILTIN_LIGHT_ID);
    expect(r.needsAsyncLoad).toBe(true);
    expect(readSnapshotState()?.last).toBe("invalid");
    expect(readSnapshotState()?.themeId).toBe("user:ghost");
  });

  it("快照命中 → 首帧注入快照 CSS，来源记为 snapshot 且不需异步读盘", () => {
    registerThemes([USER_THEME]);
    localStorage.setItem(
      snapshotKey(USER_THEME.id, USER_THEME.hash),
      JSON.stringify({ v: 1, themeId: USER_THEME.id, hash: USER_THEME.hash, css: "#write h1{color:blue}", at: 1 }),
    );
    writeStoredThemeId(USER_THEME.id);
    const r = bootstrapFirstFrameTheme();
    flushThemeInjection();
    expect(r.source).toBe("snapshot");
    expect(r.needsAsyncLoad).toBe(false);
    expect(readInjectedThemeCss()).toContain("#write h1{color:blue}");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe(USER_THEME.id);
    expect(["hit", "slow"]).toContain(readSnapshotState()?.last);
  });

  it("快照缺失 → 回落基线 + 需要异步补主题 + 状态位 missing（允许一次可见切换）", () => {
    registerThemes([USER_THEME]);
    writeStoredThemeId(USER_THEME.id);
    const r = bootstrapFirstFrameTheme();
    expect(r.themeId).toBe(USER_THEME.id);
    expect(r.source).toBe("baseline");
    expect(r.needsAsyncLoad).toBe(true);
    expect(readSnapshotState()?.last).toBe("missing");
  });

  it("启动 GC：清单外的历史快照被清理", () => {
    // 评审阻塞 2 后：GC 的 known 集合来自**持久化清单**（`inkling-themes-index`），
    // 因此这里必须先写清单（否则按新口径「清单为空 → 不动快照」）
    writeThemesIndex([{ id: USER_THEME.id, name: USER_THEME.name, mode: "light", hash: USER_THEME.hash }]);
    localStorage.setItem(
      snapshotKey("user:removed", "deadbeef"),
      JSON.stringify({ v: 1, themeId: "user:removed", hash: "deadbeef", css: "x", at: 1 }),
    );
    bootstrapFirstFrameTheme();
    expect(localStorage.getItem(snapshotKey("user:removed", "deadbeef"))).toBeNull();
  });
});

describe("#225 评审阻塞 2：首帧消费持久化清单（索引）+ GC 按清单判决", () => {
  it("索引里的磁盘主题 → 首帧快照命中（不再被判未知、不再闪一次内置基线）", () => {
    resetRegisteredThemes(); // 模拟全新启动：内存注册表里只有内置基线
    writeThemesIndex([
      { id: USER_THEME.id, name: USER_THEME.name, mode: "light", hash: USER_THEME.hash, source: "user" },
    ]);
    localStorage.setItem(
      snapshotKey(USER_THEME.id, USER_THEME.hash),
      JSON.stringify({
        v: 1,
        themeId: USER_THEME.id,
        hash: USER_THEME.hash,
        css: "#write h1{color:teal}",
        at: 1,
      }),
    );
    writeStoredThemeId(USER_THEME.id);

    const r = bootstrapFirstFrameTheme();
    flushThemeInjection();
    expect(r.source).toBe("snapshot");
    expect(r.needsAsyncLoad).toBe(false);
    expect(readInjectedThemeCss()).toContain("color:teal");
    expect(document.documentElement.getAttribute("data-theme-id")).toBe(USER_THEME.id);
    expect(readSnapshotState()?.last).not.toBe("invalid");
  });

  it("GC 按持久化清单判决：清单内的快照保留，清单外的清掉", () => {
    writeThemesIndex([
      { id: USER_THEME.id, name: USER_THEME.name, mode: "light", hash: USER_THEME.hash, source: "user" },
    ]);
    for (const [id, hash] of [
      [USER_THEME.id, USER_THEME.hash],
      ["user:orphan", "deadbeef"],
    ] as const) {
      localStorage.setItem(
        snapshotKey(id, hash),
        JSON.stringify({ v: 1, themeId: id, hash, css: "x", at: 1 }),
      );
    }
    bootstrapFirstFrameTheme();
    expect(localStorage.getItem(snapshotKey(USER_THEME.id, USER_THEME.hash))).not.toBeNull();
    expect(localStorage.getItem(snapshotKey("user:orphan", "deadbeef"))).toBeNull();
  });

  it("清单为空时**不动**快照（避免把磁盘主题快照误判为「已不存在」而每次启动清空）", () => {
    localStorage.removeItem("inkling-themes-index");
    const key = snapshotKey("user:kept", "cafebabe");
    localStorage.setItem(key, JSON.stringify({ v: 1, themeId: "user:kept", hash: "cafebabe", css: "x", at: 1 }));
    bootstrapFirstFrameTheme();
    expect(localStorage.getItem(key)).not.toBeNull();
  });
});

describe("#225 评审阻塞 3：自定义 CSS 的「前导注释 + @import」必须仍被外提", () => {
  it("splitLeadingImports 允许表首注释（许可证/作者头）", () => {
    const css = `/* Theme by X — MIT License */\n@import "base.css";\n/* 段落 */\n#write h1 { color: red }`;
    const { imports, rest } = splitLeadingImports(css);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('@import "base.css";');
    // 注释随 import 一起外提（保留归属信息），不在 layer 块内
    expect(imports[0]).toContain("Theme by X");
    expect(rest).toContain("#write h1 { color: red }");
  });

  it("injectUserCss 产物：@import 在 @layer user 之外（前导注释不再使其静默失效）", () => {
    injectUserCss(`/* header */\n@import "imp.css";\n#a{background:rgb(1,2,3)}`);
    const css = readInjectedUserCss()!;
    expect(css.indexOf('@import "imp.css";')).toBeGreaterThanOrEqual(0);
    expect(css.indexOf('@import "imp.css";')).toBeLessThan(css.indexOf("@layer user {"));
    expect(css).toContain("#a{background:rgb(1,2,3)}");
  });

  it("多个 @import（含注释间隔）全部外提，其余内容留在层内", () => {
    injectUserCss(`@import "a.css";\n/* c */\n@import url(b.css);\n#x{color:red}`);
    const css = readInjectedUserCss()!;
    const layerAt = css.indexOf("@layer user {");
    expect(css.indexOf('@import "a.css";')).toBeLessThan(layerAt);
    expect(css.indexOf("@import url(b.css);")).toBeLessThan(layerAt);
    expect(css).toContain("#x{color:red}");
  });

  // 复审补充：按 Cascade 5，`@import` 必须前于所有规则，**`@charset` 与 `@layer …;` 语句除外**
  // → 这两类合法的表首前置语句也不能挡住外提（否则 `@import` 落进 layer 块内被**静默忽略**）
  const TRIVIA_CASES: [string, string][] = [
    ["@charset 前缀", `@charset "utf-8";\n@import "imp.css";\n#a{background:rgb(1,2,3)}`],
    ["@layer 语句前缀", `@layer a, b;\n@import "imp.css";\n#a{background:rgb(1,2,3)}`],
    [
      "注释 + @charset + @import",
      `/* h */\n@charset "utf-8";\n@import "imp.css";\n#a{background:rgb(1,2,3)}`,
    ],
    [
      "@charset + @layer 语句 + 注释 + @import",
      `@charset "utf-8";\n@layer a, b;\n/* c */\n@import "imp.css";\n#a{background:rgb(1,2,3)}`,
    ],
  ];

  it.each(TRIVIA_CASES)("%s：@import 仍被外提到 @layer user 之外（不再静默失效）", (_name, input) => {
    const { imports, rest } = splitLeadingImports(input);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain('@import "imp.css";');
    // 表首前置语句随 import 一起外提，且不丢
    if (input.includes("@charset")) expect(imports[0]).toContain("@charset");
    if (/@layer\s+a,\s*b;/.test(input)) expect(imports[0]).toContain("@layer a, b;");
    expect(rest).toContain("#a{background:rgb(1,2,3)}");

    injectUserCss(input);
    const css = readInjectedUserCss()!;
    const layerAt = css.indexOf("@layer user {");
    expect(layerAt).toBeGreaterThan(-1);
    expect(css.indexOf('@import "imp.css";')).toBeGreaterThanOrEqual(0);
    expect(css.indexOf('@import "imp.css";')).toBeLessThan(layerAt);
    // @charset（若存在）必须仍在 import 之前 —— 它对位置有强要求
    if (css.includes("@charset")) {
      expect(css.indexOf("@charset")).toBeLessThan(css.indexOf('@import "imp.css";'));
    }
    expect(css).toContain("#a{background:rgb(1,2,3)}");
  });

  it("`@layer a, b;` 语句不丢：外提后仍以语句形态出现（不是被吞进层块）", () => {
    const { imports } = splitLeadingImports(`@layer a, b;\n@import "imp.css";\n#x{color:red}`);
    expect(imports[0]).toContain("@layer a, b;");
  });
});

describe("#225 §4.2：applyTheme 切换管线", () => {
  it("内置基线：写属性 + 持久化 + 卸载主题样式", () => {
    injectThemeCss("stale{}");
    flushThemeInjection();
    applyTheme({ id: BUILTIN_DARK_ID, name: "深色", mode: "dark", source: "builtin-base", css: { kind: "none" } });
    flushThemeInjection();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("inkling-theme")).toBe(BUILTIN_DARK_ID);
    expect(styleEl(THEME_STYLE_ID)).toBeNull();
    expect(currentThemeMode()).toBe("dark");
  });

  it("磁盘主题（带 hash）：写属性 + 落快照（G9 适用性判定）", () => {
    registerThemes([USER_THEME]);
    applyTheme(getUserTheme(), { css: "#write h1{color:green}" });
    flushThemeInjection();
    expect(readInjectedThemeCss()).toContain("#write h1{color:green}");
    expect(readSnapshot(USER_THEME.id, USER_THEME.hash)?.css).toBe("#write h1{color:green}");
  });

  it("unloadThemeStyles：移除主题样式与 data-theme-id（不动 data-theme）", () => {
    injectThemeCss("x{}");
    flushThemeInjection();
    unloadThemeStyles();
    flushThemeInjection();
    expect(styleEl(THEME_STYLE_ID)).toBeNull();
    expect(document.documentElement.getAttribute("data-theme-id")).toBeNull();
  });
});

function getUserTheme() {
  return {
    id: USER_THEME.id,
    name: USER_THEME.name,
    mode: USER_THEME.mode,
    source: USER_THEME.source,
    hash: USER_THEME.hash,
    css: { kind: "file" as const, path: "C:\\themes\\vue.css" },
  };
}

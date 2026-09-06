// E2E：万行复杂文档「滚动进行中立即切换模式」的锚点竞争场景（issue #212）
//
// 背景：现有 #136 门禁用例（source-mode-scroll.spec.ts A/A2/B/B2/B3）全部用
// scrollTop 直接赋值 + waitScrollConverged 等停稳后再切换，未覆盖「滚动 rAF
// 尚在途（连续快速滚动未停稳）的瞬间触发模式切换」——这是 #136 锚点漂移
// 最易复发的竞争窗口（旧实现依赖切换时 flush 待执行的 rAF 采样帧）。
//
// #212 修复把锚点采样从「滚动路径每帧」改为「切换指令触发时同步采样」
// （setTabSourceMode 翻转前经注册表执行，此刻 .md-editor-wysiwyg 仍可见，
// posAtCoords 几何现场读可靠）。本用例锁定的语义：
//   连续滚动（每帧 scrollTop += 大增量，不等待停稳）→ 在最后一个滚动帧
//   内同步点击「源码」切换 → 断言源码侧视口顶部内容 == 切换瞬间 WYSIWYG
//   视口顶部内容（内容锚点不漂移，且 scrollTop 不是陈旧值/初值/末端值）。

import { test, expect } from "@playwright/test";
import { waitScrollConverged } from "./helpers";

/**
 * 万行级 + 大量代码块的复杂文档生成器（issue #212 复现口径）。
 * 1200 节 ≈ 10,800 行 Markdown；每节 = 唯一编号标题 + 正文 + 代码块，
 * 共 1200 个代码块（与 md_editor_stress_test.md 的「大量代码块」同构）。
 * 标题编号唯一且可解析（锚点对照物）。内容通过 mock 文件系统预置注入
 * （覆盖 readme.md 的内容槽，打开文件时读取），绕开 keyboard.insertText
 * 对 350KB 文本的输入瓶颈。
 */
const RACE_SECTIONS = 1200;
const RACE_DOC = Array.from({ length: RACE_SECTIONS }, (_, i) => {
  const n = String(i + 1).padStart(5, "0");
  return `## 竞速锚点-${n}\n\n第 ${n} 节的正文段落，用于撑起足够高度并模拟真实文档内容分布，快速滚动时以本节标题作为内容锚点参照物。\n\n\`\`\`ts\n// 代码块 ${n}\nconst item${n} = ${i + 1};\n\`\`\``;
}).join("\n\n");

/**
 * 打开 mock 工作区并点开（已被替换为万行文档的）readme.md。
 * 关键时序：goto 加载应用后立即注入内容槽（不能再 goto，否则 mockFs
 * 模块重置、注入丢失），随后点「打开文件夹」建树（readme 条目本就存在）、
 * 展开 notes 打开 readme——打开动作才读 MOCK_FILE_CONTENT，读到的是
 * 注入后的万行文档。
 */
async function openRaceDoc(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(async (doc) => {
    // 注意：必须带 .ts 扩展——Vite dev 下同 URL 才复用同一模块实例，
    // 无扩展的 import 会生成第二份 MOCK_FILE_CONTENT，注入不生效
    const { MOCK_FILE_CONTENT } = (await import(
      // @ts-ignore Vite dev 专用绝对模块路径（运行时可用，TS 无对应声明）
      "/src/lib/mockFs.ts"
    )) as typeof import("../../src/lib/mockFs");
    MOCK_FILE_CONTENT["/mock-workspace/notes/readme.md"] = doc;
  }, RACE_DOC);

  await page.getByRole("button", { name: "打开文件夹" }).click();
  await expect(
    page.locator(".sidebar-tree").getByText("mock-workspace"),
  ).toBeVisible({ timeout: 10_000 });
  const notes = page.locator(
    '[data-tree-row][data-path="/mock-workspace/notes"]',
  );
  if ((await notes.getAttribute("aria-expanded")) !== "true") {
    await notes.click();
  }
  await page
    .locator(".workspace-tree-scroll")
    .getByText("readme.md", { exact: true })
    .click();
  await expect(page.locator(".tab-active")).toContainText("readme.md", {
    timeout: 15_000,
  });
  await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 30_000 });
  // 万行文档 PM 渲染完成（滚动高度撑起，含全部代码块占位高度）
  await expect
    .poll(
      async () => {
        const h = await page.evaluate(() => {
          const el = document.querySelector(".editor-scroll");
          return el ? el.scrollHeight : 0;
        });
        return h >= 200_000;
      },
      { timeout: 60_000, intervals: [500, 800] },
    )
    .toBe(true);
  // 回到顶部，避免进入用例时处于历史滚动位置
  await page.evaluate(() => {
    const el = document.querySelector(".editor-scroll");
    if (el) el.scrollTop = 0;
  });
  await waitScrollConverged(page, ".editor-scroll");
}

/** 从任意块文本中解析首个唯一节编号（标题/正文/代码块行都带 pad 编号） */
function parseAnchorId(text: string): number | null {
  const m = text.match(/\b\d{5}\b/);
  return m ? Number(m[0]) : null;
}

/**
 * 在最后一帧滚动内同步完成「记录预期锚点 + 点击切换」。
 * 返回切换瞬间 WYSIWYG 视口顶部块文本（内容锚点预期值）。
 */
async function scrollThenSwitchMidFlight(
  page: import("@playwright/test").Page,
): Promise<string> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".editor-scroll");
    if (!scroller) throw new Error("no .editor-scroll");
    const toggleBtn = document.querySelector<HTMLButtonElement>(
      ".editor-topbar .topbar-btn-label",
    );
    if (!toggleBtn) throw new Error("no source toggle button");
    const readTopBlockText = (): string => {
      const r = scroller!.getBoundingClientRect();
      const viewTop = r.top + 8;
      // 按文档顺序取第一个跨越视口顶线的块（bottom > viewTop 且 top 最靠前）。
      // 不依赖 elementFromPoint 取点：padding/margin 区域命中不稳定。
      const children = Array.from(
        scroller!.querySelectorAll(".ProseMirror > *"),
      );
      for (const b of children) {
        const br = b.getBoundingClientRect();
        if (br.bottom > viewTop) {
          return (b.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
        }
      }
      return "";
    };
    return new Promise<string>((resolve) => {
      let frames = 0;
      const step = () => {
        frames += 1;
        scroller!.scrollTop += 240;
        if (frames < 30) {
          requestAnimationFrame(step);
          return;
        }
        // 最后一帧：此刻 scrollTop 停在增量累计处（滚动未停稳），
        // 同一帧内同步读顶部块文本并触发切换——采样点在切换事件处理里
        const expected = readTopBlockText();
        toggleBtn!.click();
        resolve(expected);
      };
      requestAnimationFrame(step);
    });
  });
}

/** 读源码模式视口顶部若干行文本（CM 视口化渲染：顶部行必然已渲染） */
async function sourceTopLines(
  page: import("@playwright/test").Page,
): Promise<string> {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(
      ".source-mode-editor .cm-scroller",
    );
    if (!scroller) return "";
    const top = scroller.scrollTop;
    const lines = Array.from(
      document.querySelectorAll(".source-mode-editor .cm-line"),
    )
      .map((ln) => ({
        el: ln as HTMLElement,
        top: (ln as HTMLElement).offsetTop,
      }))
      .filter((l) => l.top >= top - 2)
      .sort((a, b) => a.top - b.top)
      .slice(0, 4);
    return lines.map((l) => l.el.textContent ?? "").join(" ");
  });
}

test.describe("滚动进行中立即切换（#212 竞争场景）", () => {
  test("C1：万行复杂文档连续滚动中切换，源码视口停在滚动停止位置对应的内容锚点", async ({ page }) => {
    test.setTimeout(180_000);
    await openRaceDoc(page);

    // 连续快速滚动 30 帧（240px/帧，共 7200px），最后帧不停稳直接切换
    const expected = await scrollThenSwitchMidFlight(page);
    const expectedId = parseAnchorId(expected);
    expect(expectedId).not.toBeNull();
    // 前置校验：滚动确实前进到了文档中段而非顶部（0 号锚点）
    expect(expectedId!).toBeGreaterThan(5);

    // 源码模式就位并等滚动恢复收敛（SourceModeEditor settle 循环）
    await expect(
      page.getByTestId("source-mode-editor").locator(".cm-content"),
    ).toBeVisible({ timeout: 15_000 });
    await waitScrollConverged(page, ".source-mode-editor .cm-scroller");

    const sourceTop = await sourceTopLines(page);
    const sourceId = parseAnchorId(sourceTop);
    expect(sourceId).not.toBeNull();

    // 内容锚点断言：源码侧视口顶部内容对应「滚动停止位置」的内容，
    // 而非顶部（陈旧 0 号）或文档头。双候选吸附可能落在 ±1 节的相邻
    // 标题，故以「与预期锚点距离 ≤2」为不漂移判据。
    expect(Math.abs(sourceId! - expectedId!)).toBeLessThanOrEqual(2);
  });

  test("C2：滚动进行中切换后源码视口不坍缩到顶部或钳到底部（对照）", async ({ page }) => {
    test.setTimeout(180_000);
    await openRaceDoc(page);
    await scrollThenSwitchMidFlight(page);

    await expect(
      page.getByTestId("source-mode-editor").locator(".cm-content"),
    ).toBeVisible({ timeout: 15_000 });
    await waitScrollConverged(page, ".source-mode-editor .cm-scroller");

    const info = await page.evaluate(() => {
      const el = document.querySelector(".source-mode-editor .cm-scroller");
      if (!el) return null;
      return {
        scrollTop: el.scrollTop,
        maxScroll: el.scrollHeight - el.clientHeight,
      };
    });
    expect(info).not.toBeNull();
    expect(info!.maxScroll).toBeGreaterThan(0);
    const ratio = info!.scrollTop / info!.maxScroll;
    // 滚动 7200px 落在文档前段：比例应显著偏离 0（顶部陈旧）与 1（底部钳制）
    expect(ratio).toBeGreaterThan(0.01);
    expect(ratio).toBeLessThan(0.6);
  });
});

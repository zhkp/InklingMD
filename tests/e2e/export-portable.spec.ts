// E2E：导出产物可移植性（#372）与导出快照纯净度（#373）
//
// 证据口径（对齐 issue 验收项，不接受「函数返回的字符串看着对」）：
// - 本地图片用**真实可解码字节**（浏览器 canvas 现做的 PNG/JPEG + 文本 SVG），
//   经 page.route 由真实 HTTP 响应供给；导出时由 `readBinaryFile` 真实读回。
// - 导出产物**写到另一个临时目录**再用 `file://` 打开，验证离开应用 origin、
//   离开工作区路径后资源仍能加载（不是「本机当前仍可通过应用读取资源」）。
// - 编辑态控件按**最终 DOM 结构**断言（不存在即不存在），不看是否被 CSS 隐藏。
//
// 证据边界：本 harness 跑浏览器构建（`isTauri() === false`），因此
// HTML 导出走 `inline` 模式；桌面端 `sidecar` 模式的落盘布局由
// `tests/lib/export-resources.test.ts` + `tests/unit/export-html-sidecar.test.ts` 覆盖。
// 同理，浏览器下 `resolveImageSrc` 原样返回相对路径，`asset://` / `asset.localhost`
// 的**改写本身**只有单测覆盖（`tests/lib/export-resources.test.ts` 钉了两种形式与
// 非法百分号路径）；本文件 E2E 覆盖的是同一处理器的真实读取通道：真实 HTTP 字节 →
// 内联 → 换目录用 `file://` 打开 → 真的解码出像素。
// 另一条边界：`window.open` 出来的打印窗口在本机**没有可用外网**（实测
// `popup.evaluate(() => fetch(...))` 挂起、无任何 request 事件），故 P2 只能断言
// 「管线自己产出的资源在 print() 前全部就绪」，外部 http(s) 图按有界等待降级处理。

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, expect, type Page } from "@playwright/test";
import { openMockWorkspace, openFile, MOD } from "./helpers";

const REMOTE_IMAGE = "https://example.com/remote.png";

// 圆心用纯品红：长图里靠这个颜色断言 SVG 图片**真的被画进画布**，
// 且不会与绿/红夹具、正文文字色、主题底色撞色。
const SVG_SOURCE =
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">` +
  `<rect width="12" height="12" fill="#2c3e50"/><circle cx="6" cy="6" r="4" fill="#ff00ff"/></svg>`;

/**
 * 用被测浏览器现做真实图片字节（不是 mock、不是占位）：
 * 能被 `new Image()` 解码、能进 canvas，才配当「资源已成功读取」的证据。
 */
async function makeRealImages(page: Page) {
  await page.goto("/");
  return page.evaluate((svg) => {
    const canvas = document.createElement("canvas");
    canvas.width = 12;
    canvas.height = 12;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#00b400";
    ctx.fillRect(0, 0, 12, 12);
    const png = canvas.toDataURL("image/png").split(",")[1];
    ctx.fillStyle = "#c0392b";
    ctx.fillRect(0, 0, 12, 12);
    const jpeg = canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
    return { png, jpeg, svg };
  }, SVG_SOURCE);
}

/**
 * 把三张本地图与远程图接到真实 HTTP 响应上（编辑器渲染与导出读取共用同一条路）。
 * 传 `BrowserContext` 而非 `Page` 时，`window.open` 出来的打印窗口也走同一套路由——
 * PDF 用例断言「print() 前所有图都已就绪」需要远程图在**产物窗口**里真能加载。
 */
type ImageRouter = Pick<Page, "route">;

async function routeFixtureImages(
  router: ImageRouter,
  images: { png: string; jpeg: string; svg: string },
) {
  await router.route("**/assets/green.png", (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.from(images.png, "base64") }),
  );
  await router.route("**/assets/red.jpg", (r) =>
    r.fulfill({ contentType: "image/jpeg", body: Buffer.from(images.jpeg, "base64") }),
  );
  await router.route("**/assets/shape.svg", (r) =>
    r.fulfill({ contentType: "image/svg+xml", body: Buffer.from(images.svg, "utf8") }),
  );
  await router.route("**/example.com/remote.png", (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.from(images.png, "base64") }),
  );
}

/** 打开导出菜单（可能已展开：只按需展开，避免点成关闭） */
async function openExportMenu(page: Page) {
  if (!(await page.locator(".export-dropdown").isVisible().catch(() => false))) {
    await page.locator('.topbar-btn[title="导出"]').click();
  }
  await expect(page.locator(".export-dropdown")).toBeVisible({ timeout: 5_000 });
}

/** 触发一次导出并拿到下载文件的字节 */
async function exportAndRead(page: Page, itemText: string, fileNameRe: RegExp): Promise<Buffer> {
  await openExportMenu(page);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.locator(".export-item", { hasText: itemText }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(fileNameRe);
  const path = await download.path();
  expect(path, "下载必须落到真实文件").toBeTruthy();
  return readFileSync(path!);
}

/** 编辑态控件选择器：产物里必须**结构上不存在**（#373） */
const CHROME_SELECTORS = [
  ".code-block-toolbar",
  ".code-block-cm",
  ".code-block-placeholder",
  ".cm-gutters",
  ".cm-content",
  ".cm-editor",
  ".frontmatter-cm",
  ".mermaid-toolbar",
  ".mermaid-editor",
  ".image-resize-handle",
  ".image-context-menu",
  ".math-editor",
  ".inkling-block-handle",
  ".inkling-drop-indicator",
  "[contenteditable]",
  "[role='textbox']",
  "select",
  "textarea",
  "button",
] as const;

test.describe("导出产物：可移植（#372）且不含编辑态控件（#373）", () => {
  test.setTimeout(180_000);

  /** 收集导出过程中的降级告知（window.alert）：既用于断言，也避免阻塞后续点击 */
  function collectAlerts(page: Page): string[] {
    const messages: string[] = [];
    page.on("dialog", (d) => {
      messages.push(d.message());
      void d.accept();
    });
    return messages;
  }

  test("P1 导出 HTML：搬到别的目录后本地图片仍加载，产物无运行时地址、无编辑器控件", async ({
    page,
  }) => {
    const images = await makeRealImages(page);
    await routeFixtureImages(page, images);
    const alerts = collectAlerts(page);

    await openMockWorkspace(page);
    await openFile(page, "export-demo.md");
    // 产物里不允许出现开发服务器地址（本机 E2E 端口可能是 1420，也可能是 3000）
    const devHost = new URL(page.url()).host;

    // #372 的第二条通道：主题 CSS 里的 `url()`（字体、背景图）也会被
    // `collectDocumentCss` 一并带进产物。没有这条用例时 `processCss` 在整个
    // harness 里是一条**空跑**的路径（应用自身 CSS 里一个 `url(` 都没有）。
    // 用与 #348 守卫同形态的注入规则，图片由真实 HTTP 响应供给。
    await page.route("**/assets/bg.png", (r) =>
      r.fulfill({ contentType: "image/png", body: Buffer.from(images.png, "base64") }),
    );
    await page.addStyleTag({
      content:
        ".editor-scroll .milkdown p{" +
        'background-image:url("/assets/bg.png");' +
        "background-repeat:no-repeat;background-size:12px 12px;}",
    });
    // 前提零：这条规则在编辑器里**真的生效**（否则「产物里有背景图」可能是别的来源）
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll<HTMLElement>(".ProseMirror p")).some((p) =>
              getComputedStyle(p).backgroundImage.includes("/assets/bg.png"),
            ),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    // 前提一：三张本地图在编辑器里**真的解码成功**（否则「导出后有图」可能只是巧合）
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              Array.from(document.querySelectorAll<HTMLImageElement>(".ProseMirror img")).filter(
                (i) => !i.src.startsWith("data:") && i.naturalWidth > 0,
              ).length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3);

    // 前提二：文档后半段仍在首屏外——懒挂载/懒渲染没跑过，导出必须自己补齐
    const belowFold = await page.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll<HTMLElement>(".code-block"));
      const last = blocks[blocks.length - 1];
      return {
        total: blocks.length,
        lastHasCm: !!last?.querySelector(".cm-editor"),
      };
    });
    expect(belowFold.total, "夹具至少要有两个代码块").toBeGreaterThanOrEqual(2);
    expect(belowFold.lastHasCm, "最后一个代码块应仍未挂载 CodeMirror（未滚动过）").toBe(false);
    // 前提三：至少一张 Mermaid 已在编辑器里渲染完成。空闲队列是异步的，导出时刻
    // 可能一张都还没画完——那样产物里的图全部来自补渲染，「复用已渲染 svg」就没被
    // 验证到。这里等第一张出来；真正未渲染时的补渲染路径由 P6 与默认渲染器单测覆盖。
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelectorAll(".ProseMirror .mermaid-render svg").length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // 导出前的编辑态现场：滚动位置与文档选区。导出只处理克隆，这两者不得被动。
    const liveBefore = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".editor-scroll")!;
      const sel = window.getSelection();
      return {
        scrollTop: scroller.scrollTop,
        anchor: sel?.anchorNode ? `${sel.anchorNode.nodeName}:${sel.anchorOffset}` : "none",
      };
    });

    const html = (await exportAndRead(page, "导出 HTML", /export-demo\.html$/)).toString("utf8");

    const liveAfter = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(".editor-scroll")!;
      const sel = window.getSelection();
      return {
        scrollTop: scroller.scrollTop,
        anchor: sel?.anchorNode ? `${sel.anchorNode.nodeName}:${sel.anchorOffset}` : "none",
      };
    });
    expect(liveAfter, "导出不得移动滚动位置或文档选区").toEqual(liveBefore);

    // 独立文档会把应用样式表整份内联（#226），其中**选择器文本**里出现编辑态类名是
    // 正常且无害的；#373 的口径是「最终 DOM 结构本身干净」，故按 body 与 DOM 断言。
    const body = html.slice(html.indexOf("<body"));

    // #372：产物里不允许残留任何运行时 / 工作区地址
    expect(html).not.toContain("asset://");
    expect(html).not.toContain("asset.localhost");
    expect(html).not.toContain(devHost);
    expect(html).not.toContain("127.0.0.1");
    // CSS 通道：注入规则里的 `url("/assets/bg.png")` 不能被原样带进产物
    expect(html).not.toContain("/assets/bg.png");
    // 远程图片保持既有语义，不被内联也不被改写
    expect(html).toContain(REMOTE_IMAGE);

    // #373：编辑态控件在正文里就不该出现（DOM 级断言见下方 file:// 复检）
    for (const marker of [
      "code-block-toolbar",
      "cm-gutters",
      "contenteditable",
      "image-resize-handle",
      "mermaid-toolbar",
      "mermaid-editor",
      "code-block-placeholder",
      "inkling-block-handle",
    ]) {
      expect(body, `正文不应含 ${marker}`).not.toContain(marker);
    }

    // 搬到另一个目录（与下载目录、应用 origin、工作区都无关）后用 file:// 打开
    const moved = mkdtempSync(join(tmpdir(), "inkling-moved-"));
    try {
      const target = join(moved, "elsewhere", "report.html");
      mkdirSync(join(moved, "elsewhere"), { recursive: true });
      writeFileSync(target, html, "utf8");
      await page.goto(pathToFileURL(target).href);
      await page.waitForLoadState("load");

      // 本地图必须是自包含 data URL，且**真的解码成功**
      const imgReport = await page.evaluate(() =>
        Array.from(document.querySelectorAll("img")).map((i) => ({
          src: i.currentSrc || i.src,
          isData: (i.getAttribute("src") ?? "").startsWith("data:"),
          ok: i.complete && i.naturalWidth > 0,
          alt: i.getAttribute("alt") ?? "",
        })),
      );
      const locals = imgReport.filter((i) => ["绿色方块", "红色方块", "矢量图形"].includes(i.alt));
      expect(locals, "三张本地图都必须在产物里").toHaveLength(3);
      // 按 MIME 逐张核对：缺失降级占位也是可解码的 SVG data URL，只查 data: 会放过「全挂了」。
      const expectedMime: Record<string, string> = {
        绿色方块: "data:image/png",
        红色方块: "data:image/jpeg",
        矢量图形: "data:image/svg+xml",
      };
      for (const img of locals) {
        expect(img.isData, `${img.alt} 应为内联 data URL，实际 ${img.src.slice(0, 64)}`).toBe(true);
        expect(
          img.src.startsWith(expectedMime[img.alt]),
          `${img.alt} 必须是真实资源（${expectedMime[img.alt]}），不是缺失占位`,
        ).toBe(true);
        expect(img.ok, `${img.alt} 必须能离开应用后解码`).toBe(true);
      }
      expect(imgReport.find((i) => i.alt === "远程图片")?.src).toContain("example.com");

      // CSS 通道真的被改写成了自包含 data URL（不是「产物里没有裸路径」这种弱证据）
      const bg = await page.evaluate(() => {
        const p = document.querySelector<HTMLElement>(".editor-scroll .milkdown p");
        return p ? getComputedStyle(p).backgroundImage : "";
      });
      expect(bg).toContain("data:image/png");

      // 最终 DOM 里没有编辑态控件（结构级，不是 CSS 隐藏）
      for (const sel of CHROME_SELECTORS) {
        expect(await page.locator(sel).count(), `产物不应含 ${sel}`).toBe(0);
      }

      // 代码块：完整源码 + 正确语言（CodeMirror 虚拟化的行不能丢）
      const ts = page.locator("pre.code-block-export code.language-typescript");
      await expect(ts).toHaveCount(1);
      const tsText = (await ts.textContent()) ?? "";
      expect(tsText).toContain("const line001 = 1;");
      expect(tsText).toContain("const line200 = 200;");
      expect(tsText.split("\n").filter((l) => l.startsWith("const line")).length).toBe(200);

      // 首屏外、从未挂载的代码块同样完整，且语言来自文档而不是 DOM
      const py = page.locator("pre.code-block-export code.language-python");
      await expect(py).toHaveCount(1);
      expect(await py.textContent()).toContain('print("below the fold")');

      // Mermaid：要么补渲染出 svg，要么给出**完整源码**兜底，绝不空块
      const mermaid = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".mermaid-render")).map((el) => ({
          hasSvg: !!el.querySelector("svg"),
          hasFallback: !!el.querySelector(".mermaid-export-fallback"),
          text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        })),
      );
      expect(mermaid.length, "两张 Mermaid 都必须在产物里留下可辨识内容").toBe(2);
      for (const m of mermaid) {
        expect(
          m.hasSvg || (m.hasFallback && m.text.length > 10),
          `Mermaid 既没 svg 也没源码兜底：${JSON.stringify(m).slice(0, 160)}`,
        ).toBe(true);
      }
      expect(mermaid.some((m) => m.hasSvg), "至少首屏那张应复用已渲染的 svg").toBe(true);

      // frontmatter 内容不丢，但编辑用的 CodeMirror 宿主已经不在。
      // 必须断言**可见文本**：`data-value` 属性里也可能带着同一串，只查字符串会假绿。
      const fmCode = page.locator(".frontmatter-block pre.code-block-export code");
      await expect(fmCode).toHaveCount(1);
      expect(await fmCode.textContent()).toContain("title: 导出夹具");

      // 正文结构完整：加粗/斜体/链接/行内代码都还在
      expect(await page.locator("strong").first().textContent()).toBe("加粗");
      expect(await page.locator("em").first().textContent()).toBe("斜体");
      expect(await page.locator('a[href="https://example.com"]').count()).toBeGreaterThan(0);
      expect(await page.locator("h1").first().textContent()).toContain("导出可移植性夹具");
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }

    // 降级告知只在真有降级时出现；出现就必须是**可读的**告知，不能静默
    for (const m of alerts) expect(m).toContain("未能完整导出");
  });

  test("P2 导出 PDF：打印前资源已就位，新窗口里没有编辑态控件", async ({ page, context }) => {
    const images = await makeRealImages(page);
    await routeFixtureImages(context, images);
    const alerts = collectAlerts(page);

    // addInitScript 对**新窗口**同样生效：在 `print()` 被调用的那一刻抓下资源状态，
    // 用来证明「打印发生在资源就绪之后」（#372 验收项），而不是靠 sleep 撞运气。
    await context.addInitScript(() => {
      const w = window as unknown as {
        __probe: { printAt: number; printImgCount: number; printNotReady: string[] };
      };
      w.__probe = { printAt: 0, printImgCount: 0, printNotReady: [] };
      // 挂在 window 而不是 document：导出走 win.document.open()/write()，
      // 那会**替换 Document 对象**（Window 与全局属性保留），document 上的监听会随之丢失。
      window.print = () => {
        const imgs = Array.from(document.images);
        w.__probe.printAt = performance.now();
        w.__probe.printImgCount = imgs.length;
        // 生产侧 waitForImages() 的承诺就是「每张图都 complete 且已解码」，
        // 所以在 print() 时刻逐张核对，比事后统计 load 事件更能钉住顺序。
        w.__probe.printNotReady = imgs
          .filter((i) => !(i.complete && i.naturalWidth > 0))
          .map((i) => (i.getAttribute("src") ?? "").slice(0, 48));
        // 不真的弹打印对话框：E2E 无法与之交互，且会阻塞后续断言
      };
    });
    await openMockWorkspace(page);
    await openFile(page, "export-demo.md");
    // 产物里不允许出现开发服务器地址（本机 E2E 端口可能是 1420，也可能是 3000）
    const devHost = new URL(page.url()).host;
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              Array.from(document.querySelectorAll<HTMLImageElement>(".ProseMirror img")).filter(
                (i) => i.naturalWidth > 0,
              ).length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3);

    // 前提：首屏 Mermaid 已渲染。本浏览器构建会把视口外的图表也交给空闲队列，
    // 两张都渲染出来属正常；「未渲染 → 补渲染」的真实路径见 P6。
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelectorAll(".ProseMirror .mermaid-render svg").length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const popupPromise = context.waitForEvent("page", { timeout: 30_000 });
    await openExportMenu(page);
    await page.locator(".export-item", { hasText: "导出 PDF" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState("load");

    // 等到 print() 真的被调用（waitForImages 之后才触发）。
    // 这一步同时证明「有图加载不出来时不会永久卡住」——waitForImages 有 IMAGE_WAIT_MS 上限。
    await expect
      .poll(
        async () =>
          popup.evaluate(() => (window as unknown as { __probe: { printAt: number } }).__probe.printAt),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    const probe = await popup.evaluate(() => {
      const w = window as unknown as {
        __probe: { printAt: number; printImgCount: number; printNotReady: string[] };
      };
      return {
        ...w.__probe,
        imgs: Array.from(document.querySelectorAll("img")).map((i) => ({
          src: i.getAttribute("src") ?? "",
          ok: i.complete && i.naturalWidth > 0,
        })),
        // DOM 级断言（独立文档会内联整份应用样式表，选择器**文本**里出现类名是正常的）
        chrome: [
          ".cm-gutters",
          ".code-block-toolbar",
          ".code-block-cm",
          "[contenteditable]",
          ".image-resize-handle",
          ".code-block-placeholder",
          ".mermaid-toolbar",
          ".mermaid-editor",
          ".inkling-block-handle",
        ].map((sel) => [sel, document.querySelectorAll(sel).length] as const),
        // 选择器必须带语言 class：frontmatter 也用 `.code-block-export`，但不带
        // `language-*`，裸选择器会先命中它并数出 0 行代码。
        codeLines: (document.querySelector("pre.code-block-export code.language-typescript")?.textContent ?? "")
          .split("\n").filter((l) => l.startsWith("const line")).length,
        // #373 验收项「PDF 无缺失图表」：两张 Mermaid 都必须留下可辨识内容
        mermaid: Array.from(document.querySelectorAll(".mermaid-render")).map((el) => ({
          ready: !!(el.querySelector("svg") || el.querySelector(".mermaid-export-fallback")),
        })),
        html: document.documentElement.outerHTML,
      };
    });

    // print() 时刻：图片一张不缺，且**我们自己产出的**每一张都已就绪。
    // 唯一允许未就绪的是外部 http(s) 地址——它不由导出管线控制，waitForImages
    // 对它是有界等待（本 harness 的打印窗口无外网，example.com 必然拉不到）。
    expect(probe.printImgCount, "打印窗口里应有本地图 + 远程图").toBeGreaterThanOrEqual(4);
    expect(
      probe.printNotReady.filter((src) => !/^https?:\/\//.test(src)),
      "内联本地图必须在 print() 前就绪；未就绪的只能是外部地址",
    ).toEqual([]);

    const locals = probe.imgs.filter((i) => i.src.startsWith("data:"));
    expect(locals.length, "本地图应已内联").toBeGreaterThanOrEqual(3);
    expect(locals.every((i) => i.ok), "内联图必须真的解码成功").toBe(true);
    // 三类本地资源各自都要以**真实 MIME** 内联；缺失占位同样是可解码的 SVG data URL，
    // 只看 data:+ok 会把「三张全降级成占位」误判为成功。
    for (const mime of ["data:image/png", "data:image/jpeg", "data:image/svg+xml"]) {
      expect(locals.some((i) => i.src.startsWith(mime)), `缺少以内联 ${mime} 呈现的本地图`).toBe(
        true,
      );
    }
    expect(probe.imgs.some((i) => i.src.includes("example.com")), "远程图保持原地址").toBe(true);

    for (const [sel, n] of probe.chrome) expect(n, `PDF 产物不应含 ${sel}`).toBe(0);
    expect(probe.codeLines, "长代码块源码必须完整").toBe(200);
    expect(probe.mermaid.length, "PDF 里两张 Mermaid 都必须在").toBe(2);
    expect(
      probe.mermaid.every((m) => m.ready),
      "PDF 里不应出现空图表（svg 或完整源码兜底二选一）",
    ).toBe(true);
    expect(probe.html).not.toContain("asset.localhost");
    expect(probe.html).not.toContain(devHost);
    expect(probe.html).not.toContain("asset://");
    for (const m of alerts) expect(m).toContain("未能完整导出");
    await popup.close();
  });

  test("P3 复制为富文本：粘进独立 contenteditable 容器后无控件、内容完整、图片不丢", async ({
    page,
    context,
  }) => {
    const images = await makeRealImages(page);
    await routeFixtureImages(page, images);
    const alerts = collectAlerts(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await openMockWorkspace(page);
    await openFile(page, "export-demo.md");
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              Array.from(document.querySelectorAll<HTMLImageElement>(".ProseMirror img")).filter(
                (i) => i.naturalWidth > 0,
              ).length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3);

    await openExportMenu(page);
    await page.locator(".export-item", { hasText: "复制为富文本" }).click();

    // 从剪贴板真实取回 text/html（不是读导出函数的返回值）；写入是异步的，轮询到有内容为止
    let html = "";
    await expect
      .poll(
        async () => {
          html = await page.evaluate(async () => {
            try {
              const items = await navigator.clipboard.read();
              for (const item of items) {
                if (item.types.includes("text/html")) {
                  return await (await item.getType("text/html")).text();
                }
              }
            } catch {
              // 权限/实现差异：下一轮再试
            }
            return "";
          });
          return html.length;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    expect(html).not.toContain("asset.localhost");
    expect(html).not.toContain("cm-gutters");
    expect(html).not.toContain("contenteditable");

    // 把剪贴板里的 text/html 落进一个**独立的** contenteditable 容器（等价于粘进外部程序），
    // 再检查最终 DOM：控件必须结构上不存在，内容必须完整。
    const sink = await context.newPage();
    await sink.goto("about:blank");
    const report = await sink.evaluate(async (fragment) => {
      const host = document.createElement("div");
      host.setAttribute("contenteditable", "true");
      document.body.appendChild(host);
      const parsed = new DOMParser().parseFromString(fragment, "text/html");
      while (parsed.body.firstChild) host.appendChild(parsed.body.firstChild);
      await Promise.all(
        Array.from(host.querySelectorAll("img")).map(
          (i) =>
            new Promise<void>((resolve) => {
              if (i.complete) return resolve();
              i.onload = () => resolve();
              i.onerror = () => resolve();
            }),
        ),
      );
      return {
        imgs: Array.from(host.querySelectorAll("img")).map((i) => ({
          alt: i.getAttribute("alt") ?? "",
          src: i.getAttribute("src") ?? "",
          isData: (i.getAttribute("src") ?? "").startsWith("data:"),
          ok: i.complete && i.naturalWidth > 0,
        })),
        chrome: [
          ".cm-gutters",
          ".code-block-toolbar",
          ".code-block-cm",
          ".image-resize-handle",
          ".mermaid-toolbar",
          ".code-block-placeholder",
          "select",
          "textarea",
        ]
          .map((sel) => [sel, host.querySelectorAll(sel).length] as const)
          .filter(([, n]) => n > 0),
        // 宿主自己带 contenteditable（模拟外部编辑区），内容里不得再嵌套一个
        innerEditable: host.querySelectorAll("[contenteditable]").length,
        // 同 P2：必须带语言 class，否则会先命中 frontmatter 的 `.code-block-export`
        codeLines: (host.querySelector("pre.code-block-export code.language-typescript")?.textContent ?? "")
          .split("\n")
          .filter((l) => l.startsWith("const line")).length,
        tsClass: !!host.querySelector("code.language-typescript"),
        pyText: host.querySelector("code.language-python")?.textContent ?? "",
        strong: host.querySelector("strong")?.textContent ?? "",
        h1: host.querySelector("h1")?.textContent ?? "",
        mermaidSvg: host.querySelectorAll(".mermaid-render svg").length,
        mermaidFallback: host.querySelectorAll(".mermaid-export-fallback").length,
        outer: host.outerHTML,
      };
    }, html);

    for (const [sel, n] of report.chrome) expect(n, `粘贴结果不应含 ${sel}`).toBe(0);
    expect(report.innerEditable, "粘贴内容里不得残留 contenteditable").toBe(0);
    expect(report.imgs.filter((i) => i.isData).length, "本地图应已内联").toBeGreaterThanOrEqual(3);
    expect(report.imgs.filter((i) => i.isData).every((i) => i.ok), "内联图必须解码成功").toBe(true);
    // 每类本地资源都要以真实 MIME 出现（占位图也是可解码的 data:image/svg+xml）
    const localByAlt = new Map(report.imgs.map((i) => [i.alt, i]));
    for (const [alt, mime] of [
      ["绿色方块", "data:image/png"],
      ["红色方块", "data:image/jpeg"],
      ["矢量图形", "data:image/svg+xml"],
    ] as const) {
      const img = localByAlt.get(alt);
      expect(img, `粘贴结果缺少 ${alt}`).toBeTruthy();
      expect(img!.src.startsWith(mime), `${alt} 必须是真实资源（${mime}），不是缺失占位`).toBe(
        true,
      );
      expect(img!.ok, `${alt} 必须能解码`).toBe(true);
    }
    expect(report.codeLines, "长代码块源码必须完整").toBe(200);
    expect(report.tsClass).toBe(true);
    expect(report.pyText).toContain('print("below the fold")');
    expect(report.strong).toBe("加粗");
    expect(report.h1).toContain("导出可移植性夹具");
    expect(report.mermaidSvg + report.mermaidFallback, "两张 Mermaid 都不能是空块").toBe(2);
    expect(report.outer).not.toContain("asset.localhost");
    for (const m of alerts) expect(m).toContain("未能完整导出");
    await sink.close();
  });

  test("P4 导出长图：本地图片真的画进画布（跨源/相对地址都不再丢图）", async ({ page }) => {
    const images = await makeRealImages(page);
    await routeFixtureImages(page, images);
    const alerts = collectAlerts(page);

    await openMockWorkspace(page);
    await openFile(page, "export-demo.md");
    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              Array.from(document.querySelectorAll<HTMLImageElement>(".ProseMirror img")).filter(
                (i) => i.naturalWidth > 0,
              ).length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(3);

    const png = await exportAndRead(page, "导出长图", /export-demo\.png$/);
    expect(png.byteLength, "PNG 产物必须非空").toBeGreaterThan(2_000);

    // 用被测浏览器解码产物并**扫像素**：三种本地图都必须真的画上了
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    const pixels = await page.evaluate(async (url) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("导出产物不是可解码的 PNG"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let green = 0;
      let red = 0;
      let magenta = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 80 && d[i + 1] > 140 && d[i + 2] < 80) green += 1;
        if (d[i] > 140 && d[i + 1] < 90 && d[i + 2] < 90) red += 1;
        // SVG 图片（#ff00ff 圆心）：与绿/红/文字色都不撞
        if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) magenta += 1;
      }
      return { green, red, magenta, w: img.naturalWidth, h: img.naturalHeight };
    }, dataUrl);

    expect(pixels.w, "长图必须有实际尺寸").toBeGreaterThan(400);
    expect(pixels.h, "长图必须有实际高度").toBeGreaterThan(400);
    expect(pixels.green, "本地 PNG（绿块）必须画进导出图").toBeGreaterThan(20);
    expect(pixels.red, "本地 JPEG（红块）必须画进导出图").toBeGreaterThan(20);
    expect(pixels.magenta, "本地 SVG（品红圆心）必须画进导出图").toBeGreaterThan(20);
    for (const m of alerts) expect(m).toContain("未能完整导出");
  });

  test("P5 缺失资源：可见降级告知 + 占位符，绝不静默缺图", async ({ page }) => {
    const images = await makeRealImages(page);
    await routeFixtureImages(page, images);
    const alerts = collectAlerts(page);

    await openMockWorkspace(page);
    await openFile(page, "export-missing.md");

    const html = (await exportAndRead(page, "导出 HTML", /export-missing\.html$/)).toString("utf8");

    // 降级告知必须真的弹出来，并且能指到出问题的那一条引用（否则用户只看到少了一张图）
    await expect.poll(() => alerts.length, { timeout: 10_000 }).toBe(1);
    expect(alerts[0]).toContain("未能完整导出");
    expect(alerts[0]).toContain("assets/gone.png");

    // 产物本身也要能看出缺了哪张：读得到的内联为 data URL，读不到的换成说明占位
    const moved = mkdtempSync(join(tmpdir(), "inkling-missing-"));
    try {
      const target = join(moved, "missing.html");
      writeFileSync(target, html, "utf8");
      await page.goto(pathToFileURL(target).href);
      await page.waitForLoadState("load");
      const imgs = await page.evaluate(() =>
        Array.from(document.images).map((i) => ({
          alt: i.getAttribute("alt") ?? "",
          src: i.getAttribute("src") ?? "",
          ok: i.complete && i.naturalWidth > 0,
        })),
      );
      const good = imgs.find((i) => i.alt === "存在的图片");
      const missing = imgs.find((i) => i.alt === "缺失的图片");
      expect(good?.src.startsWith("data:image/png"), "存在的图片应内联").toBe(true);
      expect(good?.ok, "存在的图片必须能解码").toBe(true);
      expect(missing, "缺失的图片不能凭空消失，要留下可读占位").toBeTruthy();
      expect(missing!.src.startsWith("data:image/svg+xml"), "缺失的图片应换成说明占位").toBe(true);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  test("P6 未渲染的图表：导出时按文档源码补渲染（真实 mermaid），且不扰动编辑器", async ({
    page,
  }) => {
    const images = await makeRealImages(page);
    await routeFixtureImages(page, images);
    collectAlerts(page);

    await openMockWorkspace(page);
    await openFile(page, "export-demo.md");

    // 夹具里两张图都会被空闲队列渲染；把第二张退回「未渲染」形状，
    // 才是懒加载/慢渲染时导出真正遇到的现场——它没有 svg，只能按源码补渲染。
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelectorAll(".ProseMirror .mermaid-render svg").length,
          ),
        { timeout: 15_000 },
      )
      .toBe(2);
    const before = await page.evaluate(() => {
      const hosts = document.querySelectorAll<HTMLElement>(".mermaid-render");
      const last = hosts[hosts.length - 1];
      last.querySelectorAll("svg").forEach((el) => el.remove());
      last.setAttribute("data-placeholder", "输入 Mermaid 图表代码");
      last.style.minHeight = "184px";
      return {
        rendered: document.querySelectorAll(".ProseMirror .mermaid-render svg").length,
        blocks: document.querySelectorAll(".mermaid-block").length,
      };
    });
    expect(before.blocks, "夹具应有两块 Mermaid").toBe(2);
    expect(before.rendered, "清理后应只剩一张已渲染").toBe(1);

    const html = (await exportAndRead(page, "导出 HTML", /export-demo\.html$/)).toString("utf8");

    // 导出只处理克隆：编辑器里那张仍然是「未渲染」，占位属性也不会被顺手摘掉
    const live = await page.evaluate(() => ({
      svgs: document.querySelectorAll(".ProseMirror .mermaid-render svg").length,
      placeholders: document.querySelectorAll(".ProseMirror .mermaid-render[data-placeholder]")
        .length,
    }));
    expect(live.svgs, "导出不得把补渲染结果写回编辑器").toBe(1);
    expect(live.placeholders, "克隆口径：编辑器里的占位状态保持原样").toBe(1);

    const moved = mkdtempSync(join(tmpdir(), "inkling-mermaid-"));
    try {
      const target = join(moved, "mermaid.html");
      writeFileSync(target, html, "utf8");
      await page.goto(pathToFileURL(target).href);
      await page.waitForLoadState("load");

      const blocks = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".mermaid-render")).map((el) => ({
          hasSvg: !!el.querySelector("svg"),
          svgText: (el.querySelector("svg")?.textContent ?? "").replace(/\s+/g, " ").trim(),
          fallback: el.querySelector(".mermaid-export-fallback")?.textContent ?? "",
        })),
      );
      expect(blocks).toHaveLength(2);
      const second = blocks[1];
      // 编辑器里该块没有 svg：产物里的 svg 只可能来自导出的按源码补渲染
      expect(second.hasSvg, "未渲染的图表必须由导出补渲染出 svg").toBe(true);
      expect(second.fallback, "补渲染成功时不应再叠源码兜底").toBe("");
      expect(second.svgText, "补渲染出的图必须带图表里的文字").toContain("服务端");
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  test("P7 Mermaid 语法错误：有界等待后回退为完整源码，产物不留空块", async ({ page }) => {
    const alerts = collectAlerts(page);

    await openMockWorkspace(page);
    await openFile(page, "export-mermaid-bad.md");

    // 前提：编辑器侧渲染**真的失败**了（源码本身不可解析）。
    // 否则「产物里是源码」可能只是导出没走补渲染，而不是走失败兜底。
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const host = document.querySelector<HTMLElement>(".ProseMirror .mermaid-render");
            return host ? host.classList.contains("has-error") : false;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);

    const html = (await exportAndRead(page, "导出 HTML", /export-mermaid-bad\.html$/)).toString(
      "utf8",
    );

    // 降级告知必须可见，且能指到「图表源码」而非含糊的「有一处失败」
    await expect.poll(() => alerts.length, { timeout: 10_000 }).toBe(1);
    expect(alerts[0]).toContain("未能完整导出");
    expect(alerts[0]).toContain("Mermaid");
    expect(alerts[0]).toContain("源码");

    const moved = mkdtempSync(join(tmpdir(), "inkling-mermaid-bad-"));
    try {
      const target = join(moved, "bad.html");
      writeFileSync(target, html, "utf8");
      await page.goto(pathToFileURL(target).href);
      await page.waitForLoadState("load");

      const report = await page.evaluate(() => {
        const host = document.querySelector<HTMLElement>(".mermaid-block .mermaid-render");
        return {
          hasSvg: !!host?.querySelector("svg"),
          fallback: host?.querySelector(".mermaid-export-fallback")?.textContent ?? "",
          // 图块容器里的可见文本：兜底块之外不得叠着编辑器的错误提示
          blockText: (document.querySelector(".mermaid-block")?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
          toolbars: document.querySelectorAll(".mermaid-toolbar, .mermaid-editor").length,
        };
      });
      expect(report.fallback, "渲染失败必须回退为完整源码").toBe("this is not a mermaid diagram");
      expect(report.hasSvg, "解析失败的图表不应凭空出现 svg").toBe(false);
      expect(report.blockText, "兜底后只剩图表源码本身").toBe("this is not a mermaid diagram");
      expect(report.toolbars, "产物不应残留 Mermaid 编辑工具条/编辑框").toBe(0);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  test("P8 Mermaid 编辑中导出：编辑态正常收起，产物是渲染好的图而不是编辑框/隐藏块", async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "export-demo.md");

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelectorAll(".ProseMirror .mermaid-render svg").length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThanOrEqual(1);

    // 进入第一张图的编辑态：图表被 display:none 隐藏、源码 textarea 显示
    await page.locator(".mermaid-edit-btn").first().click();
    const readEditing = () =>
      page.evaluate(() => {
        const block = document.querySelector<HTMLElement>(".mermaid-block")!;
        const diagram = block.querySelector<HTMLElement>(".mermaid-render")!;
        const editor = block.querySelector<HTMLTextAreaElement>(".mermaid-editor")!;
        return {
          diagramDisplay: getComputedStyle(diagram).display,
          editorDisplay: getComputedStyle(editor).display,
          text: editor.value,
        };
      });
    const editingBefore = await readEditing();
    expect(editingBefore.diagramDisplay, "编辑态下图表应隐藏").toBe("none");
    expect(editingBefore.editorDisplay, "编辑态下源码框应显示").not.toBe("none");
    expect(editingBefore.text).toContain("flowchart LR");

    const html = (await exportAndRead(page, "导出 HTML", /export-demo\.html$/)).toString("utf8");

    // 点导出菜单时 textarea 失焦，编辑器按既有行为提交并收起编辑态（不是导出改的）；
    // 导出本身不得改动文档内容，也不得把图表留在隐藏/未渲染状态。
    const live = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>(".mermaid-block")!;
      const diagram = block.querySelector<HTMLElement>(".mermaid-render")!;
      const editor = block.querySelector<HTMLTextAreaElement>(".mermaid-editor")!;
      return {
        diagramDisplay: getComputedStyle(diagram).display,
        editorDisplay: getComputedStyle(editor).display,
        hasSvg: !!diagram.querySelector("svg"),
        editorValue: editor.value,
      };
    });
    expect(live.diagramDisplay, "编辑态收起后图表应重新可见").not.toBe("none");
    expect(live.editorDisplay, "编辑态收起后源码框应隐藏").toBe("none");
    expect(live.hasSvg).toBe(true);
    // 导出不得改动图表源码（失焦提交的是编辑框里原有内容）
    expect(live.editorValue).toBe(editingBefore.text);

    // 导出前编辑的源码必须原样留在文档里：切源码模式直接读 Markdown 文本
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor").locator(".cm-content");
    await expect(source).toBeVisible({ timeout: 5_000 });
    const markdown = await source.innerText();
    expect(markdown).toContain("flowchart LR");
    expect(markdown).toContain("A[开始] --> B[结束]");
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });

    const moved = mkdtempSync(join(tmpdir(), "inkling-mermaid-edit-"));
    try {
      const target = join(moved, "edit.html");
      writeFileSync(target, html, "utf8");
      await page.goto(pathToFileURL(target).href);
      await page.waitForLoadState("load");

      const first = await page.evaluate(() => {
        const block = document.querySelector<HTMLElement>(".mermaid-block")!;
        const diagram = block.querySelector<HTMLElement>(".mermaid-render")!;
        return {
          display: getComputedStyle(diagram).display,
          hasSvg: !!diagram.querySelector("svg"),
          text: (diagram.textContent ?? "").replace(/\s+/g, " ").trim(),
          editors: document.querySelectorAll(".mermaid-editor").length,
        };
      });
      expect(first.display, "产物里的图表不能继承编辑态的 display:none").not.toBe("none");
      expect(first.hasSvg, "编辑中的图表也要按已保存源码渲染出 svg").toBe(true);
      expect(first.text).toContain("开始");
      expect(first.editors, "编辑框不得进产物").toBe(0);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });
});

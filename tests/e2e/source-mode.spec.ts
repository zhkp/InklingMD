// E2E：源代码模式（issue #19）

import { test, expect, type Page } from "@playwright/test";
import {
  SOURCE_OUTLINE_DEBOUNCE_MS,
  SOURCE_OUTLINE_DEADLINE_MS,
} from "../../src/lib/restartable-debounce";
import { openMockWorkspace, openFile, moveCaretToDocEnd, MOD } from "./helpers";

/** 把防抖拉长到这个值，让「退出时定时器仍挂在队列上」成为确定性事件 */
const STRETCHED_DEBOUNCE_MS = 1200;

/**
 * 把源码模式大纲防抖拉长到 1200ms（#375 竞态用例专用）。
 *
 * 不打这个补丁，「退出时定时器是否还挂在队列上」取决于打字速度，竞态是概率事件；
 * 拉长后它变成确定性事件。只包「延迟等于生产常量」的定时器，且只在打字期间生效：
 * 退出前恢复，避免 WYSIWYG tracker 自己的定时器混入计数。
 *
 * 命中次数记在 `__outlineTimerStretched`，调用方必须用
 * `expectStretchEngaged()` 断言 > 0——否则常量一改，补丁静默失效，
 * 两条竞态用例会退化成概率事件却仍然全绿。
 */
async function stretchSourceOutlineDebounce(page: Page): Promise<void> {
  await page.evaluate(
    ({ delayMs, stretchMs }) => {
      const w = window as unknown as {
        __outlineTimerFires?: number;
        __outlineTimerArmed?: boolean;
        __outlineTimerStretched?: number;
        __origSetTimeout?: typeof window.setTimeout;
      };
      w.__outlineTimerFires = 0;
      w.__outlineTimerArmed = false;
      w.__outlineTimerStretched = 0;
      w.__origSetTimeout = window.setTimeout.bind(window);
      const orig = w.__origSetTimeout;
      window.setTimeout = ((
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => {
        if (timeout === delayMs && typeof handler === "function") {
          w.__outlineTimerStretched = (w.__outlineTimerStretched ?? 0) + 1;
          return orig(() => {
            if (w.__outlineTimerArmed) {
              w.__outlineTimerFires = (w.__outlineTimerFires ?? 0) + 1;
            }
            handler(...args);
          }, stretchMs);
        }
        return orig(handler, timeout, ...args);
      }) as typeof window.setTimeout;
    },
    { delayMs: SOURCE_OUTLINE_DEBOUNCE_MS, stretchMs: STRETCHED_DEBOUNCE_MS },
  );
}

/** 断言上面的补丁真的命中过（否则竞态用例失去确定性，等于静默放宽） */
async function expectStretchEngaged(page: Page): Promise<void> {
  const stretched = await page.evaluate(
    () =>
      (window as unknown as { __outlineTimerStretched?: number })
        .__outlineTimerStretched ?? 0,
  );
  expect(
    stretched,
    `没有命中任何 ${SOURCE_OUTLINE_DEBOUNCE_MS}ms 定时器：防抖常量与 E2E 补丁不一致，` +
      `退出竞态不再是确定性事件（SM8/SM10 会退化成概率用例）`,
  ).toBeGreaterThan(0);
}

/** 恢复被拉长的 setTimeout 并布防：此后的迟到触发才计入 __outlineTimerFires */
async function restoreSetTimeoutAndArm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __outlineTimerArmed?: boolean;
      __origSetTimeout?: typeof window.setTimeout;
    };
    window.setTimeout = w.__origSetTimeout!;
    w.__outlineTimerArmed = true;
  });
}

test.describe("源代码模式", () => {
  test.beforeEach(async ({ page }) => {
    await openMockWorkspace(page);
    await openFile(page, "readme.md");
  });

  test("SM1 顶栏按钮切换源码模式", async ({ page }) => {
    const btn = page.locator('.topbar-btn[title*="源代码模式"]');
    await btn.click();
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(".ProseMirror")).toBeHidden();
    await btn.click();
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("source-mode-editor")).toBeHidden();
  });

  test("SM2 快捷键 Ctrl+Alt+S 切换", async ({ page }) => {
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });
  });

  test("SM3 源码模式编辑会标记未保存", async ({ page }) => {
    await page.locator('.topbar-btn[title*="源代码模式"]').click();
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });
    await page.getByTestId("source-mode-editor").locator(".cm-content").click();
    await page.keyboard.type("# source mode edit");
    await expect(page.getByText("未保存")).toBeVisible({ timeout: 5_000 });
  });

  test("SM5 编辑后立即切换源码模式不丢失防抖窗口内的输入", async ({ page }) => {
    // 回归：publisher 序列化防抖 150ms，切换瞬间 store 若落后于 PM doc，
    // 源码模式会用旧内容播种并永久丢失最近编辑（PR #34 review P1）
    await page.locator(".ProseMirror").click();
    await page.keyboard.type("即时切换不丢字");
    // 不等防抖，立即切换
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(
      page.getByTestId("source-mode-editor").locator(".cm-content"),
    ).toContainText("即时切换不丢字", { timeout: 5_000 });
    // 往返回 WYSIWYG 内容仍在
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toContainText("即时切换不丢字", {
      timeout: 5_000,
    });
  });

  test("SM4 callout 往返", async ({ page }) => {
    await openFile(page, "callout-demo.md");
    await page.locator('.topbar-btn[title*="源代码模式"]').click();
    await expect(page.getByTestId("source-mode-editor").locator(".cm-content")).toContainText("[!", { timeout: 5_000 });
    await page.locator('.topbar-btn[title*="源代码模式"]').click();
    await expect(page.locator(".callout-block").first()).toBeVisible({ timeout: 5_000 });
  });

  test("SM6 源码模式下大纲面板正常解析标题并支持点击跳转", async ({ page }) => {
    await openFile(page, "outline-demo.md");
    // 确保大纲面板可见
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }

    // 切换至源码模式
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.getByTestId("source-mode-editor")).toBeVisible({ timeout: 5_000 });

    // 大纲项依然存在且与文档结构对应
    const outlineItems = panel.locator(".outline-item");
    await expect(outlineItems.first()).toBeVisible({ timeout: 5_000 });
    expect(await outlineItems.count()).toBe(3);

    // 点击三级标题大纲项跳转并激活
    const thirdItem = outlineItems.nth(2);
    await thirdItem.click();
    await expect(thirdItem).toHaveClass(/active/, { timeout: 5_000 });
  });

  test("SM7 源码模式新增标题后大纲在停笔后更新（#375）", async ({ page }) => {
    await openFile(page, "outline-demo.md");
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor");
    await expect(source).toBeVisible({ timeout: 5_000 });
    await expect(panel.locator(".outline-item")).toHaveCount(3);

    // 页面内计时（#375 验收）：以最后一次输入为起点，到面板出现第 4 项为止。
    // 用页面内 performance.now() 记录，CDP 往返不计入；keydown/beforeinput/input
    // 三种路径都监听——CJK 字符走 insertText，未必有 keydown。
    await page.evaluate(() => {
      const w = window as unknown as {
        __lastInputAt?: number;
        __outlineSeenAt?: number;
      };
      w.__lastInputAt = undefined;
      w.__outlineSeenAt = undefined;
      const mark = () => {
        w.__lastInputAt = performance.now();
      };
      for (const type of ["keydown", "beforeinput", "input"]) {
        document.addEventListener(type, mark, true);
      }
      const target = document.querySelector(".outline-panel");
      if (!target) return;
      const observer = new MutationObserver(() => {
        if (w.__outlineSeenAt !== undefined) return;
        if (document.querySelectorAll(".outline-panel .outline-item").length < 4) {
          return;
        }
        w.__outlineSeenAt = performance.now();
        observer.disconnect();
      });
      observer.observe(target, { childList: true, subtree: true });
    });

    await source.locator(".cm-content").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("# 新增标题");

    // 停笔后防抖 200ms 内完成重解析并发布新标题集
    const items = panel.locator(".outline-item");
    await expect(items).toHaveCount(4, { timeout: 5_000 });
    await expect(items.nth(3)).toContainText("新增标题");
    // 旧标题仍在且顺序不变（未因重解析整体错位）
    await expect(items.nth(0)).toContainText("一级标题");
    await expect(items.nth(2)).toContainText("三级标题");

    // #375 的真实验收：停笔 250ms 内更新。5 秒轮询只能证明「最终会更新」，
    // 退化成秒级也照样绿，因此必须断言时延上界（防抖常量与回调内同步
    // 发布的确定性锁在 tests/unit/restartable-debounce.test.ts）。
    const elapsed = await page.evaluate(() => {
      const w = window as unknown as {
        __lastInputAt?: number;
        __outlineSeenAt?: number;
      };
      return typeof w.__lastInputAt === "number" &&
        typeof w.__outlineSeenAt === "number"
        ? w.__outlineSeenAt - w.__lastInputAt
        : null;
    });
    expect(elapsed, "未采集到停笔 → 大纲更新的时延").not.toBeNull();
    expect(
      elapsed as number,
      `停笔到大纲更新耗时 ${elapsed}ms，超过 #375 的 ${SOURCE_OUTLINE_DEADLINE_MS}ms 验收上限`,
    ).toBeLessThanOrEqual(SOURCE_OUTLINE_DEADLINE_MS);
  });

  test("SM8 源码模式新增标题后立即退出，大纲不回退旧快照（#375 竞态）", async ({ page }) => {
    await openFile(page, "outline-demo.md");
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor");
    await expect(source).toBeVisible({ timeout: 5_000 });

    // 把源码模式大纲防抖（200ms）拉长到 1200ms：打字速度不再决定
    // 「切回 WYSIWYG 时定时器是否还挂在队列上」，竞态成为确定性事件。
    await stretchSourceOutlineDebounce(page);

    await source.locator(".cm-content").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("# 竞态标题");
    await expectStretchEngaged(page);

    // 打字结束：恢复 setTimeout 并布防（此后的迟到触发才计入），再切回 WYSIWYG。
    // 卸载若没清掉待执行定时器，它会在 1200ms 后触发并留下计数。
    await restoreSetTimeoutAndArm(page);
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });

    const items = panel.locator(".outline-item");
    await expect(items).toHaveCount(4, { timeout: 5_000 });
    await expect(items.nth(3)).toContainText("竞态标题");

    // 越过被拉长的防抖窗口后，源码模式的旧定时器必须已被卸载清理
    await page.waitForTimeout(1_400);
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as { __outlineTimerFires?: number }
          ).__outlineTimerFires,
      ),
    ).toBe(0);
    await expect(items).toHaveCount(4);
  });

  test("SM10 退出源码模式的首个可见帧就已是新大纲（#375 首帧）", async ({ page }) => {
    await openFile(page, "outline-demo.md");
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor");
    await expect(source).toBeVisible({ timeout: 5_000 });
    await expect(panel.locator(".outline-item")).toHaveCount(3);

    // 与 SM8 同一手法：把防抖拉长到 1200ms，退出时定时器必然还挂着。
    // 这样「首帧是不是旧快照」不再取决于打字速度。
    await stretchSourceOutlineDebounce(page);

    await source.locator(".cm-content").click();
    await moveCaretToDocEnd(page);
    await page.keyboard.press("Enter");
    await page.keyboard.type("# 首帧标题");
    await expectStretchEngaged(page);

    // 首帧采样：ProseMirror 重新可见后的第一个绘制帧里，大纲面板有哪几项。
    // rAF 回调在绘制前执行，读到的就是这一帧真正会画出来的 DOM。
    //
    // 这里只锁「标题列表」：首帧的高亮索引在本场景里与 tracker 的旧值巧合一致
    // （共享滚动容器跟着源码视口滚过），无法区分对错，因此高亮保值由
    // tests/unit/outline-tracker.test.ts 的同步刷新用例确定性锁定。
    await page.evaluate(() => {
      const w = window as unknown as { __firstFrameOutline?: string[] | null };
      w.__firstFrameOutline = null;
      const tick = () => {
        const holder = document.querySelector(".md-editor-wysiwyg");
        const pm = document.querySelector(".ProseMirror");
        const visible =
          holder instanceof HTMLElement &&
          pm instanceof HTMLElement &&
          getComputedStyle(holder).display !== "none" &&
          pm.getBoundingClientRect().height > 0;
        if (visible) {
          w.__firstFrameOutline = Array.from(
            document.querySelectorAll(".outline-panel .outline-item"),
          ).map((el) => el.textContent ?? "");
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await restoreSetTimeoutAndArm(page);
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    await expect(page.locator(".ProseMirror")).toBeVisible({ timeout: 5_000 });

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __firstFrameOutline?: string[] | null })
                .__firstFrameOutline ?? null,
          ),
        { timeout: 5_000 },
      )
      .not.toBeNull();

    const firstFrame = await page.evaluate(
      () =>
        (window as unknown as { __firstFrameOutline?: string[] })
          .__firstFrameOutline ?? [],
    );
    // 退出过渡必须同帧刷新大纲：首个可见帧就要有 4 项且含新标题，
    // 不能先画旧快照、等 150ms 防抖再补
    expect(
      firstFrame.length,
      `首帧大纲项：${JSON.stringify(firstFrame)}`,
    ).toBe(4);
    expect(firstFrame[3]).toContain("首帧标题");

    // 越过被拉长的旧定时器：已卸载的源码防抖不得把退出前的快照写回来
    await page.waitForTimeout(1_400);
    const items = panel.locator(".outline-item");
    await expect(items).toHaveCount(4);
    await expect(items.nth(3)).toContainText("首帧标题");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __outlineTimerFires?: number })
            .__outlineTimerFires,
      ),
    ).toBe(0);
  });

  test("SM9 源码模式滚动时活动标题按行号定位（含重复标题）", async ({ page }) => {
    // #375：活动项由「视口高度 → 行块 → 标题行号二分」定位。
    // 用同名标题分别放在中段与末尾，滚动到底部时必须命中末尾那个（按行号而不是按文本）。
    const body = (label: string) =>
      Array.from({ length: 8 }, (_, i) => `${label}正文 ${i + 1}`);
    const doc = [
      "# 长文顶部",
      "",
      ...Array.from({ length: 20 }, (_, i) => [
        `## 前段 ${i + 1}`,
        "",
        ...body("前段"),
        "",
      ]).flat(),
      "## 重复标题",
      "",
      ...body("第一个重复标题后"),
      "",
      ...Array.from({ length: 20 }, (_, i) => [
        `## 后段 ${i + 1}`,
        "",
        ...body("后段"),
        "",
      ]).flat(),
      "## 重复标题",
      "",
      ...Array.from({ length: 80 }, (_, i) => `末尾填充段落 ${i + 1}`),
    ].join("\n");

    await openFile(page, "outline-demo.md");
    const panel = page.locator(".outline-panel");
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press(`${MOD}+'`);
      await expect(panel).toBeVisible({ timeout: 5_000 });
    }
    await page.keyboard.press(`${MOD}+Alt+KeyS`);
    const source = page.getByTestId("source-mode-editor");
    await expect(source.locator(".cm-content")).toBeVisible({ timeout: 5_000 });

    await source.locator(".cm-content").click();
    await page.keyboard.press(`${MOD}+KeyA`);
    await page.keyboard.insertText(doc);

    const items = panel.locator(".outline-item");
    const duplicates = items.filter({ hasText: "重复标题" });
    // 1 个顶部标题 + 20 前段 + 1 重复 + 20 后段 + 1 重复
    await expect(items).toHaveCount(43, { timeout: 10_000 });
    await expect(duplicates).toHaveCount(2);

    // 反复设置 scrollTop 直到虚拟化高度稳定在底部
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const el = document.querySelector(
              ".source-mode-editor .cm-scroller",
            ) as HTMLElement | null;
            if (!el) return 0;
            const max = el.scrollHeight - el.clientHeight;
            if (max <= 0) return 0;
            const ratio = el.scrollTop / max;
            if (ratio < 0.98) el.scrollTop = el.scrollHeight;
            return ratio;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.98);

    // 末尾重复标题成为活动项；中段同名标题不得被误选
    await expect(duplicates.nth(1)).toHaveClass(/outline-item-active/, {
      timeout: 10_000,
    });
    await expect(duplicates.nth(0)).not.toHaveClass(/outline-item-active/);

    // 回到顶部：首标题重新激活（视口在首标题之上时归到首标题）
    await page.evaluate(() => {
      const el = document.querySelector(
        ".source-mode-editor .cm-scroller",
      ) as HTMLElement | null;
      if (el) el.scrollTop = 0;
    });
    await expect(items.first()).toHaveClass(/outline-item-active/, {
      timeout: 10_000,
    });
  });
});

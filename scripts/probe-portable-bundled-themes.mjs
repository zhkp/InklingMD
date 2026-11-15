#!/usr/bin/env node
// Run the extracted portable app on Windows, then verify its first-run bundled-theme UI and index.
// Usage: node scripts/probe-portable-bundled-themes.mjs <evidence-dir> <source-manifest> [CDP-port=9222]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { expectedThemeSlugs, hasExpectedBundledThemes } from "./lib/portable-theme-probe.mjs";

const [evidenceDirArg, expectedManifestArg, portArg = "9222"] = process.argv.slice(2);
if (!evidenceDirArg || !expectedManifestArg || !/^\d+$/.test(portArg)) {
  console.error("用法：node scripts/probe-portable-bundled-themes.mjs <证据目录> <源主题清单> [CDP 端口=9222]");
  process.exit(1);
}

const evidenceDir = resolve(evidenceDirArg);
const port = Number(portArg);
const pause = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let browser;
let page;
let expectedSlugs = [];

try {
  const expectedManifest = JSON.parse(readFileSync(resolve(expectedManifestArg), "utf8"));
  expectedSlugs = expectedThemeSlugs(expectedManifest);
  const deadline = Date.now() + 60_000;
  let lastConnectionError;
  while (!browser && Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_500 });
    } catch (error) {
      lastConnectionError = error;
      await pause(500);
    }
  }
  if (!browser) throw new Error(`60 秒内无法连接 WebView2 CDP 端口 ${port}: ${lastConnectionError}`);

  const pageDeadline = Date.now() + 60_000;
  while (!page && Date.now() < pageDeadline) {
    const pages = browser.contexts().flatMap((context) => context.pages());
    page = pages.find((candidate) => /tauri\.localhost/.test(candidate.url()))
      ?? pages.find((candidate) => /^(https?|tauri):/.test(candidate.url()) && candidate.url() !== "about:blank");
    if (!page) await pause(500);
  }
  if (!page) throw new Error("CDP 已连接，但未找到 portable 应用页面");

  await page.locator(".empty-state").waitFor({ state: "visible", timeout: 30_000 });
  await page.bringToFront();
  await page.keyboard.press("Control+n");
  await page.locator(".ProseMirror").waitFor({ state: "visible", timeout: 30_000 });
  const themeButton = page.locator('button[title="主题"]');
  await themeButton.waitFor({ state: "visible", timeout: 30_000 });
  const indexDeadline = Date.now() + 60_000;
  let indexText = null;
  let index;
  while (Date.now() < indexDeadline) {
    indexText = await page.evaluate(() => window.localStorage.getItem("inkling-themes-index"));
    try {
      if (indexText) {
        index = JSON.parse(indexText);
        if (hasExpectedBundledThemes(index, expectedSlugs)) break;
      }
    } catch {
      index = undefined;
    }
    await pause(500);
  }
  const indexedSlugs = Array.isArray(index?.themes)
    ? index.themes
      .filter((theme) => theme?.source === "bundled")
      .map((theme) => typeof theme.id === "string" ? theme.id.replace(/^bundled:/, "") : "(无效 id)")
      .sort()
    : [];
  if (!hasExpectedBundledThemes(index, expectedSlugs)) {
    throw new Error(`bundled 索引主题集合不匹配：expected=${JSON.stringify(expectedSlugs)}, actual=${JSON.stringify(indexedSlugs)}`);
  }

  await page.locator('button[title="主题"]').click();
  await page.locator('[data-theme-menu="1"]').waitFor({ state: "visible", timeout: 10_000 });
  const menuEntries = [];
  for (const slug of expectedSlugs) {
    const option = page.locator(`[data-theme-option="bundled:${slug}"]`);
    await option.waitFor({ state: "visible", timeout: 10_000 });
    const source = await option.getAttribute("data-theme-source");
    if (source !== "bundled") throw new Error(`${slug} 菜单项 source=${source}，预期 bundled`);
    menuEntries.push({ slug, source });
  }

  mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = join(evidenceDir, "portable-theme-menu.png");
  const indexPath = join(evidenceDir, "inkling-themes-index.json");
  const reportPath = join(evidenceDir, "portable-theme-runtime-report.json");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  const report = {
    verdict: "passed",
    appUrl: page.url(),
    expectedManifest: resolve(expectedManifestArg),
    bundledSlugs: expectedSlugs,
    menuEntries,
    evidence: { screenshot: screenshotPath, index: indexPath },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`便携版首次启动验收通过：主题菜单显示 ${expectedSlugs.length} 套预装主题，均为 bundled。`);
  console.log(`菜单截图：${screenshotPath}`);
  console.log(`inkling-themes-index 原文：${indexText}`);
  console.log(`验收报告：${reportPath}`);
} catch (error) {
  mkdirSync(evidenceDir, { recursive: true });
  const failureReport = {
    verdict: "failed",
    error: error instanceof Error ? error.message : String(error),
    expectedManifest: resolve(expectedManifestArg),
    expectedSlugs,
    appUrl: page?.url() ?? null,
    pageTitle: page ? await page.title().catch(() => null) : null,
    bodyText: page ? (await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "")).slice(0, 4_000) : null,
  };
  if (page) {
    await page.screenshot({ path: join(evidenceDir, "portable-theme-runtime-failure.png"), fullPage: true }).catch(() => {});
  }
  writeFileSync(join(evidenceDir, "portable-theme-runtime-failure.json"), `${JSON.stringify(failureReport, null, 2)}\n`);
  console.error(`便携版首次启动验收失败：${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
}

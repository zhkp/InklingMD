// #398：浏览器品牌资源与空状态真实渲染 / 交互回归。
import { expect, test } from "@playwright/test";

test("favicon、ICO 回退与 Apple touch icon 均可加载，不再引用 Vite", async ({ page }) => {
  await page.goto("/");
  const icons = page.locator('head link[rel="icon"]');
  await expect(icons).toHaveCount(2);
  await expect(icons.nth(0)).toHaveAttribute("href", "/favicon.svg");
  await expect(icons.nth(0)).toHaveAttribute("type", "image/svg+xml");
  await expect(icons.nth(1)).toHaveAttribute("href", "/favicon.ico");
  await expect(icons.nth(1)).toHaveAttribute("sizes", "any");
  await expect(page.locator('head link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/apple-touch-icon.png",
  );
  await expect(page.locator('head link[href="/vite.svg"]')).toHaveCount(0);

  for (const path of ["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png", "/logo.svg"]) {
    const response = await page.request.get(path);
    expect(response.ok(), `${path} 应可加载`).toBe(true);
    expect((await response.body()).byteLength, `${path} 不应为空`).toBeGreaterThan(0);
  }

  const apple = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/apple-touch-icon.png";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minAlpha = 255;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      minAlpha = Math.min(minAlpha, pixels[offset]);
    }
    const corner = (x: number, y: number) => {
      const offset = (y * canvas.width + x) * 4;
      return [...pixels.slice(offset, offset + 4)];
    };
    return {
      minAlpha,
      corners: [
        corner(0, 0),
        corner(canvas.width - 1, 0),
        corner(0, canvas.height - 1),
        corner(canvas.width - 1, canvas.height - 1),
      ],
    };
  });
  expect(apple.minAlpha, "Apple touch icon 全像素必须不透明").toBe(255);
  for (const corner of apple.corners) {
    expect(corner[3], "Apple touch icon 圆角外区域必须不透明").toBe(255);
    expect(
      corner.slice(0, 3).every((channel) => channel >= 240),
      "Apple touch icon 圆角外区域应为白色或近白色，不得出现黑角",
    ).toBe(true);
  }
});

for (const mode of ["light", "dark"] as const) {
  test(`空状态在 ${mode} 主题显示完整 Logo，文案布局与打开侧边栏行为不变`, async ({ page }) => {
    await page.addInitScript((themeMode) => {
      localStorage.setItem("inkling-theme", `builtin:${themeMode}`);
      localStorage.setItem(
        "inkling-ui",
        JSON.stringify({ sidebarVisible: false, outlineVisible: true }),
      );
    }, mode);
    await page.goto("/");

    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    const emptyState = page.locator(".empty-state");
    await expect(emptyState).toBeVisible();
    const logo = emptyState.locator("img.empty-state-logo");
    await expect(logo).toHaveAttribute("src", "/logo.svg");
    await expect(logo).toHaveAttribute("alt", "");
    await expect(logo).toHaveCSS("display", "block");
    await expect(logo).toHaveCSS("filter", "none");
    await expect
      .poll(() => logo.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    const logoBox = await logo.boundingBox();
    expect(logoBox?.width).toBeCloseTo(72, 3);
    expect(logoBox?.height).toBeCloseTo(72, 3);

    const title = emptyState.getByRole("heading", { name: "InklingMD" });
    const description = emptyState.locator("p");
    await expect(title).toBeVisible();
    await expect(description).toHaveText(
      "从左侧侧边栏「打开」文件夹，或「打开文件」直接打开一个 .md 开始编辑",
    );
    const titleBox = await title.boundingBox();
    expect(logoBox && titleBox && logoBox.y + logoBox.height <= titleBox.y).toBe(true);

    const openSidebar = emptyState.getByRole("button", { name: "打开侧边栏" });
    await expect(openSidebar).toBeVisible();
    await openSidebar.click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(openSidebar).toHaveCount(0);
  });
}

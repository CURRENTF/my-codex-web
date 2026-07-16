import { expect, test } from "@playwright/test";
import path from "node:path";

test("loads the local app and exposes a single-sidebar workspace", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Codex Web");
  const authGate = page.getByText("需要 Codex 登录");
  const sidebar = page.locator(".sidebar");
  await expect(authGate.or(sidebar).first()).toBeVisible();
  if (await sidebar.isVisible()) {
    await expect(page.getByRole("button", { name: "新建 Session" })).toBeVisible();
    await expect(page.getByRole("tablist")).toBeVisible();
  }
});

test("adapts the workspace controls and navigation to the available width", async ({ page }) => {
  test.setTimeout(90_000);
  const outputDir = path.resolve("output/playwright/responsive");

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  test.skip(!(await sidebar.isVisible()), "Requires the isolated, logged-in E2E CODEX_HOME");

  const newSession = page.getByRole("button", { name: "新建 Session" });
  await newSession.click();
  await page.waitForURL(/\/sessions\//, { timeout: 30_000 });
  await expect(page.locator(".composer")).toBeVisible();

  const sizes = [
    { width: 1440, height: 960, name: "desktop-1440" },
    { width: 1024, height: 768, name: "compact-1024" },
    { width: 720, height: 900, name: "drawer-720" },
    { width: 390, height: 844, name: "mobile-390" },
  ];

  for (const size of sizes) {
    await page.setViewportSize(size);
    if (size.width <= 720) await expect(sidebar).not.toBeInViewport();
    await expect(page.locator(".composer")).toBeVisible();
    await expect(page.locator(".access-control select")).toBeVisible();
    await expect(page.locator(".inline-select select").first()).toBeVisible();
    await expect(page.locator(".reasoning-select select")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(outputDir, `${size.name}.png`), fullPage: true });
  }

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "Side Chat" }).click();
  await expect(page.locator(".mobile-pane-tabs")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".side-pane")).toBeVisible();
  await expect(page.locator(".side-pane .composer")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: path.join(outputDir, "side-chat-tabs-1024.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.locator(".mobile-pane-tabs")).toBeHidden();
  await expect(page.locator(".main-pane")).toBeVisible();
  await expect(page.locator(".side-pane")).toBeVisible();
  await page.screenshot({ path: path.join(outputDir, "side-chat-split-1440.png"), fullPage: true });

  await expect(sidebar).toBeVisible();
  await expect.poll(async () => Number.parseFloat(await sidebar.evaluate((node) => getComputedStyle(node).width))).toBeGreaterThan(280);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).not.toBeInViewport();
  const toggle = page.getByRole("button", { name: "打开侧边栏" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(sidebar).toBeInViewport();
  await page.getByRole("button", { name: "关闭侧边栏" }).first().click();
  await expect(sidebar).not.toBeInViewport();
});

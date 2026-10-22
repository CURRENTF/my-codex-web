import { expect, test } from "@playwright/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Run with CODEX_WEB_E2E_FIXTURE_BACKENDS=1 and CODEX_WEB_{PI,AGY}_BIN
// pointing to tests/fixtures/{pi-rpc,agy-cli}.mjs. No model calls are made.
test("switches empty-session backends and creates without waiting for catalog or history reads", async ({ page }) => {
  test.skip(process.env.CODEX_WEB_E2E_FIXTURE_BACKENDS !== "1", "Requires isolated pi and agy CLI fixtures");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "web-backend-e2e-")));
  let releaseReads = () => {};
  const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
  let catalogRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem("codex-web:composer-preferences:v1", JSON.stringify({ version: 1, state: { defaultBackend: "pi", askBackendOnNewSession: false } }));
  });
  try {
    await page.goto("/");
    await expect(page.locator(".empty-workspace").or(page.locator(".sidebar"))).toBeVisible();
    await page.evaluate(async (projectPath) => {
      const bootstrap = await fetch("/api/bootstrap").then((response) => response.json());
      const response = await fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken }, body: JSON.stringify({ path: projectPath, clientRequestId: crypto.randomUUID() }) });
      if (!response.ok) throw new Error(`Project creation failed: ${response.status}`);
    }, directory);
    await page.reload();
    await expect(page.locator(".sidebar").getByRole("button", { name: "新建 Session", exact: true })).toBeVisible();
    await page.route("**/api/backends", async (route) => { catalogRequests++; await route.abort(); });
    await page.route(/\/api\/sessions\/[^/?]+\?sync=/, async (route) => { await readGate; await route.continue(); });

    const start = Date.now();
    await page.locator(".sidebar").getByRole("button", { name: "新建 Session", exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/pi:/, { timeout: 5_000 });
    const selector = page.getByRole("group", { name: "对话后端", exact: true });
    await expect(selector).toBeVisible({ timeout: 5_000 });
    await expect(selector.getByRole("button", { name: "使用 pi 后端" })).toHaveAttribute("aria-pressed", "true");
    await expect(selector.getByRole("button", { name: "使用 Codex 后端" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "新建对话" })).toHaveCount(0);
    const creationMs = Date.now() - start;
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("keep my draft");
    await page.locator(".attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("draft attachment") });
    await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
    const switching = Date.now();
    await selector.getByRole("button", { name: "使用 agy 后端" }).click();
    await expect(page).toHaveURL(/\/sessions\/agy:/, { timeout: 5_000 });
    await expect(selector.getByRole("button", { name: "使用 agy 后端" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("keep my draft");
    await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
    const switchingMs = Date.now() - switching;
    const agyUrl = page.url();

    await page.route("**/api/projects/*/sessions", async (route) => {
      if (route.request().postDataJSON().backend === "pi") await route.fulfill({ status: 503, json: { message: "pi 尚未登录" } });
      else await route.continue();
    });
    await selector.getByRole("button", { name: "使用 pi 后端" }).click();
    await expect(page.getByRole("alert")).toContainText("pi 尚未登录");
    await expect(page).toHaveURL(agyUrl);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("keep my draft");
    await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
    await page.unroute("**/api/projects/*/sessions");

    // A one-off switch does not change the saved default or enable the dialog.
    await page.locator(".sidebar").getByRole("button", { name: "新建 Session", exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/pi:/, { timeout: 5_000 });
    await expect(selector.getByRole("button", { name: "使用 pi 后端" })).toHaveAttribute("aria-pressed", "true");
    expect(catalogRequests).toBe(0);
    console.log(JSON.stringify({ creationMs, switchingMs, catalogRequests }));
    releaseReads();
    await page.unrouteAll({ behavior: "wait" });

    // Once a conversation has history, the empty-state switch disappears.
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("hello");
    await page.getByRole("button", { name: "发送或执行命令", exact: true }).click();
    await expect(page.locator(".user-message").filter({ hasText: "hello" })).toBeVisible();
    await expect(selector).toHaveCount(0);
  } finally {
    releaseReads();
    await page.unrouteAll({ behavior: "wait" });
    await rm(directory, { recursive: true, force: true });
  }
});

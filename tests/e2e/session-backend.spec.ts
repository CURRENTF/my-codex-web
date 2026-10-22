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

    // Each backend has its own saved default and its own native model list.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const defaultModel = page.getByRole("button", { name: "新 Session 默认模型", exact: true });
    const defaultBackend = page.getByRole("button", { name: "新 Session 默认后端", exact: true });
    await expect(defaultModel).toHaveText("使用 pi 默认");
    await defaultModel.click();
    await page.getByRole("menuitemradio", { name: /Pi alternate/ }).click();
    await defaultBackend.click();
    await page.getByRole("menuitemradio", { name: "agy", exact: true }).click();
    await expect(defaultModel).toHaveText("使用 agy 默认");
    await defaultModel.click();
    await page.getByRole("menuitemradio", { name: /Agy alternate/ }).click();
    await defaultBackend.click();
    await page.getByRole("menuitemradio", { name: "Codex", exact: true }).click();
    await expect(defaultModel).toHaveText("使用项目默认");
    await defaultBackend.click();
    await page.getByRole("menuitemradio", { name: "pi", exact: true }).click();
    await expect(defaultModel).toContainText("Pi alternate");
    await page.keyboard.press("Escape");
    const beforeDefaultCreation = page.url();
    await page.locator(".sidebar").getByRole("button", { name: "新建 Session", exact: true }).click();
    await expect(page).not.toHaveURL(beforeDefaultCreation);
    await expect(page.getByRole("button", { name: "模型", exact: true })).toContainText("Pi alternate");
    await selector.getByRole("button", { name: "使用 agy 后端" }).click();
    await expect(page.getByRole("button", { name: "模型", exact: true })).toContainText("Agy alternate");

    // Refreshing a changed catalog must not reset an unsent model selection.
    const modelButton = page.getByRole("button", { name: "模型", exact: true });
    await modelButton.click();
    await page.getByRole("menuitemradio", { name: /Fixture model/ }).click();
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("keep model and draft");
    let refreshes = 0;
    await page.route("**/api/backends/agy?refresh=1", async (route) => {
      refreshes++;
      const response = await route.fetch();
      const catalog = await response.json();
      catalog.models.push({ ...catalog.models[0], id: "extra", model: "extra", displayName: "Newly available", isDefault: false });
      await route.fulfill({ response, json: catalog });
    });
    await modelButton.click();
    await page.getByRole("menuitem", { name: "刷新模型列表", exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: /Newly available/ })).toBeVisible();
    await expect(page.getByRole("menuitemradio", { name: /Fixture model/ })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(modelButton).toContainText("Fixture model");
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("keep model and draft");
    expect(refreshes).toBe(1);
    await page.unrouteAll({ behavior: "wait" });

    // Once a conversation has history, the empty-state switch disappears.
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("hello");
    await page.getByRole("button", { name: "发送或执行命令", exact: true }).click();
    await expect(page.locator(".user-message").filter({ hasText: "hello" })).toBeVisible();
    await expect(selector).toHaveCount(0);
    const threadId = page.url().split("/sessions/")[1]!;
    await expect.poll(() => page.evaluate(async (id) => {
      const session = await fetch(`/api/sessions/${id}`).then((response) => response.json());
      return session.thread.turns[0]?.status;
    }, threadId)).toBe("completed");
  } finally {
    releaseReads();
    await page.unrouteAll({ behavior: "wait" });
    await rm(directory, { recursive: true, force: true });
  }
});

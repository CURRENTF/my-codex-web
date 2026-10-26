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
    const permission = page.getByRole("button", { name: "权限", exact: true });
    await expect(permission).toHaveClass(/settings-select-trigger access/);
    await expect(permission).toHaveText("Full Access");
    await expect(permission.locator("svg")).toBeVisible();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(permission.locator(".settings-select-icon")).toBeVisible();
      const box = await permission.locator("svg").boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(14);
      await permission.click();
      await expect(page.getByRole("menuitemradio")).toHaveCount(1);
      await page.keyboard.press("Escape");
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await permission.click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(1);
    await page.screenshot({ path: test.info().outputPath("pi-permissions.png") });
    await page.keyboard.press("Escape");
    const creationMs = Date.now() - start;
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("keep my draft");
    await page.locator(".attachment-input").setInputFiles({ name: "draft.txt", mimeType: "text/plain", buffer: Buffer.from("draft attachment") });
    await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
    const sessionCount = await page.evaluate(async () => (await fetch("/api/sessions").then((response) => response.json())).length);
    const beforeImageSwitch = page.url();
    await page.locator(".attachment-input").setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
    await expect(page.locator(".attachment-chip")).toHaveCount(2);
    await selector.getByRole("button", { name: "使用 agy 后端" }).click();
    await expect(page.getByRole("alert")).toContainText("请先移除图片后再切换");
    await expect(page).toHaveURL(beforeImageSwitch);
    await selector.getByRole("button", { name: "使用 pi 后端" }).click();
    await expect(page.locator(".backend-switch-error")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("keep my draft");
    await page.getByRole("button", { name: "移除附件 draft.png", exact: true }).click();
    await expect(page.locator(".attachment-chip")).toHaveCount(1);
    const switching = Date.now();
    await selector.getByRole("button", { name: "使用 agy 后端" }).click();
    await expect(page).toHaveURL(/\/sessions\/agy:/, { timeout: 5_000 });
    await expect(selector.getByRole("button", { name: "使用 agy 后端" })).toHaveAttribute("aria-pressed", "true");
    await expect(permission).toHaveText("Accept Edits");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(permission.locator("svg")).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await permission.click();
    await expect(page.getByRole("menuitemradio")).toHaveCount(2);
    await expect(page.getByRole("menuitemradio", { name: /Accept Edits/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("agy-permissions.png") });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Reasoning effort", exact: true })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("keep my draft");
    await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
    const switchingMs = Date.now() - switching;
    const agyUrl = page.url();
    expect(await page.evaluate(async () => (await fetch("/api/sessions").then((response) => response.json())).length)).toBe(sessionCount);

    await page.route("**/api/sessions/*/backend", async (route) => {
      if (route.request().postDataJSON().backend === "pi") await route.fulfill({ status: 503, json: { error: "pi 尚未登录" } });
      else await route.continue();
    });
    await selector.getByRole("button", { name: "使用 pi 后端" }).click();
    await expect(page.getByRole("alert")).toContainText("pi 尚未登录");
    await expect(page).toHaveURL(agyUrl);
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("keep my draft");
    await expect(page.locator(".attachment-chip")).toContainText("draft.txt");
    await selector.getByRole("button", { name: "使用 agy 后端" }).click();
    await expect(page.locator(".backend-switch-error")).toHaveCount(0);
    await page.unroute("**/api/sessions/*/backend");

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
    await expect(page.getByRole("button", { name: "新 Session 默认 effort", exact: true })).toHaveCount(0);
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

    // Native permissions save without resetting the selected model or draft.
    await permission.click();
    await page.getByRole("menuitemradio", { name: /Full Access/ }).click();
    await expect(permission).toHaveText("Full Access");
    await expect(modelButton).toContainText("Fixture model");
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("keep model and draft");
    const permissionId = page.url().split("/sessions/")[1]!;
    expect(await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}`).then((response) => response.json())).settings.agyFullAccess, permissionId)).toBe(true);
    await page.reload();
    await expect(permission).toHaveText("Full Access");
    await permission.click();
    await page.getByRole("menuitemradio", { name: /Accept Edits/ }).click();
    await expect(permission).toHaveText("Accept Edits");
    expect(await page.evaluate(async (id) => (await fetch(`/api/sessions/${id}`).then((response) => response.json())).settings.agyFullAccess, permissionId)).toBe(false);

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

    // A plugin-initiated run is visible through the same live UI as user turns.
    await page.locator(".sidebar").getByRole("button", { name: "新建 Session", exact: true }).click();
    await expect(page).toHaveURL(/\/sessions\/pi:/);
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("wake");
    await page.getByRole("button", { name: "发送或执行命令", exact: true }).click();
    await expect(page.getByText("Background job resumed", { exact: true })).toBeVisible();
    await page.locator(".activity-group").filter({ hasText: "pi · unified-exec-completed" }).locator(":scope > summary").click();
    await expect(page.getByText("pi · unified-exec-completed", { exact: true })).toBeVisible();
    const piId = page.url().split("/sessions/")[1]!;
    await expect.poll(() => page.evaluate(async (id) => {
      const session = await fetch(`/api/sessions/${id}`).then((response) => response.json());
      return { turns: session.thread.turns.map((turn: any) => turn.status), state: session.runtime.state };
    }, piId)).toEqual({ turns: ["completed", "completed"], state: "justFinished" });
  } finally {
    releaseReads();
    await page.unrouteAll({ behavior: "wait" });
    await rm(directory, { recursive: true, force: true });
  }
});

test("finishes a backend switch in the sidebar without navigating away from the user's newer selection", async ({ page }) => {
  test.skip(process.env.CODEX_WEB_E2E_FIXTURE_BACKENDS !== "1", "Requires isolated pi and agy CLI fixtures");
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "web-switch-navigation-")));
  let releaseSwitch = () => {};
  const switchGate = new Promise<void>((resolve) => { releaseSwitch = resolve; });
  let switchCompleted = () => {};
  const completed = new Promise<void>((resolve) => { switchCompleted = resolve; });
  let replacementId = "";
  await page.addInitScript(() => {
    localStorage.setItem("codex-web:composer-preferences:v1", JSON.stringify({ version: 1, state: { defaultBackend: "pi", askBackendOnNewSession: false } }));
  });
  try {
    await page.goto("/");
    await expect(page.locator(".empty-workspace").or(page.locator(".sidebar"))).toBeVisible();
    const project = await page.evaluate(async (projectPath) => {
      const bootstrap = await fetch("/api/bootstrap").then((response) => response.json());
      return fetch("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken }, body: JSON.stringify({ path: projectPath, clientRequestId: crypto.randomUUID() }) }).then((response) => response.json());
    }, directory);
    await page.reload();
    await page.getByRole("button", { name: "项目", exact: true }).click();
    const newSession = page.getByRole("button", { name: `在 ${project.name} 新建 Session`, exact: true });
    await newSession.click();
    await expect(page).toHaveURL(/\/sessions\/pi:/);
    await expect(page.locator(".session-header .breadcrumb-project")).toHaveText(project.name);
    const sourceUrl = page.url(), sourceId = sourceUrl.split("/sessions/")[1]!;
    await page.getByRole("textbox", { name: "消息", exact: true }).fill("draft stays with the replacement");
    await newSession.click();
    await expect(page).not.toHaveURL(sourceUrl);
    const targetUrl = page.url(), targetId = targetUrl.split("/sessions/")[1]!;
    await page.locator(`.session-row-shell[data-thread-id="${sourceId}"] .session-row`).click();
    await expect(page).toHaveURL(sourceUrl);
    await page.route("**/api/sessions/*/backend", async (route) => {
      const response = await route.fetch();
      replacementId = (await response.json()).thread.id;
      await switchGate;
      await route.fulfill({ response });
      switchCompleted();
    });
    await page.getByRole("button", { name: "使用 agy 后端", exact: true }).click();
    await page.locator(`.session-row-shell[data-thread-id="${targetId}"] .session-row`).click();
    await expect(page).toHaveURL(targetUrl);
    releaseSwitch();
    await completed;
    await expect.poll(() => page.evaluate((id) => {
      return !!document.querySelector(`.session-row-shell[data-thread-id="${id}"]`);
    }, replacementId)).toBe(true);
    await expect(page).toHaveURL(targetUrl);
    await page.locator(`.session-row-shell[data-thread-id="${replacementId}"] .session-row`).click();
    await expect(page.getByRole("textbox", { name: "消息", exact: true })).toHaveValue("draft stays with the replacement");
  } finally {
    releaseSwitch();
    await page.unrouteAll({ behavior: "wait" });
    await rm(directory, { recursive: true, force: true });
  }
});

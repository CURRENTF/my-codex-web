import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function ensureProject(page: Page): Promise<void> {
  await page.goto("/");
  if (!(await page.locator(".empty-workspace").isVisible())) return;
  await page.evaluate(async (projectPath) => {
    const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as { csrfToken: string };
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken },
      body: JSON.stringify({ path: projectPath, clientRequestId: crypto.randomUUID() }),
    });
    if (!response.ok) throw new Error(`Project setup failed: ${response.status}`);
  }, process.cwd());
  await page.reload();
}

test("loads the local app and exposes a single-sidebar workspace", async ({ page }) => {
  await ensureProject(page);
  await expect(page).toHaveTitle("Codex Web");
  const authGate = page.getByText("需要 Codex 登录");
  const sidebar = page.locator(".sidebar");
  await expect(authGate.or(sidebar).first()).toBeVisible();
  if (await sidebar.isVisible()) {
    await expect(page.getByRole("button", { name: "新建 Session", exact: true })).toBeVisible();
    await expect(page.getByRole("tablist")).toBeVisible();
  }
});

test("leaves an archived current Session instead of keeping a stale Composer open", async ({ page }) => {
  test.setTimeout(60_000);
  await ensureProject(page);
  const sidebar = page.locator(".sidebar");
  test.skip(!(await sidebar.isVisible()), "Requires the isolated, logged-in E2E CODEX_HOME");
  await page.waitForURL(/\/sessions\//, { timeout: 30_000 });
  const previousSessionUrl = page.url();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== previousSessionUrl, { timeout: 30_000 }),
    page.getByRole("button", { name: "新建 Session", exact: true }).click(),
  ]);
  const archivedUrl = page.url();
  const archivedThreadId = archivedUrl.split("/sessions/")[1]!;

  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "归档" }).click();

  await expect(page).not.toHaveURL(archivedUrl);
  await expect(page.locator(`.session-row-shell[data-thread-id="${archivedThreadId}"]`)).toHaveCount(0);
});

test("streams model tool activity into the timeline without a refresh", async ({ page }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await ensureProject(page);
  const sidebar = page.locator(".sidebar");
  test.skip(!(await sidebar.isVisible()), "Requires the isolated, logged-in E2E CODEX_HOME");

  await page.waitForURL(/\/sessions\//, { timeout: 30_000 });
  const previousSessionUrl = page.url();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== previousSessionUrl, { timeout: 30_000 }),
    page.getByRole("button", { name: "新建 Session", exact: true }).click(),
  ]);

  const prompt = "请务必调用 shell 工具执行：printf 'CODEX_WEB_TOOL_STEP_1\\n'; sleep 5; printf 'CODEX_WEB_TOOL_STEP_2\\n'。不要修改文件。命令完成后只回复 CODEX_WEB_TOOL_DONE。";
  await page.getByRole("textbox", { name: "要求后续变更" }).fill(prompt);
  await page.getByRole("button", { name: "发送" }).click();

  await expect(page.locator(".user-message").filter({ hasText: "CODEX_WEB_TOOL_STEP_1" })).toBeVisible({ timeout: 30_000 });
  const activityGroup = page.locator(".activity-group", {
    has: page.locator(".tool-title", { hasText: "CODEX_WEB_TOOL_STEP_1" }),
  }).first();
  await expect(activityGroup.locator(":scope > summary")).toBeVisible({ timeout: 90_000 });
  await expect(activityGroup).not.toHaveAttribute("open", "");
  await activityGroup.locator(":scope > summary").click();
  await expect(activityGroup).toHaveAttribute("open", "");
  const commandCard = activityGroup.locator(".tool-card", {
    has: page.locator(".tool-title", { hasText: "CODEX_WEB_TOOL_STEP_1" }),
  }).first();
  await expect(commandCard).toBeVisible({ timeout: 90_000 });
  await expect(commandCard.locator(".tool-result")).toHaveText("inProgress");
  await page.getByRole("textbox", { name: "向当前执行追加指令" }).fill("请在当前 Turn 的最终回复中同时包含 CODEX_WEB_STEER_RECEIVED。");
  await page.getByRole("button", { name: "Steer 当前 Turn" }).click();
  const optimisticSteer = page.locator(".pending-user-message").filter({ hasText: "CODEX_WEB_STEER_RECEIVED" });
  await expect(optimisticSteer).toBeVisible();
  await expect(optimisticSteer.locator(".pending-user-status")).toHaveText(/发送中|排队中/);
  await expect(page.locator(".user-message").filter({ hasText: "CODEX_WEB_STEER_RECEIVED" })).toBeVisible({ timeout: 30_000 });
  await expect(optimisticSteer).toHaveCount(0);
  await expect(commandCard.locator(".command-output")).toContainText("CODEX_WEB_TOOL_STEP_2", { timeout: 30_000 });
  await expect(commandCard.locator(".tool-result")).toHaveText("exit 0", { timeout: 30_000 });
  await expect(page.locator(".agent-message").filter({ hasText: "CODEX_WEB_TOOL_DONE" })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".agent-message").filter({ hasText: "CODEX_WEB_STEER_RECEIVED" })).toBeVisible();
  await expect(page.locator(".turn-block")).toHaveCount(1);

  await page.getByRole("textbox", { name: "要求后续变更" }).fill("请调用 shell 工具执行 sleep 4，然后只回复 CODEX_WEB_RACE_TURN_DONE。不要修改文件。");
  await page.getByRole("button", { name: "发送" }).click();
  const raceActivityGroup = page.locator(".activity-group", { has: page.locator(".tool-title", { hasText: "sleep 4" }) }).last();
  await expect(raceActivityGroup.locator(":scope > summary")).toBeVisible({ timeout: 90_000 });
  await expect(raceActivityGroup).not.toHaveAttribute("open", "");
  await raceActivityGroup.locator(":scope > summary").click();
  const raceCard = raceActivityGroup.locator(".tool-card", { has: page.locator(".tool-title", { hasText: "sleep 4" }) }).last();
  await expect(raceCard.locator(".tool-result")).toHaveText("inProgress", { timeout: 90_000 });
  const retainedSteer = "CODEX_WEB_RACE_STEER_DRAFT";
  await page.getByRole("textbox", { name: "向当前执行追加指令" }).fill(retainedSteer);
  await expect(page.locator(".agent-message").filter({ hasText: "CODEX_WEB_RACE_TURN_DONE" })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("当前执行刚刚结束", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "要求后续变更" })).toHaveValue(retainedSteer);
  await expect(page.locator(".turn-block")).toHaveCount(2);
});

test("renders and resolves a model request_user_input server request", async ({ page }) => {
  test.setTimeout(150_000);
  await ensureProject(page);
  const sidebar = page.locator(".sidebar");
  test.skip(!(await sidebar.isVisible()), "Requires the isolated, logged-in E2E CODEX_HOME");
  await page.waitForURL(/\/sessions\//, { timeout: 30_000 });
  const previousSessionUrl = page.url();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== previousSessionUrl, { timeout: 30_000 }),
    page.getByRole("button", { name: "新建 Session", exact: true }).click(),
  ]);

  await page.getByRole("textbox", { name: "要求后续变更" }).fill("必须调用 request_user_input 工具，询问一个 header 为 Mode、id 为 mode、问题为 Continue? 的单选题，选项标签为 Continue。收到答案后只回复 PENDING_REQUEST_RESOLVED。");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("Codex 正在等待你的输入", { exact: true })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.getByRole("button", { name: "发送答案", exact: true }).click();
  await expect(page.getByText("Codex 正在等待你的输入", { exact: true })).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".agent-message").filter({ hasText: "PENDING_REQUEST_RESOLVED" })).toBeVisible({ timeout: 90_000 });
});

test("serializes writes from multiple tabs for the same Session", async ({ page }) => {
  test.setTimeout(90_000);
  await ensureProject(page);
  const sidebar = page.locator(".sidebar");
  test.skip(!(await sidebar.isVisible()), "Requires the isolated, logged-in E2E CODEX_HOME");
  await page.waitForURL(/\/sessions\//, { timeout: 30_000 });
  const previousSessionUrl = page.url();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== previousSessionUrl, { timeout: 30_000 }),
    page.getByRole("button", { name: "新建 Session", exact: true }).click(),
  ]);
  const sessionUrl = page.url(); const threadId = sessionUrl.split("/sessions/")[1]!;
  const secondPage = await page.context().newPage(); await secondPage.goto(sessionUrl);
  const start = (target: Page, marker: string) => target.evaluate(async ({ id, text }) => {
    const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as { csrfToken: string };
    const response = await fetch(`/api/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken },
      body: JSON.stringify({ text, accessMode: "fullAccess", clientRequestId: crypto.randomUUID(), clientUserMessageId: crypto.randomUUID() }),
    });
    return response.status;
  }, { id: threadId, text: `请调用 shell 执行 sleep 120，然后只回复 ${marker}。不要修改文件。` });
  const statuses = await Promise.all([start(page, "TAB_ONE_DONE"), start(secondPage, "TAB_TWO_DONE")]);
  expect(statuses.sort((left, right) => left - right)).toEqual([200, 409]);
  await expect(page.locator(".turn-block")).toHaveCount(1, { timeout: 30_000 });
  const stop = page.getByRole("button", { name: "停止" });
  await expect(stop).toBeVisible({ timeout: 30_000 });
  await stop.click();
  await expect(stop).toBeHidden({ timeout: 30_000 });
  await expect(page.locator(".main-pane .header-status")).toContainText("已中断");
  await expect(page.locator(".sidebar .session-row-shell.active .status-icon")).toHaveAttribute("aria-label", "已中断");
  await secondPage.close();
});

test("adapts the workspace controls and navigation to the available width", async ({ page }) => {
  test.setTimeout(150_000);
  const outputDir = path.resolve("output/playwright/responsive");

  await page.addInitScript(() => {
    const testState = { blocked: false, sockets: new Set<WebSocket>() };
    (window as unknown as { __codexWsTest: typeof testState }).__codexWsTest = testState;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        testState.sockets.add(this);
        this.addEventListener("close", () => testState.sockets.delete(this));
        this.addEventListener("open", () => { if (testState.blocked) this.close(); });
      }
    } as typeof WebSocket;
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await ensureProject(page);
  const sidebar = page.locator(".sidebar");
  test.skip(!(await sidebar.isVisible()), "Requires the isolated, logged-in E2E CODEX_HOME");

  await page.waitForURL(/\/sessions\//, { timeout: 30_000 });
  await expect(page.locator(".composer")).toBeVisible();
  const newSession = page.getByRole("button", { name: "新建 Session", exact: true });
  const previousSessionUrl = page.url();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== previousSessionUrl, { timeout: 30_000 }),
    newSession.click(),
  ]);
  await expect(page.locator(".composer")).toBeVisible();
  await expect.poll(() => page.locator(".timeline-area").evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(100);
  await page.getByRole("textbox", { name: "要求后续变更" }).fill("请只回复 CODEX_WEB_E2E_LIVE_OK，不要调用工具。");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.locator(".user-message").filter({ hasText: "CODEX_WEB_E2E_LIVE_OK" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".agent-message").filter({ hasText: "CODEX_WEB_E2E_LIVE_OK" })).toBeVisible({ timeout: 90_000 });
  const sessionUrl = page.url();

  await page.evaluate(() => {
    const state = (window as unknown as { __codexWsTest: { blocked: boolean; sockets: Set<WebSocket> } }).__codexWsTest;
    state.blocked = true;
    for (const socket of state.sockets) socket.close();
  });
  await expect(page.locator(".main-pane .header-status")).toContainText("连接中断", { timeout: 10_000 });
  await expect(page.locator(".sidebar .session-row-shell.active .status-icon")).toHaveAttribute("aria-label", "连接中断");
  await page.evaluate(() => { (window as unknown as { __codexWsTest: { blocked: boolean } }).__codexWsTest.blocked = false; });
  await expect(page.locator(".main-pane .header-status")).not.toContainText("连接中断", { timeout: 30_000 });

  await page.getByRole("button", { name: "设置 Goal" }).click();
  await page.getByLabel("Objective").fill("E2E persisted Goal");
  await page.getByLabel("Token Budget").fill("12000");
  await page.getByLabel("Status").selectOption("paused");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("E2E persisted Goal", { exact: true })).toBeVisible();

  const secondPage = await page.context().newPage();
  await secondPage.goto(sessionUrl);
  await expect(secondPage.locator(".goal-bar")).toBeEnabled({ timeout: 30_000 });
  await secondPage.evaluate(async (threadId) => {
    const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as { csrfToken: string };
    const response = await fetch(`/api/sessions/${threadId}/goal`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken },
      body: JSON.stringify({ objective: "E2E live Goal", status: "paused", tokenBudget: 16000, clientRequestId: crypto.randomUUID() }),
    });
    if (!response.ok) throw new Error(`Goal update failed: ${response.status}`);
  }, sessionUrl.split("/sessions/")[1]!);
  await expect(page.getByText("E2E live Goal", { exact: true })).toBeVisible({ timeout: 30_000 });
  await secondPage.close();
  await page.reload();
  await expect(page.getByText("E2E live Goal", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "项目", exact: true }).click();
  await expect(page.locator(".project-group").first()).toBeVisible();
  await page.getByRole("button", { name: "最近", exact: true }).click();
  const sort = page.locator(".sort-button");
  const sortBefore = await sort.textContent();
  const directionBefore = sortBefore?.includes("↓") ? "desc" : "asc";
  const readSortedRows = () => page.locator(".sidebar-list > .session-row-shell").evaluateAll((rows) => rows.map((row) => ({
    threadId: row.getAttribute("data-thread-id")!,
    updatedAt: Number(row.getAttribute("data-updated-at")),
  })));
  const isMonotonic = (rows: Array<{ updatedAt: number }>, direction: "asc" | "desc") => rows.every((row, index) => {
    if (index === 0) return true;
    return direction === "asc" ? rows[index - 1]!.updatedAt <= row.updatedAt : rows[index - 1]!.updatedAt >= row.updatedAt;
  });
  const rowsBefore = await readSortedRows();
  expect(rowsBefore.length).toBeGreaterThan(1);
  expect(new Set(rowsBefore.map((row) => row.updatedAt)).size).toBeGreaterThan(1);
  expect(isMonotonic(rowsBefore, directionBefore)).toBe(true);
  await sort.click();
  await expect(sort).not.toHaveText(sortBefore ?? "");
  const directionAfter = directionBefore === "desc" ? "asc" : "desc";
  await expect.poll(async () => isMonotonic(await readSortedRows(), directionAfter)).toBe(true);
  const rowsAfter = await readSortedRows();
  expect(rowsAfter.map((row) => row.threadId).sort()).toEqual(rowsBefore.map((row) => row.threadId).sort());

  await page.getByRole("button", { name: "从此轮之后 Fork" }).first().click();
  await expect(page.getByRole("dialog", { name: "创建 Fork" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /继承父 Session 的 Goal/ })).not.toBeChecked();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== sessionUrl, { timeout: 30_000 }),
    page.getByRole("button", { name: "创建 Fork", exact: true }).click(),
  ]);
  await expect(page.locator(".user-message").filter({ hasText: "CODEX_WEB_E2E_LIVE_OK" })).toBeVisible();
  await expect(page.getByRole("button", { name: "设置 Goal" })).toBeVisible();
  await page.goto(sessionUrl);
  await expect(page.getByText("E2E live Goal", { exact: true })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "从此问题之前 Fork" }).first().click();
  await expect(page.getByRole("dialog", { name: "创建 Fork" })).toBeVisible();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== sessionUrl, { timeout: 30_000 }),
    page.getByRole("button", { name: "创建 Fork", exact: true }).click(),
  ]);
  await expect(page.locator(".turn-block")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "要求后续变更" })).toHaveValue("请只回复 CODEX_WEB_E2E_LIVE_OK，不要调用工具。");
  await page.goto(sessionUrl);

  await page.getByRole("textbox", { name: "搜索 Session" }).fill("no-such-session");
  await expect(page.getByText("没有找到 Session", { exact: true })).toBeVisible();
  await expect(page.locator(".composer")).toBeVisible();
  expect(page.url()).toBe(sessionUrl);
  await page.getByRole("button", { name: "清除搜索" }).click();

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
  await page.getByRole("button", { name: "Side Chat", exact: true }).click();
  await expect(page.locator(".mobile-pane-tabs")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".side-pane")).toBeVisible();
  await expect(page.locator(".side-pane .composer")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".sidebar .session-title", { hasText: "Side Chat" })).toHaveCount(0);
  await page.screenshot({ path: path.join(outputDir, "side-chat-tabs-1024.png"), fullPage: true });

  await page.reload();
  await expect(page.locator(".mobile-pane-tabs")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Side Chat", exact: true }).last().click();
  await expect(page.locator(".side-pane .composer")).toBeVisible();

  await page.setViewportSize({ width: 1090, height: 800 });
  await expect(page.locator(".mobile-pane-tabs")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".mobile-pane-tabs")).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(page.locator(".mobile-pane-tabs")).toBeHidden();
  await expect(page.locator(".main-pane")).toBeVisible();
  await expect(page.locator(".side-pane")).toBeVisible();
  await page.screenshot({ path: path.join(outputDir, "side-chat-split-1440.png"), fullPage: true });

  const parallelStarts = await page.evaluate(async (parentThreadId) => {
    const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as {
      csrfToken: string;
      activeSideChats: Array<{ threadId: string; parentThreadId: string }>;
    };
    const sideChat = bootstrap.activeSideChats.find((candidate) => candidate.parentThreadId === parentThreadId);
    if (!sideChat) throw new Error(`No active Side Chat for ${parentThreadId}`);
    const start = async (threadId: string, marker: string) => {
      const response = await fetch(`/api/sessions/${threadId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken },
        body: JSON.stringify({
          text: `请调用 shell 执行 sleep 8，然后只回复 ${marker}。不要修改文件。`,
          accessMode: "fullAccess",
          clientRequestId: crypto.randomUUID(),
          clientUserMessageId: crypto.randomUUID(),
        }),
      });
      return response.status;
    };
    return Promise.all([
      start(parentThreadId, "MAIN_PARALLEL_DONE"),
      start(sideChat.threadId, "SIDE_PARALLEL_DONE"),
    ]);
  }, sessionUrl.split("/sessions/")[1]!);
  expect(parallelStarts).toEqual([200, 200]);
  await expect(page.locator(".main-pane .user-message").filter({ hasText: "MAIN_PARALLEL_DONE" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".side-pane .user-message").filter({ hasText: "SIDE_PARALLEL_DONE" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".side-pane .parallel-write-warning")).toContainText("主 Session 和 Side Chat 可能同时修改同一工作区", { timeout: 30_000 });
  await expect(page.locator(".main-pane .agent-message").filter({ hasText: "MAIN_PARALLEL_DONE" })).toBeVisible({ timeout: 90_000 });
  await expect(page.locator(".side-pane .agent-message").filter({ hasText: "SIDE_PARALLEL_DONE" })).toBeVisible({ timeout: 90_000 });

  await expect(sidebar).toBeVisible();
  await expect.poll(async () => Number.parseFloat(await sidebar.evaluate((node) => getComputedStyle(node).width))).toBeGreaterThan(280);

  await page.getByRole("button", { name: "关闭 Side Chat" }).click();
  await expect(page.locator(".side-pane")).toHaveCount(0);
  await expect(page.locator(".main-pane textarea")).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar).not.toBeInViewport();
  const toggle = page.getByRole("button", { name: "打开侧边栏" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(sidebar).toBeInViewport();
  await page.getByRole("button", { name: "关闭侧边栏" }).first().click();
  await expect(sidebar).not.toBeInViewport();
});

test("shows disconnection and recovers after the managed App Server crashes", async ({ page }) => {
  test.setTimeout(150_000);
  await ensureProject(page);
  const sidebar = page.locator(".sidebar");
  test.skip(!(await sidebar.isVisible()), "Requires the isolated, logged-in E2E CODEX_HOME");
  await page.waitForURL(/\/sessions\//, { timeout: 30_000 });
  const previousSessionUrl = page.url();
  await Promise.all([
    page.waitForURL((url) => /\/sessions\//.test(url.pathname) && url.toString() !== previousSessionUrl, { timeout: 30_000 }),
    page.getByRole("button", { name: "新建 Session", exact: true }).click(),
  ]);
  const threadId = page.url().split("/sessions/")[1]!;
  await page.getByRole("textbox", { name: "要求后续变更" }).fill("请调用 shell 执行 sleep 120，然后只回复 CRASH_RECOVERY_SHOULD_NOT_COMPLETE。不要修改文件。");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible({ timeout: 30_000 });

  const port = new URL(page.url()).port || "80";
  const serverPid = Number(execFileSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim().split("\n")[0]);
  const processRows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).split("\n");
  const appServerRow = processRows.find((row) => {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match && Number(match[2]) === serverPid && match[3]!.includes("codex app-server --stdio");
  });
  const appServerPid = Number(appServerRow?.trim().match(/^(\d+)/)?.[1]);
  expect(Number.isInteger(appServerPid) && appServerPid > 1).toBe(true);
  process.kill(appServerPid, "SIGTERM");

  await expect(page.locator(".main-pane .header-status")).toContainText("连接中断", { timeout: 10_000 });
  await expect.poll(async () => page.evaluate(async () => {
    const health = await fetch("/api/health", { cache: "no-store" }).then((response) => response.json()) as { connection: string };
    return health.connection;
  }), { timeout: 30_000 }).toBe("connected");
  await expect.poll(async () => page.evaluate(async (id) => {
    const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as { runtimeStates: Array<{ threadId: string; state: string }> };
    return bootstrap.runtimeStates.find((runtime) => runtime.threadId === id)?.state ?? "missing";
  }, threadId), { timeout: 30_000 }).toMatch(/^(disconnected|interrupted|failed)$/);
  await expect(page.locator(".main-pane .header-status")).not.toContainText("正在执行", { timeout: 30_000 });
});

test("discovers an existing App Server Session, applies Project defaults, and removes only the local mapping", async ({ page }) => {
  test.setTimeout(150_000);
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "codex-web-project-"));
  try {
    await ensureProject(page);
    const existingThreadId = await page.evaluate(async (root) => {
      const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as { csrfToken: string };
      const headers = { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken };
      const createProject = await fetch("/api/projects", {
        method: "POST", headers,
        body: JSON.stringify({ path: root, clientRequestId: crypto.randomUUID() }),
      });
      if (!createProject.ok) throw new Error(`Preseed Project creation failed: ${createProject.status}`);
      const project = await createProject.json() as { id: string };
      const createSession = await fetch(`/api/projects/${project.id}/sessions`, {
        method: "POST", headers,
        body: JSON.stringify({ accessMode: "readOnly", clientRequestId: crypto.randomUUID() }),
      });
      if (!createSession.ok) throw new Error(`Preseed Session creation failed: ${createSession.status}`);
      const session = await createSession.json() as { thread: { id: string } };
      const start = await fetch(`/api/sessions/${session.thread.id}/turns`, {
        method: "POST", headers,
        body: JSON.stringify({
          text: "Reply exactly CODEX_WEB_DISCOVERY_FIXTURE. Do not use tools.",
          accessMode: "readOnly",
          clientRequestId: crypto.randomUUID(),
          clientUserMessageId: crypto.randomUUID(),
        }),
      });
      if (!start.ok) throw new Error(`Preseed Turn failed: ${start.status}`);
      let completed = false;
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const snapshot = await fetch(`/api/sessions/${session.thread.id}`, { cache: "no-store" }).then((response) => response.json()) as { thread: { turns: Array<{ status: string }> } };
        const status = snapshot.thread.turns.at(-1)?.status;
        if (status === "completed") { completed = true; break; }
        if (status === "failed" || status === "interrupted") throw new Error(`Preseed Turn ended as ${status}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!completed) throw new Error("Preseed Turn did not complete before discovery setup timed out");
      const remove = await fetch(`/api/projects/${project.id}`, {
        method: "DELETE", headers,
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      });
      if (!remove.ok) throw new Error(`Preseed mapping removal failed: ${remove.status}`);
      return session.thread.id;
    }, projectRoot);
    await page.route("**/api/system/pick-directory", (route) => route.fulfill({ json: { path: projectRoot } }));
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/projects") && response.request().method() === "POST" && response.ok()),
      page.waitForResponse((response) => response.url().endsWith("/api/preferences") && response.request().method() === "PATCH" && response.ok()),
      page.getByRole("button", { name: "添加 Project" }).click(),
    ]);
    await page.unroute("**/api/system/pick-directory");
    const setup = await page.evaluate(async (root) => {
      const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as {
        csrfToken: string;
        models: Array<{ model: string; supportedReasoning: Array<{ effort: string }> }>;
        preferences: { lastProjectId: string | null };
      };
      const headers = { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken };
      const projects = await fetch("/api/projects").then((response) => response.json()) as Array<{ id: string; rootPath: string }>;
      const project = projects.find((candidate) => candidate.rootPath === root);
      if (!project) throw new Error("Project added through the directory picker was not persisted");
      if (bootstrap.preferences.lastProjectId !== project.id) throw new Error("New Project was not selected as the active creation target");
      const model = bootstrap.models.find((candidate) => candidate.supportedReasoning.length > 0);
      if (!model) throw new Error("No model with a supported Reasoning option");
      const reasoning = model.supportedReasoning[0]!.effort;
      const updateProject = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ name: "E2E Defaults Project", defaultModel: model.model, defaultReasoning: reasoning, defaultAccessMode: "workspaceWrite", clientRequestId: crypto.randomUUID() }),
      });
      if (!updateProject.ok) throw new Error(`Project defaults update failed: ${updateProject.status}`);
      const createSession = await fetch(`/api/projects/${project.id}/sessions`, {
        method: "POST", headers,
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      });
      if (!createSession.ok) throw new Error(`Session creation failed: ${createSession.status}`);
      const session = await createSession.json() as { thread: { id: string } };
      const discovered = await fetch(`/api/sessions?projectId=${encodeURIComponent(project.id)}&sortDirection=desc&search=`).then((response) => response.json()) as Array<{ threadId: string; sourceKind: string }>;
      return { projectId: project.id, threadId: session.thread.id, model: model.model, reasoning, discovered };
    }, projectRoot);

    expect(setup.discovered).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: existingThreadId, sourceKind: expect.stringMatching(/^(cli|vscode|appServer)$/) }),
    ]));

    await page.goto(`/sessions/${setup.threadId}`);
    await page.reload();
    await expect(page.locator(".composer")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".access-control select")).toHaveValue("workspaceWrite");
    await expect(page.locator(".inline-select select").first()).toHaveValue(setup.model);
    await expect(page.locator(".reasoning-select select")).toHaveValue(setup.reasoning);

    const persisted = await page.evaluate(async (threadId) => {
      const response = await fetch(`/api/sessions/${threadId}`);
      if (!response.ok) throw new Error(`Session read failed: ${response.status}`);
      return response.json() as Promise<{ settings: { model: string | null; reasoning: string | null; accessMode: string } }>;
    }, setup.threadId);
    expect(persisted.settings).toEqual({ model: setup.model, reasoning: setup.reasoning, accessMode: "workspaceWrite" });

    await page.getByRole("button", { name: "项目", exact: true }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "E2E Defaults Project 更多操作" }).click();
    await page.getByRole("menuitem", { name: "从侧边栏移除" }).click();
    await expect(page.locator(".project-group", { hasText: "E2E Defaults Project" })).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await expect(stat(projectRoot)).resolves.toBeTruthy();

    const rediscovered = await page.evaluate(async ({ projectId, threadId, root }) => {
      const bootstrap = await fetch("/api/bootstrap", { cache: "no-store" }).then((response) => response.json()) as { csrfToken: string };
      const headers = { "content-type": "application/json", "x-csrf-token": bootstrap.csrfToken };
      const projectsAfterRemoval = await fetch("/api/projects").then((response) => response.json()) as Array<{ id: string }>;
      const create = await fetch("/api/projects", {
        method: "POST", headers,
        body: JSON.stringify({ path: root, clientRequestId: crypto.randomUUID() }),
      });
      if (!create.ok) throw new Error(`Project re-add failed: ${create.status}`);
      const recreated = await create.json() as { id: string };
      const rescan = await fetch(`/api/projects/${recreated.id}/rescan`, {
        method: "POST", headers,
        body: JSON.stringify({ clientRequestId: crypto.randomUUID() }),
      });
      if (!rescan.ok) throw new Error(`Project rescan failed: ${rescan.status}`);
      const sessions = await fetch(`/api/sessions?projectId=${encodeURIComponent(recreated.id)}&sortDirection=desc&search=`).then((response) => response.json()) as Array<{ threadId: string }>;
      return {
        removedMapping: !projectsAfterRemoval.some((project) => project.id === projectId),
        recreatedProject: recreated.id !== projectId,
        rediscoveredThread: sessions.some((session) => session.threadId === threadId),
      };
    }, { ...setup, root: projectRoot });
    expect(rediscovered).toEqual({ removedMapping: true, recreatedProject: true, rediscoveredThread: true });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

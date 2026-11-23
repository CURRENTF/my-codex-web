import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { BootstrapPayload, Project, SessionSummary } from "@codex-web/shared-types";
import type { SessionPayload } from "../../apps/web/src/api";

test("recovers the workspace and keeps archive available during a Codex account outage", async ({ page }) => {
  const project: Project = {
    id: "project", name: "Example", rootPath: "/example", canonicalPath: "/example", orderIndex: 0,
    defaultModel: null, defaultReasoning: null, defaultAccessMode: "workspaceWrite",
    createdAt: 1, lastOpenedAt: null, available: true,
  };
  const sessions: SessionSummary[] = ["first", "second"].map((threadId) => ({
    threadId, projectId: project.id, title: threadId, preview: "", cwd: project.canonicalPath,
    sourceKind: "cli", createdAt: 1, updatedAt: 1, origin: "discovered", parentThreadId: null,
    forkTurnId: null, forkSourceTitle: null, forkTurnNumber: null, runtimeState: "idle", hasGoal: false, pinned: false,
  }));
  const bootstrap: BootstrapPayload = {
    backends: [{ id: "codex", name: "Codex", available: true, models: [] }],
    eventSeq: 1, connection: { state: "connected", codexVersion: null }, authReady: true, csrfToken: "fixture-token",
    projects: [project], models: [], activeSideChats: [], subagents: [], itemDeltas: {}, sessionPrefills: {}, pendingRequests: [],
    runtimeStates: sessions.map(({ threadId }) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
    preferences: { sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: project.id, lastThreadId: null, fullAccessNoticeSeenProjects: [] },
  };
  let authenticated = true;
  let transportDown = false;
  let rejectedSockets = 0;
  let openedSockets = 0;
  let archivedThread: string | undefined;
  let socket: WebSocketRoute | undefined;

  await page.routeWebSocket("**/api/events", (connection) => {
    if (transportDown) {
      rejectedSockets++;
      return connection.close();
    }
    openedSockets++;
    socket = connection;
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/login") {
      authenticated = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (!authenticated) return route.fulfill({ status: 401, json: { error: "password_required" } });
    if (url.pathname === "/api/bootstrap") return route.fulfill({ json: bootstrap });
    if (url.pathname === "/api/projects") return route.fulfill({ json: [project] });
    if (url.pathname === "/api/sessions") return route.fulfill({ json: sessions });
    if (route.request().method() === "POST" && /^\/api\/sessions\/[^/]+\/archive$/.test(url.pathname)) {
      archivedThread = url.pathname.split("/")[3];
      return route.fulfill({ json: { ok: true } });
    }
    const session = sessions.find(({ threadId }) => url.pathname === `/api/sessions/${threadId}`);
    if (session) {
      const payload: SessionPayload = {
        thread: { id: session.threadId, name: session.title, preview: "", cwd: session.cwd, createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] },
        runtime: bootstrap.runtimeStates.find(({ threadId }) => threadId === session.threadId)!,
        goal: null, settings: { accessMode: "workspaceWrite", model: null, reasoning: null, serviceTier: null },
      };
      return route.fulfill({ json: payload });
    }
    if (url.pathname.endsWith("/skills")) return route.fulfill({ json: [] });
    return route.fulfill({ json: { ok: true } });
  });

  await page.goto("/sessions/first");
  const composer = page.getByRole("textbox", { name: "消息", exact: true });
  const notice = page.getByText("正在重连 Web 服务", { exact: true });
  const rows = page.locator(".sidebar .session-status-menu");
  await expect(composer).toBeEnabled();
  const connectionsBeforeNavigation = openedSockets;
  await page.locator(".session-row").filter({ hasText: "second" }).click();
  await expect(page).toHaveURL(/\/sessions\/second$/);
  await composer.fill("draft before disconnect");
  expect(openedSockets).toBe(connectionsBeforeNavigation);

  transportDown = true;
  await socket!.close();
  await expect.poll(() => rejectedSockets).toBeGreaterThan(0);
  await expect(notice).toBeVisible();
  await expect(composer).toBeDisabled();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ has: page.locator(".status-icon") })).toHaveCount(0);
  await expect(page.locator(".header-status")).toHaveCount(0);

  transportDown = false;
  await expect(composer).toBeEnabled();
  await expect(notice).toHaveCount(0);

  authenticated = false;
  await socket!.close();
  await expect(page.getByRole("heading", { name: "进入工作区" })).toBeVisible();
  await page.getByLabel("访问密码").fill("fixture-password");
  await page.getByRole("button", { name: "继续" }).click();
  await expect(page).toHaveURL(/\/sessions\/second$/);
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("draft before disconnect");

  const codex = bootstrap.backends![0]!;
  codex.connected = true;
  codex.available = false;
  bootstrap.eventSeq = 2;
  socket!.send(JSON.stringify({
    type: "backend.connection.changed", seq: 2, emittedAt: Date.now(),
    payload: { backend: "codex", state: "connected", available: false },
  }));
  const accountNotice = page.getByText("Codex 账户暂不可用", { exact: true });
  await expect(accountNotice).toBeVisible();
  await expect(composer).toBeDisabled();
  await page.reload();
  await expect(accountNotice).toBeVisible();
  await expect(rows.filter({ has: page.locator(".status-icon") })).toHaveCount(2);
  await page.getByRole("button", { name: /^first：.*更多操作$/ }).click();
  const archive = page.getByRole("menuitem", { name: "归档" });
  await expect(archive).toBeEnabled();
  await archive.click();
  await expect.poll(() => archivedThread).toBe("first");
});

import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexAdapter, JsonRpcError, type AdapterEvent } from "@codex-web/codex-adapter";
import { requireIsolatedCodexHome } from "../../scripts/isolated-codex-home";

const run = process.env.RUN_CODEX_INTEGRATION === "1" ? describe : describe.skip;

run("real codex app-server with isolated CODEX_HOME", () => {
  it("generates a title in an isolated ephemeral Thread", async () => {
    const codexHome = requireIsolatedCodexHome(process.env.CODEX_WEB_TEST_CODEX_HOME, "CODEX_WEB_TEST_CODEX_HOME");
    const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "integration-test" });
    const projectedEvents: AdapterEvent[] = [];
    adapter.on("event", (event: AdapterEvent) => projectedEvents.push(event));
    adapter.on("stderr", (line) => process.stderr.write(`[app-server] ${String(line)}`));
    await adapter.start();
    try {
      const title = await adapter.generateSessionTitle(
        process.cwd(),
        "为 Codex Web 添加自动生成 Session 标题功能",
        "已实现首轮成功后生成标题，并保护用户手动标题",
      );
      expect(title).toBeTruthy();
      expect(Array.from(title ?? "").length).toBeLessThanOrEqual(48);
      expect(projectedEvents).toEqual([]);
    } finally {
      adapter.stop();
    }
  }, 150_000);

  it("returns the verified invalid-request code when steering without an active Turn", async () => {
    const codexHome = requireIsolatedCodexHome(process.env.CODEX_WEB_TEST_CODEX_HOME, "CODEX_WEB_TEST_CODEX_HOME");
    const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "integration-test" });
    await adapter.start();
    let threadId: string | undefined;
    try {
      const session = await adapter.startSession(path.resolve(process.cwd()), { accessMode: "readOnly", model: null, reasoning: null });
      threadId = session.thread.id;
      const failure = await adapter.steerTurn(threadId, "missing-turn-id", "probe", crypto.randomUUID()).then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(JsonRpcError);
      expect(failure).toMatchObject({ code: -32600, message: "no active turn to steer" });
    } finally {
      if (threadId) await adapter.archiveSession(threadId).catch(() => undefined);
      adapter.stop();
    }
  }, 60_000);

  it("creates an ephemeral side chat for an empty parent context", async () => {
    const codexHome = requireIsolatedCodexHome(process.env.CODEX_WEB_TEST_CODEX_HOME, "CODEX_WEB_TEST_CODEX_HOME");
    const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "integration-test" });
    adapter.on("stderr", (line) => process.stderr.write(`[app-server] ${String(line)}`));
    await adapter.start();
    const created: string[] = [];
    try {
      const session = await adapter.startSession(path.resolve(process.cwd()), { accessMode: "fullAccess", model: null, reasoning: null });
      created.push(session.thread.id);
      const sideChat = await adapter.createEmptySideChat(process.cwd(), { accessMode: "fullAccess", model: null, reasoning: null });
      created.push(sideChat.thread.id);
      expect(sideChat.thread.ephemeral).toBe(true);
      expect(sideChat.thread.cwd).toBe(session.thread.cwd);
    } finally {
      for (const threadId of created) await adapter.archiveSession(threadId).catch(() => undefined);
      adapter.stop();
    }
  }, 60_000);

  it("creates a top-level Side Chat while the parent Turn is still active", async () => {
    const codexHome = requireIsolatedCodexHome(process.env.CODEX_WEB_TEST_CODEX_HOME, "CODEX_WEB_TEST_CODEX_HOME");
    const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "integration-test" });
    adapter.on("stderr", (line) => process.stderr.write(`[app-server] ${String(line)}`));
    await adapter.start();
    const created: string[] = [];
    try {
      const session = await adapter.startSession(path.resolve(process.cwd()), { accessMode: "fullAccess", model: null, reasoning: null });
      created.push(session.thread.id);
      const terminal = new Promise<{ status: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Active parent Turn did not reach a terminal state")), 120_000);
        adapter.on("event", (event: AdapterEvent) => {
          if (event.type === "turnCompleted" && event.threadId === session.thread.id) {
            clearTimeout(timeout); resolve({ status: event.turn.status });
          }
        });
      });
      const turn = await adapter.startTurn(
        session.thread.id,
        process.cwd(),
        "Use the shell tool to run sleep 15, then reply exactly ACTIVE_PARENT_DONE.",
        { accessMode: "fullAccess", model: null, reasoning: "low" },
        crypto.randomUUID(),
      );
      expect(turn.turn.status).toBe("inProgress");

      const sideChat = await adapter.createSideChat(session.thread.id, null, { accessMode: "fullAccess", model: null, reasoning: "low" }, process.cwd());
      created.push(sideChat.thread.id);
      expect(sideChat.thread).toMatchObject({ ephemeral: true, forkedFromId: session.thread.id });

      await adapter.interruptTurn(session.thread.id, turn.turn.id);
      await expect(terminal).resolves.toEqual({ status: "interrupted" });
    } finally {
      for (const threadId of created) await adapter.archiveSession(threadId).catch(() => undefined);
      adapter.stop();
    }
  }, 150_000);

  it("initializes, lists models, runs a turn, persists a goal, and forks", async () => {
    const codexHome = requireIsolatedCodexHome(process.env.CODEX_WEB_TEST_CODEX_HOME, "CODEX_WEB_TEST_CODEX_HOME");
    const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "integration-test" });
    const notificationOrder: Array<{ method: string; threadId?: string; turnId?: string; threadSource?: string }> = [];
    adapter.supervisor.on("notification", (notification: { method: string; params?: Record<string, unknown> }) => {
      const turn = notification.params?.turn as { id?: string } | undefined;
      const thread = notification.params?.thread as { id?: string; threadSource?: string | null } | undefined;
      const threadId = notification.params?.threadId ?? thread?.id;
      const turnId = notification.params?.turnId;
      notificationOrder.push({
        method: notification.method,
        ...(typeof threadId === "string" ? { threadId } : {}),
        ...(typeof turnId === "string" ? { turnId } : turn?.id ? { turnId: turn.id } : {}),
        ...(typeof thread?.threadSource === "string" ? { threadSource: thread.threadSource } : {}),
      });
    });
    adapter.on("stderr", (line) => process.stderr.write(`[app-server] ${String(line)}`));
    await adapter.start();
    const created: string[] = [];
    try {
      expect(adapter.account).not.toBeNull();
      expect(adapter.models.length).toBeGreaterThan(0);
      const sessionSource = `codex-web-integration-session:${crypto.randomUUID()}`;
      const session = await adapter.startSession(path.resolve(process.cwd()), { accessMode: "fullAccess", model: null, reasoning: null }, false, sessionSource);
      created.push(session.thread.id);
      await vi.waitFor(() => {
        const sessionStarted = notificationOrder.find((notification) => notification.method === "thread/started" && notification.threadId === session.thread.id);
        expect(sessionStarted?.threadSource).toBe(sessionSource);
      }, { timeout: 2_000 });
      const completion = new Promise<{ status: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Turn did not complete")), 120_000);
        adapter.on("event", (event: AdapterEvent) => {
          if (event.type === "turnCompleted" && event.threadId === session.thread.id) {
            clearTimeout(timeout); resolve({ status: event.turn.status });
          }
        });
      });
      const turn = await adapter.startTurn(session.thread.id, process.cwd(), "Reply with exactly CODEX_WEB_TEST_OK. Do not use tools.", { accessMode: "fullAccess", model: null, reasoning: "low" }, crypto.randomUUID());
      expect(turn.turn.id).toBeTruthy();
      await expect(completion).resolves.toEqual({ status: "completed" });
      const turnNotifications = notificationOrder.filter((notification) => notification.threadId === session.thread.id && notification.turnId === turn.turn.id);
      const startedIndex = turnNotifications.findIndex((notification) => notification.method === "turn/started");
      const itemIndex = turnNotifications.findIndex((notification) => notification.method.startsWith("item/"));
      const completedIndex = turnNotifications.findIndex((notification) => notification.method === "turn/completed");
      expect(startedIndex).toBeGreaterThanOrEqual(0);
      expect(itemIndex).toBeGreaterThan(startedIndex);
      expect(completedIndex).toBeGreaterThan(itemIndex);
      const goal = await adapter.setGoal({ threadId: session.thread.id, objective: "Integration goal", tokenBudget: 10_000, status: "active" });
      expect((await adapter.getGoal(session.thread.id))?.objective).toBe(goal.objective);
      const recoverySource = `codex-web-integration-fork:${crypto.randomUUID()}`;
      const fork = await adapter.forkSession(
        session.thread.id,
        turn.turn.id,
        { accessMode: "fullAccess", model: null, reasoning: null },
        false,
        process.cwd(),
        recoverySource,
      );
      created.push(fork.thread.id); expect(fork.thread.forkedFromId).toBe(session.thread.id);
      const listedFork = (await adapter.listSessions({ limit: 100 })).data.find((thread) => thread.id === fork.thread.id);
      expect(listedFork?.id).toBe(fork.thread.id);
      const readFork = await adapter.readSession(fork.thread.id);
      expect(readFork.forkedFromId).toBe(session.thread.id);
      expect(readFork.turns.map((candidate) => candidate.id)).toEqual([turn.turn.id]);
      expect(notificationOrder.find((notification) => notification.method === "thread/started" && notification.threadId === fork.thread.id)?.threadSource).toBe(recoverySource);
      await adapter.clearGoal(session.thread.id); expect(await adapter.getGoal(session.thread.id)).toBeNull();
    } finally {
      for (const threadId of created) await adapter.archiveSession(threadId).catch(() => undefined);
      adapter.stop();
    }
  }, 150_000);
});

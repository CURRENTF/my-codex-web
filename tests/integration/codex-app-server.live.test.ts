import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "@codex-web/codex-adapter";

const run = process.env.RUN_CODEX_INTEGRATION === "1" ? describe : describe.skip;

run("real codex app-server with isolated CODEX_HOME", () => {
  it("creates an ephemeral side chat for an empty parent context", async () => {
    const codexHome = process.env.CODEX_WEB_TEST_CODEX_HOME;
    if (!codexHome) throw new Error("CODEX_WEB_TEST_CODEX_HOME is required");
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

  it("initializes, lists models, runs a turn, persists a goal, and forks", async () => {
    const codexHome = process.env.CODEX_WEB_TEST_CODEX_HOME;
    if (!codexHome) throw new Error("CODEX_WEB_TEST_CODEX_HOME is required");
    const adapter = new CodexAdapter({ cwd: process.cwd(), codexHome, version: "integration-test" });
    adapter.on("stderr", (line) => process.stderr.write(`[app-server] ${String(line)}`));
    await adapter.start();
    const created: string[] = [];
    try {
      expect(adapter.account).not.toBeNull();
      expect(adapter.models.length).toBeGreaterThan(0);
      const session = await adapter.startSession(path.resolve(process.cwd()), { accessMode: "fullAccess", model: null, reasoning: null });
      created.push(session.thread.id);
      const completion = new Promise<{ status: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Turn did not complete")), 120_000);
        adapter.on("notification", (notification: { method: string; params?: { threadId?: string; turn?: { status?: string } } }) => {
          if (notification.method === "turn/completed" && notification.params?.threadId === session.thread.id) {
            clearTimeout(timeout); resolve({ status: notification.params.turn?.status ?? "unknown" });
          }
        });
      });
      const turn = await adapter.startTurn(session.thread.id, process.cwd(), "Reply with exactly CODEX_WEB_TEST_OK. Do not use tools.", { accessMode: "fullAccess", model: null, reasoning: "low" }, crypto.randomUUID());
      expect(turn.turn.id).toBeTruthy();
      await expect(completion).resolves.toEqual({ status: "completed" });
      const goal = await adapter.setGoal({ threadId: session.thread.id, objective: "Integration goal", tokenBudget: 10_000, status: "active" });
      expect((await adapter.getGoal(session.thread.id))?.objective).toBe(goal.objective);
      const fork = await adapter.forkSession(session.thread.id, turn.turn.id, { accessMode: "fullAccess", model: null, reasoning: null });
      created.push(fork.thread.id); expect(fork.thread.forkedFromId).toBe(session.thread.id);
      await adapter.clearGoal(session.thread.id); expect(await adapter.getGoal(session.thread.id)).toBeNull();
    } finally {
      for (const threadId of created) await adapter.archiveSession(threadId).catch(() => undefined);
      adapter.stop();
    }
  }, 150_000);
});

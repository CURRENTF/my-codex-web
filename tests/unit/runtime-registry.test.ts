import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../../apps/server/src/database";
import { EventGateway } from "../../apps/server/src/event-gateway";
import { ThreadRuntimeRegistry } from "../../apps/server/src/runtime-registry";
import { projectAdapterEvent, projectPendingRequest } from "@codex-web/codex-adapter";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) cleanup(); });

function notify(registry: ThreadRuntimeRegistry, notification: { method: string; params?: unknown }): void {
  const event = projectAdapterEvent(notification);
  if (!event) throw new Error(`Unprojected test notification: ${notification.method}`);
  registry.handleEvent(event);
}

function pending(registry: ThreadRuntimeRegistry, request: { id: number; method: string; params?: unknown }): void {
  const projected = projectPendingRequest(request as never);
  if (!projected) throw new Error(`Unprojected test request: ${request.method}`);
  registry.handlePendingRequest(projected);
}

describe("runtime projection", () => {
  it("publishes App Server Turn errors to the browser with retry metadata", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const runtimeEvents: Array<{ type: string; payload: unknown }> = [];
    events.on("event", (event) => runtimeEvents.push(event));
    const registry = new ThreadRuntimeRegistry(events, repositories);

    notify(registry, { method: "error", params: {
      threadId: "t1",
      turnId: "turn-1",
      willRetry: true,
      error: {
        message: "Connection reset while streaming",
        codexErrorInfo: { responseStreamConnectionFailed: { httpStatusCode: 503 } },
        additionalDetails: "upstream temporarily unavailable",
      },
    } });

    expect(runtimeEvents.at(-1)).toMatchObject({
      type: "turn.error",
      payload: {
        turnId: "turn-1",
        error: {
          message: "Connection reset while streaming",
          code: "responseStreamConnectionFailed",
          httpStatusCode: 503,
          additionalDetails: "upstream temporarily unavailable",
          willRetry: true,
        },
      },
    });
  });

  it("publishes current context usage through runtime.changed", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const runtimeEvents: Array<{ type: string; payload: unknown }> = [];
    events.on("event", (event) => runtimeEvents.push(event));
    const registry = new ThreadRuntimeRegistry(events, repositories);

    notify(registry, { method: "thread/tokenUsage/updated", params: {
      threadId: "t1",
      turnId: "turn-1",
      tokenUsage: { total: { totalTokens: 800_000 }, last: { totalTokens: 28_400 }, modelContextWindow: 258_000 },
    } });

    expect(registry.get("t1").contextUsage).toEqual({ usedTokens: 28_400, maxTokens: 258_000 });
    expect(runtimeEvents.at(-1)).toMatchObject({
      type: "runtime.changed",
      payload: { threadId: "t1", contextUsage: { usedTokens: 28_400, maxTokens: 258_000 } },
    });
  });

  it("projects turn lifecycle and clears justFinished after 20 seconds", () => {
    vi.useFakeTimers();
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    const clearTerminal = vi.spyOn(repositories, "clearThreadTerminal");
    notify(registry, { method: "turn/started", params: { threadId: "t1", turn: { id: "turn-1" } } });
    expect(registry.get("t1")).toMatchObject({ state: "running", activeTurnId: "turn-1" });
    expect(clearTerminal).toHaveBeenCalledWith("t1");
    notify(registry, { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } } });
    expect(registry.get("t1").state).toBe("justFinished");
    vi.advanceTimersByTime(20_001);
    expect(registry.get("t1").state).toBe("idle");
  });

  it("hydrates unread terminal state from SQLite after a backend restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T10:00:00.000Z"));
    const databasePath = path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db");
    const repositories = new Repositories(databasePath);
    repositories.insertProject({ id: "project-1", name: "Project", rootPath: "/tmp/project", canonicalPath: "/tmp/project", orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: Date.now(), lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "failed-thread", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: Date.now(), last_seen_at: Date.now() });
    repositories.markThreadTerminal("failed-thread", "failed", Date.now() - 1_000);
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });

    const restored = new ThreadRuntimeRegistry(events, repositories);

    expect(restored.get("failed-thread")).toMatchObject({ state: "failed", lastTerminalStatus: "failed" });
    restored.markViewed("failed-thread");
    const afterView = new ThreadRuntimeRegistry(events, repositories);
    expect(afterView.get("failed-thread").state).toBe("idle");
  });

  it("keeps an interrupted state after viewing and across backend restart until the next Turn starts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T10:00:00.000Z"));
    const databasePath = path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db");
    const repositories = new Repositories(databasePath);
    repositories.insertProject({ id: "project-1", name: "Project", rootPath: "/tmp/project", canonicalPath: "/tmp/project", orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: Date.now(), lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "interrupted-thread", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: Date.now(), last_seen_at: Date.now() });
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);

    notify(registry, { method: "turn/started", params: { threadId: "interrupted-thread", turn: { id: "turn-1" } } });
    notify(registry, { method: "turn/completed", params: { threadId: "interrupted-thread", turn: { id: "turn-1", status: "interrupted" } } });
    registry.markViewed("interrupted-thread");

    expect(registry.get("interrupted-thread").state).toBe("interrupted");
    const restored = new ThreadRuntimeRegistry(events, repositories);
    expect(restored.get("interrupted-thread").state).toBe("interrupted");

    restored.setActiveTurn("interrupted-thread", "turn-2");
    expect(restored.get("interrupted-thread")).toMatchObject({ state: "running", activeTurnId: "turn-2" });
    const afterNextTurn = new ThreadRuntimeRegistry(events, repositories);
    expect(afterNextTurn.get("interrupted-thread").state).toBe("idle");
  });

  it("hydrates only the remaining portion of the just-finished window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T10:00:00.000Z"));
    const databasePath = path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db");
    const repositories = new Repositories(databasePath);
    repositories.insertProject({ id: "project-1", name: "Project", rootPath: "/tmp/project", canonicalPath: "/tmp/project", orderIndex: 0, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess", createdAt: Date.now(), lastOpenedAt: null, available: true });
    repositories.upsertProjectSession({ thread_id: "done-thread", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null, added_at: Date.now(), last_seen_at: Date.now() });
    repositories.markThreadTerminal("done-thread", "completed", Date.now() - 15_000);
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });

    const restored = new ThreadRuntimeRegistry(events, repositories);

    expect(restored.get("done-thread").state).toBe("justFinished");
    vi.advanceTimersByTime(5_001);
    expect(restored.get("done-thread").state).toBe("idle");
  });

  it("marks active sessions disconnected when app-server exits", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "turn-1"); registry.handleConnection("disconnected");
    expect(registry.get("t1")).toMatchObject({ state: "disconnected" });
    expect(registry.get("t1").activeTurnId).toBeUndefined();
  });

  it("ignores late notifications after a persistent Session is removed", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "turn-1");
    registry.removeThread("t1");

    notify(registry, { method: "turn/started", params: { threadId: "t1", turn: { id: "late-turn" } } });
    expect(registry.list().some((runtime) => runtime.threadId === "t1")).toBe(false);

    registry.restoreThread("t1");
    notify(registry, { method: "turn/started", params: { threadId: "t1", turn: { id: "new-turn" } } });
    expect(registry.get("t1")).toMatchObject({ state: "running", activeTurnId: "new-turn" });
  });

  it("reconciles a disconnected runtime from a terminal App Server snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:10.000Z"));
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "turn-1");
    registry.handleConnection("disconnected");

    registry.reconcileFromSnapshot("t1", [{
      id: "turn-1",
      status: "completed",
      items: [],
      startedAt: 1,
      completedAt: Math.floor(Date.now() / 1_000),
      durationMs: 1_000,
    }]);

    expect(registry.get("t1")).toMatchObject({ state: "justFinished", lastTerminalStatus: "completed" });
  });

  it("keeps an uncertain Turn start disconnected when the snapshot contains only the previous Turn", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);

    registry.markOperationUncertain("t1", "previous-turn");
    expect(registry.get("t1")).toMatchObject({ state: "disconnected" });

    const snapshot = [{
      id: "previous-turn",
      status: "completed",
      items: [],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    }] as const;
    expect(registry.reconcileFromSnapshot("t1", [...snapshot])).toBe("uncertainTurnUnchanged");

    expect(registry.get("t1")).toMatchObject({ state: "disconnected", uncertainTurnStart: true });
    expect(registry.confirmUncertainTurnNotApplied("t1", [...snapshot])).toBe("reconciled");
    expect(registry.get("t1").state).not.toBe("disconnected");
    expect(registry.get("t1").uncertainTurnStart).toBeUndefined();
  });

  it("restores an active Turn when an uncertain Steer is resolved", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const appliedEvents: string[] = [];
    events.on("event", (event) => appliedEvents.push(event.type));
    const registry = new ThreadRuntimeRegistry(events, repositories);
    const activeTurn = {
      id: "turn-1",
      status: "inProgress" as const,
      items: [],
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    };

    registry.setActiveTurn("t1", activeTurn.id);
    registry.markOperationUncertain("t1", activeTurn.id);
    expect(registry.get("t1")).toMatchObject({ state: "disconnected", uncertainTurnStart: true });

    expect(registry.confirmUncertainTurnNotApplied("t1", [activeTurn], activeTurn.id)).toBe("reconciled");
    expect(registry.get("t1")).toMatchObject({ state: "running", activeTurnId: activeTurn.id });

    registry.markOperationUncertain("t1", activeTurn.id);
    expect(registry.confirmUncertainTurnApplied("t1", [activeTurn], activeTurn.id)).toBe("reconciled");
    expect(registry.get("t1")).toMatchObject({ state: "running", activeTurnId: activeTurn.id });
    expect(appliedEvents).toContain("uncertainTurn.applied");
  });

  it("reconciles an uncertain Turn start only after a newer terminal Turn appears", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);

    registry.markOperationUncertain("t1", "previous-turn");
    registry.reconcileFromSnapshot("t1", [
      { id: "previous-turn", status: "completed", items: [], startedAt: 1, completedAt: 2, durationMs: 1_000 },
      { id: "new-turn", status: "completed", items: [], startedAt: 3, completedAt: 4, durationMs: 1_000 },
    ]);

    expect(registry.get("t1")).toMatchObject({ lastTerminalStatus: "completed" });
    expect(registry.get("t1").state).not.toBe("disconnected");
  });

  it("keeps a connection-interrupted Turn disconnected when only an older terminal snapshot is available", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "active-turn");
    registry.handleConnection("disconnected");

    registry.reconcileFromSnapshot("t1", [{
      id: "older-turn",
      status: "completed",
      items: [],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    }]);

    expect(registry.get("t1")).toMatchObject({ state: "disconnected" });
    expect(registry.get("t1").activeTurnId).toBeUndefined();
  });

  it("accepts a newer terminal snapshot after the interrupted Turn is proven terminal", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "interrupted-turn");
    registry.handleConnection("disconnected");

    registry.reconcileFromSnapshot("t1", [
      { id: "interrupted-turn", status: "interrupted", items: [], startedAt: 1, completedAt: 2, durationMs: 1_000 },
      { id: "newer-turn", status: "completed", items: [], startedAt: 3, completedAt: 4, durationMs: 1_000 },
    ]);

    expect(registry.get("t1")).toMatchObject({ lastTerminalStatus: "completed" });
    expect(registry.get("t1").state).not.toBe("disconnected");
  });

  it("keeps terminal visual states when a trailing idle status arrives", () => {
    vi.useFakeTimers();
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    notify(registry, { method: "turn/started", params: { threadId: "t1", turn: { id: "turn-1" } } });
    notify(registry, { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } } });
    notify(registry, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
    registry.markViewed("t1");
    expect(registry.get("t1").state).toBe("justFinished");
    vi.advanceTimersByTime(20_001);
    expect(registry.get("t1").state).toBe("idle");
  });

  it("projects active thread status even when turn/started was missed", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);

    notify(registry, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "active", activeFlags: ["loaded"] } } });

    expect(registry.get("t1")).toMatchObject({ state: "running", activeFlags: ["loaded"] });
  });

  it("maps active wait flags and clears stale active state on system errors", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    const terminal = vi.spyOn(repositories, "markThreadTerminal");
    registry.setActiveTurn("t1", "turn-1");
    pending(registry, { id: 21, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } } as never);

    notify(registry, { method: "thread/status/changed", params: {
      threadId: "t1", status: { type: "active", activeFlags: ["waitingOnApproval"] },
    } });
    expect(registry.get("t1")).toMatchObject({ state: "waitingForInput", activeTurnId: "turn-1", activeFlags: ["waitingOnApproval"] });

    notify(registry, { method: "thread/status/changed", params: {
      threadId: "t1", status: { type: "systemError" },
    } });
    expect(registry.get("t1")).toMatchObject({ state: "failed", pendingRequestIds: [], lastTerminalStatus: "failed" });
    expect(registry.get("t1").activeTurnId).toBeUndefined();
    expect(registry.listPendingRequests()).toEqual([]);
    expect(terminal).toHaveBeenCalledWith("t1", "failed", expect.any(Number));

    registry.markViewed("t1");
    expect(registry.get("t1")).toMatchObject({ state: "idle" });
    expect(registry.get("t1").activeTurnId).toBeUndefined();
  });

  it("publishes turn plan updates as stable timeline items", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const publish = vi.spyOn(events, "publish");
    const registry = new ThreadRuntimeRegistry(events, repositories);

    notify(registry, { method: "turn/plan/updated", params: {
      threadId: "t1", turnId: "turn-1", explanation: null,
      plan: [{ step: "Run command", status: "inProgress" }],
    } });

    expect(publish).toHaveBeenCalledWith("item.upserted", {
      turnId: "turn-1",
      completed: false,
      item: { type: "plan", id: "turn-plan:turn-1", text: "[~] Run command" },
    }, { threadId: "t1" });
  });

  it("projects file patch updates before the file-change Item completes", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const publish = vi.spyOn(events, "publish");
    const registry = new ThreadRuntimeRegistry(events, repositories);

    notify(registry, { method: "item/fileChange/patchUpdated", params: {
      threadId: "t1", turnId: "turn-1", itemId: "files-1",
      changes: [{ path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "@@\n-old\n+new" }],
    } });

    expect(publish).toHaveBeenCalledWith("item.upserted", {
      turnId: "turn-1",
      completed: false,
      item: { type: "fileChange", id: "files-1", status: "inProgress", changes: [{ path: "src/a.ts", kind: "update", diff: "@@\n-old\n+new" }] },
    }, { threadId: "t1" });
  });

  it("snapshots projected pending requests and live item deltas for browser reconnects", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    pending(registry, { id: 7, method: "item/commandExecution/requestApproval", params: { threadId: "t1", secretProtocolField: "not-for-browser" } } as never);
    notify(registry, { method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "hello" } });

    expect(registry.listPendingRequests()).toEqual([{ id: "7", method: "item/commandExecution/requestApproval", params: null }]);
    expect(registry.listItemDeltas()).toEqual({ "agent-1": "hello" });
  });

  it("clears unfinished item deltas when their Turn reaches a terminal state", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    notify(registry, { method: "item/agentMessage/delta", params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "partial" } });

    notify(registry, { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1", status: "interrupted" } } });

    expect(registry.listItemDeltas()).toEqual({});
  });

  it("exposes only the user-input question schema needed by the browser", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    pending(registry, { id: 8, method: "item/tool/requestUserInput", params: {
      threadId: "t1", turnId: "turn-1", itemId: "tool-1", autoResolutionMs: 60_000, secretProtocolField: "drop",
      questions: [{ id: "choice", header: "Mode", question: "Choose one", isOther: true, isSecret: false, options: [{ label: "Safe", description: "Use safe mode", extra: "drop" }] }],
    } } as never);

    expect(registry.listPendingRequests()).toEqual([{ id: "8", method: "item/tool/requestUserInput", params: {
      type: "userInput", autoResolutionMs: 60_000,
      questions: [{ id: "choice", header: "Mode", question: "Choose one", isOther: true, isSecret: false, options: [{ label: "Safe", description: "Use safe mode" }] }],
    } }]);
  });

  it("stays waiting while another server request is still pending", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "turn-1");
    pending(registry, { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } } as never);
    pending(registry, { id: 2, method: "item/fileChange/requestApproval", params: { threadId: "t1" } } as never);

    registry.resolveServerRequest("1");

    expect(registry.get("t1")).toMatchObject({ state: "waitingForInput", activeTurnId: "turn-1", pendingRequestIds: ["2"] });
  });

  it("returns to running when the last request resolves before the active Turn ID is known", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    notify(registry, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "active", activeFlags: [] } } });
    pending(registry, { id: 3, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } } as never);

    registry.resolveServerRequest("3");

    expect(registry.get("t1")).toMatchObject({ state: "running", pendingRequestIds: [] });
    expect(registry.get("t1").activeTurnId).toBeUndefined();
  });

  it("associates legacy approval requests through conversationId", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("legacy-thread", "turn-1");

    pending(registry, { id: 17, method: "execCommandApproval", params: { conversationId: "legacy-thread" } } as never);

    expect(registry.get("legacy-thread")).toMatchObject({ state: "waitingForInput", pendingRequestIds: ["17"] });
    expect(registry.listPendingRequests()).toEqual([{ id: "17", method: "execCommandApproval", params: null }]);
  });

  it("routes a subagent server request to its visible parent Session", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("parent", "parent-turn");
    registry.handleEvent({
      type: "threadStarted",
      threadId: "subagent",
      parentThreadId: "parent",
      thread: {} as never,
    });

    pending(registry, { id: 19, method: "item/commandExecution/requestApproval", params: { threadId: "subagent" } } as never);

    expect(registry.get("parent")).toMatchObject({
      state: "waitingForInput",
      activeTurnId: "parent-turn",
      pendingRequestIds: ["19"],
    });
    expect(registry.get("subagent").pendingRequestIds).toEqual([]);

    registry.resolveServerRequest("19");

    expect(registry.get("parent")).toMatchObject({ state: "running", pendingRequestIds: [] });
    expect(registry.listPendingRequests()).toEqual([]);
  });

  it("tracks Subagent spawn metadata, actual settings, and runtime state", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const runtimeEvents: Array<{ type: string; threadId?: string; payload: unknown }> = [];
    events.on("event", (event) => runtimeEvents.push(event));
    const registry = new ThreadRuntimeRegistry(events, repositories);

    notify(registry, { method: "item/started", params: { threadId: "parent", turnId: "turn-1", item: {
      type: "collabAgentToolCall", id: "spawn-1", tool: "spawnAgent", status: "inProgress", senderThreadId: "parent",
      receiverThreadIds: ["child"], prompt: "Review it", model: "gpt-5.6-sol", reasoningEffort: "high",
      agentsStates: { child: { status: "running", message: "Working" } },
    } } });
    notify(registry, { method: "thread/started", params: { thread: {
      id: "child", sessionId: "session-1", forkedFromId: "parent", parentThreadId: "parent", preview: "", ephemeral: false,
      modelProvider: "openai", createdAt: 2, updatedAt: 2, recencyAt: 2, status: { type: "active", activeFlags: [] }, path: null,
      cwd: "/tmp/project", cliVersion: "test", source: { subAgent: { thread_spawn: {
        parent_thread_id: "parent", depth: 0, agent_path: "review", agent_nickname: "reviewer", agent_role: "reviewer",
      } } }, threadSource: null, agentNickname: "reviewer", agentRole: "reviewer", gitInfo: null, name: null, turns: [],
    } } });
    notify(registry, { method: "thread/settings/updated", params: { threadId: "child", threadSettings: {
      model: "gpt-5.6-sol", effort: "xhigh", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
    } } });
    notify(registry, { method: "thread/status/changed", params: { threadId: "child", status: { type: "active", activeFlags: [] } } });

    expect(registry.listSubagents()).toEqual([expect.objectContaining({
      threadId: "child",
      parentThreadId: "parent",
      contextMode: "forked",
      sourceKind: "threadSpawn",
      agentNickname: "reviewer",
      requestedModel: "gpt-5.6-sol",
      requestedReasoning: "high",
      model: "gpt-5.6-sol",
      reasoning: "xhigh",
      state: "running",
      agentStatus: "running",
      statusMessage: "Working",
    })]);
    expect(runtimeEvents.some((event) => event.type === "subagent.changed" && event.threadId === "parent")).toBe(true);
  });

  it("marks spawn-only Subagents disconnected and recursively removes nested mappings", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    const spawn = (senderThreadId: string, childThreadId: string) => notify(registry, { method: "item/started", params: {
      threadId: senderThreadId, turnId: `${senderThreadId}-turn`, item: {
        type: "collabAgentToolCall", id: `spawn-${childThreadId}`, tool: "spawnAgent", status: "inProgress", senderThreadId,
        receiverThreadIds: [childThreadId], prompt: null, model: null, reasoningEffort: null,
        agentsStates: { [childThreadId]: { status: "running", message: null } },
      },
    } });

    spawn("parent", "child");
    spawn("child", "grandchild");
    registry.handleConnection("disconnected");
    expect(registry.listSubagents()).toEqual(expect.arrayContaining([
      expect.objectContaining({ threadId: "child", state: "disconnected" }),
      expect.objectContaining({ threadId: "grandchild", state: "disconnected" }),
    ]));

    registry.removeThread("parent");
    expect(registry.listSubagents()).toEqual([]);
  });

  it("applies later collab status updates without reparenting nested Subagents", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    const spawn = (senderThreadId: string, childThreadId: string) => notify(registry, { method: "item/started", params: {
      threadId: senderThreadId, turnId: `${senderThreadId}-turn`, item: {
        type: "collabAgentToolCall", id: `spawn-${childThreadId}`, tool: "spawnAgent", status: "inProgress", senderThreadId,
        receiverThreadIds: [childThreadId], prompt: null, model: null, reasoningEffort: null,
        agentsStates: { [childThreadId]: { status: "running", message: null } },
      },
    } });
    spawn("parent", "child");
    spawn("child", "grandchild");

    notify(registry, { method: "item/completed", params: { threadId: "parent", turnId: "parent-turn", item: {
      type: "collabAgentToolCall", id: "wait-grandchild", tool: "wait", status: "completed", senderThreadId: "parent",
      receiverThreadIds: ["grandchild"], prompt: null, model: null, reasoningEffort: null,
      agentsStates: { grandchild: { status: "completed", message: "Done" } },
    } } });

    expect(registry.listSubagents().find((item) => item.threadId === "grandchild")).toMatchObject({
      parentThreadId: "child",
      agentStatus: "completed",
      statusMessage: "Done",
    });
  });

  it("clears a request when App Server resolves it and preserves terminal state", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "turn-1");
    pending(registry, { id: 18, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } } as never);

    notify(registry, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: 18 } });
    expect(registry.listPendingRequests()).toEqual([]);
    expect(registry.get("t1")).toMatchObject({ state: "running", pendingRequestIds: [] });

    pending(registry, { id: 19, method: "item/commandExecution/requestApproval", params: { threadId: "t1" } } as never);
    notify(registry, { method: "turn/completed", params: { threadId: "t1", turn: { id: "turn-1", status: "failed" } } });
    notify(registry, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: 19 } });
    expect(registry.listPendingRequests()).toEqual([]);
    expect(registry.get("t1")).toMatchObject({ state: "failed", pendingRequestIds: [] });
  });

  it("waits for an active Turn to reach a terminal state without polling", async () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("side-1", "turn-1");

    const terminal = registry.waitForTerminal("side-1", 1_000);
    let settled = false;
    void terminal.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    notify(registry, { method: "turn/completed", params: { threadId: "side-1", turn: { id: "turn-1", status: "interrupted" } } });

    await expect(terminal).resolves.toBe(true);
  });

  it("treats an idle thread/status update as terminal when turn/completed was lost", async () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("side-idle", "turn-1");
    const terminal = registry.waitForTerminal("side-idle", 1_000);

    notify(registry, { method: "thread/status/changed", params: { threadId: "side-idle", status: { type: "idle" } } });

    await expect(terminal).resolves.toBe(true);
    expect(registry.get("side-idle")).toMatchObject({ state: "idle" });
    expect(registry.get("side-idle").activeTurnId).toBeUndefined();
  });

  it("clears terminal pending state on idle and ignores its late resolution after Side Chat removal", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.registerSideChat({ threadId: "side-idle-cleanup", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 });
    registry.setActiveTurn("side-idle-cleanup", "turn-1");
    pending(registry, { id: 31, method: "item/commandExecution/requestApproval", params: { threadId: "side-idle-cleanup" } } as never);
    notify(registry, { method: "item/agentMessage/delta", params: { threadId: "side-idle-cleanup", turnId: "turn-1", itemId: "agent-side-idle", delta: "partial" } });

    notify(registry, { method: "thread/status/changed", params: { threadId: "side-idle-cleanup", status: { type: "idle" } } });

    expect(registry.get("side-idle-cleanup")).toMatchObject({ state: "idle", pendingRequestIds: [] });
    expect(registry.listPendingRequests()).toEqual([]);
    expect(registry.listItemDeltas()).toEqual({});

    registry.removeSideChat("side-idle-cleanup");
    notify(registry, { method: "serverRequest/resolved", params: { threadId: "side-idle-cleanup", requestId: 31 } });
    expect(registry.list().some((runtime) => runtime.threadId === "side-idle-cleanup")).toBe(false);
  });

  it("waits briefly for a Turn ID when active status arrives before turn/started", async () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    notify(registry, { method: "thread/status/changed", params: { threadId: "side-race", status: { type: "active", activeFlags: [] } } });

    const activeTurnId = registry.waitForActiveTurnId("side-race", 1_000);
    notify(registry, { method: "turn/started", params: { threadId: "side-race", turn: { id: "turn-race", status: "inProgress", items: [] } } });

    await expect(activeTurnId).resolves.toBe("turn-race");
  });

  it("bounds active Turn ID waits and removes a timed-out waiter", async () => {
    vi.useFakeTimers();
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    notify(registry, { method: "thread/status/changed", params: { threadId: "side-race-timeout", status: { type: "active", activeFlags: [] } } });

    const activeTurnId = registry.waitForActiveTurnId("side-race-timeout", 2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(activeTurnId).resolves.toBeUndefined();
    expect((registry as unknown as { activeTurnWaiters: Map<string, unknown> }).activeTurnWaiters.has("side-race-timeout")).toBe(false);
    vi.useRealTimers();
  });

  it("bounds terminal waits and removes a timed-out waiter", async () => {
    vi.useFakeTimers();
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("side-long", "turn-1");

    const terminal = registry.waitForTerminal("side-long", 30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(terminal).resolves.toBe(false);
    expect((registry as unknown as { terminalWaiters: Map<string, unknown> }).terminalWaiters.has("side-long")).toBe(false);
    vi.useRealTimers();
  });

  it("ignores late notifications after a Side Chat is unsubscribed and removed", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.registerSideChat({ threadId: "side-closed", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 });
    registry.removeSideChat("side-closed");

    notify(registry, { method: "turn/completed", params: {
      threadId: "side-closed",
      turn: { id: "turn-late", status: "completed", items: [], startedAt: 1, completedAt: 2, durationMs: 1_000 },
    } });

    expect(registry.list().some((runtime) => runtime.threadId === "side-closed")).toBe(false);
  });

  it("clears Side Chat deltas when the ephemeral Thread is removed", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.registerSideChat({ threadId: "side-1", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 });
    notify(registry, { method: "item/agentMessage/delta", params: { threadId: "side-1", turnId: "turn-1", itemId: "agent-side", delta: "partial" } });

    registry.removeSideChat("side-1");

    expect(registry.listItemDeltas()).toEqual({});
  });

  it("keeps ephemeral Side Chat terminal and viewed state out of SQLite", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const terminal = vi.spyOn(repositories, "markThreadTerminal");
    const viewed = vi.spyOn(repositories, "markThreadViewed");
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.registerSideChat({ threadId: "side-1", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 });

    notify(registry, { method: "turn/started", params: { threadId: "side-1", turn: { id: "turn-1" } } });
    notify(registry, { method: "turn/completed", params: { threadId: "side-1", turn: { id: "turn-1", status: "completed" } } });
    registry.markViewed("side-1");

    expect(terminal).not.toHaveBeenCalled();
    expect(viewed).not.toHaveBeenCalled();
  });
});

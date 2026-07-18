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

  it("reconciles a disconnected runtime from a terminal App Server snapshot", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T10:00:10.000Z"));
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("t1", "turn-1");
    registry.handleConnection("disconnected");

    registry.reconcileFromSnapshot("t1", {
      id: "turn-1",
      status: "completed",
      items: [],
      startedAt: 1,
      completedAt: Math.floor(Date.now() / 1_000),
      durationMs: 1_000,
    });

    expect(registry.get("t1")).toMatchObject({ state: "justFinished", lastTerminalStatus: "completed" });
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

  it("associates legacy approval requests through conversationId", () => {
    const repositories = new Repositories(path.join(mkdtempSync(path.join(tmpdir(), "codex-web-runtime-")), "app.db"));
    const events = new EventGateway(() => true); cleanups.push(() => { events.close(); repositories.close(); });
    const registry = new ThreadRuntimeRegistry(events, repositories);
    registry.setActiveTurn("legacy-thread", "turn-1");

    pending(registry, { id: 17, method: "execCommandApproval", params: { conversationId: "legacy-thread" } } as never);

    expect(registry.get("legacy-thread")).toMatchObject({ state: "waitingForInput", pendingRequestIds: ["17"] });
    expect(registry.listPendingRequests()).toEqual([{ id: "17", method: "execCommandApproval", params: null }]);
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

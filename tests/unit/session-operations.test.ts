import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@codex-web/codex-schema/v2/Thread";
import { JsonRpcError, pendingRequestResponse, projectAdapterEvent, projectPendingRequest } from "@codex-web/codex-adapter";
import { ActiveTurnConflictError, assertValidForkBoundary, ForkBoundaryError, isSteerTurnConflictError, isUnmaterializedSessionReadError, resolveSessionSettings, SessionService } from "../../apps/server/src/session-service.js";

function turn(id: string, status: Thread["turns"][number]["status"]): Thread["turns"][number] {
  return { id, status, itemsView: "full", error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: status === "inProgress" ? null : 1_000, items: [] };
}

describe("session operation rules", () => {
  it("recognizes both empty-rollout variants as transient Session materialization races", () => {
    expect(isUnmaterializedSessionReadError(new JsonRpcError("no rollout found for thread id redacted", -32600))).toBe(true);
    expect(isUnmaterializedSessionReadError(new JsonRpcError("thread not materialized yet"))).toBe(true);
    expect(isUnmaterializedSessionReadError(new JsonRpcError("failed to read rollout /tmp/test.jsonl: rollout at /tmp/test.jsonl is empty"))).toBe(true);
    expect(isUnmaterializedSessionReadError(new JsonRpcError("thread not found"))).toBe(false);
  });
  it("distinguishes a finished-Turn Steer conflict from unrelated protocol failures", () => {
    expect(isSteerTurnConflictError(new JsonRpcError("no active turn found for thread", -32600))).toBe(true);
    expect(isSteerTurnConflictError(new JsonRpcError("expectedTurnId does not match the active turn", -32600))).toBe(true);
    expect(isSteerTurnConflictError(new JsonRpcError("internal app-server failure", -32603))).toBe(false);
  });
  it("accepts only existing terminal Turn boundaries", () => {
    const turns = [turn("done", "completed"), turn("active", "inProgress"), turn("failed", "failed"), turn("interrupted", "interrupted")];
    expect(() => assertValidForkBoundary(turns, "done")).not.toThrow();
    expect(() => assertValidForkBoundary(turns, null)).toThrow("completed Turn boundary");
    expect(() => assertValidForkBoundary(turns, "missing")).toThrow(ForkBoundaryError);
    expect(() => assertValidForkBoundary(turns, "active")).toThrow("completed Turn");
    expect(() => assertValidForkBoundary(turns, "failed")).toThrow("completed Turn");
    expect(() => assertValidForkBoundary(turns, "interrupted")).toThrow("completed Turn");
  });

  it("does not clear a failed Runtime during background Session reads", async () => {
    const snapshot = { id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("failed", "failed")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async () => snapshot),
      getGoal: vi.fn(async () => null),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      markViewed: vi.fn(),
      get: vi.fn(() => ({ threadId: "thread-1", state: "failed", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.readSession("thread-1");

    expect(runtimes.markViewed).not.toHaveBeenCalled();
  });

  it("surfaces a transient Goal read failure instead of presenting a false empty Goal", async () => {
    const snapshot = { id: "thread-1", preview: "test", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const goal = { threadId: "thread-1", objective: "ship", status: "active", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async () => snapshot),
      getGoal: vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue(goal),
      listSessions: vi.fn(async () => ({ data: [{ id: "thread-1", preview: "test", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1 }], nextCursor: null })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null })),
      listProjectSessions: vi.fn(() => [{ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null }]),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.readSession("thread-1")).rejects.toThrow("temporary");
    await service.listSessions();
    await vi.waitFor(() => expect(adapter.getGoal).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("thread-1", "goal-loaded"));
  });

  it("paginates through every mapped Session instead of truncating large histories", async () => {
    const count = 2_001;
    const mappings = Array.from({ length: count }, (_, index) => ({
      thread_id: `thread-${index}`, project_id: "project-1", cwd_snapshot: "/tmp/project",
      source_kind: "appServer", origin: "discovered", parent_thread_id: null, fork_turn_id: null,
    }));
    const adapter = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(async ({ cursor }: { cursor?: string | null }) => {
        const offset = cursor ? Number(cursor) : 0;
        const data = mappings.slice(offset, offset + 100).map((mapping, pageIndex) => ({
          id: mapping.thread_id, preview: mapping.thread_id, name: null, cwd: "/tmp/project",
          sourceKind: "appServer", createdAt: offset + pageIndex + 1, updatedAt: offset + pageIndex + 1,
        }));
        const nextOffset = offset + data.length;
        return { data, nextCursor: nextOffset < count ? String(nextOffset) : null };
      }),
    });
    const repositories = { listProjectSessions: vi.fn(() => mappings) };
    const runtimes = { get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })), getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    const goalPresence = (service as unknown as { goalPresence: Map<string, boolean> }).goalPresence;
    for (const mapping of mappings) goalPresence.set(mapping.thread_id, false);

    const sessions = await service.listSessions({ sortDirection: "asc" });

    expect(sessions).toHaveLength(count);
    expect(adapter.listSessions).toHaveBeenCalledTimes(21);
    expect(sessions.at(-1)?.threadId).toBe("thread-2000");
  });

  it("filters cached Session snapshots instead of reintroducing unrelated search results", async () => {
    const mappings = ["matching", "unrelated"].map((threadId) => ({
      thread_id: threadId, project_id: "project-1", cwd_snapshot: "/tmp/project",
      source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null,
    }));
    const adapter = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(async () => ({ data: [], nextCursor: null })),
    });
    const repositories = { listProjectSessions: vi.fn(() => mappings) };
    const runtimes = { get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })), getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    const snapshots = (service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots;
    snapshots.set("matching", { id: "matching", preview: "Run SAFARI_TOOL_START now", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [] });
    snapshots.set("unrelated", { id: "unrelated", preview: "Different task", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] });
    const goalPresence = (service as unknown as { goalPresence: Map<string, boolean> }).goalPresence;
    goalPresence.set("matching", false); goalPresence.set("unrelated", false);

    const sessions = await service.listSessions({ search: "safari_tool_start" });

    expect(adapter.listSessions).toHaveBeenCalledWith(expect.objectContaining({ searchTerm: "safari_tool_start" }));
    expect(sessions.map((session) => session.threadId)).toEqual(["matching"]);
  });

  it("deduplicates Turn submissions by clientUserMessageId even when request IDs differ", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ settings: { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" } })),
      startTurn: vi.fn(async () => ({ turn: turn("turn-1", "inProgress") })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: "gpt-test", defaultReasoning: "high", defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      setActiveTurn: vi.fn(),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    const input = { clientUserMessageId: "message-same", model: null, reasoning: null, accessMode: "fullAccess" as const };

    const first = service.startTurn("thread-1", "hello", input, "request-000001");
    const retry = service.startTurn("thread-1", "hello", input, "request-000002");

    await expect(Promise.all([first, retry])).resolves.toHaveLength(2);
    expect(adapter.startTurn).toHaveBeenCalledTimes(1);
    expect(runtimes.setActiveTurn).toHaveBeenCalledTimes(1);
  });

  it("scopes clientRequestId deduplication by mutation and resource", async () => {
    const thread = { id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => ({ thread })),
      startTurn: vi.fn(async () => ({ turn: turn("turn-1", "inProgress") })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      setActiveTurn: vi.fn(),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const created = await service.createSession("project-1", {}, "shared-request-id");
    const started = await service.startTurn("thread-1", "hello", { clientUserMessageId: "message-1" }, "shared-request-id");

    expect(created.thread.id).toBe("thread-1");
    expect(started.turn.id).toBe("turn-1");
    expect(adapter.startSession).toHaveBeenCalledTimes(1);
    expect(adapter.startTurn).toHaveBeenCalledTimes(1);
  });

  it("resolves explicit, current Session, and Project settings in that order", () => {
    const project = { defaultModel: "project-model", defaultReasoning: "medium", defaultAccessMode: "fullAccess" as const };
    const current = { model: "session-model", reasoning: "high", accessMode: "workspaceWrite" as const };
    expect(resolveSessionSettings(project, {}, current)).toEqual(current);
    expect(resolveSessionSettings(project, { model: "turn-model", reasoning: "low", accessMode: "readOnly" }, current)).toEqual({ model: "turn-model", reasoning: "low", accessMode: "readOnly" });
    expect(resolveSessionSettings(project, {})).toEqual({ model: "project-model", reasoning: "medium", accessMode: "fullAccess" });
  });

  it("preserves a cold Session's current settings before Project defaults", async () => {
    const snapshot = { id: "thread-1", preview: "test", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const projectSettings = { model: "project-model", reasoning: "high", accessMode: "fullAccess" as const };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: "app-default", reasoning: "low", accessMode: "workspaceWrite" as const } })),
      readSession: vi.fn(async () => snapshot),
      getGoal: vi.fn(async () => null),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: projectSettings.model, defaultReasoning: projectSettings.reasoning, defaultAccessMode: projectSettings.accessMode })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const result = await service.readSession("thread-1");

    expect(adapter.resumeSession).toHaveBeenCalledWith("thread-1");
    expect(result.settings).toEqual({ model: "app-default", reasoning: "low", accessMode: "workspaceWrite" });
  });

  it("serves the live snapshot while a newly started Session rollout is still materializing", async () => {
    const snapshot = { id: "thread-1", preview: "test", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("turn-1", "inProgress")] };
    const settings = { model: null, reasoning: "low", accessMode: "readOnly" as const };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => { throw new JsonRpcError("no rollout found for thread id thread-1", -32600); }),
      readSession: vi.fn(async () => { throw new JsonRpcError("no rollout found for thread id thread-1", -32600); }),
      getGoal: vi.fn(async () => null),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { sessionSnapshots: Map<string, typeof snapshot> }).sessionSnapshots.set("thread-1", snapshot);
    (service as unknown as { settings: Map<string, typeof settings> }).settings.set("thread-1", settings);

    await expect(service.readSession("thread-1")).resolves.toMatchObject({
      thread: { id: "thread-1", turns: [{ id: "turn-1", status: "inProgress" }] },
      runtime: { state: "running", activeTurnId: "turn-1" },
      settings: { model: null, reasoning: "low", accessMode: "readOnly" },
    });
  });

  it("fails a cold Session read when resume fails instead of substituting Project Full Access", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => { throw new JsonRpcError("resume failed", -32603); }),
      readSession: vi.fn(),
      getGoal: vi.fn(),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: "project-model", defaultReasoning: "high", defaultAccessMode: "fullAccess" })),
    };
    const runtimes = { getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.readSession("thread-1")).rejects.toThrow("resume failed");

    expect(adapter.readSession).not.toHaveBeenCalled();
    expect(adapter.getGoal).not.toHaveBeenCalled();
  });

  it("keeps repeated identical commands as separate live Items when IDs differ", async () => {
    const base = { id: "thread-1", preview: "test", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [{ id: "turn-1", status: "inProgress" as const, items: [], startedAt: 1, completedAt: null, durationMs: null }] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: base, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })), readSession: vi.fn(async () => base), getGoal: vi.fn(async () => null),
    });
    const repositories = { markThreadViewed: vi.fn(), getProjectSession: vi.fn(() => ({ project_id: "project-1", cwd_snapshot: "/tmp/project" })), getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })) };
    const runtimes = { markViewed: vi.fn(), get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeFlags: [], pendingRequestIds: [] })), getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    await service.readSession("thread-1");
    const command = { type: "commandExecution", command: "npm test", cwd: "/tmp/project", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    service.handleEvent(projectAdapterEvent({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { ...command, id: "command-1" } } })!);
    service.handleEvent(projectAdapterEvent({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { ...command, id: "command-2" } } })!);
    const refreshed = await service.readSession("thread-1");
    expect(refreshed.thread.turns[0]?.items.map((item) => item.id)).toEqual(["command-1", "command-2"]);
  });

  it("does not leak a rejected serial-lock tracking promise", async () => {
    const adapter = Object.assign(new EventEmitter(), { interruptTurn: vi.fn(async () => undefined) });
    const runtimes = {
      get: vi.fn()
        .mockReturnValueOnce({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })
        .mockReturnValueOnce({ threadId: "thread-1", state: "running", activeTurnId: "turn-next", activeFlags: [], pendingRequestIds: [] }),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.steer("thread-1", "late", "turn-old", "message-1", "request-1")).rejects.toThrow("finished");
    await expect(service.interrupt("thread-1")).resolves.toBeUndefined();
    expect(adapter.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-next");
  });

  it("preserves unrelated turn/steer protocol errors", async () => {
    const failure = new JsonRpcError("internal app-server failure", -32603);
    const adapter = Object.assign(new EventEmitter(), { steerTurn: vi.fn(async () => { throw failure; }) });
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.steer("thread-1", "more", "turn-1", "message-1", "request-1")).rejects.toBe(failure);
  });

  it("uses the response shape required by each approval protocol generation", () => {
    expect(pendingRequestResponse({ id: 1, method: "item/commandExecution/requestApproval", params: {} }, true)).toEqual({ decision: "accept" });
    expect(pendingRequestResponse({ id: 1, method: "execCommandApproval", params: {} }, false)).toEqual({ decision: "denied" });
    expect(pendingRequestResponse({ id: 1, method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true }, fileSystem: null } } }, true)).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(pendingRequestResponse({ id: 1, method: "item/permissions/requestApproval", params: {} }, false)).toEqual({ permissions: {}, scope: "turn" });
    expect(pendingRequestResponse({ id: 1, method: "mcpServer/elicitation/request", params: {} }, false)).toEqual({ action: "decline", content: null, _meta: null });
  });

  it("answers user-input requests with the protocol question map and keeps dynamic tools unsupported", () => {
    const request = { id: 1, method: "item/tool/requestUserInput", params: { questions: [{ id: "choice" }, { id: "secret" }] } };
    expect(projectPendingRequest(request)).not.toBeNull();
    expect(projectPendingRequest({ id: 2, method: "item/tool/call", params: {} })).toBeNull();
    expect(pendingRequestResponse(request, true, { choice: ["Option A"], secret: ["hidden"], unknown: ["drop"] })).toEqual({
      answers: { choice: { answers: ["Option A"] }, secret: { answers: ["hidden"] } },
    });
    expect(pendingRequestResponse(request, false, { choice: ["Option A"] })).toEqual({ answers: {} });
    expect(pendingRequestResponse({ id: 1, method: "item/tool/call", params: {} }, true)).toBeNull();
  });

  it("projects MCP form elicitation and returns typed structured content", () => {
    const request = { id: 3, method: "mcpServer/elicitation/request", params: {
      threadId: "thread-1", turnId: "turn-1", serverName: "calendar", mode: "form", message: "Meeting details", _meta: null,
      requestedSchema: { type: "object", required: ["title", "count"], properties: {
        title: { type: "string", title: "Title" },
        count: { type: "integer", title: "Count" },
        notify: { type: "boolean", title: "Notify" },
        guests: { type: "array", title: "Guests", items: { type: "string", enum: ["A", "B"] } },
      } },
    } };
    expect(projectPendingRequest(request)?.summary.params).toMatchObject({
      type: "elicitation", mode: "form", serverName: "calendar", message: "Meeting details",
      fields: [
        { id: "title", valueType: "string", required: true },
        { id: "count", valueType: "integer", required: true },
        { id: "notify", valueType: "boolean", required: false },
        { id: "guests", valueType: "multiSelect", required: false },
      ],
    });
    expect(pendingRequestResponse(request, true, { title: ["Sync"], count: ["2"], notify: ["true"], guests: ["A", "B"] })).toEqual({
      action: "accept", content: { title: "Sync", count: 2, notify: true, guests: ["A", "B"] }, _meta: null,
    });
    expect(() => pendingRequestResponse(request, true, { title: ["Missing count"] })).toThrow("Missing required MCP field");
  });

  it("keeps unsupported server requests inside the adapter boundary", () => {
    expect(projectPendingRequest({ id: 9, method: "account/chatgptAuthTokens/refresh", params: { threadId: "thread-1" } })).toBeNull();
  });

  it("keeps request_user_input pending until the browser submits answers", async () => {
    const request = { id: 10, method: "item/tool/requestUserInput", params: {
      threadId: "thread-1", turnId: "turn-1", itemId: "tool-1", autoResolutionMs: null,
      questions: [{ id: "mode", header: "Mode", question: "Choose", isOther: false, isSecret: false, options: [{ label: "Safe", description: "Safe mode" }] }],
    } };
    const adapter = Object.assign(new EventEmitter(), { respondPendingRequest: vi.fn() });
    const runtimes = { handlePendingRequest: vi.fn(), resolveServerRequest: vi.fn() };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);
    const projected = projectPendingRequest(request)!;

    service.handlePendingRequest(projected);
    await service.respondPendingRequest("10", true, { mode: ["Safe"] });

    expect(runtimes.handlePendingRequest).toHaveBeenCalledWith(projected);
    expect(adapter.respondPendingRequest).toHaveBeenCalledWith("10", true, { mode: ["Safe"] });
    expect(runtimes.resolveServerRequest).toHaveBeenCalledWith("10");
  });

  it("restores a Fork source Turn number from the child history after a service restart", async () => {
    const childSnapshot = {
      id: "child", preview: "fork", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2,
      ephemeral: false, forkedFromId: "parent",
      turns: [turn("first", "completed"), turn("boundary", "completed")],
    };
    const adapter = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(async () => ({
        data: [
          { id: "child", preview: "fork", name: null, cwd: "/tmp/project", sourceKind: "appServer", createdAt: 1, updatedAt: 2 },
          { id: "parent", preview: "parent", name: "Parent", cwd: "/tmp/project", sourceKind: "appServer", createdAt: 1, updatedAt: 1 },
        ],
        nextCursor: null,
      })),
      readSession: vi.fn(async () => childSnapshot),
      getGoal: vi.fn(async () => null),
    });
    const repositories = {
      listProjectSessions: vi.fn(() => [{
        thread_id: "child", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer",
        origin: "forked", parent_thread_id: "parent", fork_turn_id: "boundary", added_at: 1, last_seen_at: 2, hidden: 0,
      }]),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "child", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const summaries = await service.listSessions();

    expect(adapter.readSession).toHaveBeenCalledWith("child");
    expect(summaries[0]).toMatchObject({ threadId: "child", forkSourceTitle: "Parent", forkTurnNumber: 2 });
  });

  it("creates a before-first Fork as an empty child with inherited Session settings", async () => {
    const emptyThread = { id: "child", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => ({ thread: emptyThread })),
      clearGoal: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: "project-model", defaultReasoning: "medium", defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = { getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: "session-model", reasoning: "high", accessMode: "workspaceWrite" });

    const result = await service.fork("parent", null, false, "request-before-first", true);

    expect(adapter.startSession).toHaveBeenCalledWith("/tmp/project", { model: "session-model", reasoning: "high", accessMode: "workspaceWrite" });
    expect(result.thread.id).toBe("child");
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: "child",
      origin: "forked",
      parent_thread_id: "parent",
      fork_turn_id: null,
    }));
  });

  it("fails a default Fork when the inherited Goal cannot be cleared", async () => {
    const child = { id: "child", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: "parent", turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => ({ thread: child })),
      clearGoal: vi.fn(async () => { throw new Error("goal clear failed"); }),
      archiveSession: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = { getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" });

    await expect(service.fork("parent", null, false, "request-1", true)).rejects.toThrow("goal clear failed");
    expect(adapter.archiveSession).toHaveBeenCalledWith("child");
    expect(repositories.upsertProjectSession).not.toHaveBeenCalled();
  });

  it("re-reads disconnected Sessions after App Server reconnect", async () => {
    const snapshot = { id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("turn-1", "completed")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: "session-model", reasoning: "high", accessMode: "readOnly" } })),
      readSession: vi.fn(async () => snapshot),
    });
    const runtimes = {
      list: vi.fn(() => [{ threadId: "thread-1", state: "disconnected", activeFlags: [], pendingRequestIds: [] }]),
      listSideChats: vi.fn(() => []),
      getSideChat: vi.fn(() => undefined),
      reconcileFromSnapshot: vi.fn(),
    };
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: "project-model", defaultReasoning: "medium", defaultAccessMode: "fullAccess" })),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    const current = { model: "session-model", reasoning: "high", accessMode: "readOnly" as const };
    (service as unknown as { settings: Map<string, unknown> }).settings.set("thread-1", current);

    await service.reconcileAfterReconnect();

    expect(adapter.resumeSession).toHaveBeenCalledWith("thread-1", current);
    expect(adapter.readSession).toHaveBeenCalledWith("thread-1");
    expect(runtimes.reconcileFromSnapshot).toHaveBeenCalledWith("thread-1", snapshot.turns);
  });

  it("serializes a new Turn behind reconnect reconciliation for the same Session", async () => {
    const calls: string[] = [];
    let releaseResume!: () => void;
    const resumePending = new Promise<void>((resolve) => { releaseResume = resolve; });
    const snapshot = { id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("old-turn", "completed")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => { calls.push("resume"); await resumePending; return { thread: snapshot, settings: { model: "session-model", reasoning: "low", accessMode: "readOnly" as const } }; }),
      readSession: vi.fn(async () => { calls.push("read"); return snapshot; }),
      startTurn: vi.fn(async () => { calls.push("start"); return { turn: turn("new-turn", "inProgress") }; }),
    });
    let runtime = { threadId: "thread-1", state: "disconnected", activeFlags: [] as string[], pendingRequestIds: [] as string[], activeTurnId: undefined as string | undefined };
    const runtimes = {
      list: vi.fn(() => [runtime]),
      listSideChats: vi.fn(() => []),
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => runtime),
      reconcileFromSnapshot: vi.fn(() => { calls.push("reconcile"); runtime = { ...runtime, state: "idle" }; }),
      setActiveTurn: vi.fn((_threadId: string, turnId: string) => { runtime = { ...runtime, state: "running", activeTurnId: turnId }; }),
    };
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const reconciling = service.reconcileAfterReconnect();
    await vi.waitFor(() => expect(adapter.resumeSession).toHaveBeenCalledTimes(1));
    const starting = service.startTurn("thread-1", "new work", { clientUserMessageId: "message-1" }, "request-1");
    await Promise.resolve();
    expect(adapter.startTurn).not.toHaveBeenCalled();

    releaseResume();
    await reconciling;
    await starting;

    expect(calls).toEqual(["resume", "read", "reconcile", "start"]);
    expect(runtime).toMatchObject({ state: "running", activeTurnId: "new-turn" });
  });

  it("serializes an in-flight Session read before removing its Project", async () => {
    let releaseRead!: () => void;
    const readPending = new Promise<void>((resolve) => { releaseRead = resolve; });
    const snapshot = { id: "thread-1", preview: "test", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("turn-1", "completed")] };
    const mapping = { thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer", origin: "created" as const, parent_thread_id: null, fork_turn_id: null, added_at: 1, last_seen_at: 1, hidden: 0 };
    let mapped: typeof mapping | null = mapping;
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: "session-model", reasoning: "low", accessMode: "readOnly" as const } })),
      readSession: vi.fn(async () => { await readPending; return snapshot; }),
      getGoal: vi.fn(async () => null),
      unsubscribe: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => mapped),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      listProjectSessions: vi.fn(() => mapped ? [mapped] : []),
      deleteProject: vi.fn(() => { mapped = null; }),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: [] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []), getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      restoreThread: vi.fn(), removeThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const reading = service.readSession("thread-1");
    await vi.waitFor(() => expect(adapter.readSession).toHaveBeenCalledTimes(1));
    const removing = service.removeProject("project-1");
    await Promise.resolve();
    expect(repositories.deleteProject).not.toHaveBeenCalled();

    releaseRead();
    await expect(reading).resolves.toMatchObject({ thread: { id: "thread-1" }, settings: { accessMode: "readOnly" } });
    await removing;

    expect(repositories.deleteProject).toHaveBeenCalledWith("project-1");
    expect((service as unknown as { settings: Map<string, unknown> }).settings.has("thread-1")).toBe(false);
    expect((service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots.has("thread-1")).toBe(false);
  });

  it("rejects a Side Chat anchor unless it is a completed Turn", async () => {
    const snapshot = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("failed-turn", "failed")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async () => snapshot),
      getGoal: vi.fn(async () => null),
      createSideChat: vi.fn(),
    });
    const repositories = {
      markThreadViewed: vi.fn(),
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      markViewed: vi.fn(),
      get: vi.fn(() => ({ threadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => []),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.createSideChat("parent", "failed-turn")).rejects.toThrow(ForkBoundaryError);
    expect(adapter.createSideChat).not.toHaveBeenCalled();
  });

  it("removes idle ephemeral Side Chats after App Server reconnect", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {});
    const runtimes = {
      list: vi.fn(() => [sideChat]),
      listSideChats: vi.fn(() => [sideChat]),
      getSideChat: vi.fn((threadId: string) => threadId === "side-1" ? sideChat : undefined),
      removeSideChat: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await service.reconcileAfterReconnect();

    expect(runtimes.removeSideChat).toHaveBeenCalledWith("side-1");
  });

  it("waits for an interrupted Side Chat Turn before unsubscribing and clearing runtime state", async () => {
    const calls: string[] = [];
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      interruptTurn: vi.fn(async () => { calls.push("interrupt"); }),
      unsubscribe: vi.fn(async () => { calls.push("unsubscribe"); }),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      waitForTerminal: vi.fn(async () => { calls.push("terminal"); return true; }),
      removeSideChat: vi.fn(() => { calls.push("remove"); }),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await service.closeSideChat("side-1");

    expect(runtimes.waitForTerminal).toHaveBeenCalledWith("side-1", 10_000);
    expect(calls).toEqual(["interrupt", "terminal", "unsubscribe", "remove"]);
  });

  it("keeps Side Chat runtime registered when interrupt does not reach a terminal state", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      interruptTurn: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      waitForTerminal: vi.fn(async () => false),
      removeSideChat: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.closeSideChat("side-1")).rejects.toThrow("did not stop");

    expect(adapter.unsubscribe).not.toHaveBeenCalled();
    expect(runtimes.removeSideChat).not.toHaveBeenCalled();
  });

  it("serializes Side Chat creation per parent and returns the existing ephemeral Thread", async () => {
    const thread = { id: "side-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: true, forkedFromId: "parent", turns: [] };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread, settings: { model: "session-model", reasoning: "high", accessMode: "readOnly" } })),
      createSideChat: vi.fn(async () => { await gate; return { thread }; }),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    let registered: typeof thread extends never ? never : { threadId: string; parentThreadId: string; state: "idle"; activeFlags: string[]; pendingRequestIds: string[]; createdAt: number } | undefined;
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => registered ? [registered] : []),
      registerSideChat: vi.fn((runtime) => { registered = runtime; }),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const first = service.createSideChat("parent", null);
    const second = service.createSideChat("parent", null);
    await vi.waitFor(() => expect(adapter.createSideChat).toHaveBeenCalledTimes(1));
    release();

    const [left, right] = await Promise.all([first, second]);
    expect(left.threadId).toBe("side-1");
    expect(right.threadId).toBe("side-1");
    expect(adapter.createSideChat).toHaveBeenCalledTimes(1);
  });

  it("serializes Side Chat creation behind other parent Thread mutations", async () => {
    const child = { id: "side-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: true, forkedFromId: "parent", turns: [] };
    let releaseRename!: () => void;
    const renamePending = new Promise<void>((resolve) => { releaseRename = resolve; });
    const adapter = Object.assign(new EventEmitter(), {
      renameSession: vi.fn(() => renamePending),
      createSideChat: vi.fn(async () => ({ thread: child })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined), listSideChats: vi.fn(() => []), registerSideChat: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" });

    const rename = service.rename("parent", "renamed");
    await vi.waitFor(() => expect(adapter.renameSession).toHaveBeenCalled());
    const sideChat = service.createSideChat("parent", null);
    await Promise.resolve();
    expect(adapter.createSideChat).not.toHaveBeenCalled();

    releaseRename();
    await rename;
    await sideChat;
    expect(adapter.createSideChat).toHaveBeenCalledTimes(1);
  });

  it("inherits a cold parent's current settings when creating Side Chat", async () => {
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const child = { ...parent, id: "side-1", ephemeral: true, forkedFromId: "parent" };
    const protocolSettings = { model: "parent-model", reasoning: "low", accessMode: "readOnly" as const };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: parent, settings: protocolSettings })),
      createSideChat: vi.fn(async () => ({ thread: child })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: "project-model", defaultReasoning: "high", defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => []),
      registerSideChat: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.createSideChat("parent", null);

    expect(adapter.resumeSession).toHaveBeenCalledWith("parent");
    expect(adapter.createSideChat).toHaveBeenCalledWith("parent", null, protocolSettings, "/tmp/project");
  });

  it("updates cached Session settings from thread/settings/updated", async () => {
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const child = { ...parent, id: "side-1", ephemeral: true, forkedFromId: "parent" };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: parent, settings: { model: "old", reasoning: "medium", accessMode: "fullAccess" } })),
      readSession: vi.fn(async () => parent),
      getGoal: vi.fn(async () => null),
      createSideChat: vi.fn(async () => ({ thread: child })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => []),
      registerSideChat: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    await service.readSession("parent");
    service.handleEvent(projectAdapterEvent({ method: "thread/settings/updated", params: { threadId: "parent", threadSettings: {
      model: "new-model", effort: "low", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false },
    } } })!);

    await service.createSideChat("parent", null);

    expect(adapter.createSideChat).toHaveBeenCalledWith("parent", null, { model: "new-model", reasoning: "low", accessMode: "readOnly" }, "/tmp/project");
  });

  it("enforces Side Chat capability restrictions in the service layer", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      renameSession: vi.fn(), archiveSession: vi.fn(), forkSession: vi.fn(), getGoal: vi.fn(), setGoal: vi.fn(), clearGoal: vi.fn(),
    });
    const runtimes = { getSideChat: vi.fn((id: string) => id === "side-1" ? sideChat : undefined) };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.rename("side-1", "nope")).rejects.toThrow("does not support rename");
    await expect(service.archive("side-1")).rejects.toThrow("does not support archive");
    await expect(service.fork("side-1", null, false, "request-1", true)).rejects.toThrow("does not support Fork");
    expect(() => service.getGoal("side-1")).toThrow("does not support Goal");
    await expect(service.setGoal({ threadId: "side-1", objective: "nope" })).rejects.toThrow("does not support Goal");
    await expect(service.clearGoal("side-1")).rejects.toThrow("does not support Goal");
    await expect(service.createSideChat("side-1", null)).rejects.toThrow("does not support nested Side Chat");
    expect(adapter.renameSession).not.toHaveBeenCalled();
    expect(adapter.forkSession).not.toHaveBeenCalled();
    expect(adapter.setGoal).not.toHaveBeenCalled();
  });

  it("archives an unmaterialized empty Session by removing only its local mapping", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      archiveSession: vi.fn(async () => { throw new JsonRpcError("no rollout found for thread id empty-1", -32600); }),
      unsubscribe: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "empty-1", project_id: "project-1" })),
      removeProjectSession: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []),
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "empty-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      removeThread: vi.fn(),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.archive("empty-1");

    expect(adapter.unsubscribe).toHaveBeenCalledWith("empty-1");
    expect(repositories.removeProjectSession).toHaveBeenCalledWith("empty-1");
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("empty-1", "archived-unmaterialized");
  });

  it("does not reintroduce a successfully archived materialized Session from cache", async () => {
    const mappings = [{
      thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project",
      source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null,
    }];
    const snapshot = { id: "thread-1", preview: "cached", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      archiveSession: vi.fn(async () => undefined),
      listSessions: vi.fn(async () => ({ data: [], nextCursor: null })),
    });
    const repositories = {
      listProjectSessions: vi.fn(() => mappings),
      getProjectSession: vi.fn((threadId: string) => mappings.find((mapping) => mapping.thread_id === threadId)),
      removeProjectSession: vi.fn((threadId: string) => {
        const index = mappings.findIndex((mapping) => mapping.thread_id === threadId);
        if (index >= 0) mappings.splice(index, 1);
      }),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []),
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      removeThread: vi.fn(),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots.set("thread-1", snapshot);

    await service.archive("thread-1");

    await expect(service.listSessions({})).resolves.toEqual([]);
    expect(repositories.removeProjectSession).toHaveBeenCalledWith("thread-1");
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("thread-1", "archived");
  });

  it("rejects parent Session archival while its Side Chat Turn is active", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), { archiveSession: vi.fn(), unsubscribe: vi.fn() });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1" })),
      removeProjectSession: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => [sideChat]),
      getSideChat: vi.fn((threadId: string) => threadId === sideChat.threadId ? sideChat : undefined),
      get: vi.fn((threadId: string) => threadId === sideChat.threadId ? sideChat : { threadId, state: "idle", activeFlags: [], pendingRequestIds: [] }),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.archive("parent")).rejects.toThrow(ActiveTurnConflictError);

    expect(adapter.unsubscribe).not.toHaveBeenCalled();
    expect(adapter.archiveSession).not.toHaveBeenCalled();
    expect(repositories.removeProjectSession).not.toHaveBeenCalled();
  });

  it("closes an idle Side Chat before archiving its parent Session", async () => {
    const calls: string[] = [];
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      unsubscribe: vi.fn(async () => { calls.push("unsubscribe-side"); }),
      archiveSession: vi.fn(async () => { calls.push("archive-parent"); }),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1" })),
      removeProjectSession: vi.fn(() => { calls.push("remove-parent-mapping"); }),
    };
    const runtimes = {
      listSideChats: vi.fn(() => [sideChat]),
      getSideChat: vi.fn((threadId: string) => threadId === sideChat.threadId ? sideChat : undefined),
      get: vi.fn((threadId: string) => threadId === sideChat.threadId ? sideChat : { threadId, state: "idle", activeFlags: [], pendingRequestIds: [] }),
      removeSideChat: vi.fn(() => { calls.push("remove-side-runtime"); }),
      removeThread: vi.fn(),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.archive("parent");

    expect(calls).toEqual(["unsubscribe-side", "remove-side-runtime", "archive-parent", "remove-parent-mapping"]);
  });

  it("rejects non-whitelisted mutations while a Turn is active", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      renameSession: vi.fn(), archiveSession: vi.fn(), setGoal: vi.fn(), clearGoal: vi.fn(),
    });
    const repositories = { getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1" })), getProject: vi.fn(() => ({ id: "project-2" })), moveProjectSession: vi.fn() };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [] })),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.rename("thread-1", "new name")).rejects.toThrow(ActiveTurnConflictError);
    await expect(service.archive("thread-1")).rejects.toThrow(ActiveTurnConflictError);
    await expect(service.moveToProject("thread-1", "project-2")).rejects.toThrow(ActiveTurnConflictError);
    await expect(service.setGoal({ threadId: "thread-1", status: "paused" })).rejects.toThrow(ActiveTurnConflictError);
    await expect(service.clearGoal("thread-1")).rejects.toThrow(ActiveTurnConflictError);
    expect(adapter.renameSession).not.toHaveBeenCalled();
    expect(adapter.archiveSession).not.toHaveBeenCalled();
    expect(repositories.moveProjectSession).not.toHaveBeenCalled();
    expect(adapter.setGoal).not.toHaveBeenCalled();
    expect(adapter.clearGoal).not.toHaveBeenCalled();
  });

  it("rejects Project removal while a mapped Session is active", async () => {
    const repositories = {
      listProjectSessions: vi.fn(() => [{ thread_id: "thread-1", project_id: "project-1" }]),
      deleteProject: vi.fn(), getPreferences: vi.fn(), setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []), getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [] })),
    };
    const service = new SessionService(repositories as never, {} as never, {} as never, runtimes as never);

    await expect(service.removeProject("project-1")).rejects.toThrow(ActiveTurnConflictError);
    expect(repositories.deleteProject).not.toHaveBeenCalled();
  });

  it("clears stale Project and Thread preferences when removing an idle Project", async () => {
    const repositories = {
      listProjectSessions: vi.fn(() => [{ thread_id: "thread-1", project_id: "project-1" }]),
      deleteProject: vi.fn(),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: "project-1", lastThreadId: "thread-1", fullAccessNoticeSeenProjects: ["project-1", "project-2"] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []), getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      removeThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, {} as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("thread-1", { model: "stale", reasoning: "high", accessMode: "fullAccess" });
    (service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots.set("thread-1", { id: "thread-1" });

    await service.removeProject("project-1");

    expect(repositories.deleteProject).toHaveBeenCalledWith("project-1");
    expect(repositories.setPreferences).toHaveBeenCalledWith({ lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: ["project-2"] });
    expect((service as unknown as { settings: Map<string, unknown> }).settings.has("thread-1")).toBe(false);
    expect((service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots.has("thread-1")).toBe(false);
    expect(runtimes.removeThread).toHaveBeenCalledWith("thread-1");
  });

  it("does not resurrect removed Session caches from delayed background loads or events", async () => {
    let resolveGoal!: (goal: { objective: string } | null) => void;
    let resolveSnapshot!: (snapshot: { id: string; turns: Thread["turns"] }) => void;
    const goalPending = new Promise<{ objective: string } | null>((resolve) => { resolveGoal = resolve; });
    const snapshotPending = new Promise<{ id: string; turns: Thread["turns"] }>((resolve) => { resolveSnapshot = resolve; });
    const mapping = { thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer", origin: "forked" as const, parent_thread_id: "parent", fork_turn_id: "turn-1", added_at: 1, last_seen_at: 1, hidden: 0 };
    const adapter = Object.assign(new EventEmitter(), {
      getGoal: vi.fn(() => goalPending),
      readSession: vi.fn(() => snapshotPending),
      unsubscribe: vi.fn(async () => undefined),
    });
    const repositories = {
      listProjectSessions: vi.fn(() => [mapping]),
      deleteProject: vi.fn(),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: [] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []), getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      removeThread: vi.fn(), notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    const loadingGoal = (service as unknown as { ensureGoalPresence(ids: string[]): Promise<void> }).ensureGoalPresence(["thread-1"]);
    const loadingSnapshot = (service as unknown as { ensureForkSnapshots(rows: unknown[]): Promise<void> }).ensureForkSnapshots([mapping]);
    await vi.waitFor(() => {
      expect(adapter.getGoal).toHaveBeenCalledTimes(1);
      expect(adapter.readSession).toHaveBeenCalledTimes(1);
    });

    await service.removeProject("project-1");
    resolveGoal({ objective: "late goal" });
    resolveSnapshot({ id: "thread-1", turns: [turn("turn-1", "completed")] });
    await Promise.all([loadingGoal, loadingSnapshot]);
    service.handleEvent(projectAdapterEvent({ method: "thread/settings/updated", params: { threadId: "thread-1", threadSettings: {
      model: "late-model", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" },
    } } })!);

    expect((service as unknown as { goalPresence: Map<string, boolean> }).goalPresence.has("thread-1")).toBe(false);
    expect((service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots.has("thread-1")).toBe(false);
    expect((service as unknown as { settings: Map<string, unknown> }).settings.has("thread-1")).toBe(false);
    expect(runtimes.notifySessionSummaryUpdated).not.toHaveBeenCalled();
  });

  it("serializes Session creation before removing the same Project", async () => {
    let releaseCreation!: () => void;
    const creationPending = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const calls: string[] = [];
    const mappings: Array<{ thread_id: string; project_id: string; cwd_snapshot: string }> = [];
    const thread = { id: "created-thread", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => { calls.push("start-session"); await creationPending; return { thread }; }),
      archiveSession: vi.fn(),
    });
    const project = { id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" };
    const repositories = {
      getProject: vi.fn(() => project),
      upsertProjectSession: vi.fn((mapping: typeof mappings[number]) => { calls.push("insert-mapping"); mappings.push(mapping); }),
      listProjectSessions: vi.fn(() => [...mappings]),
      deleteProject: vi.fn(() => { calls.push("delete-project"); }),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: [] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []),
      getSideChat: vi.fn(() => undefined),
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      removeThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const creating = service.createSession("project-1", {}, "create-request");
    await vi.waitFor(() => expect(adapter.startSession).toHaveBeenCalledTimes(1));
    const removing = service.removeProject("project-1");
    await Promise.resolve();
    expect(repositories.deleteProject).not.toHaveBeenCalled();

    releaseCreation();
    await creating;
    await removing;

    expect(calls).toEqual(["start-session", "insert-mapping", "delete-project"]);
    expect(adapter.archiveSession).not.toHaveBeenCalled();
  });

  it("closes an idle Side Chat before removing its Project", async () => {
    const calls: string[] = [];
    const sideChat = { threadId: "side-1", parentThreadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), { unsubscribe: vi.fn(async (threadId: string) => { calls.push(`unsubscribe-${threadId}`); }) });
    const repositories = {
      listProjectSessions: vi.fn(() => [{ thread_id: "thread-1", project_id: "project-1" }]),
      deleteProject: vi.fn(() => { calls.push("delete-project"); }),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: [] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => [sideChat]),
      getSideChat: vi.fn((threadId: string) => threadId === sideChat.threadId ? sideChat : undefined),
      get: vi.fn((threadId: string) => threadId === sideChat.threadId ? sideChat : { threadId, state: "idle", activeFlags: [], pendingRequestIds: [] }),
      removeSideChat: vi.fn(() => { calls.push("remove-side-runtime"); }),
      removeThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.removeProject("project-1");

    expect(calls).toEqual(["unsubscribe-side-1", "remove-side-runtime", "unsubscribe-thread-1", "delete-project"]);
  });

  it("waits for concurrent Side Chat creation and closes the new chat before removing its Project", async () => {
    const child = { id: "side-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: true, forkedFromId: "thread-1", turns: [] };
    let releaseCreation!: () => void;
    const creationPending = new Promise<void>((resolve) => { releaseCreation = resolve; });
    const sideChats: Array<{ threadId: string; parentThreadId: string; state: "idle"; activeFlags: string[]; pendingRequestIds: string[]; createdAt: number }> = [];
    const adapter = Object.assign(new EventEmitter(), {
      createSideChat: vi.fn(async () => { await creationPending; return { thread: child }; }),
      unsubscribe: vi.fn(async () => undefined),
    });
    const repositories = {
      listProjectSessions: vi.fn(() => [{ thread_id: "thread-1", project_id: "project-1" }]),
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      deleteProject: vi.fn(),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: [] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => [...sideChats]),
      getSideChat: vi.fn((threadId: string) => sideChats.find((sideChat) => sideChat.threadId === threadId)),
      get: vi.fn((threadId: string) => sideChats.find((sideChat) => sideChat.threadId === threadId) ?? { threadId, state: "idle", activeFlags: [], pendingRequestIds: [] }),
      registerSideChat: vi.fn((sideChat: typeof sideChats[number]) => { sideChats.push(sideChat); }),
      removeSideChat: vi.fn((threadId: string) => { sideChats.splice(sideChats.findIndex((sideChat) => sideChat.threadId === threadId), 1); }),
      removeThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("thread-1", { model: null, reasoning: null, accessMode: "fullAccess" });

    const creating = service.createSideChat("thread-1", null);
    await vi.waitFor(() => expect(adapter.createSideChat).toHaveBeenCalled());
    const removing = service.removeProject("project-1");
    await Promise.resolve();
    expect(repositories.deleteProject).not.toHaveBeenCalled();

    releaseCreation();
    await creating;
    await removing;

    expect(adapter.unsubscribe).toHaveBeenCalledWith("side-1");
    expect(runtimes.removeSideChat).toHaveBeenCalledWith("side-1");
    expect(repositories.deleteProject).toHaveBeenCalledWith("project-1");
  });

  it("serializes a cross-tab Turn start behind an in-flight Session mutation", async () => {
    let releaseRename!: () => void;
    const renamePending = new Promise<void>((resolve) => { releaseRename = resolve; });
    const adapter = Object.assign(new EventEmitter(), {
      renameSession: vi.fn(() => renamePending),
      startTurn: vi.fn(async () => ({ turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1, completedAt: null, durationMs: null } })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      setActiveTurn: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("thread-1", { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" });

    const rename = service.rename("thread-1", "renamed");
    await vi.waitFor(() => expect(adapter.renameSession).toHaveBeenCalled());
    const start = service.startTurn("thread-1", "hello", { clientUserMessageId: "message-1" }, "request-1");
    await Promise.resolve();
    expect(adapter.startTurn).not.toHaveBeenCalled();

    releaseRename();
    await rename;
    await start;
    expect(adapter.startTurn).toHaveBeenCalledTimes(1);
  });

  it("rejects persistent mutations queued behind Project removal", async () => {
    const mapping = { thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" };
    let mapped: typeof mapping | null = mapping;
    let releaseUnsubscribe!: () => void;
    const unsubscribePending = new Promise<void>((resolve) => { releaseUnsubscribe = resolve; });
    const adapter = Object.assign(new EventEmitter(), {
      unsubscribe: vi.fn(() => unsubscribePending),
      renameSession: vi.fn(), archiveSession: vi.fn(), getGoal: vi.fn(), setGoal: vi.fn(), clearGoal: vi.fn(),
    });
    const repositories = {
      listProjectSessions: vi.fn(() => mapped ? [mapped] : []),
      getProjectSession: vi.fn(() => mapped),
      deleteProject: vi.fn(() => { mapped = null; }),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: [] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []), getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      markViewed: vi.fn(), removeThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const removing = service.removeProject("project-1");
    await vi.waitFor(() => expect(adapter.unsubscribe).toHaveBeenCalledWith("thread-1"));
    const rejected = [
      expect(service.rename("thread-1", "stale rename")).rejects.toThrow("not mapped"),
      expect(service.archive("thread-1")).rejects.toThrow("not mapped"),
      expect(service.getGoal("thread-1")).rejects.toThrow("not mapped"),
      expect(service.setGoal({ threadId: "thread-1", status: "paused" })).rejects.toThrow("not mapped"),
      expect(service.clearGoal("thread-1")).rejects.toThrow("not mapped"),
      expect(service.markViewed("thread-1")).rejects.toThrow("not mapped"),
    ];
    releaseUnsubscribe();
    await removing;
    await Promise.all(rejected);

    expect(adapter.renameSession).not.toHaveBeenCalled();
    expect(adapter.archiveSession).not.toHaveBeenCalled();
    expect(adapter.getGoal).not.toHaveBeenCalled();
    expect(adapter.setGoal).not.toHaveBeenCalled();
    expect(adapter.clearGoal).not.toHaveBeenCalled();
    expect(runtimes.markViewed).not.toHaveBeenCalled();
  });

  it("does not start later background-load batches after their Sessions are removed", async () => {
    const mappings = Array.from({ length: 9 }, (_, index) => ({
      thread_id: `thread-${index}`, project_id: "project-1", cwd_snapshot: "/tmp/project", source_kind: "appServer",
      origin: "forked" as const, parent_thread_id: "parent", fork_turn_id: "turn-1", added_at: 1, last_seen_at: 1, hidden: 0,
    }));
    let releaseGoals!: () => void;
    let releaseReads!: () => void;
    const goalsPending = new Promise<void>((resolve) => { releaseGoals = resolve; });
    const readsPending = new Promise<void>((resolve) => { releaseReads = resolve; });
    const adapter = Object.assign(new EventEmitter(), {
      getGoal: vi.fn(async () => { await goalsPending; return { objective: "late" }; }),
      readSession: vi.fn(async (threadId: string) => { await readsPending; return { id: threadId, turns: [turn("turn-1", "completed")] }; }),
      unsubscribe: vi.fn(async () => undefined),
    });
    const repositories = {
      listProjectSessions: vi.fn(() => mappings), deleteProject: vi.fn(),
      getPreferences: vi.fn(() => ({ sidebarMode: "recent", sortDirection: "desc", sideChatWidth: 42, lastProjectId: null, lastThreadId: null, fullAccessNoticeSeenProjects: [] })),
      setPreferences: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []), getSideChat: vi.fn(() => undefined),
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      removeThread: vi.fn(), notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    const goals = (service as unknown as { ensureGoalPresence(ids: string[]): Promise<void> }).ensureGoalPresence(mappings.map((mapping) => mapping.thread_id));
    const reads = (service as unknown as { ensureForkSnapshots(rows: unknown[]): Promise<void> }).ensureForkSnapshots(mappings);
    await vi.waitFor(() => {
      expect(adapter.getGoal).toHaveBeenCalledTimes(8);
      expect(adapter.readSession).toHaveBeenCalledTimes(8);
    });

    await service.removeProject("project-1");
    releaseGoals();
    releaseReads();
    await Promise.all([goals, reads]);

    expect(adapter.getGoal).toHaveBeenCalledTimes(8);
    expect(adapter.readSession).toHaveBeenCalledTimes(8);
    expect((service as unknown as { goalPresence: Map<string, boolean> }).goalPresence.size).toBe(0);
    expect((service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots.size).toBe(0);
  });

  it("reconciles a disconnected Session after a later normal read succeeds", async () => {
    const snapshot = { id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("turn-1", "completed")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: null, reasoning: null, accessMode: "readOnly" as const } })),
      readSession: vi.fn().mockRejectedValueOnce(new Error("temporary read failure")).mockResolvedValueOnce(snapshot),
      getGoal: vi.fn(async () => null),
    });
    const runtimes = {
      list: vi.fn(() => [{ threadId: "thread-1", state: "disconnected", activeFlags: [], pendingRequestIds: [] }]),
      listSideChats: vi.fn(() => []), getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "disconnected", activeFlags: [], pendingRequestIds: [] })),
      reconcileFromSnapshot: vi.fn(),
    };
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.reconcileAfterReconnect();
    expect(runtimes.reconcileFromSnapshot).not.toHaveBeenCalled();
    await service.readSession("thread-1");

    expect(runtimes.reconcileFromSnapshot).toHaveBeenCalledWith("thread-1", snapshot.turns);
  });
});

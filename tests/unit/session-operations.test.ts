import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Thread } from "@codex-web/codex-schema/v2/Thread";
import { JsonRpcError, JsonRpcMutationResponseTimeoutError, OperationUncertainError, pendingRequestResponse, projectAdapterEvent, projectPendingRequest } from "@codex-web/codex-adapter";
import { ActiveTurnConflictError, ActiveTurnIdentityError, assertValidForkBoundary, DEFERRED_CHILD_RECOVERY_DELAY_MS, ForkBoundaryError, isSteerTurnConflictError, isUnmaterializedSessionReadError, ProjectUnavailableError, ReconciliationPendingError, recoveryThreadSource, resolveSessionSettings, restoreSnapshotSkillReferences, SessionDisconnectedError, SessionService, SideChatCloseTimeoutError, SIDE_CHAT_ACTIVE_TURN_ID_WAIT_MS, SIDE_CHAT_TERMINAL_WAIT_MS, UNCERTAIN_CHILD_BACKGROUND_TTL_MS, UncertainTurnAppliedError, UnknownSkillError } from "../../apps/server/src/session-service.js";

function turn(id: string, status: Thread["turns"][number]["status"]): Thread["turns"][number] {
  return { id, status, itemsView: "full", error: null, startedAt: 1, completedAt: status === "inProgress" ? null : 2, durationMs: status === "inProgress" ? null : 1_000, items: [] };
}

describe("session operation rules", () => {
  it("restores Skill labels by client message ID without exposing paths or duplicating live Skill parts", () => {
    const snapshot = {
      id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null,
      turns: [{ ...turn("turn-1", "completed"), items: [{
        type: "userMessage" as const,
        id: "message-item",
        clientId: "message-1",
        content: [{ type: "skill", name: "caveman" }, { type: "text", text: "hello" }],
      }] }],
    };

    const restored = restoreSnapshotSkillReferences(snapshot, new Map([
      ["message-1", ["caveman", "Academic Figure Prompt"]],
    ]));

    expect(restored.turns[0]?.items[0]).toEqual(expect.objectContaining({ content: [
      { type: "skill", name: "caveman" },
      { type: "skill", name: "Academic Figure Prompt" },
      { type: "text", text: "hello" },
    ] }));
    expect(JSON.stringify(restored)).not.toContain("SKILL.md");
  });

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
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    const input = { clientUserMessageId: "message-same", model: null, reasoning: null, accessMode: "fullAccess" as const };

    const first = service.startTurn("thread-1", "hello", input, "request-000001");
    const retry = service.startTurn("thread-1", "hello", input, "request-000002");

    await expect(Promise.all([first, retry])).resolves.toHaveLength(2);
    expect(adapter.startTurn).toHaveBeenCalledTimes(1);
    expect(runtimes.setActiveTurn).toHaveBeenCalledTimes(1);
  });

  it("resolves, deduplicates, and sends enabled Skills as structured Turn input", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ settings: { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" as const } })),
      listSkills: vi.fn(async () => [{ name: "design-taste-frontend", description: "Design", path: "/skills/design/SKILL.md", scope: "user" as const }]),
      startTurn: vi.fn(async () => ({ turn: turn("turn-skill", "inProgress") })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: "gpt-test", defaultReasoning: "high", defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      setActiveTurn: vi.fn(), getSideChat: vi.fn(() => undefined), notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.startTurn("thread-1", "$design-taste-frontend redesign this", {
      clientUserMessageId: "message-skill", skillNames: ["design-taste-frontend", "design-taste-frontend"],
    }, "request-skill");

    expect(adapter.listSkills).toHaveBeenCalledWith("/tmp/project");
    expect(adapter.startTurn).toHaveBeenCalledWith(
      "thread-1", "/tmp/project", "redesign this",
      { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" }, "message-skill",
      [{ name: "design-taste-frontend", path: "/skills/design/SKILL.md" }],
    );
  });

  it("rejects unknown or disabled Skills before starting a Turn", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      listSkills: vi.fn(async () => []), startTurn: vi.fn(),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = { get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })), getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.startTurn("thread-1", "$missing do it", { clientUserMessageId: "message-missing", skillNames: ["missing"] }, "request-missing"))
      .rejects.toThrow(UnknownSkillError);
    expect(adapter.startTurn).not.toHaveBeenCalled();
  });

  it("sends structured Skills when steering an active Turn", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      listSkills: vi.fn(async () => [{ name: "review", description: "Review", path: "/skills/review/SKILL.md", scope: "repo" as const }]),
      steerTurn: vi.fn(async () => ({ turnId: "active-turn" })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = { get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeTurnId: "active-turn", activeFlags: [], pendingRequestIds: [] })), getSideChat: vi.fn(() => undefined) };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.steer("thread-1", "$review check this", "active-turn", "message-steer", "request-steer", ["review"]);
    expect(adapter.steerTurn).toHaveBeenCalledWith("thread-1", "active-turn", "check this", "message-steer", [{ name: "review", path: "/skills/review/SKILL.md" }]);
  });

  it("starts compact and inline review only while the Session is idle", async () => {
    const reviewTurn = turn("review-turn", "inProgress");
    const adapter = Object.assign(new EventEmitter(), {
      compactThread: vi.fn(async () => undefined),
      startReview: vi.fn(async () => ({ reviewThreadId: "thread-1", turn: reviewTurn })),
    });
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined), setActiveTurn: vi.fn(), notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await service.compact("thread-1");
    await service.startReview("thread-1", { type: "uncommittedChanges" });

    expect(adapter.compactThread).toHaveBeenCalledWith("thread-1");
    expect(adapter.startReview).toHaveBeenCalledWith("thread-1", { type: "uncommittedChanges" });
    expect(runtimes.setActiveTurn).toHaveBeenCalledWith("thread-1", "review-turn");
  });

  it("does not start a second Turn when active status arrived without a Turn ID", async () => {
    const adapter = Object.assign(new EventEmitter(), { startTurn: vi.fn() });
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.startTurn("thread-1", "duplicate", { clientUserMessageId: "message-1" }, "request-1"))
      .rejects.toThrow(ActiveTurnConflictError);
    expect(adapter.startTurn).not.toHaveBeenCalled();
  });

  it("recovers a missing active Turn ID from the Session snapshot before Interrupt", async () => {
    const snapshot = { id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("active-turn", "inProgress")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async () => snapshot),
      getGoal: vi.fn(async () => null),
      interruptTurn: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      setActiveTurn: vi.fn(),
      restoreThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.interrupt("thread-1");

    expect(runtimes.setActiveTurn).toHaveBeenCalledWith("thread-1", "active-turn");
    expect(adapter.interruptTurn).toHaveBeenCalledWith("thread-1", "active-turn");
  });

  it("waits for turn/started before Interrupt when active status beats Session materialization", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      readSession: vi.fn(async () => { throw new JsonRpcError("no rollout found for thread id redacted", -32600); }),
      interruptTurn: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      waitForActiveTurnId: vi.fn(async () => "turn-late"),
      setActiveTurn: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.interrupt("thread-1");

    expect(runtimes.waitForActiveTurnId).toHaveBeenCalledWith("thread-1", SIDE_CHAT_ACTIVE_TURN_ID_WAIT_MS);
    expect(adapter.interruptTurn).toHaveBeenCalledWith("thread-1", "turn-late");
  });

  it("treats natural Turn completion during Interrupt identity recovery as success", async () => {
    let runtimeState: "running" | "justFinished" = "running";
    const adapter = Object.assign(new EventEmitter(), {
      readSession: vi.fn(async () => { throw new JsonRpcError("no rollout found for thread id redacted", -32600); }),
      interruptTurn: vi.fn(),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: runtimeState, activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      waitForActiveTurnId: vi.fn(async () => {
        runtimeState = "justFinished";
        return undefined;
      }),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.interrupt("thread-1")).resolves.toBeUndefined();

    expect(runtimes.waitForActiveTurnId).toHaveBeenCalledWith("thread-1", SIDE_CHAT_ACTIVE_TURN_ID_WAIT_MS);
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
  });

  it("still rejects Interrupt when identity recovery times out while the Turn remains active", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      readSession: vi.fn(async () => { throw new JsonRpcError("no rollout found for thread id redacted", -32600); }),
      interruptTurn: vi.fn(),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      waitForActiveTurnId: vi.fn(async () => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.interrupt("thread-1")).rejects.toBeInstanceOf(ActiveTurnIdentityError);

    expect(adapter.interruptTurn).not.toHaveBeenCalled();
  });

  it("rejects Session creation before calling Codex when the Project directory is unavailable", async () => {
    const adapter = Object.assign(new EventEmitter(), { startSession: vi.fn() });
    const repositories = {
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/missing/project", available: false, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, {} as never);

    await expect(service.createSession("project-1", {}, "request-1")).rejects.toThrow(ProjectUnavailableError);
    expect(adapter.startSession).not.toHaveBeenCalled();
  });

  it("rejects a new Turn before calling Codex when the mapped Project directory is unavailable", async () => {
    const adapter = Object.assign(new EventEmitter(), { startTurn: vi.fn() });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/missing/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/missing/project", available: false, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.startTurn("thread-1", "hello", { clientUserMessageId: "message-1" }, "request-1")).rejects.toThrow(ProjectUnavailableError);
    expect(adapter.startTurn).not.toHaveBeenCalled();
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
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const created = await service.createSession("project-1", {}, "shared-request-id");
    const started = await service.startTurn("thread-1", "hello", { clientUserMessageId: "message-1" }, "shared-request-id");

    expect(created.thread.id).toBe("thread-1");
    expect(started.turn.id).toBe("turn-1");
    expect(adapter.startSession).toHaveBeenCalledTimes(1);
    expect(adapter.startTurn).toHaveBeenCalledTimes(1);
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("thread-1", "session-created");
  });

  it("scopes recovery sources by Project or parent Session when a request ID is reused", () => {
    const requestId = "shared-request-id";

    expect(recoveryThreadSource("session", "project-1", requestId)).not.toBe(
      recoveryThreadSource("session", "project-2", requestId),
    );
    expect(recoveryThreadSource("fork", "thread-1", requestId)).not.toBe(
      recoveryThreadSource("fork", "thread-2", requestId),
    );
  });

  it("recovers an exactly observed Session after an uncertain create response", async () => {
    const thread = { id: "created-thread", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => { throw new OperationUncertainError("thread/start"); }),
      listSessions: vi.fn(async () => ({
        data: [{ id: thread.id, preview: "", name: null, cwd: thread.cwd, sourceKind: "appServer", createdAt: 1, updatedAt: 1, forkedFromId: null, threadSource: "codex-web-session:project-1:create-request" }],
        nextCursor: null,
      })),
    });
    const repositories = {
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      notifySessionSummaryUpdated: vi.fn(),
      restoreThread: vi.fn(),
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.createSession("project-1", {}, "create-request")).rejects.toBeInstanceOf(OperationUncertainError);
    service.handleEvent({
      type: "threadStarted",
      threadId: thread.id,
      threadSource: "codex-web-session:project-1:create-request",
      thread,
    });
    await service.reconcileAfterReconnect();

    expect(adapter.startSession).toHaveBeenCalledWith(
      "/tmp/project",
      { model: null, reasoning: "high", accessMode: "fullAccess" },
      false,
      "codex-web-session:project-1:create-request",
    );
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: thread.id,
      project_id: "project-1",
      origin: "created",
      parent_thread_id: null,
      fork_turn_id: null,
    }));
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith(thread.id, "session-created");
  });

  it("recovers a created Session from its request-specific source when the start notification was lost", async () => {
    const threadSource = "codex-web-session:project-1:create-without-notification";
    const thread = { id: "created-without-notification", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const listed = { id: thread.id, preview: "", name: null, cwd: thread.cwd, sourceKind: "appServer", createdAt: 1, updatedAt: 1, forkedFromId: null, threadSource };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => { throw new OperationUncertainError("thread/start"); }),
      listSessions: vi.fn(async () => ({ data: [listed], nextCursor: null })),
    });
    const repositories = {
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      notifySessionSummaryUpdated: vi.fn(),
      restoreThread: vi.fn(),
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
    };
    const indexer = {
      markThreadSourcePending: vi.fn(),
      restoreThreadSourceDiscovery: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);

    await expect(service.createSession("project-1", {}, "create-without-notification")).rejects.toBeInstanceOf(OperationUncertainError);
    await service.reconcileAfterReconnect();

    expect(indexer.markThreadSourcePending).toHaveBeenCalledWith(threadSource);
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: thread.id,
      project_id: "project-1",
      origin: "created",
      parent_thread_id: null,
      fork_turn_id: null,
    }));
    expect(indexer.restoreThreadSourceDiscovery).toHaveBeenCalledWith(threadSource);
  });

  it("retains an exact created Session when mapping finalization and rollback both lose the App Server", async () => {
    const thread = { id: "created-finalization-uncertain", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => ({ thread })),
      archiveSession: vi.fn(async () => { throw new Error("connection lost"); }),
      listSessions: vi.fn(async () => ({
        data: [{ id: thread.id, preview: "", name: null, cwd: thread.cwd, sourceKind: "appServer", createdAt: 1, updatedAt: 1, forkedFromId: null, threadSource: null }],
        nextCursor: null,
      })),
    });
    const repositories = {
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn().mockImplementationOnce(() => { throw new Error("mapping write failed"); }).mockImplementation(() => undefined),
      removeProjectSession: vi.fn(),
    };
    const runtimes = {
      notifySessionSummaryUpdated: vi.fn(),
      removeThread: vi.fn(),
      restoreThread: vi.fn(),
    };
    const indexer = {
      markSessionArchived: vi.fn(),
      restoreSessionDiscovery: vi.fn(),
      scanAllInBackground: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);

    await expect(service.createSession("project-1", {}, "create-finalization-uncertain")).rejects.toBeInstanceOf(OperationUncertainError);

    expect(indexer.markSessionArchived).toHaveBeenCalledWith(thread.id);
    expect(indexer.scanAllInBackground).toHaveBeenCalled();
    expect((service as unknown as { uncertainSessions: Map<string, unknown> }).uncertainSessions.size).toBe(1);
    expect((service as unknown as { observedSessions: Map<string, unknown> }).observedSessions.size).toBe(1);

    await service.recoverDeferredChildren();

    expect(repositories.upsertProjectSession).toHaveBeenLastCalledWith(expect.objectContaining({
      thread_id: thread.id,
      project_id: "project-1",
      origin: "created",
    }));
    expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith(thread.id);
  });

  it("keeps an exactly observed empty Session recoverable until its bounded background TTL expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
      const thread = { id: "vanished-created-thread", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
      const adapter = Object.assign(new EventEmitter(), {
        startSession: vi.fn(async () => { throw new OperationUncertainError("thread/start"); }),
        listSessions: vi.fn(async () => ({ data: [], nextCursor: null })),
      });
      const repositories = {
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
        upsertProjectSession: vi.fn(),
      };
      const runtimes = {
        notifySessionSummaryUpdated: vi.fn(),
        restoreThread: vi.fn(),
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => []),
      };
      const indexer = {
        markSessionArchived: vi.fn(),
        restoreSessionDiscovery: vi.fn(),
        restoreThreadSourceDiscovery: vi.fn(),
      };
      const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);

      await expect(service.createSession("project-1", {}, "vanished-create-request")).rejects.toBeInstanceOf(OperationUncertainError);
      service.handleEvent({
        type: "threadStarted",
        threadId: thread.id,
        threadSource: "codex-web-session:project-1:vanished-create-request",
        thread,
      });
      const startedAt = Date.now();

      const initialRecovery = service.reconcileAfterReconnect();
      const initialResult = expect(initialRecovery).rejects.toBeInstanceOf(ReconciliationPendingError);
      await vi.advanceTimersByTimeAsync(300);
      await initialResult;
      expect((service as unknown as { uncertainSessions: Map<string, unknown> }).uncertainSessions.size).toBe(1);
      expect(indexer.restoreThreadSourceDiscovery).not.toHaveBeenCalled();

      vi.setSystemTime(startedAt + 30_001);
      await expect(service.reconcileAfterReconnect()).resolves.toBeUndefined();
      expect(indexer.markSessionArchived).toHaveBeenCalledWith(thread.id);
      expect((service as unknown as { uncertainSessions: Map<string, unknown> }).uncertainSessions.size).toBe(1);

      vi.setSystemTime(startedAt + 30_001 + UNCERTAIN_CHILD_BACKGROUND_TTL_MS + 1);
      await service.recoverDeferredChildren();

      expect(repositories.upsertProjectSession).not.toHaveBeenCalled();
      expect((service as unknown as { uncertainSessions: Map<string, unknown> }).uncertainSessions.size).toBe(0);
      expect(indexer.restoreThreadSourceDiscovery).toHaveBeenCalledWith("codex-web-session:project-1:vanished-create-request");
      expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith(thread.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a created Session finalization tombstone after its background TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
      const thread = { id: "created-finalization-stale", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
      const adapter = Object.assign(new EventEmitter(), {
        startSession: vi.fn(async () => ({ thread })),
        archiveSession: vi.fn(async () => { throw new Error("connection lost"); }),
      });
      const repositories = {
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
        upsertProjectSession: vi.fn(() => { throw new Error("mapping write failed"); }),
        removeProjectSession: vi.fn(),
      };
      const runtimes = {
        notifySessionSummaryUpdated: vi.fn(),
        removeThread: vi.fn(),
        restoreThread: vi.fn(),
      };
      const indexer = {
        markSessionArchived: vi.fn(),
        restoreSessionDiscovery: vi.fn(),
        restoreThreadSourceDiscovery: vi.fn(),
        scanAllInBackground: vi.fn(),
      };
      const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);

      await expect(service.createSession("project-1", {}, "create-finalization-stale")).rejects.toBeInstanceOf(OperationUncertainError);
      const startedAt = Date.now();
      expect((service as unknown as { uncertainSessions: Map<string, unknown> }).uncertainSessions.size).toBe(1);

      vi.setSystemTime(startedAt + UNCERTAIN_CHILD_BACKGROUND_TTL_MS + 1);
      await service.recoverDeferredChildren();

      expect((service as unknown as { uncertainSessions: Map<string, unknown> }).uncertainSessions.size).toBe(0);
      expect(indexer.restoreThreadSourceDiscovery).toHaveBeenCalledWith("codex-web-session:project-1:create-finalization-stale");
      expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith(thread.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a Project lock after an unconfirmed Session creation watchdog fires", async () => {
    const failedThread = { id: "failed", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const recoveredThread = { ...failedThread, id: "recovered" };
    let rejectFirst!: (error: Error) => void;
    const firstResponse = new Promise<{ thread: typeof failedThread }>((_resolve, reject) => { rejectFirst = reject; });
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn()
        .mockImplementationOnce(() => firstResponse)
        .mockResolvedValueOnce({ thread: recoveredThread }),
    });
    const repositories = {
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = { notifySessionSummaryUpdated: vi.fn(), restoreThread: vi.fn() };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const first = service.createSession("project-1", {}, "request-timeout");
    await vi.waitFor(() => expect(adapter.startSession).toHaveBeenCalledTimes(1));
    const second = service.createSession("project-1", {}, "request-after-timeout");
    await Promise.resolve();
    expect(adapter.startSession).toHaveBeenCalledTimes(1);

    rejectFirst(new JsonRpcMutationResponseTimeoutError("thread/start"));
    await expect(first).rejects.toBeInstanceOf(JsonRpcMutationResponseTimeoutError);
    await expect(second).resolves.toMatchObject({ thread: { id: "recovered" } });
    expect(adapter.startSession).toHaveBeenCalledTimes(2);
  });

  it("releases a Thread lock after a bounded mutation response timeout", async () => {
    let rejectRename!: (error: Error) => void;
    const renameResponse = new Promise<void>((_resolve, reject) => { rejectRename = reject; });
    const adapter = Object.assign(new EventEmitter(), { renameSession: vi.fn(() => renameResponse) });
    const repositories = { getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1" })) };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      markViewed: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const rename = service.rename("thread-1", "new name");
    await vi.waitFor(() => expect(adapter.renameSession).toHaveBeenCalled());
    const viewed = service.markViewed("thread-1");
    await Promise.resolve();
    expect(runtimes.markViewed).not.toHaveBeenCalled();

    rejectRename(new Error("JSON-RPC timeout for thread/name/set"));
    await expect(rename).rejects.toThrow("thread/name/set");
    await expect(viewed).resolves.toBeUndefined();
    expect(runtimes.markViewed).toHaveBeenCalledWith("thread-1");
  });

  it("marks an uncertain Turn start disconnected so reconnect must reconcile it", async () => {
    const previous = {
      id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1,
      ephemeral: false, forkedFromId: null, turns: [turn("previous-turn", "completed")],
    };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({
        thread: previous,
        settings: { model: null, reasoning: null, accessMode: "fullAccess" as const },
      })),
      startTurn: vi.fn(async () => { throw new OperationUncertainError("turn/start"); }),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      markOperationUncertain: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.startTurn("thread-1", "work", { clientUserMessageId: "message-1" }, "request-1")).rejects.toBeInstanceOf(OperationUncertainError);

    expect(runtimes.markOperationUncertain).toHaveBeenCalledWith("thread-1", "previous-turn");
  });

  it("releases retained Turn submission metadata when a late turn/started proves application", () => {
    const service = new SessionService({} as never, Object.assign(new EventEmitter(), {}) as never, {} as never, {} as never);
    const internals = service as unknown as {
      uncertainTurnBaselines: Map<string, string | undefined>;
      uncertainTurnMessageIds: Map<string, string>;
      uncertainTurnDrafts: Map<string, string>;
    };
    internals.uncertainTurnBaselines.set("thread-1", "previous-turn");
    internals.uncertainTurnMessageIds.set("thread-1", "message-1");
    internals.uncertainTurnDrafts.set("thread-1", "work");

    service.handleEvent({
      type: "turnStarted",
      threadId: "thread-1",
      turn: turn("late-turn", "inProgress"),
    });

    expect(internals.uncertainTurnBaselines.size).toBe(0);
    expect(internals.uncertainTurnMessageIds.size).toBe(0);
    expect(internals.uncertainTurnDrafts.size).toBe(0);
  });

  it("keeps an uncertain Turn blocked until the user explicitly confirms it was not applied", async () => {
    vi.useFakeTimers();
    try {
      const previous = {
        id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1,
        ephemeral: false, forkedFromId: null, turns: [turn("previous-turn", "completed")],
      };
      const adapter = Object.assign(new EventEmitter(), {
        resumeSession: vi.fn(async () => ({
          thread: previous,
          settings: { model: null, reasoning: null, accessMode: "fullAccess" as const },
        })),
        readSession: vi.fn(async () => previous),
        startTurn: vi.fn()
          .mockRejectedValueOnce(new OperationUncertainError("turn/start"))
          .mockResolvedValueOnce({ turn: turn("next-turn", "inProgress") }),
      });
      const repositories = {
        getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      };
      let runtimeState: "disconnected" | "idle" | "running" = "idle";
      const runtimes = {
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => [{ threadId: "thread-1", state: runtimeState, activeFlags: [], pendingRequestIds: [] }]),
        get: vi.fn(() => ({ threadId: "thread-1", state: runtimeState, activeFlags: [], pendingRequestIds: [] })),
        getSideChat: vi.fn(() => undefined),
        markOperationUncertain: vi.fn(() => { runtimeState = "disconnected"; }),
        reconcileFromSnapshot: vi.fn(() => "uncertainTurnUnchanged"),
        confirmUncertainTurnNotApplied: vi.fn(() => { runtimeState = "idle"; return "reconciled"; }),
        confirmUncertainTurnApplied: vi.fn(),
        setActiveTurn: vi.fn(() => { runtimeState = "running"; }),
      };
      const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

      await expect(service.startTurn("thread-1", "work", { clientUserMessageId: "message-1" }, "request-1"))
        .rejects.toBeInstanceOf(OperationUncertainError);

      const reconciling = service.reconcileAfterReconnect();
      await vi.runAllTimersAsync();
      await reconciling;

      expect(adapter.readSession).toHaveBeenCalledTimes(3);
      expect(runtimes.confirmUncertainTurnNotApplied).not.toHaveBeenCalled();
      await expect(service.startTurn("thread-1", "unsafe retry", { clientUserMessageId: "message-blocked" }, "request-blocked"))
        .rejects.toBeInstanceOf(SessionDisconnectedError);
      expect(adapter.startTurn).toHaveBeenCalledTimes(1);

      await expect(service.resolveUncertainTurn("thread-1")).resolves.toEqual({
        status: "notApplied",
        clientUserMessageId: "message-1",
        draft: "work",
      });
      expect(runtimes.confirmUncertainTurnNotApplied).toHaveBeenCalledWith("thread-1", previous.turns);
      await expect(service.startTurn("thread-1", "safe retry", { clientUserMessageId: "message-1" }, "request-2"))
        .resolves.toMatchObject({ turn: { id: "next-turn" } });
      expect(adapter.readSession).toHaveBeenCalledTimes(4);
      expect(adapter.startTurn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an applied Turn instead of resending when explicit resolution sees it appear", async () => {
    vi.useFakeTimers();
    try {
      const previous = {
        id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1,
        ephemeral: false, forkedFromId: null, turns: [turn("previous-turn", "completed")],
      };
      const applied = { ...previous, updatedAt: 2, turns: [...previous.turns, turn("late-applied-turn", "completed")] };
      let reads = 0;
      const adapter = Object.assign(new EventEmitter(), {
        resumeSession: vi.fn(async () => ({
          thread: previous,
          settings: { model: null, reasoning: null, accessMode: "fullAccess" as const },
        })),
        readSession: vi.fn(async () => ++reads <= 3 ? previous : applied),
        startTurn: vi.fn(),
      });
      const repositories = {
        getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      };
      let runtimeState: "disconnected" | "idle" = "disconnected";
      const runtimes = {
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => [{ threadId: "thread-1", state: runtimeState, activeFlags: [], pendingRequestIds: [] }]),
        get: vi.fn(() => ({ threadId: "thread-1", state: runtimeState, activeFlags: [], pendingRequestIds: [] })),
        getSideChat: vi.fn(() => undefined),
        reconcileFromSnapshot: vi.fn(() => "uncertainTurnUnchanged"),
        confirmUncertainTurnApplied: vi.fn(() => { runtimeState = "idle"; return "reconciled"; }),
      };
      const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
      (service as unknown as { uncertainTurnBaselines: Map<string, string | undefined> }).uncertainTurnBaselines.set("thread-1", "previous-turn");

      const reconciling = service.reconcileAfterReconnect();
      await vi.runAllTimersAsync();
      await reconciling;

      await expect(service.startTurn("thread-1", "duplicate work", { clientUserMessageId: "message-2" }, "request-2"))
        .rejects.toBeInstanceOf(SessionDisconnectedError);
      await expect(service.resolveUncertainTurn("thread-1"))
        .rejects.toBeInstanceOf(UncertainTurnAppliedError);
      expect(adapter.readSession).toHaveBeenCalledTimes(4);
      expect(adapter.startTurn).not.toHaveBeenCalled();
      expect(runtimes.confirmUncertainTurnApplied).toHaveBeenLastCalledWith("thread-1", applied.turns);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles a response-lost Steer by its client message ID without duplicating the instruction", async () => {
    const activeTurn = {
      ...turn("turn-1", "inProgress"),
      items: [{ type: "userMessage" as const, id: "steer-user", clientId: "steer-message-1", content: [{ type: "text", text: "more work" }] }],
    };
    const snapshot = {
      id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2,
      ephemeral: false, forkedFromId: null, turns: [activeTurn],
    };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({
        thread: snapshot,
        settings: { model: null, reasoning: null, accessMode: "fullAccess" as const },
      })),
      readSession: vi.fn(async () => snapshot),
      steerTurn: vi.fn(async () => { throw new OperationUncertainError("turn/steer"); }),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    let runtimeState: "running" | "disconnected" = "running";
    const runtimes = {
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => [{ threadId: "thread-1", state: runtimeState, activeTurnId: runtimeState === "running" ? "turn-1" : undefined, activeFlags: [], pendingRequestIds: [] }]),
      get: vi.fn(() => ({ threadId: "thread-1", state: runtimeState, activeTurnId: runtimeState === "running" ? "turn-1" : undefined, activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      markOperationUncertain: vi.fn(() => { runtimeState = "disconnected"; }),
      confirmUncertainTurnApplied: vi.fn((_threadId: string, _turns: unknown[], activeTurnId?: string) => {
        if (activeTurnId) runtimeState = "running";
        return "reconciled";
      }),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.steer("thread-1", "more work", "turn-1", "steer-message-1", "steer-request-1"))
      .rejects.toBeInstanceOf(OperationUncertainError);
    await service.reconcileAfterReconnect();

    expect(runtimes.confirmUncertainTurnApplied).toHaveBeenCalledWith("thread-1", snapshot.turns, "turn-1");
    expect(adapter.steerTurn).toHaveBeenCalledTimes(1);
    await expect(service.steer("thread-1", "more work", "turn-1", "steer-message-1", "steer-request-2"))
      .rejects.toBeInstanceOf(OperationUncertainError);
    expect(adapter.steerTurn).toHaveBeenCalledTimes(1);
  });

  it("restores the active Turn before retrying a Steer proven not applied", async () => {
    vi.useFakeTimers();
    try {
      const snapshot = {
        id: "thread-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1,
        ephemeral: false, forkedFromId: null, turns: [turn("turn-1", "inProgress")],
      };
      const adapter = Object.assign(new EventEmitter(), {
        resumeSession: vi.fn(async () => ({
          thread: snapshot,
          settings: { model: null, reasoning: null, accessMode: "fullAccess" as const },
        })),
        readSession: vi.fn(async () => snapshot),
        steerTurn: vi.fn()
          .mockRejectedValueOnce(new OperationUncertainError("turn/steer"))
          .mockResolvedValueOnce({}),
      });
      const repositories = {
        getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      };
      let runtimeState: "running" | "disconnected" = "running";
      const runtimes = {
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => [{ threadId: "thread-1", state: runtimeState, activeTurnId: runtimeState === "running" ? "turn-1" : undefined, activeFlags: [], pendingRequestIds: [] }]),
        get: vi.fn(() => ({ threadId: "thread-1", state: runtimeState, activeTurnId: runtimeState === "running" ? "turn-1" : undefined, activeFlags: [], pendingRequestIds: [] })),
        getSideChat: vi.fn(() => undefined),
        markOperationUncertain: vi.fn(() => { runtimeState = "disconnected"; }),
        confirmUncertainTurnNotApplied: vi.fn((_threadId: string, _turns: unknown[], activeTurnId?: string) => {
          if (activeTurnId) runtimeState = "running";
          return "reconciled";
        }),
      };
      const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

      await expect(service.steer("thread-1", "more work", "turn-1", "steer-message-1", "steer-request-1"))
        .rejects.toBeInstanceOf(OperationUncertainError);

      const reconciling = service.reconcileAfterReconnect();
      await vi.runAllTimersAsync();
      await reconciling;
      expect(runtimeState).toBe("disconnected");

      await expect(service.resolveUncertainTurn("thread-1")).resolves.toEqual({
        status: "notApplied",
        clientUserMessageId: "steer-message-1",
        draft: "more work",
      });
      expect(runtimes.confirmUncertainTurnNotApplied).toHaveBeenCalledWith("thread-1", snapshot.turns, "turn-1");
      expect(runtimeState).toBe("running");

      await expect(service.steer("thread-1", "more work", "turn-1", "steer-message-1", "steer-request-2"))
        .resolves.toEqual({});
      expect(adapter.steerTurn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a recovered Fork prefill when reconnect proves its first Turn started", async () => {
    const snapshot = {
      id: "fork-empty", preview: "original question", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2,
      ephemeral: false, forkedFromId: null, turns: [turn("accepted-turn", "completed")],
    };
    const settings = { model: null, reasoning: null, accessMode: "fullAccess" as const };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings })),
      readSession: vi.fn(async () => snapshot),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "fork-empty", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => [{ threadId: "fork-empty", state: "disconnected", activeFlags: [], pendingRequestIds: [] }]),
      reconcileFromSnapshot: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { sessionPrefills: Map<string, string> }).sessionPrefills.set("fork-empty", "original question");

    await service.reconcileAfterReconnect();

    expect(service.listPrefills()).toEqual({});
    expect(runtimes.reconcileFromSnapshot).toHaveBeenCalledWith("fork-empty", snapshot.turns);
  });

  it("rejects a new Turn while the Session outcome is still disconnected", async () => {
    const adapter = Object.assign(new EventEmitter(), { startTurn: vi.fn() });
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "disconnected", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.startTurn("thread-1", "duplicate work", { clientUserMessageId: "message-2" }, "request-2"))
      .rejects.toBeInstanceOf(SessionDisconnectedError);

    expect(adapter.startTurn).not.toHaveBeenCalled();
  });

  it("resolves explicit, current Session, and Project settings in that order", () => {
    const project = { defaultModel: "project-model", defaultReasoning: "medium", defaultAccessMode: "fullAccess" as const };
    const current = { model: "session-model", reasoning: "high", accessMode: "workspaceWrite" as const };
    expect(resolveSessionSettings(project, {}, current)).toEqual(current);
    expect(resolveSessionSettings(project, { model: "turn-model", reasoning: "low", accessMode: "readOnly" }, current)).toEqual({ model: "turn-model", reasoning: "low", accessMode: "readOnly" });
    expect(resolveSessionSettings(project, {})).toEqual({ model: "project-model", reasoning: "medium", accessMode: "fullAccess" });
  });

  it("defaults reasoning to high when no Turn, Session, or Project setting exists", () => {
    const project = { defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" as const };
    expect(resolveSessionSettings(project, {})).toEqual({ model: null, reasoning: "high", accessMode: "fullAccess" });
  });

  it("applies the Project access default to a cold Session while preserving its model and reasoning", async () => {
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

    expect(adapter.resumeSession).toHaveBeenCalledWith("thread-1", { accessMode: "fullAccess" });
    expect(result.settings).toEqual({ model: "app-default", reasoning: "low", accessMode: "fullAccess" });
  });

  it("applies a persisted Session access override before the Project default", async () => {
    const snapshot = { id: "thread-1", preview: "test", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: snapshot, settings: { model: "app-default", reasoning: "low", accessMode: "workspaceWrite" as const } })),
      readSession: vi.fn(async () => snapshot),
      getGoal: vi.fn(async () => null),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project", access_mode_override: "readOnly" as const })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" as const })),
    };
    const runtimes = {
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    const result = await service.readSession("thread-1");

    expect(adapter.resumeSession).toHaveBeenCalledWith("thread-1", { accessMode: "readOnly" });
    expect(result.settings).toEqual({ model: "app-default", reasoning: "low", accessMode: "readOnly" });
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
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      notifySessionSummaryUpdated: vi.fn(),
    };
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
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: "session-model", reasoning: "high", accessMode: "workspaceWrite" });

    const result = await service.fork("parent", null, false, "request-before-first", true);

    expect(adapter.startSession).toHaveBeenCalledWith(
      "/tmp/project",
      { model: "session-model", reasoning: "high", accessMode: "workspaceWrite" },
      false,
      "codex-web-fork:parent:request-before-first",
    );
    expect(result.thread.id).toBe("child");
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: "child",
      origin: "forked",
      parent_thread_id: "parent",
      fork_turn_id: null,
    }));
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("child", "fork-created");
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
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" });

    await expect(service.fork("parent", null, false, "request-1", true)).rejects.toThrow("goal clear failed");
    expect(adapter.archiveSession).toHaveBeenCalledWith("child");
    expect(repositories.upsertProjectSession).not.toHaveBeenCalled();
  });

  it("retains an exact Fork child when finalization and rollback both lose the App Server", async () => {
    const child = { id: "child-finalization-uncertain", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: "parent", turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => ({ thread: child })),
      clearGoal: vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue(undefined),
      archiveSession: vi.fn(async () => { throw new Error("connection lost"); }),
      listSessions: vi.fn(async () => ({
        data: [{ id: child.id, preview: "", name: null, cwd: child.cwd, sourceKind: "appServer", createdAt: 1, updatedAt: 1, forkedFromId: null, threadSource: null }],
        nextCursor: null,
      })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
      removeProjectSession: vi.fn(),
    };
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      removeThread: vi.fn(),
      restoreThread: vi.fn(),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const indexer = {
      markSessionArchived: vi.fn(),
      restoreSessionDiscovery: vi.fn(),
      scanAllInBackground: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

    await expect(service.fork("parent", null, false, "request-finalization-uncertain", true, "original question")).rejects.toBeInstanceOf(OperationUncertainError);

    expect(indexer.markSessionArchived).toHaveBeenCalledWith(child.id);
    expect(indexer.scanAllInBackground).toHaveBeenCalled();
    expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(1);
    expect((service as unknown as { observedForks: Map<string, unknown> }).observedForks.size).toBe(1);

    await service.recoverDeferredChildren();

    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: child.id,
      origin: "forked",
      parent_thread_id: "parent",
      fork_turn_id: null,
    }));
    expect(service.listPrefills()).toEqual({ [child.id]: "original question" });
    expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith(child.id);
  });

  it("archives and clears a Fork when its Project mapping cannot be stored", async () => {
    const child = { id: "child", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: "parent", turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => ({ thread: child })),
      clearGoal: vi.fn(async () => undefined),
      archiveSession: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(() => { throw new Error("mapping write failed"); }),
      removeProjectSession: vi.fn(),
    };
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      removeThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

    await expect(service.fork("parent", null, false, "request-1", true)).rejects.toThrow("mapping write failed");

    expect(repositories.removeProjectSession).toHaveBeenCalledWith("child");
    expect(runtimes.removeThread).toHaveBeenCalledWith("child");
    expect(adapter.archiveSession).toHaveBeenCalledWith("child");
    expect((service as unknown as { settings: Map<string, unknown> }).settings.has("child")).toBe(false);
    expect((service as unknown as { sessionSnapshots: Map<string, unknown> }).sessionSnapshots.has("child")).toBe(false);
  });

  it("recovers Fork metadata and the default Goal policy after an uncertain App Server response", async () => {
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [turn("boundary", "completed")] };
    const child = { id: "child", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: "parent", turns: [turn("boundary", "completed")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: parent, settings: { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async (threadId: string) => threadId === "parent" ? parent : child),
      getGoal: vi.fn(async () => null),
      forkSession: vi.fn(async () => { throw new OperationUncertainError("thread/fork"); }),
      clearGoal: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      listProjectSessions: vi.fn(() => [{ thread_id: "parent", project_id: "project-1" }]),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
      notifySessionSummaryUpdated: vi.fn(),
      restoreThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" });

    await expect(service.fork("parent", "boundary", false, "request-uncertain")).rejects.toBeInstanceOf(OperationUncertainError);
    service.handleEvent({
      type: "threadStarted",
      threadId: "child",
      threadSource: "codex-web-fork:parent:request-uncertain",
      thread: child,
    });
    await service.reconcileAfterReconnect();

    expect(adapter.forkSession).toHaveBeenCalledWith(
      "parent",
      "boundary",
      { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" },
      false,
      "/tmp/project",
      "codex-web-fork:parent:request-uncertain",
    );
    expect(adapter.clearGoal).toHaveBeenCalledWith("child");
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: "child",
      origin: "forked",
      parent_thread_id: "parent",
      fork_turn_id: "boundary",
    }));
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("child", "fork-created");
  });

  it("recovers Fork provenance from its request-specific source when the start notification was lost", async () => {
    const threadSource = "codex-web-fork:parent:request-without-notification";
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [turn("boundary", "completed")] };
    const child = { id: "child-without-notification", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: "parent", turns: [turn("boundary", "completed")] };
    const listed = { id: child.id, preview: "", name: null, cwd: child.cwd, sourceKind: "appServer", createdAt: 2, updatedAt: 2, forkedFromId: "parent", threadSource };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: parent, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async (threadId: string) => threadId === "parent" ? parent : child),
      getGoal: vi.fn(async () => null),
      forkSession: vi.fn(async () => { throw new OperationUncertainError("thread/fork"); }),
      listSessions: vi.fn(async () => ({ data: [listed], nextCursor: null })),
      clearGoal: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
      notifySessionSummaryUpdated: vi.fn(),
      restoreThread: vi.fn(),
    };
    const indexer = {
      markThreadSourcePending: vi.fn(),
      restoreThreadSourceDiscovery: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

    await expect(service.fork("parent", "boundary", false, "request-without-notification")).rejects.toBeInstanceOf(OperationUncertainError);
    await service.reconcileAfterReconnect();

    expect(indexer.markThreadSourcePending).toHaveBeenCalledWith(threadSource);
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: child.id,
      origin: "forked",
      parent_thread_id: "parent",
      fork_turn_id: "boundary",
    }));
    expect(indexer.restoreThreadSourceDiscovery).toHaveBeenCalledWith(threadSource);
  });

  it("retries an exactly observed normal Fork until its history materializes", async () => {
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [turn("boundary", "completed")] };
    const child = { id: "child", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: "parent", turns: [turn("boundary", "completed")] };
    const incompleteChild = { ...child, forkedFromId: null, turns: [] };
    let childReads = 0;
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: parent, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async (threadId: string) => {
        if (threadId === "parent") return parent;
        return childReads++ === 0 ? incompleteChild : child;
      }),
      getGoal: vi.fn(async () => null),
      forkSession: vi.fn(async () => { throw new OperationUncertainError("thread/fork"); }),
      clearGoal: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
      notifySessionSummaryUpdated: vi.fn(),
      restoreThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

    await expect(service.fork("parent", "boundary", false, "request-history-retry")).rejects.toBeInstanceOf(OperationUncertainError);
    service.handleEvent({
      type: "threadStarted",
      threadId: child.id,
      threadSource: "codex-web-fork:parent:request-history-retry",
      thread: child,
    });
    await service.reconcileAfterReconnect();

    expect(childReads).toBe(2);
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: child.id,
      origin: "forked",
      parent_thread_id: "parent",
      fork_turn_id: "boundary",
    }));
  });

  it("releases stale non-empty Fork recovery and discovery tombstones after the final TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
      const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [turn("boundary", "completed")] };
      const child = { id: "stale-child", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: "parent", turns: [turn("boundary", "completed")] };
      const incompleteChild = { ...child, forkedFromId: null, turns: [] };
      const adapter = Object.assign(new EventEmitter(), {
        resumeSession: vi.fn(async () => ({ thread: parent, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
        readSession: vi.fn(async (threadId: string) => threadId === "parent" ? parent : incompleteChild),
        getGoal: vi.fn(async () => null),
        forkSession: vi.fn(async () => { throw new OperationUncertainError("thread/fork"); }),
        clearGoal: vi.fn(async () => undefined),
      });
      const repositories = {
        getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
        upsertProjectSession: vi.fn(),
      };
      const runtimes = {
        getSideChat: vi.fn(() => undefined),
        get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => []),
      };
      const indexer = {
        markSessionArchived: vi.fn(),
        restoreSessionDiscovery: vi.fn(),
        restoreThreadSourceDiscovery: vi.fn(),
      };
      const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);
      (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

      await expect(service.fork("parent", "boundary", false, "request-stale")).rejects.toBeInstanceOf(OperationUncertainError);
      service.handleEvent({
        type: "threadStarted",
        threadId: child.id,
        threadSource: "codex-web-fork:parent:request-stale",
        thread: child,
      });
      const startedAt = Date.now();
      const initialRecovery = service.reconcileAfterReconnect();
      const initialResult = expect(initialRecovery).rejects.toBeInstanceOf(ReconciliationPendingError);
      await vi.advanceTimersByTimeAsync(300);
      await initialResult;

      vi.setSystemTime(startedAt + 30_001);
      await expect(service.reconcileAfterReconnect()).resolves.toBeUndefined();
      expect(indexer.markSessionArchived).toHaveBeenCalledWith(child.id);
      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(1);

      vi.setSystemTime(startedAt + 30_001 + UNCERTAIN_CHILD_BACKGROUND_TTL_MS + 1);
      await service.recoverDeferredChildren();

      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(0);
      expect(indexer.restoreThreadSourceDiscovery).toHaveBeenCalledWith("codex-web-fork:parent:request-stale");
      expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith(child.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("self-schedules background Fork recovery after the one post-reconnect scan is already over", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
      const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [turn("boundary", "completed")] };
      const child = { id: "late-child", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: "parent", turns: [turn("boundary", "completed")] };
      const incompleteChild = { ...child, forkedFromId: null, turns: [] };
      let materialized = false;
      const adapter = Object.assign(new EventEmitter(), {
        resumeSession: vi.fn(async () => ({ thread: parent, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
        readSession: vi.fn(async (threadId: string) => threadId === "parent" ? parent : materialized ? child : incompleteChild),
        getGoal: vi.fn(async () => null),
        forkSession: vi.fn(async () => { throw new OperationUncertainError("thread/fork"); }),
        clearGoal: vi.fn(async () => undefined),
      });
      const repositories = {
        getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
        upsertProjectSession: vi.fn(),
      };
      const runtimes = {
        getSideChat: vi.fn(() => undefined),
        get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => []),
        notifySessionSummaryUpdated: vi.fn(),
        restoreThread: vi.fn(),
      };
      const indexer = {
        markSessionArchived: vi.fn(),
        restoreSessionDiscovery: vi.fn(),
        restoreThreadSourceDiscovery: vi.fn(),
      };
      const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);
      (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

      await expect(service.fork("parent", "boundary", false, "request-late-materialization")).rejects.toBeInstanceOf(OperationUncertainError);
      service.handleEvent({
        type: "threadStarted",
        threadId: child.id,
        threadSource: "codex-web-fork:parent:request-late-materialization",
        thread: child,
      });
      const recovery = (service as unknown as { uncertainForks: Map<string, { recoveryDeadlineAt?: number }> }).uncertainForks
        .get("codex-web-fork:parent:request-late-materialization");
      if (!recovery) throw new Error("missing Fork recovery");
      recovery.recoveryDeadlineAt = Date.now();

      await service.reconcileAfterReconnect();
      expect(indexer.markSessionArchived).toHaveBeenCalledWith(child.id);
      expect(repositories.upsertProjectSession).not.toHaveBeenCalled();

      materialized = true;
      await vi.advanceTimersByTimeAsync(DEFERRED_CHILD_RECOVERY_DELAY_MS);

      expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
        thread_id: child.id,
        parent_thread_id: "parent",
        fork_turn_id: "boundary",
      }));
      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(0);
      expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith(child.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not recover an observed Fork after its Project is removed", async () => {
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [turn("boundary", "completed")] };
    const child = { id: "child", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: "parent", turns: [turn("boundary", "completed")] };
    const adapter = Object.assign(new EventEmitter(), {
      resumeSession: vi.fn(async () => ({ thread: parent, settings: { model: null, reasoning: null, accessMode: "fullAccess" as const } })),
      readSession: vi.fn(async (threadId: string) => threadId === "parent" ? parent : child),
      forkSession: vi.fn(async () => { throw new OperationUncertainError("thread/fork"); }),
      getGoal: vi.fn(async () => null),
      setGoal: vi.fn(async () => undefined),
      clearGoal: vi.fn(async () => undefined),
    });
    let projectExists = true;
    const repositories = {
      getProjectSession: vi.fn(() => projectExists ? { thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" } : null),
      getProject: vi.fn(() => projectExists ? { id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" } : null),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

    await expect(service.fork("parent", "boundary", true, "request-removed-project")).rejects.toBeInstanceOf(OperationUncertainError);
    service.handleEvent({
      type: "threadStarted",
      threadId: "child",
      threadSource: "codex-web-fork:parent:request-removed-project",
      thread: child,
    });
    projectExists = false;
    await service.reconcileAfterReconnect();

    expect(adapter.readSession).toHaveBeenCalledTimes(1);
    expect(adapter.readSession).toHaveBeenCalledWith("parent");
    expect(adapter.getGoal).toHaveBeenCalledTimes(1);
    expect(adapter.getGoal).toHaveBeenCalledWith("parent");
    expect(adapter.setGoal).not.toHaveBeenCalled();
    expect(adapter.clearGoal).not.toHaveBeenCalled();
    expect(repositories.upsertProjectSession).not.toHaveBeenCalled();
  });

  it("recovers only the exactly observed empty before-first Fork", async () => {
    const child = { id: "empty-child", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => { throw new OperationUncertainError("thread/start"); }),
      listSessions: vi.fn(async () => ({
        data: [
          { id: "external-candidate", preview: "", name: null, cwd: "/tmp/project", sourceKind: "appServer", createdAt: 2, updatedAt: 2, forkedFromId: null, threadSource: null },
          { id: "empty-child", preview: "", name: null, cwd: "/tmp/project", sourceKind: "appServer", createdAt: 2, updatedAt: 2, forkedFromId: null, threadSource: null },
        ],
        nextCursor: null,
      })),
      readSession: vi.fn(),
      clearGoal: vi.fn(async () => undefined),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
      notifySessionSummaryUpdated: vi.fn(),
      restoreThread: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

    await expect(service.fork("parent", null, false, "request-empty-observed", true, "original question")).rejects.toBeInstanceOf(OperationUncertainError);
    service.handleEvent({
      type: "threadStarted",
      threadId: "empty-child",
      threadSource: "codex-web-fork:parent:request-empty-observed",
      thread: child,
    });
    await service.reconcileAfterReconnect();

    expect(adapter.readSession).not.toHaveBeenCalled();
    expect(adapter.clearGoal).not.toHaveBeenCalled();
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({
      thread_id: "empty-child",
      parent_thread_id: "parent",
      fork_turn_id: null,
    }));
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("empty-child", "fork-created", { prefill: "original question" });
  });

  it("keeps an exactly observed before-first Fork recoverable until its bounded background TTL expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
      const child = { id: "empty-child", preview: "", name: null, cwd: "/tmp/project", createdAt: 2, updatedAt: 2, ephemeral: false, forkedFromId: null, turns: [] };
      const adapter = Object.assign(new EventEmitter(), {
        startSession: vi.fn(async () => { throw new OperationUncertainError("thread/start"); }),
        listSessions: vi.fn(async () => ({ data: [], nextCursor: null })),
        clearGoal: vi.fn(async () => undefined),
      });
      const repositories = {
        getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
        upsertProjectSession: vi.fn(),
      };
      const runtimes = {
        get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
        getSideChat: vi.fn(() => undefined),
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => []),
        notifySessionSummaryUpdated: vi.fn(),
        restoreThread: vi.fn(),
      };
      const indexer = {
        markSessionArchived: vi.fn(),
        restoreSessionDiscovery: vi.fn(),
        restoreThreadSourceDiscovery: vi.fn(),
      };
      const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);
      (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

      await expect(service.fork("parent", null, false, "request-empty-retry", true, "original question")).rejects.toBeInstanceOf(OperationUncertainError);
      service.handleEvent({
        type: "threadStarted",
        threadId: child.id,
        threadSource: "codex-web-fork:parent:request-empty-retry",
        thread: child,
      });
      const startedAt = Date.now();

      const initialRecovery = service.reconcileAfterReconnect();
      const initialResult = expect(initialRecovery).rejects.toBeInstanceOf(ReconciliationPendingError);
      await vi.advanceTimersByTimeAsync(300);
      await initialResult;
      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(1);

      vi.setSystemTime(startedAt + 30_001);
      await expect(service.reconcileAfterReconnect()).resolves.toBeUndefined();
      expect(indexer.markSessionArchived).toHaveBeenCalledWith(child.id);
      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(1);

      vi.setSystemTime(startedAt + 30_001 + UNCERTAIN_CHILD_BACKGROUND_TTL_MS + 1);
      await service.recoverDeferredChildren();

      expect(repositories.upsertProjectSession).not.toHaveBeenCalled();
      expect(runtimes.notifySessionSummaryUpdated).not.toHaveBeenCalled();
      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(0);
      expect(indexer.restoreThreadSourceDiscovery).toHaveBeenCalledWith("codex-web-fork:parent:request-empty-retry");
      expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith(child.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never claims an external empty Session while waiting for a before-first Fork's durable identity", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
      const now = Math.floor(Date.now() / 1_000);
      const adapter = Object.assign(new EventEmitter(), {
        startSession: vi.fn(async () => { throw new OperationUncertainError("thread/start"); }),
        listSessions: vi.fn(async () => ({
          data: [{
            id: "external-candidate", preview: "", name: null, cwd: "/tmp/project", sourceKind: "appServer",
            createdAt: now, updatedAt: now, forkedFromId: null, threadSource: null,
          }],
          nextCursor: null,
        })),
        readSession: vi.fn(),
        clearGoal: vi.fn(async () => undefined),
      });
      const repositories = {
        getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
        getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
        listProjectSessions: vi.fn(() => [{ thread_id: "parent", project_id: "project-1" }]),
        upsertProjectSession: vi.fn(),
      };
      const runtimes = {
        get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
        getSideChat: vi.fn(() => undefined),
        listSideChats: vi.fn(() => []),
        list: vi.fn(() => []),
        notifySessionSummaryUpdated: vi.fn(),
      };
      const indexer = { restoreThreadSourceDiscovery: vi.fn() };
      const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);
      (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

      await expect(service.fork("parent", null, false, "request-empty-uncertain", true)).rejects.toBeInstanceOf(OperationUncertainError);
      const startedAt = Date.now();
      await expect(service.reconcileAfterReconnect()).rejects.toBeInstanceOf(ReconciliationPendingError);
      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(1);

      vi.setSystemTime(startedAt + 30_001);
      await expect(service.reconcileAfterReconnect()).resolves.toBeUndefined();

      expect(adapter.clearGoal).not.toHaveBeenCalled();
      expect(adapter.readSession).not.toHaveBeenCalled();
      expect(repositories.upsertProjectSession).not.toHaveBeenCalled();
      expect((service as unknown as { uncertainForks: Map<string, unknown> }).uncertainForks.size).toBe(0);
      expect(indexer.restoreThreadSourceDiscovery).toHaveBeenCalledWith("codex-web-fork:parent:request-empty-uncertain");
    } finally {
      vi.useRealTimers();
    }
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
    await expect(reading).resolves.toMatchObject({ thread: { id: "thread-1" }, settings: { accessMode: "fullAccess" } });
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
      get: vi.fn(() => sideChat),
      waitForTerminal: vi.fn(async () => { calls.push("terminal"); return true; }),
      removeSideChat: vi.fn(() => { calls.push("remove"); }),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await service.closeSideChat("side-1");

    expect(runtimes.waitForTerminal).toHaveBeenCalledWith("side-1", SIDE_CHAT_TERMINAL_WAIT_MS);
    expect(calls).toEqual(["interrupt", "terminal", "unsubscribe", "remove"]);
  });

  it("closes a Side Chat when Interrupt confirms that its remembered Turn already ended", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-stale", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      interruptTurn: vi.fn(async () => { throw new JsonRpcError("no active turn to interrupt", -32600); }),
      unsubscribe: vi.fn(async () => undefined),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      get: vi.fn(() => sideChat),
      waitForTerminal: vi.fn(),
      removeSideChat: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await service.closeSideChat("side-1");

    expect(adapter.unsubscribe).toHaveBeenCalledWith("side-1");
    expect(runtimes.removeSideChat).toHaveBeenCalledWith("side-1");
    expect(runtimes.waitForTerminal).not.toHaveBeenCalled();
  });

  it("recovers a missing active Turn ID before closing a Side Chat", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const snapshot = { id: "side-1", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: true, forkedFromId: "parent", turns: [turn("turn-recovered", "inProgress")] };
    const adapter = Object.assign(new EventEmitter(), {
      readSession: vi.fn(),
      interruptTurn: vi.fn(async () => undefined),
      unsubscribe: vi.fn(async () => undefined),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      get: vi.fn(() => sideChat),
      setActiveTurn: vi.fn(),
      waitForTerminal: vi.fn(async () => true),
      removeSideChat: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { sessionSnapshots: Map<string, typeof snapshot> }).sessionSnapshots.set("side-1", snapshot);

    await service.closeSideChat("side-1");

    expect(adapter.readSession).not.toHaveBeenCalled();
    expect(runtimes.setActiveTurn).toHaveBeenCalledWith("side-1", "turn-recovered");
    expect(adapter.interruptTurn).toHaveBeenCalledWith("side-1", "turn-recovered");
    expect(runtimes.waitForTerminal).toHaveBeenCalledWith("side-1", SIDE_CHAT_TERMINAL_WAIT_MS);
    expect(adapter.unsubscribe).toHaveBeenCalledWith("side-1");
    expect(runtimes.removeSideChat).toHaveBeenCalledWith("side-1");
  });

  it("waits for turn/started instead of restarting the App Server when a Side Chat Turn ID has not arrived", async () => {
    const calls: string[] = [];
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      readSession: vi.fn(),
      interruptTurn: vi.fn(async () => { calls.push("interrupt"); }),
      unsubscribe: vi.fn(async () => { calls.push("unsubscribe"); }),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      get: vi.fn(() => sideChat),
      waitForActiveTurnId: vi.fn(async () => { calls.push("identity"); return "turn-late"; }),
      waitForTerminal: vi.fn(async () => { calls.push("terminal"); return true; }),
      removeSideChat: vi.fn(() => { calls.push("remove"); }),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await service.closeSideChat("side-1");

    expect(runtimes.waitForActiveTurnId).toHaveBeenCalledWith("side-1", SIDE_CHAT_TERMINAL_WAIT_MS);
    expect(adapter.interruptTurn).toHaveBeenCalledWith("side-1", "turn-late");
    expect(calls).toEqual(["identity", "interrupt", "terminal", "unsubscribe", "remove"]);
    expect(adapter.readSession).not.toHaveBeenCalled();
  });

  it("restarts an otherwise idle App Server to recover a Side Chat whose terminal notification was lost", async () => {
    const calls: string[] = [];
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      interruptTurn: vi.fn(async () => { calls.push("interrupt"); }),
      unsubscribe: vi.fn(async () => { calls.push("unsubscribe"); }),
      restartForRecovery: vi.fn(() => { calls.push("restart"); }),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      get: vi.fn(() => sideChat),
      list: vi.fn(() => [sideChat]),
      listSideChats: vi.fn(() => [sideChat]),
      waitForTerminal: vi.fn(async () => { calls.push("terminal-timeout"); return false; }),
      removeSideChat: vi.fn(() => { calls.push("remove"); }),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await service.closeSideChat("side-1");

    expect(runtimes.waitForTerminal).toHaveBeenCalledWith("side-1", SIDE_CHAT_TERMINAL_WAIT_MS);
    expect(calls).toEqual(["interrupt", "terminal-timeout", "restart", "remove"]);
    expect(adapter.unsubscribe).not.toHaveBeenCalled();
  });

  it("preserves a timed-out Side Chat while another Session Turn is active", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      interruptTurn: vi.fn(async () => undefined),
      restartForRecovery: vi.fn(),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      get: vi.fn(() => sideChat),
      list: vi.fn(() => [sideChat, { threadId: "parent", state: "running", activeTurnId: "parent-turn", activeFlags: [], pendingRequestIds: [] }]),
      listSideChats: vi.fn(() => [sideChat]),
      waitForTerminal: vi.fn(async () => false),
      removeSideChat: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.closeSideChat("side-1")).rejects.toBeInstanceOf(SideChatCloseTimeoutError);

    expect(adapter.restartForRecovery).not.toHaveBeenCalled();
    expect(runtimes.removeSideChat).not.toHaveBeenCalled();
  });

  it("preserves a timed-out Side Chat while another idle Side Chat exists", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const otherSideChat = { threadId: "side-2", parentThreadId: "other-parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 2 };
    const adapter = Object.assign(new EventEmitter(), {
      interruptTurn: vi.fn(async () => undefined),
      restartForRecovery: vi.fn(),
    });
    const runtimes = {
      getSideChat: vi.fn((threadId: string) => threadId === "side-1" ? sideChat : otherSideChat),
      get: vi.fn(() => sideChat),
      list: vi.fn(() => [sideChat, otherSideChat]),
      listSideChats: vi.fn(() => [sideChat, otherSideChat]),
      waitForTerminal: vi.fn(async () => false),
      removeSideChat: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.closeSideChat("side-1")).rejects.toBeInstanceOf(SideChatCloseTimeoutError);

    expect(adapter.restartForRecovery).not.toHaveBeenCalled();
    expect(runtimes.removeSideChat).not.toHaveBeenCalled();
  });

  it("preserves a timed-out Side Chat while another non-idempotent mutation is pending", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const adapter = Object.assign(new EventEmitter(), {
      interruptTurn: vi.fn(async () => undefined),
      restartForRecovery: vi.fn(() => false),
    });
    const runtimes = {
      getSideChat: vi.fn(() => sideChat),
      get: vi.fn(() => sideChat),
      list: vi.fn(() => [sideChat]),
      listSideChats: vi.fn(() => [sideChat]),
      waitForTerminal: vi.fn(async () => false),
      removeSideChat: vi.fn(),
    };
    const service = new SessionService({} as never, adapter as never, {} as never, runtimes as never);

    await expect(service.closeSideChat("side-1")).rejects.toBeInstanceOf(SideChatCloseTimeoutError);

    expect(adapter.restartForRecovery).toHaveBeenCalledTimes(1);
    expect(runtimes.removeSideChat).not.toHaveBeenCalled();
  });

  it("preserves a timed-out Side Chat while a Fork is finalizing after its protocol response", async () => {
    let finishGoalClear!: () => void;
    const goalClearPending = new Promise<void>((resolve) => { finishGoalClear = resolve; });
    const sideChat = { threadId: "side-1", parentThreadId: "side-parent", state: "running", activeTurnId: "side-turn", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const child = { id: "child", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const adapter = Object.assign(new EventEmitter(), {
      startSession: vi.fn(async () => ({ thread: child })),
      clearGoal: vi.fn(async () => goalClearPending),
      interruptTurn: vi.fn(async () => undefined),
      restartForRecovery: vi.fn(() => true),
    });
    const repositories = {
      getProjectSession: vi.fn((threadId: string) => threadId === "parent"
        ? { thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" }
        : null),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      upsertProjectSession: vi.fn(),
    };
    const runtimes = {
      getSideChat: vi.fn((threadId: string) => threadId === "side-1" ? sideChat : undefined),
      get: vi.fn((threadId: string) => threadId === "side-1"
        ? sideChat
        : { threadId, state: "idle", activeFlags: [], pendingRequestIds: [] }),
      list: vi.fn(() => [sideChat]),
      listSideChats: vi.fn(() => [sideChat]),
      waitForTerminal: vi.fn(async () => false),
      removeSideChat: vi.fn(),
      restoreThread: vi.fn(),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("parent", { model: null, reasoning: null, accessMode: "fullAccess" });

    const forking = service.fork("parent", null, false, "request-overlap", true);
    await vi.waitFor(() => expect(adapter.clearGoal).toHaveBeenCalledWith("child"));

    await expect(service.closeSideChat("side-1")).rejects.toBeInstanceOf(SideChatCloseTimeoutError);
    expect(adapter.restartForRecovery).not.toHaveBeenCalled();
    expect(runtimes.removeSideChat).not.toHaveBeenCalled();

    finishGoalClear();
    await expect(forking).resolves.toMatchObject({ thread: { id: "child" } });
    expect(repositories.upsertProjectSession).toHaveBeenCalledWith(expect.objectContaining({ thread_id: "child", origin: "forked" }));
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
      get: vi.fn((threadId: string) => registered ?? ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
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
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => []),
      registerSideChat: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await service.createSideChat("parent", null);

    expect(adapter.resumeSession).toHaveBeenCalledWith("parent", { accessMode: "fullAccess" });
    expect(adapter.createSideChat).toHaveBeenCalledWith("parent", null, { ...protocolSettings, accessMode: "fullAccess" }, "/tmp/project");
  });

  it("falls back to an empty ephemeral Thread only when the parent is proven empty", async () => {
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [] };
    const child = { ...parent, id: "side-1", ephemeral: true, forkedFromId: null };
    const settings = { model: null, reasoning: null, accessMode: "fullAccess" as const };
    const adapter = Object.assign(new EventEmitter(), {
      createSideChat: vi.fn(async () => { throw new JsonRpcError("no rollout found for thread id parent", -32600); }),
      createEmptySideChat: vi.fn(async () => ({ thread: child })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => []),
      registerSideChat: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, typeof settings>; sessionSnapshots: Map<string, typeof parent> }).settings.set("parent", settings);
    (service as unknown as { sessionSnapshots: Map<string, typeof parent> }).sessionSnapshots.set("parent", parent);

    await expect(service.createSideChat("parent", null)).resolves.toMatchObject({ threadId: "side-1" });
    expect(adapter.createEmptySideChat).toHaveBeenCalledWith("/tmp/project", settings);
  });

  it("never drops parent history when an ephemeral Fork reports a materialization error", async () => {
    const parent = { id: "parent", preview: "", name: null, cwd: "/tmp/project", createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null, turns: [turn("turn-1", "completed")] };
    const settings = { model: null, reasoning: null, accessMode: "fullAccess" as const };
    const failure = new JsonRpcError("no rollout found for thread id parent", -32600);
    const adapter = Object.assign(new EventEmitter(), {
      createSideChat: vi.fn(async () => { throw failure; }),
      createEmptySideChat: vi.fn(),
    });
    const repositories = {
      getProjectSession: vi.fn(() => ({ thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" })),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", available: true, defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
    };
    const runtimes = {
      get: vi.fn((threadId: string) => ({ threadId, state: "idle", activeFlags: [], pendingRequestIds: [] })),
      getSideChat: vi.fn(() => undefined),
      listSideChats: vi.fn(() => []),
      registerSideChat: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, typeof settings>; sessionSnapshots: Map<string, typeof parent> }).settings.set("parent", settings);
    (service as unknown as { sessionSnapshots: Map<string, typeof parent> }).sessionSnapshots.set("parent", parent);

    await expect(service.createSideChat("parent", null)).rejects.toBe(failure);
    expect(adapter.createEmptySideChat).not.toHaveBeenCalled();
  });

  it("updates model and reasoning from thread/settings/updated without overriding the preferred access mode", async () => {
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
    const normalized = service.handleEvent(projectAdapterEvent({ method: "thread/settings/updated", params: { threadId: "parent", threadSettings: {
      model: "new-model", effort: "low", approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false },
    } } })!);

    await service.createSideChat("parent", null);

    expect(normalized).toMatchObject({ type: "settingsUpdated", settings: { model: "new-model", reasoning: "low", accessMode: "fullAccess" } });
    expect(adapter.createSideChat).toHaveBeenCalledWith("parent", null, { model: "new-model", reasoning: "low", accessMode: "fullAccess" }, "/tmp/project");
  });

  it("updates an ephemeral Side Chat access mode without requiring a persistent mapping", async () => {
    const sideChat = { threadId: "side-1", parentThreadId: "parent", state: "idle", activeFlags: [], pendingRequestIds: [], createdAt: 1 };
    const repositories = {
      getProjectSession: vi.fn((threadId: string) => threadId === "parent" ? { thread_id: "parent", project_id: "project-1", cwd_snapshot: "/tmp/project" } : null),
      getProject: vi.fn(() => ({ id: "project-1", canonicalPath: "/tmp/project", defaultModel: null, defaultReasoning: null, defaultAccessMode: "fullAccess" })),
      setSessionAccessModeOverride: vi.fn(),
    };
    const runtimes = {
      getSideChat: vi.fn((threadId: string) => threadId === "side-1" ? sideChat : undefined),
    };
    const service = new SessionService(repositories as never, new EventEmitter() as never, {} as never, runtimes as never);
    (service as unknown as { settings: Map<string, unknown> }).settings.set("side-1", { model: "gpt-test", reasoning: "high", accessMode: "fullAccess" });

    await expect(service.setAccessModeOverride("side-1", "readOnly")).resolves.toEqual({ model: "gpt-test", reasoning: "high", accessMode: "readOnly" });
    expect(repositories.setSessionAccessModeOverride).not.toHaveBeenCalled();
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

  it("removes a Session after reconnect confirms an unacknowledged archive was applied", async () => {
    const mapping = { thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" };
    const adapter = Object.assign(new EventEmitter(), {
      archiveSession: vi.fn(async () => { throw new OperationUncertainError("thread/archive"); }),
      listSessions: vi.fn(async () => ({ data: [], nextCursor: null })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => mapping),
      removeProjectSession: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      removeThread: vi.fn(),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const indexer = {
      markSessionArchived: vi.fn(),
      restoreSessionDiscovery: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);

    await expect(service.archive("thread-1")).rejects.toBeInstanceOf(OperationUncertainError);
    expect(indexer.restoreSessionDiscovery).not.toHaveBeenCalled();
    expect(repositories.removeProjectSession).not.toHaveBeenCalled();

    await service.reconcileAfterReconnect();

    expect(adapter.listSessions).toHaveBeenCalledWith({ cursor: null, limit: 100, archived: false });
    expect(repositories.removeProjectSession).toHaveBeenCalledWith("thread-1");
    expect(runtimes.notifySessionSummaryUpdated).toHaveBeenCalledWith("thread-1", "archived-after-reconnect");
  });

  it("restores an unacknowledged archive when reconnect confirms the Session is still unarchived", async () => {
    const mapping = { thread_id: "thread-1", project_id: "project-1", cwd_snapshot: "/tmp/project" };
    const adapter = Object.assign(new EventEmitter(), {
      archiveSession: vi.fn(async () => { throw new OperationUncertainError("thread/archive"); }),
      listSessions: vi.fn(async () => ({
        data: [{ id: "thread-1", preview: "", name: null, cwd: "/tmp/project", sourceKind: "appServer", createdAt: 1, updatedAt: 1, forkedFromId: null }],
        nextCursor: null,
      })),
    });
    const repositories = {
      getProjectSession: vi.fn(() => mapping),
      removeProjectSession: vi.fn(),
    };
    const runtimes = {
      listSideChats: vi.fn(() => []),
      list: vi.fn(() => []),
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "idle", activeFlags: [], pendingRequestIds: [] })),
      notifySessionSummaryUpdated: vi.fn(),
    };
    const indexer = {
      markSessionArchived: vi.fn(),
      restoreSessionDiscovery: vi.fn(),
    };
    const service = new SessionService(repositories as never, adapter as never, indexer as never, runtimes as never);

    await expect(service.archive("thread-1")).rejects.toBeInstanceOf(OperationUncertainError);
    await service.reconcileAfterReconnect();

    expect(repositories.removeProjectSession).not.toHaveBeenCalled();
    expect(indexer.restoreSessionDiscovery).toHaveBeenCalledWith("thread-1");
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

  it("allows human metadata and Goal controls but rejects structural mutations while a Turn is active", async () => {
    const adapter = Object.assign(new EventEmitter(), {
      renameSession: vi.fn(), archiveSession: vi.fn(), setGoal: vi.fn(), clearGoal: vi.fn(),
    });
    const repositories = { getProjectSession: vi.fn(() => ({ thread_id: "thread-1", project_id: "project-1" })), getProject: vi.fn(() => ({ id: "project-2" })), moveProjectSession: vi.fn() };
    const runtimes = {
      getSideChat: vi.fn(() => undefined),
      get: vi.fn(() => ({ threadId: "thread-1", state: "running", activeTurnId: "turn-1", activeFlags: [], pendingRequestIds: [] })),
    };
    const service = new SessionService(repositories as never, adapter as never, {} as never, runtimes as never);

    await expect(service.rename("thread-1", "new name")).resolves.toBeUndefined();
    await expect(service.setGoal({ threadId: "thread-1", status: "paused" })).resolves.toBeUndefined();
    await expect(service.clearGoal("thread-1")).resolves.toBeUndefined();
    await expect(service.archive("thread-1")).rejects.toThrow(ActiveTurnConflictError);
    await expect(service.moveToProject("thread-1", "project-2")).rejects.toThrow(ActiveTurnConflictError);
    expect(adapter.renameSession).toHaveBeenCalledWith("thread-1", "new name");
    expect(adapter.archiveSession).not.toHaveBeenCalled();
    expect(repositories.moveProjectSession).not.toHaveBeenCalled();
    expect(adapter.setGoal).toHaveBeenCalledWith({ threadId: "thread-1", status: "paused" });
    expect(adapter.clearGoal).toHaveBeenCalledWith("thread-1");
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
      notifySessionSummaryUpdated: vi.fn(),
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

import { randomUUID } from "node:crypto";
import type { AccessMode, SessionSummary, SideChatRuntime } from "@codex-web/shared-types";
import { CodexAdapter, JsonRpcError } from "@codex-web/codex-adapter";
import { Repositories, type ProjectSessionRow } from "./database.js";
import { ProjectIndexer } from "./project-indexer.js";
import { ThreadRuntimeRegistry } from "./runtime-registry.js";

export class SteerConflictError extends Error {
  constructor() { super("The active turn finished before the steer message could be sent"); }
}

interface TurnSettings { model?: string | null; reasoning?: string | null; accessMode?: AccessMode }
type SessionSnapshot = Awaited<ReturnType<CodexAdapter["readSession"]>>;
type SnapshotTurn = SessionSnapshot["turns"][number];
type SnapshotItem = SnapshotTurn["items"][number];
type AdapterNotification = { method: string; params?: unknown };

export class SessionService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly idempotentResults = new Map<string, Promise<unknown>>();
  private readonly settings = new Map<string, { model: string | null; reasoning: string | null; accessMode: AccessMode }>();
  private readonly sessionSnapshots = new Map<string, SessionSnapshot>();

  constructor(
    private readonly repositories: Repositories,
    private readonly adapter: CodexAdapter,
    private readonly indexer: ProjectIndexer,
    private readonly runtimes: ThreadRuntimeRegistry,
  ) {
    this.adapter.on("notification", (notification: AdapterNotification) => this.updateSessionSnapshot(notification));
  }

  async listSessions(options: { projectId?: string; search?: string; sortDirection?: "asc" | "desc" } = {}): Promise<SessionSummary[]> {
    const mappings = this.repositories.listProjectSessions(options.projectId);
    if (!mappings.length) return [];
    const mapped = new Map(mappings.map((item) => [item.thread_id, item]));
    const threads = [];
    let cursor: string | null = null;
    do {
      const page = await this.adapter.listSessions({ cursor, limit: 100, sortDirection: options.sortDirection ?? "desc", searchTerm: options.search });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor && threads.length < 2_000);
    const seen = new Set<string>();
    const summaries = threads.flatMap((thread): SessionSummary[] => {
      const mapping = mapped.get(thread.id);
      if (!mapping) return [];
      seen.add(thread.id);
      return [{
        threadId: thread.id,
        projectId: mapping.project_id,
        title: thread.name || thread.preview || "Untitled session",
        preview: thread.preview,
        cwd: thread.cwd,
        sourceKind: mapping.source_kind ?? "unknown",
        createdAt: thread.createdAt * 1_000,
        updatedAt: thread.updatedAt * 1_000,
        origin: mapping.origin,
        parentThreadId: mapping.parent_thread_id,
        forkTurnId: mapping.fork_turn_id,
        runtimeState: this.runtimes.get(thread.id).state,
        hasGoal: false,
      }];
    });
    for (const mapping of mappings) {
      if (seen.has(mapping.thread_id)) continue;
      const snapshot = this.sessionSnapshots.get(mapping.thread_id);
      if (!snapshot) continue;
      summaries.push({
        threadId: snapshot.id,
        projectId: mapping.project_id,
        title: snapshot.name || snapshot.preview || "Untitled session",
        preview: snapshot.preview,
        cwd: snapshot.cwd,
        sourceKind: mapping.source_kind ?? "appServer",
        createdAt: snapshot.createdAt * 1_000,
        updatedAt: snapshot.updatedAt * 1_000,
        origin: mapping.origin,
        parentThreadId: mapping.parent_thread_id,
        forkTurnId: mapping.fork_turn_id,
        runtimeState: this.runtimes.get(snapshot.id).state,
        hasGoal: false,
      });
    }
    return summaries.sort((left, right) => (options.sortDirection === "asc" ? 1 : -1) * (left.updatedAt - right.updatedAt));
  }

  async readSession(threadId: string) {
    this.runtimes.markViewed(threadId);
    const sideChat = this.runtimes.getSideChat(threadId);
    const sideChatSnapshot = sideChat ? this.sessionSnapshots.get(threadId) : undefined;
    if (sideChatSnapshot) {
      return { thread: sideChatSnapshot, goal: null, runtime: this.runtimes.get(threadId), settings: this.getSettings(threadId) };
    }
    await this.adapter.resumeSession(threadId).catch(() => undefined);
    const [thread, goal] = await Promise.all([
      this.adapter.readSession(threadId).catch((error) => {
        const snapshot = this.sessionSnapshots.get(threadId);
        if (snapshot && error instanceof JsonRpcError && error.message.includes("not materialized yet")) return snapshot;
        throw error;
      }),
      this.adapter.getGoal(threadId).catch(() => null),
    ]);
    return { thread, goal, runtime: this.runtimes.get(threadId), settings: this.getSettings(threadId) };
  }

  async rename(threadId: string, name: string): Promise<void> {
    await this.adapter.renameSession(threadId, name);
  }

  async archive(threadId: string): Promise<void> {
    await this.adapter.archiveSession(threadId);
  }

  async createSession(projectId: string, input: TurnSettings, clientRequestId: string) {
    return this.idempotent(clientRequestId, async () => {
      const project = this.requireProject(projectId);
      const settings = this.resolveSettings(projectId, input);
      const response = await this.adapter.startSession(project.canonicalPath, settings);
      this.settings.set(response.thread.id, settings);
      this.sessionSnapshots.set(response.thread.id, response.thread);
      const now = Date.now();
      this.repositories.upsertProjectSession({
        thread_id: response.thread.id, project_id: projectId, cwd_snapshot: project.canonicalPath,
        source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null,
        added_at: now, last_seen_at: now,
      });
      return { thread: response.thread, settings };
    });
  }

  async startTurn(threadId: string, text: string, input: TurnSettings & { clientUserMessageId: string }, clientRequestId: string) {
    return this.idempotent(clientRequestId, () => this.withLock(threadId, async () => {
      const runtime = this.runtimes.get(threadId);
      if (runtime.activeTurnId) throw new Error("A turn is already active; use steer instead");
      const mapping = this.requireMapping(threadId);
      const project = this.requireProject(mapping.project_id);
      const settings = this.resolveSettings(project.id, input, threadId);
      const response = await this.adapter.startTurn(threadId, mapping.cwd_snapshot ?? project.canonicalPath, text, settings, input.clientUserMessageId);
      this.settings.set(threadId, settings);
      this.upsertSnapshotTurn(threadId, response.turn);
      this.runtimes.setActiveTurn(threadId, response.turn.id);
      return response;
    }));
  }

  async steer(threadId: string, text: string, expectedTurnId: string, clientUserMessageId: string, clientRequestId: string) {
    return this.idempotent(clientRequestId, () => this.withLock(threadId, async () => {
      const runtime = this.runtimes.get(threadId);
      if (!runtime.activeTurnId || runtime.activeTurnId !== expectedTurnId) throw new SteerConflictError();
      try {
        return await this.adapter.steerTurn(threadId, expectedTurnId, text, clientUserMessageId);
      } catch (error) {
        if (error instanceof JsonRpcError) throw new SteerConflictError();
        throw error;
      }
    }));
  }

  async interrupt(threadId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      const activeTurnId = this.runtimes.get(threadId).activeTurnId;
      if (activeTurnId) await this.adapter.interruptTurn(threadId, activeTurnId);
    });
  }

  async fork(threadId: string, lastTurnId: string | null, inheritGoal: boolean, clientRequestId: string) {
    return this.idempotent(clientRequestId, () => this.withLock(threadId, async () => {
      const mapping = this.requireMapping(threadId);
      const settings = this.getSettings(threadId);
      const response = await this.adapter.forkSession(threadId, lastTurnId, settings, false, mapping.cwd_snapshot ?? this.requireProject(mapping.project_id).canonicalPath);
      this.settings.set(response.thread.id, settings);
      this.sessionSnapshots.set(response.thread.id, response.thread);
      const now = Date.now();
      this.repositories.upsertProjectSession({
        thread_id: response.thread.id, project_id: mapping.project_id,
        cwd_snapshot: response.thread.cwd, source_kind: "appServer", origin: "forked",
        parent_thread_id: threadId, fork_turn_id: lastTurnId, added_at: now, last_seen_at: now,
      });
      if (inheritGoal) {
        const goal = await this.adapter.getGoal(threadId);
        if (goal) await this.adapter.setGoal({ threadId: response.thread.id, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget });
      } else {
        await this.adapter.clearGoal(response.thread.id).catch(() => undefined);
      }
      return { thread: response.thread, settings };
    }));
  }

  async createSideChat(parentThreadId: string, anchorTurnId: string | null) {
    const existing = this.runtimes.listSideChats().find((sideChat) => sideChat.parentThreadId === parentThreadId);
    if (existing) return existing;
    const settings = this.getSettings(parentThreadId);
    const mapping = this.requireMapping(parentThreadId);
    const cwd = mapping.cwd_snapshot ?? this.requireProject(mapping.project_id).canonicalPath;
    let response;
    try {
      response = await this.adapter.createSideChat(parentThreadId, anchorTurnId, settings, cwd);
    } catch (error) {
      if (!(error instanceof JsonRpcError) || !error.message.includes("no rollout found")) throw error;
      response = await this.adapter.createEmptySideChat(cwd, settings);
    }
    this.settings.set(response.thread.id, settings);
    this.sessionSnapshots.set(response.thread.id, response.thread);
    const runtime: SideChatRuntime = {
      threadId: response.thread.id,
      parentThreadId,
      ...(anchorTurnId ? { anchorTurnId } : {}),
      state: "idle",
      activeFlags: [],
      pendingRequestIds: [],
      createdAt: Date.now(),
    };
    this.runtimes.registerSideChat(runtime);
    return runtime;
  }

  async closeSideChat(threadId: string): Promise<void> {
    const sideChat = this.runtimes.getSideChat(threadId);
    if (!sideChat) return;
    if (sideChat.activeTurnId) {
      await this.adapter.interruptTurn(threadId, sideChat.activeTurnId).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.adapter.unsubscribe(threadId).catch(() => undefined);
    this.settings.delete(threadId);
    this.sessionSnapshots.delete(threadId);
    this.runtimes.removeSideChat(threadId);
  }

  async respondPendingRequest(requestId: string, allow: boolean): Promise<void> {
    const request = this.runtimes.getPendingRequest(requestId);
    if (!request) throw new Error("Pending request not found");
    let result: unknown;
    if (request.method.includes("requestApproval") || request.method === "applyPatchApproval" || request.method === "execCommandApproval") {
      result = { decision: allow ? "accept" : "decline" };
    } else if (request.method === "mcpServer/elicitation/request") {
      result = { action: allow ? "accept" : "decline", content: null, _meta: null };
    } else if (request.method === "item/tool/requestUserInput") {
      result = { answers: {} };
    } else {
      result = { success: false, contentItems: [] };
    }
    this.adapter.respondToServerRequest(request, result);
    this.runtimes.resolveServerRequest(requestId);
  }

  private resolveSettings(projectId: string, input: TurnSettings, threadId?: string) {
    const project = this.requireProject(projectId);
    const current = threadId ? this.settings.get(threadId) : undefined;
    return {
      model: input.model ?? current?.model ?? project.defaultModel,
      reasoning: input.reasoning ?? current?.reasoning ?? project.defaultReasoning,
      accessMode: input.accessMode ?? current?.accessMode ?? project.defaultAccessMode,
    };
  }

  private getSettings(threadId: string) {
    const current = this.settings.get(threadId);
    if (current) return current;
    const mapping = this.requireMapping(threadId);
    return this.resolveSettings(mapping.project_id, {});
  }

  private requireProject(projectId: string) {
    const project = this.repositories.getProject(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }

  private requireMapping(threadId: string): ProjectSessionRow {
    const mapping = this.repositories.getProjectSession(threadId);
    if (!mapping) {
      const sideChat = this.runtimes.getSideChat(threadId);
      if (sideChat) return this.requireMapping(sideChat.parentThreadId);
      throw new Error("Session is not mapped to a project");
    }
    return mapping;
  }

  private withLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    this.locks.set(threadId, next.finally(() => {
      if (this.locks.get(threadId) === next) this.locks.delete(threadId);
    }));
    return next;
  }

  private idempotent<T>(key: string, action: () => Promise<T>): Promise<T> {
    const existing = this.idempotentResults.get(key);
    if (existing) return existing as Promise<T>;
    const promise = action();
    this.idempotentResults.set(key, promise);
    setTimeout(() => this.idempotentResults.delete(key), 5 * 60_000).unref();
    return promise;
  }

  private updateSessionSnapshot(notification: AdapterNotification): void {
    const params = (notification.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (!threadId || !this.sessionSnapshots.has(threadId)) return;
    if ((notification.method === "turn/started" || notification.method === "turn/completed") && this.isSnapshotTurn(params.turn)) {
      this.upsertSnapshotTurn(threadId, params.turn);
      return;
    }
    if ((notification.method === "item/started" || notification.method === "item/completed") && typeof params.turnId === "string" && this.isSnapshotItem(params.item)) {
      this.upsertSnapshotItem(threadId, params.turnId, params.item);
    }
  }

  private upsertSnapshotTurn(threadId: string, turn: SnapshotTurn): void {
    const snapshot = this.sessionSnapshots.get(threadId);
    if (!snapshot) return;
    const turns = [...snapshot.turns];
    const index = turns.findIndex((candidate) => candidate.id === turn.id);
    if (index < 0) turns.push(turn);
    else turns[index] = turn;
    this.sessionSnapshots.set(threadId, { ...snapshot, turns, updatedAt: Math.floor(Date.now() / 1_000) });
  }

  private upsertSnapshotItem(threadId: string, turnId: string, item: SnapshotItem): void {
    const snapshot = this.sessionSnapshots.get(threadId);
    if (!snapshot) return;
    const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
    if (!turn) return;
    const items = [...turn.items];
    const index = items.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) items.push(item);
    else items[index] = item;
    this.upsertSnapshotTurn(threadId, { ...turn, items });
  }

  private isSnapshotTurn(value: unknown): value is SnapshotTurn {
    return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && Array.isArray((value as { items?: unknown }).items);
  }

  private isSnapshotItem(value: unknown): value is SnapshotItem {
    return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { type?: unknown }).type === "string";
  }
}

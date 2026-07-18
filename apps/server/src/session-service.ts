import { randomUUID } from "node:crypto";
import { mergeStreamingText, type AccessMode, type SessionSummary, type SideChatRuntime } from "@codex-web/shared-types";
import { CodexAdapter, isThreadMaterializationRace, JsonRpcError, type AdapterEvent, type AdapterPendingRequest, type SessionSettings } from "@codex-web/codex-adapter";
import { Repositories, type ProjectSessionRow } from "./database.js";
import { ProjectIndexer } from "./project-indexer.js";
import { ThreadRuntimeRegistry } from "./runtime-registry.js";
import { KeyedOperationLock } from "./keyed-operation-lock.js";

export class SteerConflictError extends Error {
  constructor() { super("The active turn finished before the steer message could be sent"); }
}

export class ForkBoundaryError extends Error {
  constructor(message: string) { super(message); }
}

export class ActiveTurnConflictError extends Error {
  constructor(operation: string) { super(`${operation} is unavailable while a Turn is active`); }
}

export function isUnmaterializedSessionReadError(error: unknown): boolean {
  return isThreadMaterializationRace(error);
}

export function isSteerTurnConflictError(error: unknown): boolean {
  if (!(error instanceof JsonRpcError)) return false;
  return /no active turn|active turn.*(?:not found|finished|completed)|expected.?turn.?id.*(?:mismatch|does not match)|turn\b.*\bis not active/i.test(error.message);
}

function sessionSummaryMatchesSearch(summary: Pick<SessionSummary, "title" | "preview">, search: string | undefined): boolean {
  const term = search?.trim().toLocaleLowerCase();
  if (!term) return true;
  return `${summary.title}\n${summary.preview}`.toLocaleLowerCase().includes(term);
}

interface TurnSettings { model?: string | null; reasoning?: string | null; accessMode?: AccessMode }
interface ProjectSettings { defaultModel: string | null; defaultReasoning: string | null; defaultAccessMode: AccessMode }
type SessionSnapshot = Awaited<ReturnType<CodexAdapter["readSession"]>>;
type SnapshotTurn = SessionSnapshot["turns"][number];
type SnapshotItem = SnapshotTurn["items"][number];

function terminalizeSnapshotItem(item: SnapshotItem, turnStatus: SnapshotTurn["status"]): SnapshotItem {
  if (turnStatus === "inProgress" || !("status" in item) || item.status !== "inProgress") return item;
  return { ...item, status: turnStatus === "completed" ? "completed" : turnStatus };
}

function terminalizeSnapshotTurn(turn: SnapshotTurn): SnapshotTurn {
  if (turn.status === "inProgress") return turn;
  return { ...turn, items: turn.items.map((item) => terminalizeSnapshotItem(item, turn.status)) };
}

function terminalizeSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return { ...snapshot, turns: snapshot.turns.map(terminalizeSnapshotTurn) };
}

export function assertValidForkBoundary(turns: SnapshotTurn[], lastTurnId: string | null): void {
  if (lastTurnId === null) throw new ForkBoundaryError("A completed Turn boundary is required for a non-empty Fork");
  const turn = turns.find((candidate) => candidate.id === lastTurnId);
  if (!turn) throw new ForkBoundaryError("Fork boundary Turn was not found in this Session");
  if (turn.status !== "completed") throw new ForkBoundaryError("Only a completed Turn can be used as a Fork boundary");
}

export function resolveSessionSettings(project: ProjectSettings, input: TurnSettings, current?: { model: string | null; reasoning: string | null; accessMode: AccessMode }) {
  return {
    model: input.model ?? current?.model ?? project.defaultModel,
    reasoning: input.reasoning ?? current?.reasoning ?? project.defaultReasoning,
    accessMode: input.accessMode ?? current?.accessMode ?? project.defaultAccessMode,
  };
}

function stableValue(value: unknown, key?: string): unknown {
  if (key && new Set(["id", "clientId", "processId", "status", "durationMs", "aggregatedOutput", "exitCode", "result", "error", "contentItems", "success", "memoryCitation", "agentsStates"]).has(key)) return undefined;
  if (Array.isArray(value)) return value.map((item) => stableValue(item)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).flatMap(([childKey, childValue]) => {
      const normalized = stableValue(childValue, childKey);
      return normalized === undefined ? [] : [[childKey, normalized]];
    }));
  }
  return value;
}

function snapshotItemKey(item: SnapshotItem): string {
  if (item.type === "userMessage") return `user:${JSON.stringify(item.content)}`;
  if (item.type === "agentMessage") return `agent:${item.phase ?? ""}:${item.text}`;
  if (item.type === "plan") return `plan:${item.text}`;
  if (item.type === "reasoning") return `reasoning:${JSON.stringify([item.summary, item.content])}`;
  if (item.type === "commandExecution") return `command:${item.cwd}:${item.command}`;
  if (item.type === "fileChange") return `files:${JSON.stringify(item.changes.map((change) => stableValue(change)))}`;
  if (item.type === "mcpToolCall") return `mcp:${item.server}:${item.tool}`;
  if (item.type === "genericToolCall") return `generic:${item.title}`;
  return JSON.stringify(stableValue(item));
}

function occurrenceKeys(items: SnapshotItem[], sharedIdentities: Set<string>): string[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const identity = `${item.type}\u0000${item.id}`;
    if (sharedIdentities.has(identity)) return `id:${identity}`;
    const key = snapshotItemKey(item);
    const occurrence = (counts.get(key) ?? 0) + 1;
    counts.set(key, occurrence);
    return `${key}\u0000${occurrence}`;
  });
}

function commonItemPairs(primary: SnapshotItem[], supplemental: SnapshotItem[]): Array<[number, number]> {
  const supplementalIdentities = new Set(supplemental.map((item) => `${item.type}\u0000${item.id}`));
  const sharedIdentities = new Set(primary.map((item) => `${item.type}\u0000${item.id}`).filter((identity) => supplementalIdentities.has(identity)));
  const left = occurrenceKeys(primary, sharedIdentities); const right = occurrenceKeys(supplemental, sharedIdentities);
  const lengths = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex]![rightIndex] = left[leftIndex] === right[rightIndex]
        ? lengths[leftIndex + 1]![rightIndex + 1]! + 1
        : Math.max(lengths[leftIndex + 1]![rightIndex]!, lengths[leftIndex]![rightIndex + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let leftIndex = 0; let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) { pairs.push([leftIndex, rightIndex]); leftIndex += 1; rightIndex += 1; }
    else if (lengths[leftIndex + 1]![rightIndex]! >= lengths[leftIndex]![rightIndex + 1]!) leftIndex += 1;
    else rightIndex += 1;
  }
  return pairs;
}

function itemRichness(item: SnapshotItem): number {
  if (item.type === "commandExecution") return (item.aggregatedOutput?.length ?? 0) + (item.exitCode !== null ? 1_000 : 0) + (item.durationMs !== null ? 100 : 0) + (item.status === "completed" ? 10 : 0);
  if (item.type === "fileChange") return item.changes.reduce((total, change) => total + (change.diff?.length ?? 0), 0) + (item.status === "completed" ? 10 : 0);
  if (item.type === "mcpToolCall") return (item.durationMs !== null ? 100 : 0) + (item.status === "completed" ? 10 : 0);
  if (item.type === "genericToolCall") return item.title.length + (item.status === "completed" ? 10 : 0);
  return JSON.stringify(item).length;
}

function richerItem(primary: SnapshotItem, supplemental: SnapshotItem): SnapshotItem {
  if (primary.type === "commandExecution" && supplemental.type === "commandExecution") {
    return mergeCommandExecution(supplemental, primary);
  }
  return itemRichness(primary) >= itemRichness(supplemental) ? primary : supplemental;
}

function mergeCommandExecution(
  previous: Extract<SnapshotItem, { type: "commandExecution" }>,
  incoming: Extract<SnapshotItem, { type: "commandExecution" }>,
): Extract<SnapshotItem, { type: "commandExecution" }> {
  return {
    ...previous,
    ...incoming,
    aggregatedOutput: mergeStreamingText(previous.aggregatedOutput, incoming.aggregatedOutput) || null,
  };
}

function mergeSnapshotItems(primary: SnapshotItem[], supplemental: SnapshotItem[]): SnapshotItem[] {
  const merged: SnapshotItem[] = [];
  let primaryIndex = 0; let supplementalIndex = 0;
  for (const [primaryAnchor, supplementalAnchor] of commonItemPairs(primary, supplemental)) {
    merged.push(...supplemental.slice(supplementalIndex, supplementalAnchor));
    merged.push(...primary.slice(primaryIndex, primaryAnchor));
    const primaryItem = primary[primaryAnchor]!;
    const supplementalItem = supplemental[supplementalAnchor]!;
    merged.push(primaryItem.type === "plan" && supplementalItem.type === "plan" ? supplementalItem : richerItem(primaryItem, supplementalItem));
    primaryIndex = primaryAnchor + 1; supplementalIndex = supplementalAnchor + 1;
  }
  merged.push(...supplemental.slice(supplementalIndex));
  merged.push(...primary.slice(primaryIndex));
  return merged;
}

export function mergeSessionSnapshot(primary: SessionSnapshot, supplemental: SessionSnapshot): SessionSnapshot {
  if (primary.id !== supplemental.id) return terminalizeSessionSnapshot(primary);
  const primaryTurns = new Map(primary.turns.map((turn) => [turn.id, turn]));
  const seen = new Set<string>();
  const turns = supplemental.turns.map((turn) => {
    seen.add(turn.id);
    const current = primaryTurns.get(turn.id);
    return current ? { ...current, items: mergeSnapshotItems(current.items, turn.items) } : turn;
  });
  for (const turn of primary.turns) if (!seen.has(turn.id)) turns.push(turn);
  return terminalizeSessionSnapshot({ ...primary, turns });
}

export class SessionService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly idempotentResults = new Map<string, Promise<unknown>>();
  private readonly userMessageResults = new Map<string, Promise<unknown>>();
  private readonly settings = new Map<string, SessionSettings>();
  private readonly sessionSnapshots = new Map<string, SessionSnapshot>();
  private readonly commandOutputDeltas = new Map<string, string>();
  private readonly goalPresence = new Map<string, boolean>();
  private readonly goalPresenceLoading = new Set<string>();
  private readonly removedThreads = new Set<string>();
  private readonly sessionGenerations = new Map<string, number>();

  constructor(
    private readonly repositories: Repositories,
    private readonly adapter: CodexAdapter,
    private readonly indexer: ProjectIndexer,
    private readonly runtimes: ThreadRuntimeRegistry,
    private readonly projectLocks = new KeyedOperationLock(),
  ) {}

  async listSessions(options: { projectId?: string; search?: string; sortDirection?: "asc" | "desc" } = {}): Promise<SessionSummary[]> {
    const mappings = this.repositories.listProjectSessions(options.projectId);
    if (!mappings.length) return [];
    for (const mapping of mappings) this.restoreSession(mapping.thread_id);
    void this.ensureGoalPresence(mappings.map((mapping) => mapping.thread_id));
    const mapped = new Map(mappings.map((item) => [item.thread_id, item]));
    const threads = [];
    let cursor: string | null = null;
    do {
      const page = await this.adapter.listSessions({ cursor, limit: 100, sortDirection: options.sortDirection ?? "desc", searchTerm: options.search });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    await this.ensureForkSnapshots(mappings);
    const seen = new Set<string>();
    const threadById = new Map(threads.map((thread) => [thread.id, thread]));
    const summaries = threads.flatMap((thread): SessionSummary[] => {
      const mapping = mapped.get(thread.id);
      if (!mapping) return [];
      seen.add(thread.id);
      const forkSource = mapping.parent_thread_id ? threadById.get(mapping.parent_thread_id) : undefined;
      const sourceSnapshot = mapping.parent_thread_id ? this.sessionSnapshots.get(mapping.parent_thread_id) : undefined;
      const childSnapshot = this.sessionSnapshots.get(thread.id);
      const boundaryTurns = sourceSnapshot?.turns ?? childSnapshot?.turns ?? [];
      const forkTurnIndex = mapping.fork_turn_id ? boundaryTurns.findIndex((turn) => turn.id === mapping.fork_turn_id) : -1;
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
        forkSourceTitle: forkSource?.name || forkSource?.preview || sourceSnapshot?.name || sourceSnapshot?.preview || null,
        forkTurnNumber: forkTurnIndex >= 0 ? forkTurnIndex + 1 : null,
        runtimeState: this.runtimes.get(thread.id).state,
        hasGoal: this.goalPresence.get(thread.id) ?? false,
      }];
    });
    for (const mapping of mappings) {
      if (seen.has(mapping.thread_id)) continue;
      const snapshot = this.sessionSnapshots.get(mapping.thread_id);
      if (!snapshot) continue;
      const snapshotForkTurnIndex = mapping.fork_turn_id ? snapshot.turns.findIndex((turn) => turn.id === mapping.fork_turn_id) : -1;
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
        forkSourceTitle: mapping.parent_thread_id
          ? threadById.get(mapping.parent_thread_id)?.name || threadById.get(mapping.parent_thread_id)?.preview || this.sessionSnapshots.get(mapping.parent_thread_id)?.name || this.sessionSnapshots.get(mapping.parent_thread_id)?.preview || null
          : null,
        forkTurnNumber: snapshotForkTurnIndex >= 0 ? snapshotForkTurnIndex + 1 : null,
        runtimeState: this.runtimes.get(snapshot.id).state,
        hasGoal: this.goalPresence.get(snapshot.id) ?? false,
      });
    }
    return summaries
      .filter((summary) => sessionSummaryMatchesSearch(summary, options.search))
      .sort((left, right) => (options.sortDirection === "asc" ? 1 : -1) * (left.updatedAt - right.updatedAt));
  }

  readSession(threadId: string) {
    return this.withLock(threadId, () => this.readSessionUnlocked(threadId));
  }

  private async readSessionUnlocked(threadId: string) {
    const sideChat = this.runtimes.getSideChat(threadId);
    const sideChatSnapshot = sideChat ? this.sessionSnapshots.get(threadId) : undefined;
    if (sideChatSnapshot) {
      return { thread: sideChatSnapshot, goal: null, runtime: this.runtimes.get(threadId), settings: this.getSettings(threadId) };
    }
    this.requireMapping(threadId);
    this.restoreSession(threadId);
    await this.resumeWithPreferredSettings(threadId);
    const [persistedThread, goal] = await Promise.all([
      this.adapter.readSession(threadId).catch((error) => {
        const snapshot = this.sessionSnapshots.get(threadId);
        if (snapshot && isUnmaterializedSessionReadError(error)) return snapshot;
        throw error;
      }),
      this.adapter.getGoal(threadId),
    ]);
    const snapshot = this.sessionSnapshots.get(threadId);
    const thread = snapshot ? mergeSessionSnapshot(persistedThread, snapshot) : terminalizeSessionSnapshot(persistedThread);
    this.sessionSnapshots.set(threadId, thread);
    this.goalPresence.set(threadId, goal !== null);
    if (this.runtimes.get(threadId).state === "disconnected") this.runtimes.reconcileFromSnapshot(threadId, thread.turns);
    return { thread, goal, runtime: this.runtimes.get(threadId), settings: this.getSettings(threadId) };
  }

  async markViewed(threadId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      this.requireMapping(threadId);
      this.runtimes.markViewed(threadId);
    });
  }

  async rename(threadId: string, name: string): Promise<void> {
    this.assertPersistentSession(threadId, "rename");
    return this.withLock(threadId, async () => {
      this.requireMapping(threadId);
      this.assertNoActiveTurn(threadId, "Rename");
      await this.adapter.renameSession(threadId, name);
    });
  }

  async archive(threadId: string): Promise<void> {
    this.assertPersistentSession(threadId, "archive");
    return this.withLock(threadId, async () => {
      this.requireMapping(threadId);
      this.assertNoActiveTurn(threadId, "Archive");
      const sideChat = this.runtimes.listSideChats().find((candidate) => candidate.parentThreadId === threadId);
      if (sideChat) {
        await this.withLock(sideChat.threadId, async () => {
          this.assertNoActiveTurn(sideChat.threadId, "Archive");
          await this.closeSideChatUnlocked(sideChat.threadId);
        });
      }
      let reason = "archived";
      this.indexer.markSessionArchived?.(threadId);
      try {
        await this.adapter.archiveSession(threadId);
      } catch (error) {
        if (!isUnmaterializedSessionReadError(error) && (!(error instanceof JsonRpcError) || !error.message.includes("no rollout found"))) {
          this.indexer.restoreSessionDiscovery?.(threadId);
          throw error;
        }
        reason = "archived-unmaterialized";
        await this.adapter.unsubscribe(threadId).catch(() => undefined);
      }
      this.repositories.removeProjectSession(threadId);
      this.clearSessionCaches(threadId);
      this.runtimes.notifySessionSummaryUpdated(threadId, reason);
    });
  }

  async moveToProject(threadId: string, projectId: string): Promise<ProjectSessionRow> {
    this.assertPersistentSession(threadId, "move between Projects");
    const sourceProjectId = this.requireMapping(threadId).project_id;
    return this.projectLocks.withKeys([sourceProjectId, projectId], () => this.withLock(threadId, async () => {
      this.assertNoActiveTurn(threadId, "Move to Project");
      const current = this.requireMapping(threadId);
      if (current.project_id !== sourceProjectId) throw new Error("Session Project changed while moving; retry the operation");
      this.requireProject(projectId);
      return this.repositories.moveProjectSession(threadId, projectId);
    }));
  }

  async removeProject(projectId: string): Promise<void> {
    return this.projectLocks.withKey(projectId, async () => {
      const mappings = this.repositories.listProjectSessions(projectId);
      const mappedThreadIds = new Set(mappings.map((mapping) => mapping.thread_id));
      return this.withLocks([...mappedThreadIds].sort(), async () => {
        const relatedSideChats = this.runtimes.listSideChats().filter((sideChat) => mappedThreadIds.has(sideChat.parentThreadId));
        return this.withLocks(relatedSideChats.map((sideChat) => sideChat.threadId).sort(), async () => {
          for (const mapping of mappings) this.assertNoActiveTurn(mapping.thread_id, "Remove Project");
          for (const sideChat of relatedSideChats) this.assertNoActiveTurn(sideChat.threadId, "Remove Project");
          for (const sideChat of relatedSideChats) await this.closeSideChatUnlocked(sideChat.threadId);
          await Promise.all(mappings.map((mapping) => this.adapter.unsubscribe?.(mapping.thread_id).catch(() => undefined)));

          const preferences = this.repositories.getPreferences();
          this.repositories.deleteProject(projectId);
          for (const mapping of mappings) this.clearSessionCaches(mapping.thread_id);
          const changes: Partial<typeof preferences> = {};
          if (preferences.lastProjectId === projectId) changes.lastProjectId = null;
          if (preferences.lastThreadId && mappedThreadIds.has(preferences.lastThreadId)) changes.lastThreadId = null;
          if (preferences.fullAccessNoticeSeenProjects.includes(projectId)) {
            changes.fullAccessNoticeSeenProjects = preferences.fullAccessNoticeSeenProjects.filter((id) => id !== projectId);
          }
          if (Object.keys(changes).length) this.repositories.setPreferences(changes);
        });
      });
    });
  }

  async createSession(projectId: string, input: TurnSettings, clientRequestId: string) {
    return this.idempotent(`project:${projectId}:create`, clientRequestId, () => this.projectLocks.withKey(projectId, async () => {
      const project = this.requireProject(projectId);
      const settings = this.resolveSettings(projectId, input);
      const response = await this.adapter.startSession(project.canonicalPath, settings);
      this.settings.set(response.thread.id, settings);
      this.sessionSnapshots.set(response.thread.id, response.thread);
      try {
        const now = Date.now();
        this.repositories.upsertProjectSession({
          thread_id: response.thread.id, project_id: projectId, cwd_snapshot: project.canonicalPath,
          source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null,
          added_at: now, last_seen_at: now,
        });
      } catch (error) {
        this.clearSessionCaches(response.thread.id);
        await this.adapter.archiveSession(response.thread.id).catch(() => undefined);
        throw error;
      }
      this.restoreSession(response.thread.id);
      return { thread: response.thread, settings };
    }));
  }

  async startTurn(threadId: string, text: string, input: TurnSettings & { clientUserMessageId: string }, clientRequestId: string) {
    return this.idempotentUserMessage(threadId, "turn", input.clientUserMessageId, clientRequestId, () => this.withLock(threadId, async () => {
      const runtime = this.runtimes.get(threadId);
      if (runtime.activeTurnId) throw new ActiveTurnConflictError("Starting another Turn");
      const mapping = this.requireMapping(threadId);
      const project = this.requireProject(mapping.project_id);
      await this.ensureSessionSettings(threadId);
      const settings = this.resolveSettings(project.id, input, threadId);
      const response = await this.adapter.startTurn(threadId, mapping.cwd_snapshot ?? project.canonicalPath, text, settings, input.clientUserMessageId);
      this.settings.set(threadId, settings);
      this.upsertSnapshotTurn(threadId, response.turn);
      this.runtimes.setActiveTurn(threadId, response.turn.id);
      return response;
    }));
  }

  async steer(threadId: string, text: string, expectedTurnId: string, clientUserMessageId: string, clientRequestId: string) {
    return this.idempotentUserMessage(threadId, "steer", clientUserMessageId, clientRequestId, () => this.withLock(threadId, async () => {
      const runtime = this.runtimes.get(threadId);
      if (!runtime.activeTurnId || runtime.activeTurnId !== expectedTurnId) throw new SteerConflictError();
      try {
        return await this.adapter.steerTurn(threadId, expectedTurnId, text, clientUserMessageId);
      } catch (error) {
        if (isSteerTurnConflictError(error)) throw new SteerConflictError();
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

  async fork(threadId: string, lastTurnId: string | null, inheritGoal: boolean, clientRequestId: string, empty = false) {
    this.assertPersistentSession(threadId, "Fork");
    const sourceProjectId = this.requireMapping(threadId).project_id;
    return this.idempotent(`thread:${threadId}:fork`, clientRequestId, () => this.projectLocks.withKey(sourceProjectId, () => this.withLock(threadId, async () => {
      const mapping = this.requireMapping(threadId);
      if (mapping.project_id !== sourceProjectId) throw new Error("Session Project changed while forking; retry the operation");
      const settings = await this.ensureSessionSettings(threadId);
      const cwd = mapping.cwd_snapshot ?? this.requireProject(mapping.project_id).canonicalPath;
      let response;
      if (empty) {
        if (lastTurnId !== null) throw new ForkBoundaryError("An empty Fork cannot include a Turn boundary");
        response = await this.adapter.startSession(cwd, settings);
      } else {
        const source = await this.readSessionUnlocked(threadId);
        assertValidForkBoundary(source.thread.turns, lastTurnId);
        response = await this.adapter.forkSession(threadId, lastTurnId, settings, false, cwd);
      }
      this.settings.set(response.thread.id, settings);
      this.sessionSnapshots.set(response.thread.id, response.thread);
      try {
        if (inheritGoal) {
          const goal = await this.adapter.getGoal(threadId);
          if (goal) await this.adapter.setGoal({ threadId: response.thread.id, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget });
        } else {
          await this.adapter.clearGoal(response.thread.id);
        }
      } catch (error) {
        this.settings.delete(response.thread.id);
        this.sessionSnapshots.delete(response.thread.id);
        await this.adapter.archiveSession(response.thread.id).catch(() => undefined);
        throw error;
      }
      const now = Date.now();
      this.repositories.upsertProjectSession({
        thread_id: response.thread.id, project_id: mapping.project_id,
        cwd_snapshot: response.thread.cwd, source_kind: "appServer", origin: "forked",
        parent_thread_id: threadId, fork_turn_id: lastTurnId, added_at: now, last_seen_at: now,
      });
      this.restoreSession(response.thread.id);
      return { thread: response.thread, settings };
    })));
  }

  handlePendingRequest(request: AdapterPendingRequest): void {
    this.runtimes.handlePendingRequest(request);
  }

  handleEvent(event: AdapterEvent): void {
    this.updateSessionSnapshot(event);
  }

  async reconcileAfterReconnect(): Promise<void> {
    const sideChats = this.runtimes.listSideChats();
    const sideChatIds = new Set(sideChats.map((sideChat) => sideChat.threadId));
    await Promise.all(sideChats.map((sideChat) => this.withLock(sideChat.threadId, async () => {
      this.settings.delete(sideChat.threadId);
      this.sessionSnapshots.delete(sideChat.threadId);
      this.markSessionRemoved(sideChat.threadId);
      this.runtimes.removeSideChat(sideChat.threadId);
    })));
    const disconnected = this.runtimes.list().filter((runtime) => runtime.state === "disconnected" && !sideChatIds.has(runtime.threadId));
    await Promise.all(disconnected.map((runtime) => this.withLock(runtime.threadId, async () => {
      try {
        await this.resumeWithPreferredSettings(runtime.threadId);
        const snapshot = await this.adapter.readSession(runtime.threadId);
        this.sessionSnapshots.set(runtime.threadId, snapshot);
        this.runtimes.reconcileFromSnapshot(runtime.threadId, snapshot.turns);
      } catch {
        // The previous Turn's outcome is unknown after an App Server crash.
        // Keep the explicit disconnected state until a later successful read.
      }
    })));
  }

  async createSideChat(parentThreadId: string, anchorTurnId: string | null) {
    this.assertPersistentSession(parentThreadId, "nested Side Chat");
    return this.withLocks([parentThreadId, `side-chat:${parentThreadId}`], async () => {
      const existing = this.runtimes.listSideChats().find((sideChat) => sideChat.parentThreadId === parentThreadId);
      if (existing) return existing;
      if (anchorTurnId) {
        const source = await this.readSessionUnlocked(parentThreadId);
        assertValidForkBoundary(source.thread.turns, anchorTurnId);
      }
      const settings = await this.ensureSessionSettings(parentThreadId);
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
      this.restoreSession(response.thread.id);
      this.runtimes.registerSideChat(runtime);
      return runtime;
    });
  }

  async closeSideChat(threadId: string): Promise<void> {
    return this.withLock(threadId, () => this.closeSideChatUnlocked(threadId));
  }

  private async closeSideChatUnlocked(threadId: string): Promise<void> {
    const sideChat = this.runtimes.getSideChat(threadId);
    if (!sideChat) return;
    if (sideChat.activeTurnId) {
      await this.adapter.interruptTurn(threadId, sideChat.activeTurnId);
      const stopped = await this.runtimes.waitForTerminal(threadId, 10_000);
      if (!stopped) throw new Error("Side Chat Turn did not stop before the close timeout");
    }
    await this.adapter.unsubscribe(threadId);
    this.settings.delete(threadId);
    this.sessionSnapshots.delete(threadId);
    this.markSessionRemoved(threadId);
    this.runtimes.removeSideChat(threadId);
  }

  getGoal(threadId: string) {
    this.assertPersistentSession(threadId, "Goal");
    return this.withLock(threadId, async () => {
      this.requireMapping(threadId);
      return this.adapter.getGoal(threadId);
    });
  }

  async setGoal(params: Parameters<CodexAdapter["setGoal"]>[0]) {
    this.assertPersistentSession(params.threadId, "Goal");
    return this.withLock(params.threadId, async () => {
      this.requireMapping(params.threadId);
      this.assertNoActiveTurn(params.threadId, "Goal update");
      return this.adapter.setGoal(params);
    });
  }

  async clearGoal(threadId: string): Promise<void> {
    this.assertPersistentSession(threadId, "Goal");
    return this.withLock(threadId, async () => {
      this.requireMapping(threadId);
      this.assertNoActiveTurn(threadId, "Goal clear");
      await this.adapter.clearGoal(threadId);
    });
  }

  private assertNoActiveTurn(threadId: string, operation: string): void {
    const runtime = this.runtimes.get(threadId);
    if (runtime.activeTurnId || runtime.state === "running" || runtime.state === "waitingForInput") throw new ActiveTurnConflictError(operation);
  }

  async respondPendingRequest(requestId: string, allow: boolean, answers: Record<string, string[]> = {}): Promise<void> {
    this.adapter.respondPendingRequest(requestId, allow, answers);
    this.runtimes.resolveServerRequest(requestId);
  }

  private resolveSettings(projectId: string, input: TurnSettings, threadId?: string) {
    const project = this.requireProject(projectId);
    const current = threadId ? this.settings.get(threadId) : undefined;
    return resolveSessionSettings(project, input, current);
  }

  private getSettings(threadId: string) {
    const current = this.settings.get(threadId);
    if (current) return current;
    return this.projectDefaults(threadId);
  }

  private async ensureSessionSettings(threadId: string): Promise<SessionSettings> {
    const current = this.settings.get(threadId);
    if (current) return current;
    return (await this.resumeWithPreferredSettings(threadId)).settings;
  }

  private projectDefaults(threadId: string): SessionSettings {
    const mapping = this.requireMapping(threadId);
    return resolveSessionSettings(this.requireProject(mapping.project_id), {});
  }

  private async resumeWithPreferredSettings(threadId: string) {
    const current = this.settings.get(threadId);
    let resumed;
    try {
      resumed = current
        ? await this.adapter.resumeSession(threadId, current)
        : await this.adapter.resumeSession(threadId);
    } catch (error) {
      const snapshot = this.sessionSnapshots.get(threadId);
      if (!current || !snapshot || !isUnmaterializedSessionReadError(error)) throw error;
      return { thread: snapshot, settings: current };
    }
    const mapping = this.requireMapping(threadId);
    const settings = resolveSessionSettings(this.requireProject(mapping.project_id), {}, current ?? resumed.settings);
    this.settings.set(threadId, settings);
    return { ...resumed, settings };
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

  private assertPersistentSession(threadId: string, capability: string): void {
    if (this.runtimes.getSideChat(threadId)) throw new Error(`Side Chat does not support ${capability}`);
  }

  private clearSessionCaches(threadId: string): void {
    this.settings.delete(threadId);
    this.sessionSnapshots.delete(threadId);
    this.goalPresence.delete(threadId);
    this.goalPresenceLoading.delete(threadId);
    for (const key of this.commandOutputDeltas.keys()) {
      if (key.startsWith(`${threadId}\u0000`)) this.commandOutputDeltas.delete(key);
    }
    this.markSessionRemoved(threadId);
    this.runtimes.removeThread(threadId);
  }

  private restoreSession(threadId: string): void {
    this.removedThreads.delete(threadId);
    this.runtimes.restoreThread?.(threadId);
  }

  private markSessionRemoved(threadId: string): void {
    this.removedThreads.add(threadId);
    this.sessionGenerations.set(threadId, (this.sessionGenerations.get(threadId) ?? 0) + 1);
  }

  private withLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(threadId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const tracked = next.then(() => undefined, () => undefined).finally(() => {
      if (this.locks.get(threadId) === tracked) this.locks.delete(threadId);
    });
    this.locks.set(threadId, tracked);
    return next;
  }

  private withLocks<T>(threadIds: string[], action: () => Promise<T>): Promise<T> {
    const [threadId, ...rest] = [...new Set(threadIds)];
    return threadId ? this.withLock(threadId, () => this.withLocks(rest, action)) : action();
  }

  private idempotent<T>(scope: string, clientRequestId: string, action: () => Promise<T>): Promise<T> {
    const key = `${scope}\u0000${clientRequestId}`;
    const existing = this.idempotentResults.get(key);
    if (existing) return existing as Promise<T>;
    const promise = action();
    this.idempotentResults.set(key, promise);
    setTimeout(() => this.idempotentResults.delete(key), 5 * 60_000).unref();
    return promise;
  }

  private idempotentUserMessage<T>(threadId: string, operation: "turn" | "steer", clientUserMessageId: string, clientRequestId: string, action: () => Promise<T>): Promise<T> {
    const messageKey = `${threadId}\u0000${operation}\u0000${clientUserMessageId}`;
    const existing = this.userMessageResults.get(messageKey);
    if (existing) return existing as Promise<T>;
    const promise = this.idempotent(messageKey, clientRequestId, action);
    this.userMessageResults.set(messageKey, promise);
    setTimeout(() => this.userMessageResults.delete(messageKey), 5 * 60_000).unref();
    return promise;
  }

  private updateSessionSnapshot(event: AdapterEvent): void {
    const threadId = "threadId" in event ? event.threadId : undefined;
    if (threadId && this.removedThreads.has(threadId)) return;
    if (event.type === "settingsUpdated") this.settings.set(event.threadId, event.settings);
    if (event.type === "goalUpdated") this.goalPresence.set(event.threadId, true);
    if (event.type === "goalCleared") this.goalPresence.set(event.threadId, false);
    if (!threadId || !this.sessionSnapshots.has(threadId)) return;
    if (event.type === "turnStarted" || event.type === "turnCompleted") {
      this.upsertSnapshotTurn(threadId, event.turn);
      return;
    }
    if (event.type === "itemUpserted") {
      const item = event.item.type === "commandExecution" ? this.withBufferedCommandOutput(threadId, event.item) : event.item;
      this.upsertSnapshotItem(threadId, event.turnId, item);
      if (event.completed && item.type === "commandExecution") {
        this.commandOutputDeltas.delete(this.commandDeltaKey(threadId, item.id));
      }
      return;
    }
    if (event.type === "itemDelta" && event.delta.kind === "commandOutput" && event.turnId) {
      this.appendSnapshotCommandDelta(threadId, event.turnId, event.delta.itemId, event.delta.delta);
    }
  }

  private upsertSnapshotTurn(threadId: string, turn: SnapshotTurn): void {
    const snapshot = this.sessionSnapshots.get(threadId);
    if (!snapshot) return;
    const turns = [...snapshot.turns];
    const index = turns.findIndex((candidate) => candidate.id === turn.id);
    if (index < 0) turns.push(terminalizeSnapshotTurn(turn));
    else turns[index] = terminalizeSnapshotTurn({ ...turn, items: mergeSnapshotItems(turn.items, turns[index]!.items) });
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
    else {
      const current = items[index]!;
      items[index] = current.type === "commandExecution" && item.type === "commandExecution"
        ? mergeCommandExecution(current, item)
        : item;
    }
    this.upsertSnapshotTurn(threadId, { ...turn, items });
  }

  private appendSnapshotCommandDelta(threadId: string, turnId: string, itemId: string, delta: string): void {
    const key = this.commandDeltaKey(threadId, itemId);
    const buffered = (this.commandOutputDeltas.get(key) ?? "") + delta;
    this.commandOutputDeltas.set(key, buffered);
    const snapshot = this.sessionSnapshots.get(threadId);
    const turn = snapshot?.turns.find((candidate) => candidate.id === turnId);
    const command = turn?.items.find((item) => item.id === itemId && item.type === "commandExecution");
    if (!turn || !command || command.type !== "commandExecution") return;
    this.upsertSnapshotItem(threadId, turnId, {
      ...command,
      aggregatedOutput: `${command.aggregatedOutput ?? ""}${delta}` || null,
    });
  }

  private withBufferedCommandOutput(
    threadId: string,
    item: Extract<SnapshotItem, { type: "commandExecution" }>,
  ): Extract<SnapshotItem, { type: "commandExecution" }> {
    const buffered = this.commandOutputDeltas.get(this.commandDeltaKey(threadId, item.id));
    return buffered ? { ...item, aggregatedOutput: mergeStreamingText(buffered, item.aggregatedOutput) || null } : item;
  }

  private commandDeltaKey(threadId: string, itemId: string): string {
    return `${threadId}\u0000${itemId}`;
  }

  private async ensureGoalPresence(threadIds: string[]): Promise<void> {
    const unknown = [...new Set(threadIds)].filter((threadId) => !this.goalPresence.has(threadId) && !this.goalPresenceLoading.has(threadId));
    const generations = new Map(unknown.map((threadId) => [threadId, this.sessionGenerations.get(threadId) ?? 0]));
    for (const threadId of unknown) this.goalPresenceLoading.add(threadId);
    for (let index = 0; index < unknown.length; index += 8) {
      await Promise.all(unknown.slice(index, index + 8).map(async (threadId) => {
        const generation = generations.get(threadId)!;
        try {
          if (this.removedThreads.has(threadId)) return;
          const goal = await this.adapter.getGoal(threadId);
          if (this.removedThreads.has(threadId) || (this.sessionGenerations.get(threadId) ?? 0) !== generation) return;
          this.goalPresence.set(threadId, goal !== null);
          if (goal) this.runtimes.notifySessionSummaryUpdated(threadId, "goal-loaded");
        } catch {
          // A transient app-server failure must remain retryable on the next list request.
        } finally {
          this.goalPresenceLoading.delete(threadId);
        }
      }));
    }
  }

  private async ensureForkSnapshots(mappings: ProjectSessionRow[]): Promise<void> {
    const threadIds = [...new Set(mappings
      .filter((mapping) => mapping.fork_turn_id && !this.sessionSnapshots.has(mapping.thread_id))
      .map((mapping) => mapping.thread_id))];
    const generations = new Map(threadIds.map((threadId) => [threadId, this.sessionGenerations.get(threadId) ?? 0]));
    for (let index = 0; index < threadIds.length; index += 8) {
      await Promise.all(threadIds.slice(index, index + 8).map(async (threadId) => {
        const generation = generations.get(threadId)!;
        try {
          if (this.removedThreads.has(threadId)) return;
          const snapshot = await this.adapter.readSession(threadId);
          if (this.removedThreads.has(threadId) || (this.sessionGenerations.get(threadId) ?? 0) !== generation) return;
          this.sessionSnapshots.set(threadId, snapshot);
        } catch {
          // Fork provenance is supplemental metadata. A transient read failure
          // must not prevent the Session list itself from rendering.
        }
      }));
    }
  }
}

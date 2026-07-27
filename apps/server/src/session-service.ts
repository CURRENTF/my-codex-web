import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mergeStreamingText, type AccessMode, type SessionSummary, type SideChatRuntime } from "@codex-web/shared-types";
import { CodexAdapter, isThreadMaterializationRace, JsonRpcError, OperationUncertainError, type AdapterEvent, type AdapterPendingRequest, type ReviewTarget, type SessionSettings, type SkillReference } from "@codex-web/codex-adapter";
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

export class ActiveTurnIdentityError extends Error {
  constructor() { super("The active Turn could not be identified; refresh the Session and retry Interrupt"); }
}

export class ProjectUnavailableError extends Error {
  constructor() { super("Project directory is unavailable"); }
}

export class SessionDisconnectedError extends Error {
  constructor(operation: string) { super(`${operation} is unavailable until the Session has been reconciled after reconnecting`); }
}

export class UncertainTurnAppliedError extends Error {
  constructor() { super("The previously unconfirmed Turn appeared in the Session; duplicate sending was cancelled"); }
}

export class SideChatCloseTimeoutError extends Error {
  constructor() { super("Side Chat is still running and could not be closed safely; retry after the current Turn finishes"); }
}

export class ReconciliationPendingError extends Error {
  constructor() { super("Observed Codex children are still materializing; reconnect reconciliation will retry"); }
}

export class UnknownSkillError extends Error {
  constructor(readonly skillNames: string[]) {
    super(`Unknown or disabled Skill: ${skillNames.join(", ")}`);
  }
}

export const SIDE_CHAT_ACTIVE_TURN_ID_WAIT_MS = 2_000;
export const SIDE_CHAT_TERMINAL_WAIT_MS = 30_000;

export function isUnmaterializedSessionReadError(error: unknown): boolean {
  return isThreadMaterializationRace(error);
}

export function isSteerTurnConflictError(error: unknown): boolean {
  if (!(error instanceof JsonRpcError)) return false;
  return /no active turn|active turn.*(?:not found|finished|completed)|expected.?turn.?id.*(?:mismatch|does not match)|turn\b.*\bis not active/i.test(error.message);
}

export function recoveryThreadSource(kind: "session" | "fork", scope: string, clientRequestId: string): string {
  return `codex-web-${kind}:${encodeURIComponent(scope)}:${clientRequestId}`;
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

function removeSkillMentions(text: string, names: readonly string[]): string {
  let next = text;
  for (const name of [...names].sort((left, right) => right.length - left.length)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    next = next.replace(new RegExp(`(?:^|\\s)\\$${escaped}(?=$|\\s|[.,;:!?，。；：！？])`, "g"), (match) => match.startsWith(" ") ? " " : "");
  }
  return next.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+/gm, "").trim();
}

function snapshotHasClientUserMessage(snapshot: SessionSnapshot, turnId: string, clientUserMessageId: string): boolean {
  return snapshot.turns.find((turn) => turn.id === turnId)?.items.some((item) => (
    item.type === "userMessage" && item.clientId === clientUserMessageId
  )) ?? false;
}

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

export function restoreSnapshotSkillReferences(snapshot: SessionSnapshot, references: ReadonlyMap<string, readonly string[]>): SessionSnapshot {
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({
      ...turn,
      items: turn.items.map((item) => {
        if (item.type !== "userMessage" || !item.clientId) return item;
        const names = references.get(item.clientId);
        if (!names?.length) return item;
        const existingNames = item.content.flatMap((part) => part.type === "skill" && part.name ? [part.name] : []);
        const orderedNames = [...new Set([...names, ...existingNames])];
        return {
          ...item,
          content: [
            ...orderedNames.map((name) => ({ type: "skill", name })),
            ...item.content.filter((part) => part.type !== "skill"),
          ],
        };
      }),
    })),
  };
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
  if (item.type === "reasoning") return `reasoning:${JSON.stringify(item.summary)}`;
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

interface PendingForkRecovery {
  threadSource: string;
  parentThreadId: string;
  projectId: string;
  lastTurnId: string | null;
  expectedTurnIds: string[];
  empty: boolean;
  inheritGoal: boolean;
  settings: SessionSettings;
  prefill?: string;
  recoveryDeadlineAt?: number;
  background?: boolean;
  abandonAt?: number;
}

interface PendingSessionRecovery {
  threadSource: string;
  projectId: string;
  settings: SessionSettings;
  recoveryDeadlineAt?: number;
  background?: boolean;
  abandonAt?: number;
}

interface PendingSteerRecovery {
  expectedTurnId: string;
  clientUserMessageId: string;
  draft: string;
}

type ForkRecoveryOutcome = "finalized" | "discard" | "retry";
type SessionRecoveryOutcome = "finalized" | "discard" | "retry";
const UNCERTAIN_FORK_RECOVERY_ATTEMPTS = 3;
const UNCERTAIN_FORK_RECOVERY_DELAY_MS = 100;
const UNCERTAIN_CHILD_RECOVERY_TIMEOUT_MS = 30_000;
export const UNCERTAIN_CHILD_BACKGROUND_TTL_MS = 5 * 60_000;
export const DEFERRED_CHILD_RECOVERY_DELAY_MS = 1_000;
const UNCERTAIN_TURN_RECONCILIATION_ATTEMPTS = 3;
const UNCERTAIN_TURN_RECONCILIATION_DELAY_MS = 100;

export class SessionService extends EventEmitter {
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
  private readonly uncertainSessions = new Map<string, PendingSessionRecovery>();
  private readonly observedSessions = new Map<string, SessionSnapshot>();
  private readonly uncertainForks = new Map<string, PendingForkRecovery>();
  private readonly observedForks = new Map<string, SessionSnapshot>();
  private readonly uncertainArchives = new Set<string>();
  private readonly uncertainTurnBaselines = new Map<string, string | undefined>();
  private readonly uncertainTurnMessageIds = new Map<string, string>();
  private readonly uncertainTurnDrafts = new Map<string, string>();
  private readonly uncertainSteers = new Map<string, PendingSteerRecovery>();
  private readonly sessionPrefills = new Map<string, string>();
  private childRecovery: Promise<{ sessionRecoveryPending: boolean; forkRecoveryPending: boolean }> | null = null;
  private childRecoveryTimer: NodeJS.Timeout | null = null;
  private recoveryCriticalOperations = 0;

  constructor(
    private readonly repositories: Repositories,
    private readonly adapter: CodexAdapter,
    private readonly indexer: ProjectIndexer,
    private readonly runtimes: ThreadRuntimeRegistry,
    private readonly projectLocks = new KeyedOperationLock(),
  ) { super(); }

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
    let thread = snapshot ? mergeSessionSnapshot(persistedThread, snapshot) : terminalizeSessionSnapshot(persistedThread);
    thread = this.withPersistedSkillReferences(threadId, thread);
    this.sessionSnapshots.set(threadId, thread);
    this.clearPrefillAfterTurnStart(threadId, thread.turns);
    this.goalPresence.set(threadId, goal !== null);
    if (this.runtimes.get(threadId).state === "disconnected") thread = await this.reconcileRuntimeSnapshot(threadId, thread);
    return { thread, goal, runtime: this.runtimes.get(threadId), settings: this.getSettings(threadId) };
  }

  async markViewed(threadId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      this.requireMapping(threadId);
      this.runtimes.markViewed(threadId);
    });
  }

  async setAccessModeOverride(threadId: string, accessMode: AccessMode): Promise<SessionSettings> {
    return this.withLock(threadId, async () => {
      const sideChat = this.runtimes.getSideChat(threadId);
      if (sideChat) {
        const current = this.settings.get(threadId) ?? this.getSettings(sideChat.parentThreadId);
        const settings = { ...current, accessMode };
        this.settings.set(threadId, settings);
        return settings;
      }
      const mapping = this.requireMapping(threadId);
      this.repositories.setSessionAccessModeOverride(threadId, accessMode);
      const current = this.settings.get(threadId) ?? resolveSessionSettings(this.requireProject(mapping.project_id), {});
      const settings = { ...current, accessMode };
      this.settings.set(threadId, settings);
      return settings;
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
        if (error instanceof OperationUncertainError) {
          this.uncertainArchives.add(threadId);
          throw error;
        }
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
    return this.idempotent(`project:${projectId}:create`, clientRequestId, () => this.projectLocks.withKey(projectId, () => this.withRecoveryCriticalOperation(async () => {
      const project = this.requireAvailableProject(projectId);
      const settings = this.resolveSettings(projectId, input);
      const recovery: PendingSessionRecovery = {
        threadSource: recoveryThreadSource("session", projectId, clientRequestId),
        projectId,
        settings,
      };
      this.uncertainSessions.set(recovery.threadSource, recovery);
      this.indexer.markThreadSourcePending?.(recovery.threadSource);
      try {
        const response = await this.adapter.startSession(project.canonicalPath, settings, false, recovery.threadSource);
        this.observedSessions.set(recovery.threadSource, response.thread);
        const result = await this.finalizeCreatedSession(response.thread, recovery, true);
        this.uncertainSessions.delete(recovery.threadSource);
        this.observedSessions.delete(recovery.threadSource);
        this.indexer.restoreThreadSourceDiscovery?.(recovery.threadSource);
        return result;
      } catch (error) {
        if (error instanceof OperationUncertainError) {
          recovery.recoveryDeadlineAt = Date.now() + UNCERTAIN_CHILD_RECOVERY_TIMEOUT_MS;
        } else {
          this.uncertainSessions.delete(recovery.threadSource);
          this.observedSessions.delete(recovery.threadSource);
          this.indexer.restoreThreadSourceDiscovery?.(recovery.threadSource);
        }
        throw error;
      }
    })));
  }

  async listProjectSkills(projectId: string) {
    const project = this.requireAvailableProject(projectId);
    return this.adapter.listSkills(project.canonicalPath);
  }

  private async resolveSkills(cwd: string, skillNames: readonly string[]): Promise<{ skills: SkillReference[]; textNames: string[] }> {
    const textNames = [...new Set(skillNames.map((name) => name.trim()).filter(Boolean))];
    if (!textNames.length) return { skills: [], textNames: [] };
    const available = await this.adapter.listSkills(cwd);
    const byName = new Map(available.map((skill) => [skill.name, skill]));
    const unknown = textNames.filter((name) => !byName.has(name));
    if (unknown.length) throw new UnknownSkillError(unknown);
    return {
      textNames,
      skills: textNames.map((name) => {
        const skill = byName.get(name)!;
        return { name: skill.name, path: skill.path };
      }),
    };
  }

  private async finalizeCreatedSession(thread: SessionSnapshot, recovery: PendingSessionRecovery, rollbackOnFailure: boolean) {
    this.settings.set(thread.id, recovery.settings);
    this.sessionSnapshots.set(thread.id, thread);
    try {
      const now = Date.now();
      this.repositories.upsertProjectSession({
        thread_id: thread.id, project_id: recovery.projectId, cwd_snapshot: thread.cwd,
        source_kind: "appServer", origin: "created", parent_thread_id: null, fork_turn_id: null,
        added_at: now, last_seen_at: now,
      });
    } catch (error) {
      if (rollbackOnFailure && !(await this.rollbackCreatedThread(thread.id))) {
        this.retainUncertainChild(thread.id, recovery);
        throw new OperationUncertainError("thread/start finalization", error);
      }
      throw error;
    }
    this.restoreSession(thread.id);
    this.runtimes.notifySessionSummaryUpdated(thread.id, "session-created");
    return { thread, settings: recovery.settings };
  }

  async startTurn(threadId: string, text: string, input: TurnSettings & { clientUserMessageId: string; skillNames?: string[] }, clientRequestId: string) {
    return this.idempotentUserMessage(threadId, "turn", input.clientUserMessageId, clientRequestId, () => this.withLock(threadId, async () => {
      this.assertNoActiveTurn(threadId, "Starting another Turn");
      const mapping = this.requireMapping(threadId);
      const project = this.requireAvailableProject(mapping.project_id);
      await this.ensureSessionSettings(threadId);
      const settings = this.resolveSettings(project.id, input, threadId);
      const resolvedSkills = await this.resolveSkills(mapping.cwd_snapshot ?? project.canonicalPath, input.skillNames ?? []);
      const promptText = removeSkillMentions(text, resolvedSkills.textNames);
      this.persistSkillReferences(threadId, input.clientUserMessageId, resolvedSkills.textNames);
      const previousLastTurnId = this.sessionSnapshots.get(threadId)?.turns.at(-1)?.id;
      let response;
      try {
        response = await this.adapter.startTurn(threadId, mapping.cwd_snapshot ?? project.canonicalPath, promptText, settings, input.clientUserMessageId, resolvedSkills.skills);
      } catch (error) {
        if (!(error instanceof OperationUncertainError)) this.removePersistedSkillReferences(threadId, input.clientUserMessageId);
        if (error instanceof OperationUncertainError) {
          this.uncertainTurnBaselines.set(threadId, previousLastTurnId);
          this.uncertainTurnMessageIds.set(threadId, input.clientUserMessageId);
          this.uncertainTurnDrafts.set(threadId, text);
          this.runtimes.markOperationUncertain(threadId, previousLastTurnId);
        }
        throw error;
      }
      this.uncertainTurnBaselines.delete(threadId);
      this.uncertainTurnMessageIds.delete(threadId);
      this.uncertainTurnDrafts.delete(threadId);
      this.settings.set(threadId, settings);
      this.upsertSnapshotTurn(threadId, response.turn);
      this.runtimes.setActiveTurn(threadId, response.turn.id);
      this.sessionPrefills.delete(threadId);
      return response;
    }));
  }

  async steer(threadId: string, text: string, expectedTurnId: string, clientUserMessageId: string, clientRequestId: string, skillNames: string[] = []) {
    return this.idempotentUserMessage(threadId, "steer", clientUserMessageId, clientRequestId, () => this.withLock(threadId, async () => {
      if (this.uncertainSteers.has(threadId)) throw new SessionDisconnectedError("Steer");
      const runtime = this.runtimes.get(threadId);
      if (!runtime.activeTurnId || runtime.activeTurnId !== expectedTurnId) throw new SteerConflictError();
      let resolvedSkills: { skills: SkillReference[]; textNames: string[] } = { skills: [], textNames: [] };
      if (skillNames.length) {
        const mapping = this.requireMapping(threadId);
        const project = this.requireAvailableProject(mapping.project_id);
        resolvedSkills = await this.resolveSkills(mapping.cwd_snapshot ?? project.canonicalPath, skillNames);
      }
      const promptText = removeSkillMentions(text, resolvedSkills.textNames);
      this.persistSkillReferences(threadId, clientUserMessageId, resolvedSkills.textNames);
      try {
        return await this.adapter.steerTurn(threadId, expectedTurnId, promptText, clientUserMessageId, resolvedSkills.skills);
      } catch (error) {
        if (!(error instanceof OperationUncertainError)) this.removePersistedSkillReferences(threadId, clientUserMessageId);
        if (error instanceof OperationUncertainError) {
          this.uncertainSteers.set(threadId, { expectedTurnId, clientUserMessageId, draft: text });
          this.runtimes.markOperationUncertain(threadId, expectedTurnId);
        }
        if (isSteerTurnConflictError(error)) throw new SteerConflictError();
        throw error;
      }
    }));
  }

  async interrupt(threadId: string): Promise<void> {
    return this.withLock(threadId, async () => {
      let activeTurnId: string | undefined;
      try {
        activeTurnId = await this.activeTurnIdForInterrupt(threadId);
      } catch (error) {
        if (!(error instanceof ActiveTurnIdentityError)) throw error;
        activeTurnId = await this.runtimes.waitForActiveTurnId(threadId, SIDE_CHAT_ACTIVE_TURN_ID_WAIT_MS);
        if (!activeTurnId) {
          const runtime = this.runtimes.get(threadId);
          activeTurnId = runtime.activeTurnId;
          if (!activeTurnId && (runtime.state === "running" || runtime.state === "waitingForInput")) throw error;
        }
      }
      if (activeTurnId) await this.adapter.interruptTurn(threadId, activeTurnId);
    });
  }

  async compact(threadId: string): Promise<void> {
    this.assertPersistentSession(threadId, "Context compaction");
    return this.withLock(threadId, async () => {
      this.assertSessionReconciled(threadId, "Context compaction");
      this.assertNoActiveTurn(threadId, "Context compaction");
      await this.adapter.compactThread(threadId);
    });
  }

  async startReview(threadId: string, target: ReviewTarget) {
    this.assertPersistentSession(threadId, "Review");
    return this.withLock(threadId, async () => {
      this.assertSessionReconciled(threadId, "Review");
      this.assertNoActiveTurn(threadId, "Review");
      const response = await this.adapter.startReview(threadId, target);
      if (response.reviewThreadId !== threadId) throw new Error("Inline Review started in an unexpected Session");
      this.upsertSnapshotTurn(threadId, response.turn);
      this.runtimes.setActiveTurn(threadId, response.turn.id);
      return response;
    });
  }

  async fork(threadId: string, lastTurnId: string | null, inheritGoal: boolean, clientRequestId: string, empty = false, prefill?: string) {
    this.assertPersistentSession(threadId, "Fork");
    const sourceProjectId = this.requireMapping(threadId).project_id;
    return this.idempotent(`thread:${threadId}:fork`, clientRequestId, () => this.projectLocks.withKey(sourceProjectId, () => this.withLock(threadId, () => this.withRecoveryCriticalOperation(async () => {
      this.assertSessionReconciled(threadId, "Fork");
      const mapping = this.requireMapping(threadId);
      if (mapping.project_id !== sourceProjectId) throw new Error("Session Project changed while forking; retry the operation");
      const settings = await this.ensureSessionSettings(threadId);
      const project = this.requireAvailableProject(mapping.project_id);
      const cwd = mapping.cwd_snapshot ?? project.canonicalPath;
      if (empty && lastTurnId !== null) throw new ForkBoundaryError("An empty Fork cannot include a Turn boundary");
      let expectedTurnIds: string[] = [];
      if (!empty) {
        const source = await this.readSessionUnlocked(threadId);
        assertValidForkBoundary(source.thread.turns, lastTurnId);
        const boundaryIndex = source.thread.turns.findIndex((turn) => turn.id === lastTurnId);
        expectedTurnIds = source.thread.turns.slice(0, boundaryIndex + 1).map((turn) => turn.id);
      }
      const recovery: PendingForkRecovery = {
        threadSource: recoveryThreadSource("fork", threadId, clientRequestId),
        parentThreadId: threadId,
        projectId: mapping.project_id,
        lastTurnId,
        expectedTurnIds,
        empty,
        inheritGoal,
        settings,
        ...(empty && prefill ? { prefill } : {}),
      };
      this.uncertainForks.set(recovery.threadSource, recovery);
      this.indexer.markThreadSourcePending?.(recovery.threadSource);
      try {
        const response = empty
          ? await this.adapter.startSession(cwd, settings, false, recovery.threadSource)
          : await this.adapter.forkSession(threadId, lastTurnId, settings, false, cwd, recovery.threadSource);
        this.observedForks.set(recovery.threadSource, response.thread);
        const result = await this.finalizeFork(response.thread, recovery, true);
        this.uncertainForks.delete(recovery.threadSource);
        this.observedForks.delete(recovery.threadSource);
        this.indexer.restoreThreadSourceDiscovery?.(recovery.threadSource);
        return result;
      } catch (error) {
        if (error instanceof OperationUncertainError) {
          recovery.recoveryDeadlineAt = Date.now() + UNCERTAIN_CHILD_RECOVERY_TIMEOUT_MS;
        } else {
          this.uncertainForks.delete(recovery.threadSource);
          this.observedForks.delete(recovery.threadSource);
          this.indexer.restoreThreadSourceDiscovery?.(recovery.threadSource);
        }
        throw error;
      }
    }))));
  }

  private async finalizeFork(thread: SessionSnapshot, recovery: PendingForkRecovery, rollbackOnFailure: boolean, applyGoalPolicy = true) {
    this.settings.set(thread.id, recovery.settings);
    this.sessionSnapshots.set(thread.id, thread);
    try {
      if (applyGoalPolicy) {
        if (recovery.inheritGoal) {
          const goal = await this.adapter.getGoal(recovery.parentThreadId);
          if (goal) await this.adapter.setGoal({ threadId: thread.id, objective: goal.objective, status: goal.status, tokenBudget: goal.tokenBudget });
        } else {
          await this.adapter.clearGoal(thread.id);
        }
      }
      const now = Date.now();
      this.repositories.upsertProjectSession({
        thread_id: thread.id, project_id: recovery.projectId,
        cwd_snapshot: thread.cwd, source_kind: "appServer", origin: "forked",
        parent_thread_id: recovery.parentThreadId, fork_turn_id: recovery.lastTurnId, added_at: now, last_seen_at: now,
      });
    } catch (error) {
      if (rollbackOnFailure && !(await this.rollbackCreatedThread(thread.id))) {
        this.retainUncertainChild(thread.id, recovery);
        throw new OperationUncertainError("thread/fork finalization", error);
      }
      throw error;
    }
    this.restoreSession(thread.id);
    if (recovery.prefill) this.sessionPrefills.set(thread.id, recovery.prefill);
    if (recovery.prefill) this.runtimes.notifySessionSummaryUpdated(thread.id, "fork-created", { prefill: recovery.prefill });
    else this.runtimes.notifySessionSummaryUpdated(thread.id, "fork-created");
    return { thread, settings: recovery.settings };
  }

  private async recoverUncertainForks(): Promise<boolean> {
    if (!this.uncertainForks.size) return false;
    let pending = false;
    for (const [threadSource, recovery] of this.uncertainForks) {
      const project = this.repositories.getProject(recovery.projectId);
      const parentMapping = this.repositories.getProjectSession(recovery.parentThreadId);
      if (!project || parentMapping?.project_id !== recovery.projectId) {
        this.uncertainForks.delete(threadSource);
        this.observedForks.delete(threadSource);
        this.indexer.restoreThreadSourceDiscovery?.(threadSource);
        continue;
      }
      const knownObserved = this.observedForks.get(threadSource);
      if (recovery.background === true && recovery.abandonAt !== undefined && Date.now() >= recovery.abandonAt) {
        this.uncertainForks.delete(threadSource);
        this.observedForks.delete(threadSource);
        this.indexer.restoreThreadSourceDiscovery?.(threadSource);
        if (knownObserved) this.indexer.restoreSessionDiscovery?.(knownObserved.id);
        continue;
      }
      let observed = this.observedForks.get(threadSource);
      if (!observed) {
        observed = await this.findListedSessionByThreadSource(threadSource);
        if (observed) this.observedForks.set(threadSource, observed);
      }
      if (!observed) {
        recovery.recoveryDeadlineAt ??= Date.now() + UNCERTAIN_CHILD_RECOVERY_TIMEOUT_MS;
        if (Date.now() < recovery.recoveryDeadlineAt) {
          pending = true;
          continue;
        }
        if (recovery.empty) {
          this.uncertainForks.delete(threadSource);
          this.observedForks.delete(threadSource);
          this.indexer.restoreThreadSourceDiscovery?.(threadSource);
          continue;
        }
        recovery.background = true;
        recovery.abandonAt ??= Date.now() + UNCERTAIN_CHILD_BACKGROUND_TTL_MS;
        continue;
      }

      recovery.recoveryDeadlineAt ??= Date.now() + UNCERTAIN_CHILD_RECOVERY_TIMEOUT_MS;
      const finalAttempt = recovery.background === true || Date.now() >= recovery.recoveryDeadlineAt;
      let outcome: ForkRecoveryOutcome = "retry";
      const attemptCount = finalAttempt ? 1 : UNCERTAIN_FORK_RECOVERY_ATTEMPTS;
      for (let attempt = 0; attempt < attemptCount; attempt += 1) {
        outcome = await this.tryRecoverObservedFork(recovery, observed);
        if (outcome !== "retry") break;
        if (attempt + 1 < attemptCount) {
          await new Promise((resolve) => setTimeout(resolve, UNCERTAIN_FORK_RECOVERY_DELAY_MS * 2 ** attempt));
        }
      }
      if (outcome === "retry") {
        if (finalAttempt) {
          if (!recovery.background) {
            recovery.background = true;
            recovery.abandonAt = Date.now() + UNCERTAIN_CHILD_BACKGROUND_TTL_MS;
            this.indexer.markSessionArchived?.(observed.id);
          }
        } else {
          pending = true;
        }
        continue;
      }
      this.uncertainForks.delete(threadSource);
      this.observedForks.delete(threadSource);
      this.indexer.restoreThreadSourceDiscovery?.(threadSource);
      if (recovery.background) this.indexer.restoreSessionDiscovery?.(observed.id);
    }
    return pending;
  }

  private tryRecoverObservedFork(recovery: PendingForkRecovery, observed: SessionSnapshot): Promise<ForkRecoveryOutcome> {
    return this.projectLocks.withKey(recovery.projectId, () => this.withLock(recovery.parentThreadId, async () => {
      const project = this.repositories.getProject(recovery.projectId);
      const parentMapping = this.repositories.getProjectSession(recovery.parentThreadId);
      if (!project || parentMapping?.project_id !== recovery.projectId) return "discard";
      let recovered = observed;
      if (recovery.empty) {
        if (!(await this.listedSessionExists(observed.id))) return "retry";
      } else {
        try {
          recovered = await this.adapter.readSession(observed.id);
        } catch (error) {
          if (isUnmaterializedSessionReadError(error)) return "retry";
          throw error;
        }
        const exactHistory = recovered.turns.map((turn) => turn.id).join("\u0000") === recovery.expectedTurnIds.join("\u0000");
        if (!exactHistory || recovered.forkedFromId !== recovery.parentThreadId) return "retry";
      }
      await this.finalizeFork(recovered, recovery, false, !recovery.empty || recovery.inheritGoal);
      return "finalized";
    }));
  }

  private async listedSessionExists(threadId: string): Promise<boolean> {
    let cursor: string | null = null;
    do {
      const page = await this.adapter.listSessions({ cursor, limit: 100 });
      if (page.data.some((thread) => thread.id === threadId)) return true;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }

  private async findListedSessionByThreadSource(threadSource: string): Promise<SessionSnapshot | undefined> {
    const matches = [];
    let cursor: string | null = null;
    do {
      const page = await this.adapter.listSessions({ cursor, limit: 100 });
      matches.push(...page.data.filter((thread) => thread.threadSource === threadSource));
      if (matches.length > 1) return undefined;
      cursor = page.nextCursor;
    } while (cursor);
    const [thread] = matches;
    return thread ? { ...thread, ephemeral: false, turns: [] } : undefined;
  }

  private async recoverUncertainSessions(): Promise<boolean> {
    if (!this.uncertainSessions.size) return false;
    let pending = false;
    for (const [threadSource, recovery] of this.uncertainSessions) {
      if (!this.repositories.getProject(recovery.projectId)) {
        this.uncertainSessions.delete(threadSource);
        this.observedSessions.delete(threadSource);
        this.indexer.restoreThreadSourceDiscovery?.(threadSource);
        continue;
      }
      const knownObserved = this.observedSessions.get(threadSource);
      if (recovery.background === true && recovery.abandonAt !== undefined && Date.now() >= recovery.abandonAt) {
        this.uncertainSessions.delete(threadSource);
        this.observedSessions.delete(threadSource);
        this.indexer.restoreThreadSourceDiscovery?.(threadSource);
        if (knownObserved) this.indexer.restoreSessionDiscovery?.(knownObserved.id);
        continue;
      }
      let observed = this.observedSessions.get(threadSource);
      if (!observed) {
        observed = await this.findListedSessionByThreadSource(threadSource);
        if (observed) this.observedSessions.set(threadSource, observed);
      }
      if (!observed) {
        recovery.recoveryDeadlineAt ??= Date.now() + UNCERTAIN_CHILD_RECOVERY_TIMEOUT_MS;
        if (Date.now() < recovery.recoveryDeadlineAt) {
          pending = true;
          continue;
        }
        this.uncertainSessions.delete(threadSource);
        this.observedSessions.delete(threadSource);
        this.indexer.restoreThreadSourceDiscovery?.(threadSource);
        continue;
      }
      recovery.recoveryDeadlineAt ??= Date.now() + UNCERTAIN_CHILD_RECOVERY_TIMEOUT_MS;
      const finalAttempt = recovery.background === true || Date.now() >= recovery.recoveryDeadlineAt;
      let outcome: SessionRecoveryOutcome = "retry";
      const attemptCount = finalAttempt ? 1 : UNCERTAIN_FORK_RECOVERY_ATTEMPTS;
      for (let attempt = 0; attempt < attemptCount; attempt += 1) {
        outcome = await this.tryRecoverObservedSession(recovery, observed);
        if (outcome !== "retry") break;
        if (attempt + 1 < attemptCount) {
          await new Promise((resolve) => setTimeout(resolve, UNCERTAIN_FORK_RECOVERY_DELAY_MS * 2 ** attempt));
        }
      }
      if (outcome === "retry") {
        if (finalAttempt) {
          if (!recovery.background) {
            recovery.background = true;
            recovery.abandonAt = Date.now() + UNCERTAIN_CHILD_BACKGROUND_TTL_MS;
            this.indexer.markSessionArchived?.(observed.id);
          }
        } else {
          pending = true;
        }
        continue;
      }
      this.uncertainSessions.delete(threadSource);
      this.observedSessions.delete(threadSource);
      this.indexer.restoreThreadSourceDiscovery?.(threadSource);
      if (recovery.background) this.indexer.restoreSessionDiscovery?.(observed.id);
    }
    return pending;
  }

  private tryRecoverObservedSession(recovery: PendingSessionRecovery, observed: SessionSnapshot): Promise<SessionRecoveryOutcome> {
    return this.projectLocks.withKey(recovery.projectId, async () => {
      if (!this.repositories.getProject(recovery.projectId)) return "discard";
      if (!(await this.listedSessionExists(observed.id))) return "retry";
      await this.finalizeCreatedSession(observed, recovery, false);
      return "finalized";
    });
  }

  handlePendingRequest(request: AdapterPendingRequest): void {
    this.runtimes.handlePendingRequest(request);
  }

  listPrefills(): Record<string, string> {
    return Object.fromEntries(this.sessionPrefills);
  }

  async recoverDeferredChildren(): Promise<void> {
    await this.recoverChildren();
  }

  handleEvent(event: AdapterEvent): AdapterEvent {
    const eventThreadId = "threadId" in event ? event.threadId : undefined;
    if (eventThreadId && this.removedThreads.has(eventThreadId)) return event;
    event = this.withPreferredAccessMode(event);
    if (event.type === "threadStarted" && event.threadSource) {
      const sessionRecovery = this.uncertainSessions.get(event.threadSource);
      if (sessionRecovery) this.observedSessions.set(event.threadSource, event.thread);
      const recovery = this.uncertainForks.get(event.threadSource);
      if (recovery) this.observedForks.set(event.threadSource, event.thread);
    }
    if (event.type === "turnStarted") {
      this.uncertainTurnBaselines.delete(event.threadId);
      this.uncertainTurnMessageIds.delete(event.threadId);
      this.uncertainTurnDrafts.delete(event.threadId);
    }
    this.updateSessionSnapshot(event);
    return event;
  }

  async reconcileAfterReconnect(): Promise<void> {
    await this.recoverUncertainArchives();
    const { sessionRecoveryPending, forkRecoveryPending } = await this.recoverChildren();
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
        await this.reconcileRuntimeSnapshot(runtime.threadId, snapshot);
      } catch {
        // The previous Turn's outcome is unknown after an App Server crash.
        // Keep the explicit disconnected state until a later successful read.
      }
    })));
    if (sessionRecoveryPending || forkRecoveryPending) throw new ReconciliationPendingError();
  }

  private async reconcileRuntimeSnapshot(threadId: string, initialSnapshot: SessionSnapshot): Promise<SessionSnapshot> {
    let snapshot = initialSnapshot;
    for (let attempt = 0; attempt < UNCERTAIN_TURN_RECONCILIATION_ATTEMPTS; attempt += 1) {
      this.sessionSnapshots.set(threadId, snapshot);
      this.clearPrefillAfterTurnStart(threadId, snapshot.turns);
      const uncertainSteer = this.uncertainSteers.get(threadId);
      if (uncertainSteer) {
        if (snapshotHasClientUserMessage(snapshot, uncertainSteer.expectedTurnId, uncertainSteer.clientUserMessageId)) {
          this.uncertainSteers.delete(threadId);
          this.runtimes.confirmUncertainTurnApplied(
            threadId,
            snapshot.turns,
            this.activeSteerTurnId(snapshot, uncertainSteer.expectedTurnId),
          );
          return snapshot;
        }
        if (attempt + 1 === UNCERTAIN_TURN_RECONCILIATION_ATTEMPTS) return snapshot;
        await new Promise((resolve) => setTimeout(resolve, UNCERTAIN_TURN_RECONCILIATION_DELAY_MS * 2 ** attempt));
        const persisted = await this.adapter.readSession(threadId);
        snapshot = mergeSessionSnapshot(persisted, snapshot);
        continue;
      }
      const outcome = this.runtimes.reconcileFromSnapshot(threadId, snapshot.turns);
      if (outcome !== "uncertainTurnUnchanged") {
        const baseline = this.uncertainTurnBaselines.get(threadId);
        const lastTurn = snapshot.turns.at(-1);
        if (this.uncertainTurnBaselines.has(threadId) && lastTurn && lastTurn.id !== baseline) {
          this.uncertainTurnBaselines.delete(threadId);
          this.uncertainTurnMessageIds.delete(threadId);
          this.uncertainTurnDrafts.delete(threadId);
          if (outcome === "unresolved") this.runtimes.confirmUncertainTurnApplied(threadId, snapshot.turns);
        }
        return snapshot;
      }
      if (attempt + 1 === UNCERTAIN_TURN_RECONCILIATION_ATTEMPTS) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, UNCERTAIN_TURN_RECONCILIATION_DELAY_MS * 2 ** attempt));
      const persisted = await this.adapter.readSession(threadId);
      snapshot = mergeSessionSnapshot(persisted, snapshot);
    }
    return snapshot;
  }

  async resolveUncertainTurn(threadId: string): Promise<{ status: "notApplied" | "alreadyResolved"; clientUserMessageId?: string; draft?: string }> {
    this.assertPersistentSession(threadId, "uncertain Turn resolution");
    return this.withLock(threadId, async () => {
      this.requireMapping(threadId);
      const uncertainSteer = this.uncertainSteers.get(threadId);
      if (!uncertainSteer && !this.uncertainTurnBaselines.has(threadId)) return { status: "alreadyResolved" };
      const baseline = this.uncertainTurnBaselines.get(threadId);
      const persisted = await this.adapter.readSession(threadId);
      const cached = this.sessionSnapshots.get(threadId);
      const snapshot = cached ? mergeSessionSnapshot(persisted, cached) : terminalizeSessionSnapshot(persisted);
      this.sessionSnapshots.set(threadId, snapshot);
      this.clearPrefillAfterTurnStart(threadId, snapshot.turns);
      if (uncertainSteer) {
        if (snapshotHasClientUserMessage(snapshot, uncertainSteer.expectedTurnId, uncertainSteer.clientUserMessageId)) {
          this.uncertainSteers.delete(threadId);
          this.runtimes.confirmUncertainTurnApplied(
            threadId,
            snapshot.turns,
            this.activeSteerTurnId(snapshot, uncertainSteer.expectedTurnId),
          );
          throw new UncertainTurnAppliedError();
        }
        this.uncertainSteers.delete(threadId);
        this.clearUserMessageResult(threadId, "steer", uncertainSteer.clientUserMessageId);
        this.runtimes.confirmUncertainTurnNotApplied(
          threadId,
          snapshot.turns,
          this.activeSteerTurnId(snapshot, uncertainSteer.expectedTurnId),
        );
        return {
          status: "notApplied",
          clientUserMessageId: uncertainSteer.clientUserMessageId,
          draft: uncertainSteer.draft,
        };
      }
      const lastTurn = snapshot.turns.at(-1);
      if (lastTurn && lastTurn.id !== baseline) {
        this.uncertainTurnBaselines.delete(threadId);
        this.uncertainTurnMessageIds.delete(threadId);
        this.uncertainTurnDrafts.delete(threadId);
        this.runtimes.confirmUncertainTurnApplied(threadId, snapshot.turns);
        throw new UncertainTurnAppliedError();
      }
      const clientUserMessageId = this.uncertainTurnMessageIds.get(threadId);
      const draft = this.uncertainTurnDrafts.get(threadId);
      this.uncertainTurnBaselines.delete(threadId);
      this.uncertainTurnMessageIds.delete(threadId);
      this.uncertainTurnDrafts.delete(threadId);
      if (clientUserMessageId) this.clearUserMessageResult(threadId, "turn", clientUserMessageId);
      this.runtimes.confirmUncertainTurnNotApplied(threadId, snapshot.turns);
      return { status: "notApplied", ...(clientUserMessageId ? { clientUserMessageId } : {}), ...(draft ? { draft } : {}) };
    });
  }

  private async recoverUncertainArchives(): Promise<void> {
    if (!this.uncertainArchives.size) return;
    const unarchived = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.adapter.listSessions({ cursor, limit: 100, archived: false });
      for (const thread of page.data) unarchived.add(thread.id);
      cursor = page.nextCursor;
    } while (cursor);
    for (const threadId of [...this.uncertainArchives]) {
      this.uncertainArchives.delete(threadId);
      if (unarchived.has(threadId)) {
        this.indexer.restoreSessionDiscovery?.(threadId);
        continue;
      }
      this.repositories.removeProjectSession(threadId);
      this.clearSessionCaches(threadId);
      this.runtimes.notifySessionSummaryUpdated(threadId, "archived-after-reconnect");
    }
  }

  private recoverChildren(): Promise<{ sessionRecoveryPending: boolean; forkRecoveryPending: boolean }> {
    if (this.childRecovery) return this.childRecovery;
    let tracked!: Promise<{ sessionRecoveryPending: boolean; forkRecoveryPending: boolean }>;
    tracked = (async () => {
      const sessionRecoveryPending = await this.recoverUncertainSessions();
      const forkRecoveryPending = await this.recoverUncertainForks();
      return { sessionRecoveryPending, forkRecoveryPending };
    })().finally(() => {
      if (this.childRecovery === tracked) this.childRecovery = null;
      this.syncDeferredChildRecoveryTimer();
    });
    this.childRecovery = tracked;
    return tracked;
  }

  async createSideChat(parentThreadId: string, anchorTurnId: string | null) {
    this.assertPersistentSession(parentThreadId, "nested Side Chat");
    return this.withLocks([parentThreadId, `side-chat:${parentThreadId}`], () => this.withRecoveryCriticalOperation(async () => {
      this.assertSessionReconciled(parentThreadId, "Side Chat");
      const existing = this.runtimes.listSideChats().find((sideChat) => sideChat.parentThreadId === parentThreadId);
      if (existing) return existing;
      let source = this.sessionSnapshots.get(parentThreadId);
      if (anchorTurnId && !source) source = (await this.readSessionUnlocked(parentThreadId)).thread;
      if (anchorTurnId) assertValidForkBoundary(source?.turns ?? [], anchorTurnId);
      const settings = await this.ensureSessionSettings(parentThreadId);
      const mapping = this.requireMapping(parentThreadId);
      const project = this.requireAvailableProject(mapping.project_id);
      const cwd = mapping.cwd_snapshot ?? project.canonicalPath;
      let response;
      try {
        response = await this.adapter.createSideChat(parentThreadId, anchorTurnId, settings, cwd);
      } catch (error) {
        if (!isUnmaterializedSessionReadError(error) || !source || source.turns.length > 0) throw error;
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
    }));
  }

  async closeSideChat(threadId: string): Promise<void> {
    return this.withLock(threadId, () => this.closeSideChatUnlocked(threadId));
  }

  private async closeSideChatUnlocked(threadId: string): Promise<void> {
    const sideChat = this.runtimes.getSideChat(threadId);
    if (!sideChat) return;
    let activeTurnId: string | undefined;
    try {
      activeTurnId = await this.activeTurnIdForInterrupt(threadId);
    } catch (error) {
      if (!(error instanceof ActiveTurnIdentityError)) throw error;
      activeTurnId = await this.runtimes.waitForActiveTurnId(threadId, SIDE_CHAT_TERMINAL_WAIT_MS);
    }
    if (activeTurnId) {
      try {
        await this.adapter.interruptTurn(threadId, activeTurnId);
      } catch (error) {
        if (!isSteerTurnConflictError(error)) throw error;
        await this.adapter.unsubscribe(threadId);
        this.clearSideChatState(threadId);
        return;
      }
      const terminal = await this.runtimes.waitForTerminal(threadId, SIDE_CHAT_TERMINAL_WAIT_MS);
      if (!terminal) {
        this.recoverTimedOutSideChat(threadId);
        return;
      }
    } else {
      const runtime = this.runtimes.get(threadId);
      if (runtime.state === "running" || runtime.state === "waitingForInput") {
        this.recoverTimedOutSideChat(threadId);
        return;
      }
    }
    await this.adapter.unsubscribe(threadId);
    this.clearSideChatState(threadId);
  }

  private clearSideChatState(threadId: string): void {
    this.settings.delete(threadId);
    this.sessionSnapshots.delete(threadId);
    this.markSessionRemoved(threadId);
    this.runtimes.removeSideChat(threadId);
  }

  private recoverTimedOutSideChat(threadId: string): void {
    const anotherTurnIsActive = this.runtimes.list().some((runtime) =>
      runtime.threadId !== threadId && (runtime.state === "running" || runtime.state === "waitingForInput"));
    const anotherSideChatExists = this.runtimes.listSideChats().some((sideChat) => sideChat.threadId !== threadId);
    if (anotherTurnIsActive || anotherSideChatExists || this.recoveryCriticalOperations > 0) throw new SideChatCloseTimeoutError();
    if (this.adapter.restartForRecovery() === false) throw new SideChatCloseTimeoutError();
    this.clearSideChatState(threadId);
  }

  private async activeTurnIdForInterrupt(threadId: string): Promise<string | undefined> {
    const runtime = this.runtimes.get(threadId);
    if (runtime.activeTurnId) return runtime.activeTurnId;
    if (runtime.state !== "running" && runtime.state !== "waitingForInput") return undefined;

    const cached = this.sessionSnapshots.get(threadId);
    if (this.runtimes.getSideChat(threadId)) {
      const activeTurnId = [...(cached?.turns ?? [])].reverse().find((turn) => turn.status === "inProgress")?.id;
      if (!activeTurnId) throw new ActiveTurnIdentityError();
      this.runtimes.setActiveTurn(threadId, activeTurnId);
      return activeTurnId;
    }

    let persisted: SessionSnapshot;
    try {
      persisted = await this.adapter.readSession(threadId);
    } catch (error) {
      if (isUnmaterializedSessionReadError(error)) throw new ActiveTurnIdentityError();
      throw error;
    }
    const thread = cached ? mergeSessionSnapshot(persisted, cached) : terminalizeSessionSnapshot(persisted);
    this.sessionSnapshots.set(threadId, thread);
    const activeTurnId = [...thread.turns].reverse().find((turn) => turn.status === "inProgress")?.id;
    if (!activeTurnId) throw new ActiveTurnIdentityError();
    this.runtimes.setActiveTurn(threadId, activeTurnId);
    return activeTurnId;
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
    if (this.uncertainTurnBaselines.has(threadId)) throw new SessionDisconnectedError(operation);
    const runtime = this.runtimes.get(threadId);
    if (runtime.state === "disconnected") throw new SessionDisconnectedError(operation);
    if (runtime.activeTurnId || runtime.state === "running" || runtime.state === "waitingForInput") throw new ActiveTurnConflictError(operation);
  }

  private assertSessionReconciled(threadId: string, operation: string): void {
    if (this.runtimes.get(threadId).state === "disconnected") throw new SessionDisconnectedError(operation);
  }

  private async withRecoveryCriticalOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.recoveryCriticalOperations += 1;
    try {
      return await operation();
    } finally {
      this.recoveryCriticalOperations -= 1;
    }
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

  private withPersistedSkillReferences(threadId: string, snapshot: SessionSnapshot): SessionSnapshot {
    if (this.runtimes.getSideChat(threadId)) return snapshot;
    const references = new Map((this.repositories.listMessageSkillReferences?.(threadId) ?? [])
      .map((row) => [row.client_user_message_id, row.skill_names] as const));
    return references.size ? restoreSnapshotSkillReferences(snapshot, references) : snapshot;
  }

  private persistSkillReferences(threadId: string, clientUserMessageId: string, skillNames: readonly string[]): void {
    if (!skillNames.length || this.runtimes.getSideChat(threadId)) return;
    this.repositories.setMessageSkillReferences?.(threadId, clientUserMessageId, skillNames);
  }

  private removePersistedSkillReferences(threadId: string, clientUserMessageId: string): void {
    if (this.runtimes.getSideChat(threadId)) return;
    this.repositories.removeMessageSkillReferences?.(threadId, clientUserMessageId);
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
    const mapping = this.requireMapping(threadId);
    const project = this.requireProject(mapping.project_id);
    const coldAccessMode = mapping.access_mode_override ?? project.defaultAccessMode;
    let resumed;
    try {
      resumed = current
        ? await this.adapter.resumeSession(threadId, current)
        : await this.adapter.resumeSession(threadId, { accessMode: coldAccessMode });
    } catch (error) {
      const snapshot = this.sessionSnapshots.get(threadId);
      if (!current || !snapshot || !isUnmaterializedSessionReadError(error)) throw error;
      return { thread: snapshot, settings: current };
    }
    const settings = resolveSessionSettings(project, {}, current ?? { ...resumed.settings, accessMode: coldAccessMode });
    const cachedSnapshot = this.sessionSnapshots.get(threadId);
    const thread = cachedSnapshot ? mergeSessionSnapshot(resumed.thread, cachedSnapshot) : resumed.thread;
    this.settings.set(threadId, settings);
    this.sessionSnapshots.set(threadId, thread);
    return { ...resumed, thread, settings };
  }

  private requireProject(projectId: string) {
    const project = this.repositories.getProject(projectId);
    if (!project) throw new Error("Project not found");
    return project;
  }

  private requireAvailableProject(projectId: string) {
    const project = this.requireProject(projectId);
    if (project.available === false) throw new ProjectUnavailableError();
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
    this.sessionPrefills.delete(threadId);
    this.goalPresence.delete(threadId);
    this.goalPresenceLoading.delete(threadId);
    this.uncertainArchives.delete(threadId);
    this.uncertainTurnBaselines.delete(threadId);
    this.uncertainTurnMessageIds.delete(threadId);
    this.uncertainTurnDrafts.delete(threadId);
    this.uncertainSteers.delete(threadId);
    for (const key of this.commandOutputDeltas.keys()) {
      if (key.startsWith(`${threadId}\u0000`)) this.commandOutputDeltas.delete(key);
    }
    this.markSessionRemoved(threadId);
    this.runtimes.removeThread?.(threadId);
  }

  private async rollbackCreatedThread(threadId: string): Promise<boolean> {
    try { this.repositories.removeProjectSession?.(threadId); } catch { /* best-effort rollback after a database failure */ }
    this.clearSessionCaches(threadId);
    try {
      await this.adapter.archiveSession(threadId);
      return true;
    } catch {
      return false;
    }
  }

  private retainUncertainChild(threadId: string, recovery: PendingSessionRecovery | PendingForkRecovery): void {
    recovery.background = true;
    recovery.recoveryDeadlineAt = Date.now();
    recovery.abandonAt = Date.now() + UNCERTAIN_CHILD_BACKGROUND_TTL_MS;
    this.indexer.markSessionArchived?.(threadId);
    this.indexer.scanAllInBackground?.();
    this.syncDeferredChildRecoveryTimer();
  }

  private activeSteerTurnId(snapshot: SessionSnapshot, expectedTurnId: string): string | undefined {
    return snapshot.turns.find((turn) => turn.id === expectedTurnId && turn.status === "inProgress")?.id;
  }

  private hasBackgroundChildRecovery(): boolean {
    return [...this.uncertainSessions.values(), ...this.uncertainForks.values()]
      .some((recovery) => recovery.background === true);
  }

  private syncDeferredChildRecoveryTimer(): void {
    if (!this.hasBackgroundChildRecovery()) {
      if (this.childRecoveryTimer) clearTimeout(this.childRecoveryTimer);
      this.childRecoveryTimer = null;
      return;
    }
    if (this.childRecoveryTimer) return;
    this.childRecoveryTimer = setTimeout(() => {
      this.childRecoveryTimer = null;
      void this.recoverDeferredChildren()
        .catch((error: unknown) => this.emit("deferredRecoveryError", error))
        .finally(() => this.syncDeferredChildRecoveryTimer());
    }, DEFERRED_CHILD_RECOVERY_DELAY_MS);
    this.childRecoveryTimer.unref();
  }

  dispose(): void {
    if (this.childRecoveryTimer) clearTimeout(this.childRecoveryTimer);
    this.childRecoveryTimer = null;
    this.removeAllListeners();
  }

  private clearPrefillAfterTurnStart(threadId: string, turns: SnapshotTurn[]): void {
    if (turns.length) this.sessionPrefills.delete(threadId);
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

  private clearUserMessageResult(threadId: string, operation: "turn" | "steer", clientUserMessageId: string): void {
    this.userMessageResults.delete(`${threadId}\u0000${operation}\u0000${clientUserMessageId}`);
  }

  private updateSessionSnapshot(event: AdapterEvent): void {
    const threadId = "threadId" in event ? event.threadId : undefined;
    if (threadId && this.removedThreads.has(threadId)) return;
    if (event.type === "turnStarted") this.sessionPrefills.delete(event.threadId);
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

  private withPreferredAccessMode(event: AdapterEvent): AdapterEvent {
    if (event.type !== "settingsUpdated") return event;
    const current = this.settings.get(event.threadId);
    const mapping = this.repositories.getProjectSession(event.threadId);
    if (!mapping) {
      return current ? { ...event, settings: { ...event.settings, accessMode: current.accessMode } } : event;
    }
    const project = this.repositories.getProject(mapping.project_id);
    const accessMode = mapping.access_mode_override ?? project?.defaultAccessMode ?? current?.accessMode ?? event.settings.accessMode;
    return { ...event, settings: { ...event.settings, accessMode } };
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

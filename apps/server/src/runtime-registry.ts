import type { PendingRequestSummary, RuntimeState, SessionTurn, SideChatRuntime, SubagentDescriptor, SubagentRuntime, ThreadRuntime } from "@codex-web/shared-types";
import type { AdapterEvent, AdapterPendingRequest, ListedSubagent } from "@codex-web/codex-adapter";
import { EventGateway } from "./event-gateway.js";
import { Repositories } from "./database.js";

type TerminalWaiter = { resolve(value: boolean): void; timer: NodeJS.Timeout };
type ActiveTurnWaiter = { resolve(value: string | undefined): void; timer: NodeJS.Timeout };
export type SnapshotReconciliationResult = "reconciled" | "uncertainTurnUnchanged" | "unresolved";

export class ThreadRuntimeRegistry {
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly sideChats = new Map<string, SideChatRuntime>();
  private readonly pendingRequests = new Map<string, AdapterPendingRequest>();
  private readonly pendingRequestOwners = new Map<string, string>();
  private readonly subagentParents = new Map<string, string>();
  private readonly subagents = new Map<string, SubagentRuntime>();
  private readonly liveDeltas = new Map<string, string>();
  private readonly liveDeltaThreads = new Map<string, string>();
  private readonly finishTimers = new Map<string, NodeJS.Timeout>();
  private readonly terminalWaiters = new Map<string, Set<TerminalWaiter>>();
  private readonly activeTurnWaiters = new Map<string, Set<ActiveTurnWaiter>>();
  private readonly closedSideChats = new Set<string>();
  private readonly removedThreads = new Set<string>();
  private readonly connectionInterruptedTurns = new Map<string, string | null>();
  private readonly uncertainTurnBaselines = new Map<string, string | undefined>();
  private readonly activeThreadHints = new Set<string>();

  constructor(private readonly events: EventGateway, private readonly repositories: Repositories) {
    this.hydratePersistedStates();
  }

  list(): ThreadRuntime[] { return [...this.runtimes.values()].map((item) => ({ ...item })); }
  listSideChats(): SideChatRuntime[] { return [...this.sideChats.values()].map((item) => ({ ...item })); }
  listSubagents(): SubagentRuntime[] { return [...this.subagents.values()].map((item) => ({ ...item })); }
  restoreSubagents(subagents: readonly ListedSubagent[]): void {
    for (const subagent of [...subagents].sort((left, right) => left.createdAt - right.createdAt || left.threadId.localeCompare(right.threadId))) {
      this.subagentParents.set(subagent.threadId, subagent.parentThreadId);
      const current = this.subagents.get(subagent.threadId);
      const currentIsLive = current?.state === "running"
        || current?.state === "waitingForInput"
        || current?.agentStatus === "pendingInit"
        || current?.agentStatus === "running";
      const snapshotIsLive = subagent.state === "running" || subagent.state === "waitingForInput";
      this.updateSubagent(subagent.threadId, {
        ...subagent,
        ...(currentIsLive && !snapshotIsLive ? {
          state: current.state,
          activeFlags: current.activeFlags,
          agentStatus: current.agentStatus,
          activeTurnId: current.activeTurnId,
        } : {}),
      });
    }
  }
  get(threadId: string): ThreadRuntime {
    return this.runtimes.get(threadId) ?? { threadId, state: "idle", activeFlags: [], pendingRequestIds: [] };
  }
  getSideChat(threadId: string): SideChatRuntime | undefined { return this.sideChats.get(threadId); }
  listPendingRequests(): PendingRequestSummary[] {
    return [...this.pendingRequests.values()].map((request) => request.summary);
  }
  listItemDeltas(): Record<string, string> { return Object.fromEntries(this.liveDeltas); }

  registerSideChat(runtime: SideChatRuntime): void {
    this.closedSideChats.delete(runtime.threadId);
    this.removedThreads.delete(runtime.threadId);
    this.sideChats.set(runtime.threadId, runtime);
    this.runtimes.set(runtime.threadId, runtime);
    this.events.publish("sideChat.created", runtime, { threadId: runtime.parentThreadId, sideChatId: runtime.threadId });
  }

  removeSideChat(threadId: string): void {
    const sideChat = this.sideChats.get(threadId);
    if (!sideChat) return;
    this.clearPendingRequests(threadId, sideChat.pendingRequestIds);
    this.sideChats.delete(threadId);
    this.runtimes.delete(threadId);
    this.clearLiveDeltas(threadId);
    this.connectionInterruptedTurns.delete(threadId);
    this.uncertainTurnBaselines.delete(threadId);
    this.activeThreadHints.delete(threadId);
    this.removeSubagentMappings(threadId);
    this.closedSideChats.add(threadId);
    this.resolveTerminalWaiters(threadId, false);
    this.resolveActiveTurnWaiters(threadId, undefined);
    this.events.publish("sideChat.closed", { threadId }, { threadId: sideChat.parentThreadId, sideChatId: threadId });
  }

  removeThread(threadId: string): void {
    if (this.sideChats.has(threadId)) {
      this.removeSideChat(threadId);
      return;
    }
    const runtime = this.runtimes.get(threadId);
    if (runtime) this.clearPendingRequests(threadId, runtime.pendingRequestIds);
    this.clearFinishTimer(threadId);
    this.clearLiveDeltas(threadId);
    this.connectionInterruptedTurns.delete(threadId);
    this.uncertainTurnBaselines.delete(threadId);
    this.activeThreadHints.delete(threadId);
    this.removeSubagentMappings(threadId);
    this.runtimes.delete(threadId);
    this.removedThreads.add(threadId);
    this.resolveTerminalWaiters(threadId, false);
    this.resolveActiveTurnWaiters(threadId, undefined);
  }

  restoreThread(threadId: string): void {
    this.removedThreads.delete(threadId);
  }

  waitForTerminal(threadId: string, timeoutMs = 10_000): Promise<boolean> {
    const runtime = this.get(threadId);
    if (!runtime.activeTurnId && runtime.state !== "running" && runtime.state !== "waitingForInput") return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter: TerminalWaiter = {
        resolve,
        timer: setTimeout(() => {
          const waiters = this.terminalWaiters.get(threadId);
          waiters?.delete(waiter);
          if (!waiters?.size) this.terminalWaiters.delete(threadId);
          resolve(false);
        }, timeoutMs),
      };
      const waiters = this.terminalWaiters.get(threadId) ?? new Set<TerminalWaiter>();
      waiters.add(waiter);
      this.terminalWaiters.set(threadId, waiters);
    });
  }

  waitForActiveTurnId(threadId: string, timeoutMs = 2_000): Promise<string | undefined> {
    const runtime = this.get(threadId);
    if (runtime.activeTurnId) return Promise.resolve(runtime.activeTurnId);
    if (runtime.state !== "running" && runtime.state !== "waitingForInput") return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const waiter: ActiveTurnWaiter = {
        resolve,
        timer: setTimeout(() => {
          const waiters = this.activeTurnWaiters.get(threadId);
          waiters?.delete(waiter);
          if (!waiters?.size) this.activeTurnWaiters.delete(threadId);
          resolve(undefined);
        }, timeoutMs),
      };
      const waiters = this.activeTurnWaiters.get(threadId) ?? new Set<ActiveTurnWaiter>();
      waiters.add(waiter);
      this.activeTurnWaiters.set(threadId, waiters);
    });
  }

  handleConnection(state: "connected" | "connecting" | "disconnected"): void {
    if (state === "disconnected") {
      this.liveDeltas.clear();
      this.liveDeltaThreads.clear();
      this.pendingRequests.clear();
      this.pendingRequestOwners.clear();
      this.activeThreadHints.clear();
      for (const [threadId, runtime] of this.runtimes) {
        if (runtime.state === "running" || runtime.state === "waitingForInput") {
          this.connectionInterruptedTurns.set(threadId, runtime.activeTurnId ?? null);
          this.setRuntime(threadId, { state: "disconnected", activeTurnId: undefined, pendingRequestIds: [] });
        }
      }
      for (const [threadId, subagent] of this.subagents) {
        const spawnOnlyActive = !this.runtimes.has(threadId) && (subagent.agentStatus === "pendingInit" || subagent.agentStatus === "running");
        if (subagent.state === "running" || subagent.state === "waitingForInput" || spawnOnlyActive) {
          this.updateSubagent(threadId, { state: "disconnected", activeTurnId: undefined, pendingRequestIds: [] });
        }
      }
    }
    this.events.publish("connection.changed", { state });
  }

  reconcileFromSnapshot(threadId: string, turns: SessionTurn[]): SnapshotReconciliationResult {
    return this.reconcileSnapshot(threadId, turns, false);
  }

  confirmUncertainTurnNotApplied(threadId: string, turns: SessionTurn[], activeTurnId?: string): SnapshotReconciliationResult {
    if (activeTurnId) {
      this.setActiveTurn(threadId, activeTurnId);
      return "reconciled";
    }
    return this.reconcileSnapshot(threadId, turns, true);
  }

  confirmUncertainTurnApplied(threadId: string, turns: SessionTurn[], activeTurnId?: string): SnapshotReconciliationResult {
    if (activeTurnId) {
      this.setActiveTurn(threadId, activeTurnId);
      this.events.publish("uncertainTurn.applied", { threadId }, this.ids(threadId));
      return "reconciled";
    }
    this.uncertainTurnBaselines.delete(threadId);
    this.setRuntime(threadId, { uncertainTurnStart: undefined });
    const outcome = this.reconcileSnapshot(threadId, turns, false);
    this.events.publish("uncertainTurn.applied", { threadId }, this.ids(threadId));
    return outcome;
  }

  private reconcileSnapshot(threadId: string, turns: SessionTurn[], acceptUnchangedUncertainTurn: boolean): SnapshotReconciliationResult {
    this.clearFinishTimer(threadId);
    const lastTurn = turns.at(-1);
    const interruptedTurn = this.connectionInterruptedTurns.get(threadId);
    const uncertainTurnStart = interruptedTurn === null && this.uncertainTurnBaselines.has(threadId);
    const uncertainTurnBaseline = this.uncertainTurnBaselines.get(threadId);
    const interruptedSnapshot = interruptedTurn === undefined || interruptedTurn === null
      ? undefined
      : turns.find((turn) => turn.id === interruptedTurn);
    const interruptedTurnIsTerminal = interruptedTurn !== undefined
      && interruptedTurn !== null
      && interruptedSnapshot !== undefined
      && interruptedSnapshot.status !== "inProgress";
    const knownInterruptedTurnIsUnresolved = interruptedTurn !== undefined && interruptedTurn !== null && !interruptedTurnIsTerminal;
    const uncertainTurnIsUnchanged = uncertainTurnStart && (!lastTurn || lastTurn.id === uncertainTurnBaseline);
    const uncertainTurnWasApplied = uncertainTurnStart && !uncertainTurnIsUnchanged;
    const uncertainTurnIsUnresolved = uncertainTurnStart
      && ((uncertainTurnIsUnchanged && !acceptUnchangedUncertainTurn) || lastTurn?.status === "inProgress");
    const acceptedEmptyUncertainTurn = !lastTurn && uncertainTurnIsUnchanged && acceptUnchangedUncertainTurn;
    if ((!lastTurn && !acceptedEmptyUncertainTurn) || lastTurn?.status === "inProgress" || knownInterruptedTurnIsUnresolved || uncertainTurnIsUnresolved) {
      this.setRuntime(threadId, {
        state: "disconnected",
        activeTurnId: undefined,
        pendingRequestIds: [],
        uncertainTurnStart: uncertainTurnStart || undefined,
      });
      return uncertainTurnIsUnchanged && !acceptUnchangedUncertainTurn ? "uncertainTurnUnchanged" : "unresolved";
    }
    this.activeThreadHints.delete(threadId);
    this.connectionInterruptedTurns.delete(threadId);
    this.uncertainTurnBaselines.delete(threadId);
    if (!lastTurn) {
      this.setRuntime(threadId, { state: "idle", activeTurnId: undefined, pendingRequestIds: [], uncertainTurnStart: undefined });
      return "reconciled";
    }
    const lastCompletedAt = (lastTurn.completedAt ?? Math.floor(Date.now() / 1_000)) * 1_000;
    const state: RuntimeState = lastTurn.status === "completed"
      ? Date.now() - lastCompletedAt < 20_000 ? "justFinished" : "idle"
      : lastTurn.status;
    this.setRuntime(threadId, {
      state,
      activeTurnId: undefined,
      pendingRequestIds: [],
      uncertainTurnStart: undefined,
      lastCompletedAt,
      lastTerminalStatus: lastTurn.status,
    });
    if (!this.sideChats.has(threadId)) this.repositories.markThreadTerminal(threadId, lastTurn.status, lastCompletedAt);
    if (state === "justFinished") this.scheduleIdle(threadId, Math.max(0, 20_000 - (Date.now() - lastCompletedAt)));
    if (uncertainTurnWasApplied) this.events.publish("uncertainTurn.applied", { threadId }, this.ids(threadId));
    return "reconciled";
  }

  handlePendingRequest(request: AdapterPendingRequest): void {
    const requestId = request.id;
    this.pendingRequests.set(requestId, request);
    const threadId = this.visibleRequestThreadId(request.threadId);
    if (threadId) {
      this.pendingRequestOwners.set(requestId, threadId);
      this.activeThreadHints.add(threadId);
      const runtime = this.get(threadId);
      this.setRuntime(threadId, {
        state: "waitingForInput",
        pendingRequestIds: [...new Set([...runtime.pendingRequestIds, requestId])],
      });
    }
    this.events.publish("pendingRequest.created", request.summary, threadId ? { threadId } : {});
  }

  resolveServerRequest(requestId: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) return;
    this.pendingRequests.delete(requestId);
    const threadId = this.pendingRequestOwners.get(requestId) ?? this.visibleRequestThreadId(request.threadId);
    this.pendingRequestOwners.delete(requestId);
    if (threadId) {
      if (this.closedSideChats.has(threadId) || this.removedThreads.has(threadId)) {
        this.events.publish("pendingRequest.resolved", { id: requestId }, { threadId });
        return;
      }
      const runtime = this.get(threadId);
      const pendingRequestIds = runtime.pendingRequestIds.filter((id) => id !== requestId);
      const terminalVisualState = runtime.state === "justFinished" || runtime.state === "interrupted" || runtime.state === "failed";
      this.setRuntime(threadId, {
        pendingRequestIds,
        state: pendingRequestIds.length
          ? "waitingForInput"
          : terminalVisualState
            ? runtime.state
            : runtime.activeTurnId || this.activeThreadHints.has(threadId) ? "running" : "idle",
      });
    }
    this.events.publish("pendingRequest.resolved", { id: requestId }, threadId ? { threadId } : {});
  }

  handleEvent(event: AdapterEvent): void {
    if (event.type === "serverRequestResolved") {
      this.resolveServerRequest(event.requestId);
      return;
    }
    if (event.type === "threadStarted") {
      if (event.parentThreadId) {
        this.subagentParents.set(event.threadId, event.parentThreadId);
        this.updateSubagent(event.threadId, event.subagent ?? {
          threadId: event.threadId,
          parentThreadId: event.parentThreadId,
          forkedFromId: event.thread.forkedFromId,
          contextMode: event.thread.forkedFromId ? "forked" : "isolated",
          sourceKind: "unknown",
          depth: null,
          agentPath: null,
          agentNickname: null,
          agentRole: null,
          createdAt: event.thread.createdAt * 1_000,
        });
      }
      return;
    }
    const threadId = event.threadId;
    if (this.closedSideChats.has(threadId) || this.removedThreads.has(threadId)) return;
    switch (event.type) {
      case "threadStatusChanged": {
        const activeFlags = event.activeFlags;
        const current = this.get(threadId);
        const terminalVisualState = current.state === "justFinished" || current.state === "interrupted" || current.state === "failed";
        const waitingForInput = current.pendingRequestIds.length > 0
          || activeFlags.some((flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput");
        const state: RuntimeState = event.status === "active"
          ? (waitingForInput ? "waitingForInput" : "running")
          : event.status === "systemError" ? "failed" : terminalVisualState ? current.state : "idle";
        if (event.status === "active") this.activeThreadHints.add(threadId);
        else this.activeThreadHints.delete(threadId);
        if (event.status === "systemError") {
          this.clearFinishTimer(threadId);
          this.clearPendingRequests(threadId, current.pendingRequestIds);
          this.clearLiveDeltas(threadId);
          this.setRuntime(threadId, {
            state,
            activeFlags,
            activeTurnId: undefined,
            pendingRequestIds: [],
            lastCompletedAt: Date.now(),
            lastTerminalStatus: "failed",
          });
          if (!this.sideChats.has(threadId)) this.repositories.markThreadTerminal(threadId, "failed", Date.now());
        } else if (event.status !== "active") {
          this.clearPendingRequests(threadId, current.pendingRequestIds);
          this.clearLiveDeltas(threadId);
          this.setRuntime(threadId, {
            state,
            activeFlags,
            activeTurnId: undefined,
            pendingRequestIds: [],
          });
        } else {
          this.setRuntime(threadId, {
            state,
            activeFlags,
          });
        }
        break;
      }
      case "turnStarted": {
        const turn = event.turn;
        const uncertainTurnWasApplied = this.uncertainTurnBaselines.has(threadId);
        this.connectionInterruptedTurns.delete(threadId);
        this.uncertainTurnBaselines.delete(threadId);
        this.activeThreadHints.add(threadId);
        this.clearFinishTimer(threadId);
        if (!this.sideChats.has(threadId)) this.repositories.clearThreadTerminal(threadId);
        this.setRuntime(threadId, {
          state: "running",
          activeTurnId: turn.id,
          uncertainTurnStart: undefined,
          lastTerminalStatus: undefined,
        });
        this.events.publish("turn.started", { turn }, this.ids(threadId));
        if (uncertainTurnWasApplied) this.events.publish("uncertainTurn.applied", { threadId }, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "turn-started" }, { threadId });
        break;
      }
      case "turnCompleted": {
        const turn = event.turn;
        this.connectionInterruptedTurns.delete(threadId);
        this.uncertainTurnBaselines.delete(threadId);
        this.activeThreadHints.delete(threadId);
        const status = turn.status === "inProgress" ? "failed" : turn.status;
        const state: RuntimeState = status === "completed" ? "justFinished" : status;
        const pendingRequestIds = this.get(threadId).pendingRequestIds;
        this.clearPendingRequests(threadId, pendingRequestIds);
        this.clearLiveDeltas(threadId);
        this.setRuntime(threadId, {
          state,
          activeTurnId: undefined,
          pendingRequestIds: [],
          uncertainTurnStart: undefined,
          lastCompletedAt: Date.now(),
          lastTerminalStatus: status,
        });
        if (!this.sideChats.has(threadId)) this.repositories.markThreadTerminal(threadId, status, Date.now());
        if (status === "completed") this.scheduleIdle(threadId);
        this.events.publish("turn.completed", { turn }, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "turn-completed" }, { threadId });
        break;
      }
      case "turnError":
        this.events.publish("turn.error", { turnId: event.turnId, error: event.error }, this.ids(threadId));
        break;
      case "itemUpserted": {
        if (event.subagentUpdate) {
          for (const receiverThreadId of event.subagentUpdate.receiverThreadIds) {
            const agentState = event.subagentUpdate.agentsStates[receiverThreadId];
            if (event.subagentUpdate.spawn) {
              this.subagentParents.set(receiverThreadId, event.subagentUpdate.parentThreadId);
              const existingParent = this.subagents.get(event.subagentUpdate.parentThreadId);
              const existingChild = this.subagents.get(receiverThreadId);
              this.updateSubagent(receiverThreadId, {
                parentThreadId: event.subagentUpdate.parentThreadId,
                requestedModel: event.subagentUpdate.model,
                requestedReasoning: event.subagentUpdate.reasoning,
                prompt: event.subagentUpdate.prompt,
                depth: existingChild?.depth ?? (existingParent ? existingParent.depth === null ? null : existingParent.depth + 1 : 0),
                ...(agentState ? { agentStatus: agentState.status, statusMessage: agentState.message } : {}),
              });
            } else if (agentState && this.subagents.has(receiverThreadId)) {
              this.updateSubagent(receiverThreadId, { agentStatus: agentState.status, statusMessage: agentState.message });
            }
          }
        }
        this.events.publish("item.upserted", { turnId: event.turnId, item: event.item, completed: event.completed, ...("startedAtMs" in event ? { startedAtMs: event.startedAtMs } : {}), ...("completedAtMs" in event ? { completedAtMs: event.completedAtMs } : {}) }, this.ids(threadId));
        if (event.completed) {
          this.liveDeltas.delete(event.item.id);
          this.liveDeltaThreads.delete(event.item.id);
        }
        break;
      }
      case "itemDelta":
        this.liveDeltas.set(event.delta.itemId, (this.liveDeltas.get(event.delta.itemId) ?? "") + event.delta.delta);
        this.liveDeltaThreads.set(event.delta.itemId, threadId);
        this.events.publish("item.delta", event.delta, this.ids(threadId));
        break;
      case "goalUpdated":
        this.events.publish("goal.updated", { goal: event.goal }, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "goal-updated" }, { threadId });
        break;
      case "goalCleared":
        this.events.publish("goal.cleared", { threadId }, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "goal-cleared" }, { threadId });
        break;
      case "tokenUsageUpdated":
        this.setRuntime(threadId, { contextUsage: event.contextUsage });
        break;
      case "settingsUpdated":
        this.updateSubagent(threadId, { model: event.settings.model, reasoning: event.settings.reasoning });
        this.events.publish("session.settings.updated", { settings: event.settings }, this.ids(threadId));
        break;
      case "nameUpdated":
        this.events.publish("session.summary.updated", { reason: "renamed", name: event.name ?? null }, { threadId });
        break;
      default:
        break;
    }
  }

  setActiveTurn(threadId: string, turnId: string): void {
    this.connectionInterruptedTurns.delete(threadId);
    this.uncertainTurnBaselines.delete(threadId);
    this.activeThreadHints.add(threadId);
    if (!this.sideChats.has(threadId)) this.repositories.clearThreadTerminal(threadId);
    this.setRuntime(threadId, { state: "running", activeTurnId: turnId, uncertainTurnStart: undefined });
  }

  markOperationUncertain(threadId: string, previousLastTurnId?: string): void {
    this.connectionInterruptedTurns.set(threadId, null);
    this.uncertainTurnBaselines.set(threadId, previousLastTurnId);
    this.activeThreadHints.delete(threadId);
    this.setRuntime(threadId, {
      state: "disconnected",
      activeTurnId: undefined,
      pendingRequestIds: [],
      uncertainTurnStart: true,
    });
  }

  notifySessionSummaryUpdated(threadId: string, reason: string, details: Record<string, unknown> = {}): void {
    this.events.publish("session.summary.updated", { reason, ...details }, { threadId });
  }

  markViewed(threadId: string): void {
    const runtime = this.get(threadId);
    if (runtime.state === "failed") {
      this.setRuntime(threadId, { state: "idle" });
    }
    if (!this.sideChats.has(threadId)) this.repositories.markThreadViewed(threadId);
  }

  private setRuntime(threadId: string, changes: Partial<ThreadRuntime>): void {
    const current = this.get(threadId);
    const updated = { ...current, ...changes } as ThreadRuntime;
    for (const key of Object.keys(updated) as Array<keyof ThreadRuntime>) {
      if (updated[key] === undefined) delete updated[key];
    }
    this.runtimes.set(threadId, updated);
    if (this.sideChats.has(threadId)) this.sideChats.set(threadId, updated as SideChatRuntime);
    if (this.subagents.has(threadId)) this.updateSubagent(threadId, updated);
    if (updated.activeTurnId) this.resolveActiveTurnWaiters(threadId, updated.activeTurnId);
    else if (updated.state !== "running" && updated.state !== "waitingForInput") this.resolveActiveTurnWaiters(threadId, undefined);
    if (!updated.activeTurnId && updated.state !== "running" && updated.state !== "waitingForInput") this.resolveTerminalWaiters(threadId, true);
    this.events.publish("runtime.changed", updated, this.ids(threadId));
  }

  private resolveTerminalWaiters(threadId: string, value: boolean): void {
    const waiters = this.terminalWaiters.get(threadId);
    if (!waiters) return;
    this.terminalWaiters.delete(threadId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  private resolveActiveTurnWaiters(threadId: string, value: string | undefined): void {
    const waiters = this.activeTurnWaiters.get(threadId);
    if (!waiters) return;
    this.activeTurnWaiters.delete(threadId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  private clearPendingRequests(threadId: string, requestIds: string[]): void {
    for (const requestId of requestIds) {
      this.pendingRequests.delete(requestId);
      this.pendingRequestOwners.delete(requestId);
      this.events.publish("pendingRequest.resolved", { id: requestId }, this.ids(threadId));
    }
  }

  private visibleRequestThreadId(threadId: string | undefined): string | undefined {
    if (!threadId) return undefined;
    const visited = new Set<string>();
    let current = threadId;
    while (!visited.has(current)) {
      visited.add(current);
      const parent = this.subagentParents.get(current);
      if (!parent) return current;
      current = parent;
    }
    return threadId;
  }

  private removeSubagentMappings(threadId: string): void {
    const pending = [threadId];
    const removed = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (removed.has(current)) continue;
      removed.add(current);
      for (const [subagentId, parentThreadId] of this.subagentParents) {
        if (parentThreadId === current) pending.push(subagentId);
      }
    }
    for (const removedThreadId of removed) {
      this.subagentParents.delete(removedThreadId);
      this.subagents.delete(removedThreadId);
    }
  }

  private updateSubagent(threadId: string, changes: Partial<SubagentRuntime> | SubagentDescriptor): void {
    const current = this.subagents.get(threadId);
    const parentThreadId = changes.parentThreadId ?? current?.parentThreadId;
    if (!parentThreadId) return;
    const runtime = this.get(threadId);
    const base: SubagentRuntime = current ?? {
      ...runtime,
      threadId,
      parentThreadId,
      forkedFromId: null,
      contextMode: "unknown",
      sourceKind: "unknown",
      depth: null,
      agentPath: null,
      agentNickname: null,
      agentRole: null,
      createdAt: Date.now(),
      requestedModel: null,
      requestedReasoning: null,
      model: null,
      reasoning: null,
      prompt: null,
    };
    const updated = { ...base, ...runtime, ...changes, threadId, parentThreadId } as SubagentRuntime;
    this.subagents.set(threadId, updated);
    this.events.publish("subagent.changed", updated, { threadId: this.visibleRequestThreadId(parentThreadId) ?? parentThreadId });
  }

  private clearLiveDeltas(threadId: string): void {
    for (const [itemId, ownerThreadId] of this.liveDeltaThreads) {
      if (ownerThreadId !== threadId) continue;
      this.liveDeltaThreads.delete(itemId);
      this.liveDeltas.delete(itemId);
    }
  }

  private hydratePersistedStates(): void {
    const now = Date.now();
    for (const row of this.repositories.listThreadUiStates()) {
      const status = row.last_terminal_status;
      const lastCompletedAt = row.last_completed_at;
      if (!lastCompletedAt || (status !== "completed" && status !== "interrupted" && status !== "failed")) continue;
      if (status === "failed" && (row.last_viewed_at ?? 0) >= lastCompletedAt) continue;
      const state: RuntimeState = status === "completed"
        ? now - lastCompletedAt < 20_000 ? "justFinished" : "idle"
        : status;
      if (state === "idle") continue;
      this.runtimes.set(row.thread_id, {
        threadId: row.thread_id,
        state,
        activeFlags: [],
        pendingRequestIds: [],
        lastCompletedAt,
        lastTerminalStatus: status,
      });
      if (state === "justFinished") this.scheduleIdle(row.thread_id, Math.max(0, 20_000 - (now - lastCompletedAt)));
    }
  }

  private scheduleIdle(threadId: string, delay = 20_000): void {
    this.clearFinishTimer(threadId);
    this.finishTimers.set(threadId, setTimeout(() => {
      if (this.get(threadId).state === "justFinished") this.setRuntime(threadId, { state: "idle" });
      this.finishTimers.delete(threadId);
    }, delay));
  }

  private clearFinishTimer(threadId: string): void {
    const timer = this.finishTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.finishTimers.delete(threadId);
  }

  private ids(threadId: string): { threadId: string; sideChatId?: string } {
    return this.sideChats.has(threadId) ? { threadId, sideChatId: threadId } : { threadId };
  }

}

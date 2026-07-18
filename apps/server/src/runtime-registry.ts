import type { PendingRequestSummary, RuntimeState, SessionTurn, SideChatRuntime, ThreadRuntime } from "@codex-web/shared-types";
import type { AdapterEvent, AdapterPendingRequest } from "@codex-web/codex-adapter";
import { EventGateway } from "./event-gateway.js";
import { Repositories } from "./database.js";

type TerminalWaiter = { resolve(value: boolean): void; timer: NodeJS.Timeout };

export class ThreadRuntimeRegistry {
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly sideChats = new Map<string, SideChatRuntime>();
  private readonly pendingRequests = new Map<string, AdapterPendingRequest>();
  private readonly liveDeltas = new Map<string, string>();
  private readonly liveDeltaThreads = new Map<string, string>();
  private readonly finishTimers = new Map<string, NodeJS.Timeout>();
  private readonly terminalWaiters = new Map<string, Set<TerminalWaiter>>();
  private readonly closedSideChats = new Set<string>();

  constructor(private readonly events: EventGateway, private readonly repositories: Repositories) {
    this.hydratePersistedStates();
  }

  list(): ThreadRuntime[] { return [...this.runtimes.values()].map((item) => ({ ...item })); }
  listSideChats(): SideChatRuntime[] { return [...this.sideChats.values()].map((item) => ({ ...item })); }
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
    this.sideChats.set(runtime.threadId, runtime);
    this.runtimes.set(runtime.threadId, runtime);
    this.events.publish("sideChat.created", runtime, { threadId: runtime.parentThreadId, sideChatId: runtime.threadId });
  }

  removeSideChat(threadId: string): void {
    const sideChat = this.sideChats.get(threadId);
    if (!sideChat) return;
    this.sideChats.delete(threadId);
    this.runtimes.delete(threadId);
    this.clearLiveDeltas(threadId);
    this.closedSideChats.add(threadId);
    this.resolveTerminalWaiters(threadId, false);
    this.events.publish("sideChat.closed", { threadId }, { threadId: sideChat.parentThreadId, sideChatId: threadId });
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

  handleConnection(state: "connected" | "connecting" | "disconnected"): void {
    if (state === "disconnected") {
      this.liveDeltas.clear();
      this.liveDeltaThreads.clear();
      this.pendingRequests.clear();
      for (const [threadId, runtime] of this.runtimes) {
        if (runtime.state === "running" || runtime.state === "waitingForInput") {
          this.setRuntime(threadId, { state: "disconnected", activeTurnId: undefined, pendingRequestIds: [] });
        }
      }
    }
    this.events.publish("connection.changed", { state });
  }

  reconcileFromSnapshot(threadId: string, lastTurn: SessionTurn | undefined): void {
    this.clearFinishTimer(threadId);
    if (!lastTurn || lastTurn.status === "inProgress") {
      this.setRuntime(threadId, { state: "disconnected", activeTurnId: undefined, pendingRequestIds: [] });
      return;
    }
    const lastCompletedAt = (lastTurn.completedAt ?? Math.floor(Date.now() / 1_000)) * 1_000;
    const state: RuntimeState = lastTurn.status === "completed"
      ? Date.now() - lastCompletedAt < 20_000 ? "justFinished" : "idle"
      : lastTurn.status;
    this.setRuntime(threadId, {
      state,
      activeTurnId: undefined,
      pendingRequestIds: [],
      lastCompletedAt,
      lastTerminalStatus: lastTurn.status,
    });
    if (!this.sideChats.has(threadId)) this.repositories.markThreadTerminal(threadId, lastTurn.status, lastCompletedAt);
    if (state === "justFinished") this.scheduleIdle(threadId, Math.max(0, 20_000 - (Date.now() - lastCompletedAt)));
  }

  handlePendingRequest(request: AdapterPendingRequest): void {
    const requestId = request.id;
    this.pendingRequests.set(requestId, request);
    const threadId = request.threadId;
    if (threadId) {
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
    const threadId = request.threadId;
    if (threadId) {
      const runtime = this.get(threadId);
      const pendingRequestIds = runtime.pendingRequestIds.filter((id) => id !== requestId);
      const terminalVisualState = runtime.state === "justFinished" || runtime.state === "interrupted" || runtime.state === "failed";
      this.setRuntime(threadId, {
        pendingRequestIds,
        state: pendingRequestIds.length ? "waitingForInput" : runtime.activeTurnId ? "running" : terminalVisualState ? runtime.state : "idle",
      });
    }
    this.events.publish("pendingRequest.resolved", { id: requestId }, threadId ? { threadId } : {});
  }

  handleEvent(event: AdapterEvent): void {
    if (event.type === "serverRequestResolved") {
      this.resolveServerRequest(event.requestId);
      return;
    }
    const threadId = event.threadId;
    if (this.closedSideChats.has(threadId)) return;
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
        } else {
          this.setRuntime(threadId, { state, activeFlags });
        }
        break;
      }
      case "turnStarted": {
        const turn = event.turn;
        this.clearFinishTimer(threadId);
        if (!this.sideChats.has(threadId)) this.repositories.clearThreadTerminal(threadId);
        this.setRuntime(threadId, { state: "running", activeTurnId: turn.id, lastTerminalStatus: undefined });
        this.events.publish("turn.started", { turn }, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "turn-started" }, { threadId });
        break;
      }
      case "turnCompleted": {
        const turn = event.turn;
        const status = turn.status === "inProgress" ? "failed" : turn.status;
        const state: RuntimeState = status === "completed" ? "justFinished" : status;
        const pendingRequestIds = this.get(threadId).pendingRequestIds;
        this.clearPendingRequests(threadId, pendingRequestIds);
        this.clearLiveDeltas(threadId);
        this.setRuntime(threadId, {
          state,
          activeTurnId: undefined,
          pendingRequestIds: [],
          lastCompletedAt: Date.now(),
          lastTerminalStatus: status,
        });
        if (!this.sideChats.has(threadId)) this.repositories.markThreadTerminal(threadId, status, Date.now());
        if (status === "completed") this.scheduleIdle(threadId);
        this.events.publish("turn.completed", { turn }, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "turn-completed" }, { threadId });
        break;
      }
      case "itemUpserted": {
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
      case "settingsUpdated":
        this.events.publish("session.settings.updated", { settings: event.settings }, this.ids(threadId));
        break;
      case "nameUpdated":
        this.events.publish("session.summary.updated", { reason: "renamed", ...(event.name ? { name: event.name } : {}) }, { threadId });
        break;
      default:
        break;
    }
  }

  setActiveTurn(threadId: string, turnId: string): void {
    if (!this.sideChats.has(threadId)) this.repositories.clearThreadTerminal(threadId);
    this.setRuntime(threadId, { state: "running", activeTurnId: turnId });
  }

  notifySessionSummaryUpdated(threadId: string, reason: string): void {
    this.events.publish("session.summary.updated", { reason }, { threadId });
  }

  markViewed(threadId: string): void {
    const runtime = this.get(threadId);
    if (runtime.state === "failed" || runtime.state === "interrupted") {
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

  private clearPendingRequests(threadId: string, requestIds: string[]): void {
    for (const requestId of requestIds) {
      this.pendingRequests.delete(requestId);
      this.events.publish("pendingRequest.resolved", { id: requestId }, this.ids(threadId));
    }
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
      if ((status === "failed" || status === "interrupted") && (row.last_viewed_at ?? 0) >= lastCompletedAt) continue;
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

import type { RuntimeState, SideChatRuntime, ThreadRuntime } from "@codex-web/shared-types";
import type { RpcServerRequest } from "@codex-web/codex-adapter";
import { EventGateway } from "./event-gateway.js";
import { Repositories } from "./database.js";

type Notification = { method: string; params?: unknown };

export class ThreadRuntimeRegistry {
  private readonly runtimes = new Map<string, ThreadRuntime>();
  private readonly sideChats = new Map<string, SideChatRuntime>();
  private readonly pendingRequests = new Map<string, RpcServerRequest>();
  private readonly finishTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly events: EventGateway, private readonly repositories: Repositories) {}

  list(): ThreadRuntime[] { return [...this.runtimes.values()].map((item) => ({ ...item })); }
  listSideChats(): SideChatRuntime[] { return [...this.sideChats.values()].map((item) => ({ ...item })); }
  get(threadId: string): ThreadRuntime {
    return this.runtimes.get(threadId) ?? { threadId, state: "idle", activeFlags: [], pendingRequestIds: [] };
  }
  getSideChat(threadId: string): SideChatRuntime | undefined { return this.sideChats.get(threadId); }
  getPendingRequest(id: string): RpcServerRequest | undefined { return this.pendingRequests.get(id); }

  registerSideChat(runtime: SideChatRuntime): void {
    this.sideChats.set(runtime.threadId, runtime);
    this.runtimes.set(runtime.threadId, runtime);
    this.events.publish("sideChat.created", runtime, { threadId: runtime.parentThreadId, sideChatId: runtime.threadId });
  }

  removeSideChat(threadId: string): void {
    const sideChat = this.sideChats.get(threadId);
    if (!sideChat) return;
    this.sideChats.delete(threadId);
    this.runtimes.delete(threadId);
    this.events.publish("sideChat.closed", { threadId }, { threadId: sideChat.parentThreadId, sideChatId: threadId });
  }

  handleConnection(state: "connected" | "connecting" | "disconnected"): void {
    if (state === "disconnected") {
      for (const [threadId, runtime] of this.runtimes) {
        if (runtime.state === "running" || runtime.state === "waitingForInput") {
          this.setRuntime(threadId, { state: "disconnected", activeTurnId: undefined });
        }
      }
    }
    this.events.publish("connection.changed", { state });
  }

  handleServerRequest(request: RpcServerRequest): void {
    const requestId = String(request.id);
    this.pendingRequests.set(requestId, request);
    const threadId = this.threadIdFromParams(request.params);
    if (threadId) {
      const runtime = this.get(threadId);
      this.setRuntime(threadId, {
        state: "waitingForInput",
        pendingRequestIds: [...new Set([...runtime.pendingRequestIds, requestId])],
      });
    }
    this.events.publish("pendingRequest.created", { id: requestId, method: request.method, params: request.params }, threadId ? { threadId } : {});
  }

  resolveServerRequest(requestId: string): void {
    const request = this.pendingRequests.get(requestId);
    if (!request) return;
    this.pendingRequests.delete(requestId);
    const threadId = this.threadIdFromParams(request.params);
    if (threadId) {
      const runtime = this.get(threadId);
      const pendingRequestIds = runtime.pendingRequestIds.filter((id) => id !== requestId);
      this.setRuntime(threadId, { pendingRequestIds, state: runtime.activeTurnId ? "running" : "idle" });
    }
    this.events.publish("pendingRequest.resolved", { id: requestId }, threadId ? { threadId } : {});
  }

  handleNotification(notification: Notification): void {
    const params = (notification.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    switch (notification.method) {
      case "thread/status/changed": {
        if (!threadId) break;
        const status = params.status as { type?: string; activeFlags?: unknown[] } | undefined;
        const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags.map(String) : [];
        const state: RuntimeState = status?.type === "active"
          ? (this.get(threadId).pendingRequestIds.length ? "waitingForInput" : "running")
          : status?.type === "systemError" ? "failed" : "idle";
        this.setRuntime(threadId, { state, activeFlags });
        break;
      }
      case "turn/started": {
        if (!threadId) break;
        const turn = params.turn as { id?: string } | undefined;
        this.clearFinishTimer(threadId);
        this.setRuntime(threadId, { state: "running", activeTurnId: turn?.id, lastTerminalStatus: undefined });
        this.events.publish("turn.started", params, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "turn-started" }, { threadId });
        break;
      }
      case "turn/completed": {
        if (!threadId) break;
        const turn = params.turn as { id?: string; status?: "completed" | "interrupted" | "failed" } | undefined;
        const status = turn?.status ?? "failed";
        const state: RuntimeState = status === "completed" ? "justFinished" : status;
        this.setRuntime(threadId, {
          state,
          activeTurnId: undefined,
          lastCompletedAt: Date.now(),
          lastTerminalStatus: status,
        });
        this.repositories.markThreadTerminal(threadId, status, Date.now());
        if (status === "completed") this.scheduleIdle(threadId);
        this.events.publish("turn.completed", params, this.ids(threadId));
        this.events.publish("session.summary.updated", { reason: "turn-completed" }, { threadId });
        break;
      }
      case "item/started":
      case "item/completed":
        if (threadId) this.events.publish("item.upserted", params, this.ids(threadId));
        break;
      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
      case "item/commandExecution/outputDelta":
        if (threadId) this.events.publish("item.delta", { source: notification.method, ...params }, this.ids(threadId));
        break;
      case "thread/goal/updated":
        if (threadId) this.events.publish("goal.updated", params, this.ids(threadId));
        break;
      case "thread/goal/cleared":
        if (threadId) this.events.publish("goal.cleared", params, this.ids(threadId));
        break;
      case "thread/name/updated":
        if (threadId) this.events.publish("session.summary.updated", { reason: "renamed", ...params }, { threadId });
        break;
      default:
        if (threadId) this.events.publish("codex.notification", notification, this.ids(threadId));
    }
  }

  setActiveTurn(threadId: string, turnId: string): void {
    this.setRuntime(threadId, { state: "running", activeTurnId: turnId });
  }

  markViewed(threadId: string): void {
    const runtime = this.get(threadId);
    if (runtime.state === "failed" || runtime.state === "interrupted" || runtime.state === "justFinished") {
      this.setRuntime(threadId, { state: "idle" });
    }
    this.repositories.markThreadViewed(threadId);
  }

  private setRuntime(threadId: string, changes: Partial<ThreadRuntime>): void {
    const current = this.get(threadId);
    const updated = { ...current, ...changes } as ThreadRuntime;
    for (const key of Object.keys(updated) as Array<keyof ThreadRuntime>) {
      if (updated[key] === undefined) delete updated[key];
    }
    this.runtimes.set(threadId, updated);
    if (this.sideChats.has(threadId)) this.sideChats.set(threadId, updated as SideChatRuntime);
    this.events.publish("runtime.changed", updated, this.ids(threadId));
  }

  private scheduleIdle(threadId: string): void {
    this.clearFinishTimer(threadId);
    this.finishTimers.set(threadId, setTimeout(() => {
      if (this.get(threadId).state === "justFinished") this.setRuntime(threadId, { state: "idle" });
      this.finishTimers.delete(threadId);
    }, 20_000));
  }

  private clearFinishTimer(threadId: string): void {
    const timer = this.finishTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.finishTimers.delete(threadId);
  }

  private ids(threadId: string): { threadId: string; sideChatId?: string } {
    return this.sideChats.has(threadId) ? { threadId, sideChatId: threadId } : { threadId };
  }

  private threadIdFromParams(params: unknown): string | undefined {
    if (!params || typeof params !== "object") return undefined;
    const candidate = params as Record<string, unknown>;
    return typeof candidate.threadId === "string" ? candidate.threadId : undefined;
  }
}

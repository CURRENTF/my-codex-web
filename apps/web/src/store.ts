import { create } from "zustand";
import type { PendingRequestSummary, SideChatRuntime, ThreadRuntime, UiEvent } from "@codex-web/shared-types";

interface AppStore {
  connectionState: "connected" | "connecting" | "disconnected";
  lastEventSeq: number;
  runtimes: Record<string, ThreadRuntime>;
  sideChats: Record<string, SideChatRuntime>;
  deltas: Record<string, string>;
  pendingRequests: Record<string, PendingRequestSummary>;
  drafts: Record<string, string>;
  pendingSubmissions: Record<string, { draft: string; clientUserMessageId: string; state: "sending" | "uncertain" | "retryReady" }>;
  optimisticUserMessages: Record<string, OptimisticUserMessage[]>;
  injectedPrefills: Record<string, string>;
  queuedSlashCommands: Record<string, QueuedSlashCommand>;
  setDraft(threadId: string, text: string): void;
  beginSubmission(threadId: string, draft: string, clientUserMessageId: string): void;
  acceptSubmission(threadId: string): void;
  markSubmissionUncertain(threadId: string): void;
  markSubmissionRetryReady(threadId: string, clientUserMessageId?: string): void;
  finishSubmission(threadId: string, clearDraft: boolean): void;
  reconcileOptimisticUserMessages(threadId: string, confirmedClientIds: readonly string[]): void;
  restorePrefill(threadId: string, text: string): void;
  queueSlashCommand(threadId: string, command: QueuedSlashCommand): void;
  clearQueuedSlashCommand(threadId: string, clientRequestId?: string): void;
  initialize(runtimes: ThreadRuntime[], sideChats: SideChatRuntime[], deltas?: Record<string, string>, pendingRequests?: PendingRequestSummary[], connectionState?: "connected" | "connecting" | "disconnected", eventSeq?: number, sessionPrefills?: Record<string, string>): void;
  markDisconnected(): void;
  consume(event: UiEvent): void;
}

export interface OptimisticUserMessage {
  clientUserMessageId: string;
  text: string;
  state: "sending" | "queued" | "uncertain";
}

export interface QueuedSlashCommand {
  raw: string;
  clientRequestId: string;
  createdAt: number;
}

const QUEUED_SLASH_STORAGE_KEY = "codex-web:queued-slash-commands:v1";

function readQueuedSlashCommands(): Record<string, QueuedSlashCommand> {
  if (typeof window === "undefined") return {};
  try {
    const value = JSON.parse(window.localStorage.getItem(QUEUED_SLASH_STORAGE_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([threadId, command]) => {
      if (!command || typeof command !== "object") return [];
      const candidate = command as Partial<QueuedSlashCommand>;
      return typeof candidate.raw === "string" && typeof candidate.clientRequestId === "string" && typeof candidate.createdAt === "number"
        ? [[threadId, candidate as QueuedSlashCommand]]
        : [];
    }));
  } catch {
    return {};
  }
}

function persistQueuedSlashCommands(commands: Record<string, QueuedSlashCommand>): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(QUEUED_SLASH_STORAGE_KEY, JSON.stringify(commands)); } catch { /* storage can be unavailable in private contexts */ }
}

function withoutOptimisticMessages(
  messagesByThread: Record<string, OptimisticUserMessage[]>,
  threadId: string,
  clientIds: readonly string[],
): Record<string, OptimisticUserMessage[]> {
  const messages = messagesByThread[threadId];
  if (!messages?.length || !clientIds.length) return messagesByThread;
  const confirmed = new Set(clientIds);
  const remaining = messages.filter((message) => !confirmed.has(message.clientUserMessageId));
  if (remaining.length === messages.length) return messagesByThread;
  const next = { ...messagesByThread };
  if (remaining.length) next[threadId] = remaining;
  else delete next[threadId];
  return next;
}

export const useAppStore = create<AppStore>((set) => ({
  connectionState: "connecting", lastEventSeq: 0, runtimes: {}, sideChats: {}, deltas: {}, pendingRequests: {}, drafts: {}, pendingSubmissions: {}, optimisticUserMessages: {}, injectedPrefills: {}, queuedSlashCommands: readQueuedSlashCommands(),
  setDraft: (threadId, text) => set((state) => {
    const injectedPrefills = { ...state.injectedPrefills };
    delete injectedPrefills[threadId];
    return { drafts: { ...state.drafts, [threadId]: text }, injectedPrefills };
  }),
  beginSubmission: (threadId, draft, clientUserMessageId) => set((state) => {
    const currentMessages = state.optimisticUserMessages[threadId] ?? [];
    const optimisticMessage: OptimisticUserMessage = { clientUserMessageId, text: draft.trim(), state: "sending" };
    const existingIndex = currentMessages.findIndex((message) => message.clientUserMessageId === clientUserMessageId);
    const nextMessages = [...currentMessages];
    if (existingIndex < 0) nextMessages.push(optimisticMessage);
    else nextMessages[existingIndex] = optimisticMessage;
    return {
      pendingSubmissions: {
        ...state.pendingSubmissions,
        [threadId]: { draft, clientUserMessageId, state: "sending" },
      },
      optimisticUserMessages: { ...state.optimisticUserMessages, [threadId]: nextMessages },
    };
  }),
  acceptSubmission: (threadId) => set((state) => {
    const pending = state.pendingSubmissions[threadId];
    if (!pending) return state;
    const pendingSubmissions = { ...state.pendingSubmissions };
    const drafts = { ...state.drafts };
    delete pendingSubmissions[threadId];
    if (drafts[threadId] === pending.draft) delete drafts[threadId];
    const messages = state.optimisticUserMessages[threadId];
    const optimisticUserMessages = messages?.some((message) => message.clientUserMessageId === pending.clientUserMessageId)
      ? {
          ...state.optimisticUserMessages,
          [threadId]: messages.map((message) => message.clientUserMessageId === pending.clientUserMessageId
            ? { ...message, state: "queued" as const }
            : message),
        }
      : state.optimisticUserMessages;
    return { pendingSubmissions, drafts, optimisticUserMessages };
  }),
  markSubmissionUncertain: (threadId) => set((state) => {
    const pending = state.pendingSubmissions[threadId];
    return pending ? {
      pendingSubmissions: {
        ...state.pendingSubmissions,
        [threadId]: { ...pending, state: "uncertain" },
      },
      optimisticUserMessages: {
        ...state.optimisticUserMessages,
        [threadId]: (state.optimisticUserMessages[threadId] ?? []).map((message) => message.clientUserMessageId === pending.clientUserMessageId
          ? { ...message, state: "uncertain" as const }
          : message),
      },
    } : state;
  }),
  markSubmissionRetryReady: (threadId, clientUserMessageId) => set((state) => {
    const pending = state.pendingSubmissions[threadId];
    if (!pending) return state;
    return {
      pendingSubmissions: {
        ...state.pendingSubmissions,
        [threadId]: {
          ...pending,
          ...(clientUserMessageId ? { clientUserMessageId } : {}),
          state: "retryReady",
        },
      },
      optimisticUserMessages: withoutOptimisticMessages(
        state.optimisticUserMessages,
        threadId,
        [pending.clientUserMessageId, ...(clientUserMessageId ? [clientUserMessageId] : [])],
      ),
    };
  }),
  finishSubmission: (threadId, clearDraft) => set((state) => {
    const pending = state.pendingSubmissions[threadId];
    if (!pending) return state;
    const pendingSubmissions = { ...state.pendingSubmissions };
    const drafts = { ...state.drafts };
    delete pendingSubmissions[threadId];
    if (clearDraft && drafts[threadId] === pending.draft) delete drafts[threadId];
    return {
      pendingSubmissions,
      drafts,
      optimisticUserMessages: withoutOptimisticMessages(state.optimisticUserMessages, threadId, [pending.clientUserMessageId]),
    };
  }),
  reconcileOptimisticUserMessages: (threadId, confirmedClientIds) => set((state) => {
    const optimisticUserMessages = withoutOptimisticMessages(state.optimisticUserMessages, threadId, confirmedClientIds);
    return optimisticUserMessages === state.optimisticUserMessages ? state : { optimisticUserMessages };
  }),
  restorePrefill: (threadId, text) => set((state) => {
    if (!text || Object.hasOwn(state.drafts, threadId)) return state;
    return {
      drafts: { ...state.drafts, [threadId]: text },
      injectedPrefills: { ...state.injectedPrefills, [threadId]: text },
    };
  }),
  queueSlashCommand: (threadId, command) => set((state) => {
    const queuedSlashCommands = { ...state.queuedSlashCommands, [threadId]: command };
    persistQueuedSlashCommands(queuedSlashCommands);
    return { queuedSlashCommands };
  }),
  clearQueuedSlashCommand: (threadId, clientRequestId) => set((state) => {
    const current = state.queuedSlashCommands[threadId];
    if (!current || (clientRequestId && current.clientRequestId !== clientRequestId)) return state;
    const queuedSlashCommands = { ...state.queuedSlashCommands };
    delete queuedSlashCommands[threadId];
    persistQueuedSlashCommands(queuedSlashCommands);
    return { queuedSlashCommands };
  }),
  initialize: (runtimes, sideChats, deltas = {}, pendingRequests = [], connectionState = "connected", eventSeq = 0, sessionPrefills = {}) => set((state) => {
    const drafts = { ...state.drafts };
    const injectedPrefills = { ...state.injectedPrefills };
    for (const [threadId, injected] of Object.entries(injectedPrefills)) {
      if (sessionPrefills[threadId] !== undefined) continue;
      if (drafts[threadId] === injected) delete drafts[threadId];
      delete injectedPrefills[threadId];
    }
    for (const [threadId, prefill] of Object.entries(sessionPrefills)) {
      if (!prefill) continue;
      const injected = injectedPrefills[threadId];
      if (!Object.hasOwn(drafts, threadId) || (injected !== undefined && drafts[threadId] === injected)) {
        drafts[threadId] = prefill;
        injectedPrefills[threadId] = prefill;
      }
    }
    return {
      connectionState,
      lastEventSeq: eventSeq,
      runtimes: Object.fromEntries(runtimes.map((runtime) => [runtime.threadId, runtime])),
      sideChats: Object.fromEntries(sideChats.map((runtime) => [runtime.threadId, runtime])),
      deltas,
      pendingRequests: Object.fromEntries(pendingRequests.map((request) => [request.id, request])),
      drafts,
      injectedPrefills,
    };
  }),
  markDisconnected: () => set((state) => ({
    connectionState: "disconnected",
    runtimes: Object.fromEntries(Object.entries(state.runtimes).map(([threadId, runtime]) => [threadId, {
      ...runtime,
      state: "disconnected" as const,
      activeTurnId: undefined,
    }])),
  })),
  consume: (event) => set((state) => {
    if (event.seq <= state.lastEventSeq) return state;
    const sequenced = { lastEventSeq: event.seq };
    if (event.type === "connection.changed") {
      const connectionState = (event.payload as { state?: AppStore["connectionState"] }).state;
      return connectionState ? { ...sequenced, connectionState } : sequenced;
    }
    if (event.type === "runtime.changed") {
      const runtime = event.payload as ThreadRuntime;
      return { ...sequenced, runtimes: { ...state.runtimes, [runtime.threadId]: runtime } };
    }
    if (event.type === "turn.started" && event.threadId) {
      const injected = state.injectedPrefills[event.threadId];
      const drafts = { ...state.drafts };
      const injectedPrefills = { ...state.injectedPrefills };
      if (injected !== undefined && drafts[event.threadId] === injected) delete drafts[event.threadId];
      if (injected !== undefined) delete injectedPrefills[event.threadId];
      return injected !== undefined ? { ...sequenced, drafts, injectedPrefills } : sequenced;
    }
    if (event.type === "uncertainTurn.applied" && event.threadId) {
      const pending = state.pendingSubmissions[event.threadId];
      if (!pending) return sequenced;
      const drafts = { ...state.drafts };
      const pendingSubmissions = { ...state.pendingSubmissions };
      if (drafts[event.threadId] === pending.draft) delete drafts[event.threadId];
      delete pendingSubmissions[event.threadId];
      const messages = state.optimisticUserMessages[event.threadId] ?? [];
      return {
        ...sequenced,
        drafts,
        pendingSubmissions,
        optimisticUserMessages: {
          ...state.optimisticUserMessages,
          [event.threadId]: messages.map((message) => message.clientUserMessageId === pending.clientUserMessageId
            ? { ...message, state: "queued" as const }
            : message),
        },
      };
    }
    if (event.type === "sideChat.created") {
      const sideChat = event.payload as SideChatRuntime;
      return { ...sequenced, sideChats: { ...state.sideChats, [sideChat.threadId]: sideChat } };
    }
    if (event.type === "sideChat.closed" && event.sideChatId) {
      const sideChats = { ...state.sideChats }; delete sideChats[event.sideChatId]; return { ...sequenced, sideChats };
    }
    if (event.type === "item.delta") {
      const payload = event.payload as { itemId?: string; delta?: string };
      if (!payload.itemId || !payload.delta) return sequenced;
      return { ...sequenced, deltas: { ...state.deltas, [payload.itemId]: (state.deltas[payload.itemId] ?? "") + payload.delta } };
    }
    if (event.type === "item.upserted") {
      const payload = event.payload as { item?: { id?: string; type?: string; clientId?: string | null }; completedAtMs?: number; completed?: boolean };
      const itemId = payload.item?.id;
      const optimisticUserMessages = event.threadId && payload.item?.type === "userMessage" && payload.item.clientId
        ? withoutOptimisticMessages(state.optimisticUserMessages, event.threadId, [payload.item.clientId])
        : state.optimisticUserMessages;
      if (!itemId || (!payload.completed && payload.completedAtMs === undefined) || state.deltas[itemId] === undefined) {
        return optimisticUserMessages === state.optimisticUserMessages ? sequenced : { ...sequenced, optimisticUserMessages };
      }
      const deltas = { ...state.deltas }; delete deltas[itemId];
      return optimisticUserMessages === state.optimisticUserMessages
        ? { ...sequenced, deltas }
        : { ...sequenced, deltas, optimisticUserMessages };
    }
    if (event.type === "pendingRequest.created") {
      const pending = event.payload as PendingRequestSummary;
      return { ...sequenced, pendingRequests: { ...state.pendingRequests, [pending.id]: pending } };
    }
    if (event.type === "pendingRequest.resolved") {
      const { id } = event.payload as { id: string }; const pendingRequests = { ...state.pendingRequests }; delete pendingRequests[id]; return { ...sequenced, pendingRequests };
    }
    return sequenced;
  }),
}));

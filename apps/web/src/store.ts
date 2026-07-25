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
  injectedPrefills: Record<string, string>;
  setDraft(threadId: string, text: string): void;
  beginSubmission(threadId: string, draft: string, clientUserMessageId: string): void;
  markSubmissionUncertain(threadId: string): void;
  markSubmissionRetryReady(threadId: string, clientUserMessageId?: string): void;
  finishSubmission(threadId: string, clearDraft: boolean): void;
  restorePrefill(threadId: string, text: string): void;
  initialize(runtimes: ThreadRuntime[], sideChats: SideChatRuntime[], deltas?: Record<string, string>, pendingRequests?: PendingRequestSummary[], connectionState?: "connected" | "connecting" | "disconnected", eventSeq?: number, sessionPrefills?: Record<string, string>): void;
  markDisconnected(): void;
  consume(event: UiEvent): void;
}

export const useAppStore = create<AppStore>((set) => ({
  connectionState: "connecting", lastEventSeq: 0, runtimes: {}, sideChats: {}, deltas: {}, pendingRequests: {}, drafts: {}, pendingSubmissions: {}, injectedPrefills: {},
  setDraft: (threadId, text) => set((state) => {
    const injectedPrefills = { ...state.injectedPrefills };
    delete injectedPrefills[threadId];
    return { drafts: { ...state.drafts, [threadId]: text }, injectedPrefills };
  }),
  beginSubmission: (threadId, draft, clientUserMessageId) => set((state) => ({
    pendingSubmissions: {
      ...state.pendingSubmissions,
      [threadId]: { draft, clientUserMessageId, state: "sending" },
    },
  })),
  markSubmissionUncertain: (threadId) => set((state) => {
    const pending = state.pendingSubmissions[threadId];
    return pending ? {
      pendingSubmissions: {
        ...state.pendingSubmissions,
        [threadId]: { ...pending, state: "uncertain" },
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
    };
  }),
  finishSubmission: (threadId, clearDraft) => set((state) => {
    const pending = state.pendingSubmissions[threadId];
    if (!pending) return state;
    const pendingSubmissions = { ...state.pendingSubmissions };
    const drafts = { ...state.drafts };
    delete pendingSubmissions[threadId];
    if (clearDraft && drafts[threadId] === pending.draft) delete drafts[threadId];
    return { pendingSubmissions, drafts };
  }),
  restorePrefill: (threadId, text) => set((state) => {
    if (!text || Object.hasOwn(state.drafts, threadId)) return state;
    return {
      drafts: { ...state.drafts, [threadId]: text },
      injectedPrefills: { ...state.injectedPrefills, [threadId]: text },
    };
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
      return { ...sequenced, drafts, pendingSubmissions };
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
      const payload = event.payload as { item?: { id?: string }; completedAtMs?: number; completed?: boolean };
      const itemId = payload.item?.id;
      if (!itemId || (!payload.completed && payload.completedAtMs === undefined) || state.deltas[itemId] === undefined) return sequenced;
      const deltas = { ...state.deltas }; delete deltas[itemId]; return { ...sequenced, deltas };
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

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
  setDraft(threadId: string, text: string): void;
  initialize(runtimes: ThreadRuntime[], sideChats: SideChatRuntime[], deltas?: Record<string, string>, pendingRequests?: PendingRequestSummary[], connectionState?: "connected" | "connecting" | "disconnected", eventSeq?: number): void;
  markDisconnected(): void;
  consume(event: UiEvent): void;
}

export const useAppStore = create<AppStore>((set) => ({
  connectionState: "connecting", lastEventSeq: 0, runtimes: {}, sideChats: {}, deltas: {}, pendingRequests: {}, drafts: {},
  setDraft: (threadId, text) => set((state) => ({ drafts: { ...state.drafts, [threadId]: text } })),
  initialize: (runtimes, sideChats, deltas = {}, pendingRequests = [], connectionState = "connected", eventSeq = 0) => set({
    connectionState,
    lastEventSeq: eventSeq,
    runtimes: Object.fromEntries(runtimes.map((runtime) => [runtime.threadId, runtime])),
    sideChats: Object.fromEntries(sideChats.map((runtime) => [runtime.threadId, runtime])),
    deltas,
    pendingRequests: Object.fromEntries(pendingRequests.map((request) => [request.id, request])),
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

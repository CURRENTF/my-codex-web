import { create } from "zustand";
import type { SideChatRuntime, ThreadRuntime, UiEvent } from "@codex-web/shared-types";

interface AppStore {
  runtimes: Record<string, ThreadRuntime>;
  sideChats: Record<string, SideChatRuntime>;
  deltas: Record<string, string>;
  pendingRequests: Record<string, { id: string; method: string; params: unknown }>;
  drafts: Record<string, string>;
  setDraft(threadId: string, text: string): void;
  initialize(runtimes: ThreadRuntime[], sideChats: SideChatRuntime[]): void;
  consume(event: UiEvent): void;
}

export const useAppStore = create<AppStore>((set) => ({
  runtimes: {}, sideChats: {}, deltas: {}, pendingRequests: {}, drafts: {},
  setDraft: (threadId, text) => set((state) => ({ drafts: { ...state.drafts, [threadId]: text } })),
  initialize: (runtimes, sideChats) => set({
    runtimes: Object.fromEntries(runtimes.map((runtime) => [runtime.threadId, runtime])),
    sideChats: Object.fromEntries(sideChats.map((runtime) => [runtime.threadId, runtime])),
  }),
  consume: (event) => set((state) => {
    if (event.type === "runtime.changed") {
      const runtime = event.payload as ThreadRuntime;
      return { runtimes: { ...state.runtimes, [runtime.threadId]: runtime } };
    }
    if (event.type === "sideChat.created") {
      const sideChat = event.payload as SideChatRuntime;
      return { sideChats: { ...state.sideChats, [sideChat.threadId]: sideChat } };
    }
    if (event.type === "sideChat.closed" && event.sideChatId) {
      const sideChats = { ...state.sideChats }; delete sideChats[event.sideChatId]; return { sideChats };
    }
    if (event.type === "item.delta") {
      const payload = event.payload as { itemId?: string; delta?: string };
      if (!payload.itemId || !payload.delta) return state;
      return { deltas: { ...state.deltas, [payload.itemId]: (state.deltas[payload.itemId] ?? "") + payload.delta } };
    }
    if (event.type === "pendingRequest.created") {
      const pending = event.payload as { id: string; method: string; params: unknown };
      return { pendingRequests: { ...state.pendingRequests, [pending.id]: pending } };
    }
    if (event.type === "pendingRequest.resolved") {
      const { id } = event.payload as { id: string }; const pendingRequests = { ...state.pendingRequests }; delete pendingRequests[id]; return { pendingRequests };
    }
    return state;
  }),
}));

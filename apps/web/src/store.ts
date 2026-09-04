import { create } from "zustand";
import type { AccessMode, PendingRequestSummary, SideChatRuntime, SubagentRuntime, ThreadRuntime, UiEvent, UploadedAttachment } from "@codex-web/shared-types";
import type { QueuedTurnBarrier } from "./queued-turn-barrier";

interface AppStore {
  connectionState: "connected" | "connecting" | "disconnected";
  lastEventSeq: number;
  runtimes: Record<string, ThreadRuntime>;
  sideChats: Record<string, SideChatRuntime>;
  subagents: Record<string, SubagentRuntime>;
  deltas: Record<string, string>;
  pendingRequests: Record<string, PendingRequestSummary>;
  drafts: Record<string, string>;
  pendingSubmissions: Record<string, { draft: string; clientUserMessageId: string; state: "sending" | "uncertain" | "retryReady" }>;
  optimisticUserMessages: Record<string, OptimisticUserMessage[]>;
  injectedPrefills: Record<string, string>;
  queuedSubmissions: Record<string, QueuedSubmission[]>;
  queuedEffectiveSettings: Record<string, QueuedMessageSettings>;
  queuedTurnBarriers: Record<string, QueuedTurnBarrier>;
  setDraft(threadId: string, text: string): void;
  beginSubmission(threadId: string, draft: string, clientUserMessageId: string, attachments?: UploadedAttachment[]): void;
  acceptSubmission(threadId: string): void;
  markSubmissionUncertain(threadId: string): void;
  markSubmissionRetryReady(threadId: string, clientUserMessageId?: string): void;
  finishSubmission(threadId: string, clearDraft: boolean, returnToQueue?: boolean): void;
  reconcileOptimisticUserMessages(threadId: string, confirmedClientIds: readonly string[]): void;
  restorePrefill(threadId: string, text: string): void;
  enqueueSubmission(threadId: string, submission: QueuedSubmission): void;
  applyQueuedSettings(threadId: string, settings: QueuedMessageSettings): void;
  setQueuedTurnBarrier(threadId: string, barrier: QueuedTurnBarrier | null): void;
  removeQueuedSubmission(threadId: string, clientRequestId: string, preserveOptimistic?: boolean): void;
  initialize(runtimes: ThreadRuntime[], sideChats: SideChatRuntime[], deltas?: Record<string, string>, pendingRequests?: PendingRequestSummary[], connectionState?: "connected" | "connecting" | "disconnected", eventSeq?: number, sessionPrefills?: Record<string, string>, subagents?: SubagentRuntime[]): void;
  markDisconnected(): void;
  consume(event: UiEvent): void;
}

export interface OptimisticUserMessage {
  clientUserMessageId: string;
  text: string;
  attachments?: UploadedAttachment[];
  state: "sending" | "queued" | "uncertain";
}

export interface QueuedSlashCommand {
  raw: string;
  clientRequestId: string;
  createdAt: number;
}

export interface QueuedUserMessage {
  text: string;
  attachments?: UploadedAttachment[];
  skillNames: string[];
  model: string;
  reasoning: string;
  serviceTier: string | null;
  accessMode: AccessMode;
  clientRequestId: string;
  clientUserMessageId: string;
  createdAt: number;
}

export type QueuedMessageSettings = Pick<QueuedUserMessage, "model" | "reasoning" | "serviceTier" | "accessMode">;
export type QueuedSubmission = ({ kind: "command" } & QueuedSlashCommand) | ({ kind: "message" } & QueuedUserMessage);

const QUEUED_SUBMISSIONS_STORAGE_KEY = "codex-web:queued-submissions:v2";
const QUEUED_EFFECTIVE_SETTINGS_STORAGE_KEY = "codex-web:queued-effective-settings:v1";
const QUEUED_TURN_BARRIERS_STORAGE_KEY = "codex-web:queued-turn-barriers:v1";
const LEGACY_QUEUED_SLASH_STORAGE_KEY = "codex-web:queued-slash-commands:v1";
const LEGACY_QUEUED_USER_MESSAGE_STORAGE_KEY = "codex-web:queued-user-messages:v1";

function parseQueuedSlashCommand(value: unknown): QueuedSlashCommand | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<QueuedSlashCommand>;
  return typeof candidate.raw === "string" && typeof candidate.clientRequestId === "string" && typeof candidate.createdAt === "number"
    ? candidate as QueuedSlashCommand
    : null;
}

function parseQueuedUserMessage(value: unknown): QueuedUserMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<QueuedUserMessage>;
  const validAccessMode = candidate.accessMode === "fullAccess" || candidate.accessMode === "workspaceWrite" || candidate.accessMode === "readOnly";
  const validAttachments = candidate.attachments === undefined || (Array.isArray(candidate.attachments) && candidate.attachments.every((attachment) => attachment && typeof attachment === "object" && typeof attachment.id === "string" && typeof attachment.name === "string"));
  const validServiceTier = candidate.serviceTier === undefined || candidate.serviceTier === null || typeof candidate.serviceTier === "string";
  return typeof candidate.text === "string" && Array.isArray(candidate.skillNames) && candidate.skillNames.every((name) => typeof name === "string")
    && typeof candidate.model === "string" && typeof candidate.reasoning === "string" && validAccessMode && validAttachments
    && validServiceTier
    && typeof candidate.clientRequestId === "string" && typeof candidate.clientUserMessageId === "string" && typeof candidate.createdAt === "number"
    ? { ...candidate, serviceTier: candidate.serviceTier ?? null, attachments: candidate.attachments ?? [] } as QueuedUserMessage
    : null;
}

function parseQueuedMessageSettings(value: unknown): QueuedMessageSettings | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<QueuedMessageSettings>;
  const validAccessMode = candidate.accessMode === "fullAccess" || candidate.accessMode === "workspaceWrite" || candidate.accessMode === "readOnly";
  const validServiceTier = candidate.serviceTier === null || typeof candidate.serviceTier === "string";
  return typeof candidate.model === "string" && typeof candidate.reasoning === "string" && validServiceTier && validAccessMode
    ? candidate as QueuedMessageSettings
    : null;
}

function parseQueuedTurnBarrier(value: unknown): QueuedTurnBarrier | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<QueuedTurnBarrier>;
  const validTurnId = candidate.turnId === undefined || typeof candidate.turnId === "string";
  return typeof candidate.clientRequestId === "string" && (candidate.previousLatestTurnId === null || typeof candidate.previousLatestTurnId === "string") && validTurnId
    ? candidate as QueuedTurnBarrier
    : null;
}

function parseQueuedSubmission(value: unknown): QueuedSubmission | null {
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "command") {
    const command = parseQueuedSlashCommand(value);
    return command ? { ...command, kind } : null;
  }
  if (kind === "message") {
    const message = parseQueuedUserMessage(value);
    return message ? { ...message, kind } : null;
  }
  return null;
}

function parseQueuedSubmissionRecord(value: unknown): Record<string, QueuedSubmission[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([threadId, queue]) => {
    if (!Array.isArray(queue)) return [];
    const submissions = queue.flatMap((submission) => {
      const parsed = parseQueuedSubmission(submission);
      return parsed ? [parsed] : [];
    });
    return submissions.length ? [[threadId, submissions]] : [];
  }));
}

function parseLegacyRecord<T>(raw: string | null, parse: (value: unknown) => T | null): Record<string, T> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([threadId, item]) => {
      const parsed = parse(item);
      return parsed ? [[threadId, parsed]] : [];
    }));
  } catch {
    return {};
  }
}

function readStorageValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(key); }
  catch { return null; }
}

function readQueuedSubmissions(): Record<string, QueuedSubmission[]> {
  if (typeof window === "undefined") return {};
  const current = readStorageValue(QUEUED_SUBMISSIONS_STORAGE_KEY);
  if (current !== null) {
    try { return parseQueuedSubmissionRecord(JSON.parse(current)); }
    catch { return {}; }
  }
  const commands = parseLegacyRecord(readStorageValue(LEGACY_QUEUED_SLASH_STORAGE_KEY), parseQueuedSlashCommand);
  const messages = parseLegacyRecord(readStorageValue(LEGACY_QUEUED_USER_MESSAGE_STORAGE_KEY), parseQueuedUserMessage);
  const threadIds = new Set([...Object.keys(commands), ...Object.keys(messages)]);
  return Object.fromEntries([...threadIds].flatMap((threadId) => {
    const queue: QueuedSubmission[] = [
      ...(commands[threadId] ? [{ ...commands[threadId], kind: "command" as const }] : []),
      ...(messages[threadId] ? [{ ...messages[threadId], kind: "message" as const }] : []),
    ].sort((left, right) => left.createdAt - right.createdAt);
    return queue.length ? [[threadId, queue]] : [];
  }));
}

function persistQueuedSubmissions(submissions: Record<string, QueuedSubmission[]>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(QUEUED_SUBMISSIONS_STORAGE_KEY, JSON.stringify(submissions));
    window.localStorage.removeItem(LEGACY_QUEUED_SLASH_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_QUEUED_USER_MESSAGE_STORAGE_KEY);
  } catch { /* storage can be unavailable in private contexts */ }
}

const initialQueuedSubmissions = readQueuedSubmissions();
const storedQueuedEffectiveSettings = typeof window === "undefined"
  ? {}
  : parseLegacyRecord(readStorageValue(QUEUED_EFFECTIVE_SETTINGS_STORAGE_KEY), parseQueuedMessageSettings);
const initialQueuedEffectiveSettings = Object.fromEntries(Object.entries(initialQueuedSubmissions).flatMap(([threadId, queue]) => {
  const firstMessage = queue.find((submission): submission is Extract<QueuedSubmission, { kind: "message" }> => submission.kind === "message");
  const settings = storedQueuedEffectiveSettings[threadId] ?? (firstMessage ? {
    model: firstMessage.model,
    reasoning: firstMessage.reasoning,
    serviceTier: firstMessage.serviceTier,
    accessMode: firstMessage.accessMode,
  } : undefined);
  return settings ? [[threadId, settings]] : [];
}));
function persistQueuedEffectiveSettings(settings: Record<string, QueuedMessageSettings>): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(QUEUED_EFFECTIVE_SETTINGS_STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* storage can be unavailable in private contexts */ }
}
const storedQueuedTurnBarriers = typeof window === "undefined"
  ? {}
  : parseLegacyRecord(readStorageValue(QUEUED_TURN_BARRIERS_STORAGE_KEY), parseQueuedTurnBarrier);
const initialQueuedTurnBarriers = Object.fromEntries(Object.entries(storedQueuedTurnBarriers).filter(([threadId]) => initialQueuedSubmissions[threadId]?.length));
function persistQueuedTurnBarriers(barriers: Record<string, QueuedTurnBarrier>): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(QUEUED_TURN_BARRIERS_STORAGE_KEY, JSON.stringify(barriers)); }
  catch { /* storage can be unavailable in private contexts */ }
}
const initialQueuedOptimisticMessages = Object.fromEntries(Object.entries(initialQueuedSubmissions).flatMap(([threadId, queue]) => {
  const messages = queue.flatMap((submission): OptimisticUserMessage[] => submission.kind === "message" ? [{
    clientUserMessageId: submission.clientUserMessageId,
    text: submission.text,
    ...(submission.attachments?.length ? { attachments: submission.attachments } : {}),
    state: "queued",
  }] : []);
  return messages.length ? [[threadId, messages]] : [];
}));

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
  connectionState: "connecting", lastEventSeq: 0, runtimes: {}, sideChats: {}, subagents: {}, deltas: {}, pendingRequests: {}, drafts: {}, pendingSubmissions: {}, optimisticUserMessages: initialQueuedOptimisticMessages, injectedPrefills: {}, queuedSubmissions: initialQueuedSubmissions, queuedEffectiveSettings: initialQueuedEffectiveSettings, queuedTurnBarriers: initialQueuedTurnBarriers,
  setDraft: (threadId, text) => set((state) => {
    const injectedPrefills = { ...state.injectedPrefills };
    delete injectedPrefills[threadId];
    return { drafts: { ...state.drafts, [threadId]: text }, injectedPrefills };
  }),
  beginSubmission: (threadId, draft, clientUserMessageId, attachments = []) => set((state) => {
    const currentMessages = state.optimisticUserMessages[threadId] ?? [];
    const optimisticMessage: OptimisticUserMessage = { clientUserMessageId, text: draft.trim(), ...(attachments.length ? { attachments } : {}), state: "sending" };
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
  finishSubmission: (threadId, clearDraft, returnToQueue = false) => set((state) => {
    const pending = state.pendingSubmissions[threadId];
    if (!pending) return state;
    const pendingSubmissions = { ...state.pendingSubmissions };
    const drafts = { ...state.drafts };
    delete pendingSubmissions[threadId];
    if (clearDraft && drafts[threadId] === pending.draft) delete drafts[threadId];
    return {
      pendingSubmissions,
      drafts,
      optimisticUserMessages: returnToQueue
        ? {
            ...state.optimisticUserMessages,
            [threadId]: (state.optimisticUserMessages[threadId] ?? []).map((message) => message.clientUserMessageId === pending.clientUserMessageId
              ? { ...message, state: "queued" as const }
              : message),
          }
        : withoutOptimisticMessages(state.optimisticUserMessages, threadId, [pending.clientUserMessageId]),
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
  enqueueSubmission: (threadId, submission) => set((state) => {
    const currentQueue = state.queuedSubmissions[threadId] ?? [];
    const existingIndex = currentQueue.findIndex((candidate) => candidate.clientRequestId === submission.clientRequestId);
    const nextQueue = [...currentQueue];
    if (existingIndex < 0) nextQueue.push(submission);
    else nextQueue[existingIndex] = submission;
    const queuedSubmissions = { ...state.queuedSubmissions, [threadId]: nextQueue };
    persistQueuedSubmissions(queuedSubmissions);
    if (submission.kind === "command") return { queuedSubmissions };
    const currentMessages = state.optimisticUserMessages[threadId] ?? [];
    const queuedOptimisticMessage: OptimisticUserMessage = {
      clientUserMessageId: submission.clientUserMessageId,
      text: submission.text,
      ...((submission.attachments?.length ?? 0) ? { attachments: submission.attachments } : {}),
      state: "queued",
    };
    const existingMessageIndex = currentMessages.findIndex((candidate) => candidate.clientUserMessageId === submission.clientUserMessageId);
    const nextMessages = [...currentMessages];
    if (existingMessageIndex < 0) nextMessages.push(queuedOptimisticMessage);
    else nextMessages[existingMessageIndex] = queuedOptimisticMessage;
    return {
      queuedSubmissions,
      optimisticUserMessages: { ...state.optimisticUserMessages, [threadId]: nextMessages },
    };
  }),
  applyQueuedSettings: (threadId, settings) => set((state) => {
    const currentQueue = state.queuedSubmissions[threadId];
    if (!currentQueue?.length) return state;
    const queuedSubmissions = { ...state.queuedSubmissions, [threadId]: currentQueue.map((submission) => submission.kind === "message" ? { ...submission, ...settings } : submission) };
    const queuedEffectiveSettings = { ...state.queuedEffectiveSettings, [threadId]: settings };
    persistQueuedSubmissions(queuedSubmissions);
    persistQueuedEffectiveSettings(queuedEffectiveSettings);
    return { queuedSubmissions, queuedEffectiveSettings };
  }),
  setQueuedTurnBarrier: (threadId, barrier) => set((state) => {
    const queuedTurnBarriers = { ...state.queuedTurnBarriers };
    if (barrier) queuedTurnBarriers[threadId] = barrier;
    else delete queuedTurnBarriers[threadId];
    persistQueuedTurnBarriers(queuedTurnBarriers);
    return { queuedTurnBarriers };
  }),
  removeQueuedSubmission: (threadId, clientRequestId, preserveOptimistic = false) => set((state) => {
    const currentQueue = state.queuedSubmissions[threadId] ?? [];
    const current = currentQueue.find((submission) => submission.clientRequestId === clientRequestId);
    if (!current) return state;
    const remaining = currentQueue.filter((submission) => submission.clientRequestId !== clientRequestId);
    const queuedSubmissions = { ...state.queuedSubmissions };
    if (remaining.length) queuedSubmissions[threadId] = remaining;
    else delete queuedSubmissions[threadId];
    const queuedEffectiveSettings = { ...state.queuedEffectiveSettings };
    if (!remaining.length) delete queuedEffectiveSettings[threadId];
    const queuedTurnBarriers = { ...state.queuedTurnBarriers };
    if (!remaining.length) delete queuedTurnBarriers[threadId];
    persistQueuedSubmissions(queuedSubmissions);
    persistQueuedEffectiveSettings(queuedEffectiveSettings);
    persistQueuedTurnBarriers(queuedTurnBarriers);
    return {
      queuedSubmissions,
      queuedEffectiveSettings,
      queuedTurnBarriers,
      optimisticUserMessages: current.kind === "command" || preserveOptimistic
        ? state.optimisticUserMessages
        : withoutOptimisticMessages(state.optimisticUserMessages, threadId, [current.clientUserMessageId]),
    };
  }),
  initialize: (runtimes, sideChats, deltas = {}, pendingRequests = [], connectionState = "connected", eventSeq = 0, sessionPrefills = {}, subagents = []) => set((state) => {
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
      subagents: Object.fromEntries(subagents.map((runtime) => [runtime.threadId, runtime])),
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
    subagents: Object.fromEntries(Object.entries(state.subagents).map(([threadId, runtime]) => {
      const active = runtime.state === "running" || runtime.state === "waitingForInput" || runtime.agentStatus === "pendingInit" || runtime.agentStatus === "running";
      return [threadId, active ? { ...runtime, state: "disconnected" as const, activeTurnId: undefined } : runtime];
    })),
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
    if (event.type === "subagent.changed") {
      const subagent = event.payload as SubagentRuntime;
      return { ...sequenced, subagents: { ...state.subagents, [subagent.threadId]: subagent } };
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
      const payload = event.payload as { item?: { id?: string }; completedAtMs?: number; completed?: boolean };
      const itemId = payload.item?.id;
      if (!itemId || (!payload.completed && payload.completedAtMs === undefined) || state.deltas[itemId] === undefined) {
        return sequenced;
      }
      const deltas = { ...state.deltas }; delete deltas[itemId];
      return { ...sequenced, deltas };
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

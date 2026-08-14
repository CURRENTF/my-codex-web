import type { ContextUsage, Goal, ItemDeltaUiEventPayload, SessionItem, SessionThread, SessionTurn, SessionTurnError, SubagentAgentStatus, SubagentDescriptor, SubagentSourceKind } from "@codex-web/shared-types";
import type { Thread } from "@codex-web/codex-schema/v2/Thread";
import type { ThreadItem } from "@codex-web/codex-schema/v2/ThreadItem";
import type { ThreadSettings } from "@codex-web/codex-schema/v2/ThreadSettings";
import { projectFileChangePatch, projectItemDelta, projectThread, projectThreadItem, projectTurn, projectTurnError, projectTurnPlan } from "./ui-projection.js";
import type { TurnError } from "@codex-web/codex-schema/v2/TurnError";
import type { SessionSettings } from "./codex-adapter.js";

export type AdapterEvent =
  | { type: "threadStarted"; threadId: string; thread: SessionThread; threadSource?: string; parentThreadId?: string; subagent?: SubagentDescriptor }
  | { type: "threadStatusChanged"; threadId: string; status: "active" | "idle" | "notLoaded" | "systemError"; activeFlags: string[] }
  | { type: "turnStarted" | "turnCompleted"; threadId: string; turn: SessionTurn }
  | { type: "turnError"; threadId: string; turnId: string; error: SessionTurnError }
  | { type: "itemUpserted"; threadId: string; turnId: string; item: SessionItem; completed: boolean; startedAtMs?: number; completedAtMs?: number; subagentUpdate?: SubagentToolUpdate }
  | { type: "itemDelta"; threadId: string; turnId?: string; delta: ItemDeltaUiEventPayload }
  | { type: "goalUpdated"; threadId: string; goal: Goal }
  | { type: "goalCleared"; threadId: string }
  | { type: "tokenUsageUpdated"; threadId: string; contextUsage: ContextUsage }
  | { type: "settingsUpdated"; threadId: string; settings: SessionSettings }
  | { type: "nameUpdated"; threadId: string; name?: string }
  | { type: "serverRequestResolved"; requestId: string };

type Notification = { method: string; params?: unknown };
type ThreadStatus = Extract<AdapterEvent, { type: "threadStatusChanged" }>["status"];
type SubagentToolUpdate = {
  parentThreadId: string;
  receiverThreadIds: string[];
  spawn: boolean;
  prompt: string | null;
  model: string | null;
  reasoning: string | null;
  agentsStates: Record<string, { status: SubagentAgentStatus; message: string | null }>;
};

function subagentSourceKind(source: unknown): SubagentSourceKind {
  if (source === "review") return "review";
  if (source === "compact") return "compact";
  if (source === "memory_consolidation") return "memoryConsolidation";
  if (source && typeof source === "object" && "thread_spawn" in source) return "threadSpawn";
  if (source && typeof source === "object" && "other" in source) return "other";
  return "unknown";
}

export function projectSubagentDescriptor(thread: Thread): SubagentDescriptor | undefined {
  if (!thread.parentThreadId) return undefined;
  const subagentSource = thread.source && typeof thread.source === "object" && "subAgent" in thread.source
    ? thread.source.subAgent
    : undefined;
  const spawn = subagentSource && typeof subagentSource === "object" && "thread_spawn" in subagentSource
    ? subagentSource.thread_spawn
    : undefined;
  return {
    threadId: thread.id,
    parentThreadId: thread.parentThreadId,
    forkedFromId: thread.forkedFromId,
    contextMode: thread.forkedFromId ? "forked" : "isolated",
    sourceKind: subagentSourceKind(subagentSource),
    depth: spawn?.depth ?? null,
    agentPath: spawn?.agent_path ?? null,
    agentNickname: thread.agentNickname ?? spawn?.agent_nickname ?? null,
    agentRole: thread.agentRole ?? spawn?.agent_role ?? null,
    createdAt: thread.createdAt * 1_000,
  };
}

function projectSubagentUpdate(item: ThreadItem): SubagentToolUpdate | undefined {
  if (item.type !== "collabAgentToolCall") return undefined;
  return {
    parentThreadId: item.senderThreadId,
    receiverThreadIds: [...new Set([...item.receiverThreadIds, ...Object.keys(item.agentsStates)])],
    spawn: item.tool === "spawnAgent",
    prompt: item.prompt,
    model: item.model,
    reasoning: item.reasoningEffort,
    agentsStates: Object.fromEntries(Object.entries(item.agentsStates).map(([threadId, state]) => [threadId, {
      status: state!.status,
      message: state!.message,
    }])),
  };
}

export function projectAdapterEvent(notification: Notification): AdapterEvent | null {
  const params = (notification.params ?? {}) as Record<string, unknown>;
  if (notification.method === "thread/started" && params.thread && typeof params.thread === "object") {
    const thread = params.thread as Parameters<typeof projectThread>[0];
    if (typeof thread.id !== "string") return null;
    const subagent = projectSubagentDescriptor(thread);
    return {
      type: "threadStarted",
      threadId: thread.id,
      thread: projectThread(thread),
      ...(typeof thread.threadSource === "string" ? { threadSource: thread.threadSource } : {}),
      ...(typeof thread.parentThreadId === "string" ? { parentThreadId: thread.parentThreadId } : {}),
      ...(subagent ? { subagent } : {}),
    };
  }
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (notification.method === "serverRequest/resolved") {
    const requestId = typeof params.requestId === "string" || typeof params.requestId === "number" ? String(params.requestId) : null;
    return requestId ? { type: "serverRequestResolved", requestId } : null;
  }
  if (!threadId) return null;
  if (notification.method === "thread/status/changed") {
    const status = params.status as { type?: string; activeFlags?: unknown[] } | undefined;
    if (!status || !new Set(["active", "idle", "notLoaded", "systemError"]).has(status.type ?? "")) return null;
    return { type: "threadStatusChanged", threadId, status: status.type as ThreadStatus, activeFlags: Array.isArray(status.activeFlags) ? status.activeFlags.map(String) : [] };
  }
  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    if (!params.turn || typeof params.turn !== "object") return null;
    return { type: notification.method === "turn/started" ? "turnStarted" : "turnCompleted", threadId, turn: projectTurn(params.turn as Parameters<typeof projectTurn>[0]) };
  }
  if (notification.method === "error" && typeof params.turnId === "string" && params.error && typeof params.error === "object") {
    return {
      type: "turnError",
      threadId,
      turnId: params.turnId,
      error: projectTurnError(params.error as TurnError, params.willRetry === true),
    };
  }
  if (notification.method === "turn/plan/updated" && typeof params.turnId === "string" && Array.isArray(params.plan)) {
    return { type: "itemUpserted", threadId, turnId: params.turnId, item: projectTurnPlan(params as Parameters<typeof projectTurnPlan>[0]), completed: false };
  }
  if (notification.method === "item/fileChange/patchUpdated" && typeof params.turnId === "string" && typeof params.itemId === "string" && Array.isArray(params.changes)) {
    return { type: "itemUpserted", threadId, turnId: params.turnId, item: projectFileChangePatch(params as Parameters<typeof projectFileChangePatch>[0]), completed: false };
  }
  if ((notification.method === "item/started" || notification.method === "item/completed") && typeof params.turnId === "string" && params.item && typeof params.item === "object") {
    const rawItem = params.item as Parameters<typeof projectThreadItem>[0];
    const item = projectThreadItem(rawItem);
    if (!item) return null;
    const subagentUpdate = projectSubagentUpdate(rawItem);
    return {
      type: "itemUpserted", threadId, turnId: params.turnId, item, completed: notification.method === "item/completed",
      ...(typeof params.startedAtMs === "number" ? { startedAtMs: params.startedAtMs } : {}),
      ...(typeof params.completedAtMs === "number" ? { completedAtMs: params.completedAtMs } : {}),
      ...(subagentUpdate ? { subagentUpdate } : {}),
    };
  }
  const delta = projectItemDelta(notification.method, params);
  if (delta) return { type: "itemDelta", threadId, ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}), delta };
  if (notification.method === "thread/goal/updated") {
    const goal = params.goal;
    return goal && typeof goal === "object" ? { type: "goalUpdated", threadId, goal: goal as Goal } : null;
  }
  if (notification.method === "thread/goal/cleared") return { type: "goalCleared", threadId };
  if (notification.method === "thread/tokenUsage/updated") {
    const tokenUsage = params.tokenUsage;
    if (!tokenUsage || typeof tokenUsage !== "object") return null;
    const { last, modelContextWindow } = tokenUsage as { last?: unknown; modelContextWindow?: unknown };
    if (!last || typeof last !== "object") return null;
    const usedTokens = (last as { totalTokens?: unknown }).totalTokens;
    const validUsedTokens = typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
    const validContextWindow = modelContextWindow === null
      || (typeof modelContextWindow === "number" && Number.isFinite(modelContextWindow) && modelContextWindow >= 0);
    if (!validUsedTokens || !validContextWindow) return null;
    return { type: "tokenUsageUpdated", threadId, contextUsage: { usedTokens, maxTokens: modelContextWindow } };
  }
  if (notification.method === "thread/settings/updated") {
    const settings = params.threadSettings;
    return isThreadSettings(settings) ? { type: "settingsUpdated", threadId, settings: projectSettings(settings) } : null;
  }
  if (notification.method === "thread/name/updated") return { type: "nameUpdated", threadId, ...(typeof params.name === "string" ? { name: params.name } : {}) };
  return null;
}

function isThreadSettings(value: unknown): value is ThreadSettings {
  return !!value && typeof value === "object" && typeof (value as { model?: unknown }).model === "string" && !!(value as { sandboxPolicy?: unknown }).sandboxPolicy;
}

function projectSettings(settings: ThreadSettings): SessionSettings {
  const accessMode = settings.sandboxPolicy.type === "dangerFullAccess" && settings.approvalPolicy === "never"
    ? "fullAccess"
    : settings.sandboxPolicy.type === "workspaceWrite" ? "workspaceWrite" : "readOnly";
  return { model: settings.model || null, reasoning: settings.effort ?? null, accessMode };
}

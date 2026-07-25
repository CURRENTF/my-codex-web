import type { Goal, ItemDeltaUiEventPayload, SessionItem, SessionThread, SessionTurn } from "@codex-web/shared-types";
import type { ThreadSettings } from "@codex-web/codex-schema/v2/ThreadSettings";
import { projectFileChangePatch, projectItemDelta, projectThread, projectThreadItem, projectTurn, projectTurnPlan } from "./ui-projection.js";
import type { SessionSettings } from "./codex-adapter.js";

export type AdapterEvent =
  | { type: "threadStarted"; threadId: string; thread: SessionThread; threadSource?: string; parentThreadId?: string }
  | { type: "threadStatusChanged"; threadId: string; status: "active" | "idle" | "notLoaded" | "systemError"; activeFlags: string[] }
  | { type: "turnStarted" | "turnCompleted"; threadId: string; turn: SessionTurn }
  | { type: "itemUpserted"; threadId: string; turnId: string; item: SessionItem; completed: boolean; startedAtMs?: number; completedAtMs?: number }
  | { type: "itemDelta"; threadId: string; turnId?: string; delta: ItemDeltaUiEventPayload }
  | { type: "goalUpdated"; threadId: string; goal: Goal }
  | { type: "goalCleared"; threadId: string }
  | { type: "settingsUpdated"; threadId: string; settings: SessionSettings }
  | { type: "nameUpdated"; threadId: string; name?: string }
  | { type: "serverRequestResolved"; requestId: string };

type Notification = { method: string; params?: unknown };
type ThreadStatus = Extract<AdapterEvent, { type: "threadStatusChanged" }>["status"];

export function projectAdapterEvent(notification: Notification): AdapterEvent | null {
  const params = (notification.params ?? {}) as Record<string, unknown>;
  if (notification.method === "thread/started" && params.thread && typeof params.thread === "object") {
    const thread = params.thread as Parameters<typeof projectThread>[0];
    if (typeof thread.id !== "string") return null;
    return {
      type: "threadStarted",
      threadId: thread.id,
      thread: projectThread(thread),
      ...(typeof thread.threadSource === "string" ? { threadSource: thread.threadSource } : {}),
      ...(typeof thread.parentThreadId === "string" ? { parentThreadId: thread.parentThreadId } : {}),
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
  if (notification.method === "turn/plan/updated" && typeof params.turnId === "string" && Array.isArray(params.plan)) {
    return { type: "itemUpserted", threadId, turnId: params.turnId, item: projectTurnPlan(params as Parameters<typeof projectTurnPlan>[0]), completed: false };
  }
  if (notification.method === "item/fileChange/patchUpdated" && typeof params.turnId === "string" && typeof params.itemId === "string" && Array.isArray(params.changes)) {
    return { type: "itemUpserted", threadId, turnId: params.turnId, item: projectFileChangePatch(params as Parameters<typeof projectFileChangePatch>[0]), completed: false };
  }
  if ((notification.method === "item/started" || notification.method === "item/completed") && typeof params.turnId === "string" && params.item && typeof params.item === "object") {
    const item = projectThreadItem(params.item as Parameters<typeof projectThreadItem>[0]);
    if (!item) return null;
    return {
      type: "itemUpserted", threadId, turnId: params.turnId, item, completed: notification.method === "item/completed",
      ...(typeof params.startedAtMs === "number" ? { startedAtMs: params.startedAtMs } : {}),
      ...(typeof params.completedAtMs === "number" ? { completedAtMs: params.completedAtMs } : {}),
    };
  }
  const delta = projectItemDelta(notification.method, params);
  if (delta) return { type: "itemDelta", threadId, ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}), delta };
  if (notification.method === "thread/goal/updated") {
    const goal = params.goal;
    return goal && typeof goal === "object" ? { type: "goalUpdated", threadId, goal: goal as Goal } : null;
  }
  if (notification.method === "thread/goal/cleared") return { type: "goalCleared", threadId };
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

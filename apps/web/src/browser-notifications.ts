import type { SessionTurn } from "@codex-web/shared-types";

const STORAGE_KEY = "codex-web:turn-completion-notifications:v1";

export type BrowserNotificationPermission = NotificationPermission | "unsupported";
export type BrowserNotificationControlState = "enabled" | "disabled" | "blocked" | "unsupported";

export interface TurnCompletionNotificationInput {
  threadId: string;
  turnId: string;
  status: SessionTurn["status"];
  sessionTitle: string;
  activeThreadId: string | null;
  documentVisible: boolean;
}

export interface TurnCompletionNotificationCopy {
  title: string;
  body: string;
}

export function readTurnCompletionNotificationsEnabled(storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage): boolean {
  if (!storage) return false;
  try { return storage.getItem(STORAGE_KEY) === "enabled"; } catch { return false; }
}

export function persistTurnCompletionNotificationsEnabled(enabled: boolean, storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage): void {
  if (!storage) return;
  try { storage.setItem(STORAGE_KEY, enabled ? "enabled" : "disabled"); } catch { /* Browser storage may be unavailable. */ }
}

export function currentBrowserNotificationPermission(): BrowserNotificationPermission {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

export function browserNotificationControlState(enabled: boolean, permission: BrowserNotificationPermission): BrowserNotificationControlState {
  if (permission === "unsupported") return "unsupported";
  if (permission === "denied") return "blocked";
  return enabled && permission === "granted" ? "enabled" : "disabled";
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted" || Notification.permission === "denied") return Notification.permission;
  return Notification.requestPermission();
}

export function shouldNotifyTurnCompletion(input: TurnCompletionNotificationInput, enabled: boolean, permission: BrowserNotificationPermission): boolean {
  if (!enabled || permission !== "granted" || input.status === "inProgress") return false;
  return !input.documentVisible || input.activeThreadId !== input.threadId;
}

export function turnCompletionNotificationCopy(status: SessionTurn["status"], sessionTitle: string): TurnCompletionNotificationCopy {
  const title = status === "completed"
    ? "Codex Session 已完成"
    : status === "failed" ? "Codex Session 执行失败" : "Codex Session 已中断";
  const normalized = sessionTitle.replace(/\s+/g, " ").trim();
  const body = normalized.length > 120 ? `${normalized.slice(0, 117)}…` : normalized;
  return { title, body: body || "点击返回 Codex Web" };
}

export function showTurnCompletionNotification(input: TurnCompletionNotificationInput, onOpen: (threadId: string) => void): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  const copy = turnCompletionNotificationCopy(input.status, input.sessionTitle);
  try {
    const notification = new Notification(copy.title, {
      body: copy.body,
      tag: `codex-web-turn:${input.threadId}:${input.turnId}`,
    });
    notification.onclick = () => {
      window.focus();
      onOpen(input.threadId);
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

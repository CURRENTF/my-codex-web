import type { BootstrapPayload, Goal, Preferences, Project, SessionItem, SessionSummary, SessionThread, SessionTurn } from "@codex-web/shared-types";

let csrfToken = "";
let securityRefresh: Promise<void> | null = null;
export function newClientRequestId(): string { return crypto.randomUUID(); }

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) { super(message); }
}

async function request<T>(path: string, init: RequestInit, allowSecurityRefresh: boolean): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method) && csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = response.status === 204 ? undefined : (isJson ? await response.json() : await response.text());
  const errorCode = typeof body === "object" && body !== null && "error" in body ? (body as { error?: unknown }).error : undefined;
  const securityContextExpired = response.status === 401 || (response.status === 403 && errorCode === "Invalid CSRF token");
  if (!response.ok && allowSecurityRefresh && path !== "/api/bootstrap" && securityContextExpired) {
    securityRefresh ??= bootstrap().then(() => undefined).finally(() => { securityRefresh = null; });
    await securityRefresh;
    return request<T>(path, init, false);
  }
  if (!response.ok) throw new ApiError((body as { message?: string; error?: string } | undefined)?.message ?? (body as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`, response.status, body);
  return body as T;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, init, true);
}

export async function bootstrap(): Promise<BootstrapPayload> {
  const payload = await api<BootstrapPayload>("/api/bootstrap", { cache: "no-store" });
  csrfToken = payload.csrfToken;
  return payload;
}

export const endpoints = {
  projects: () => api<Project[]>("/api/projects"),
  sessions: (search = "", sortDirection: "asc" | "desc" = "desc", signal?: AbortSignal) => api<SessionSummary[]>(`/api/sessions?sortDirection=${sortDirection}&search=${encodeURIComponent(search)}`, { signal }),
  session: (threadId: string, signal?: AbortSignal) => api<SessionPayload>(`/api/sessions/${threadId}`, { signal }),
  preferences: (changes: Partial<Preferences>) => api<Preferences>("/api/preferences", { method: "PATCH", body: JSON.stringify({ ...changes, clientRequestId: newClientRequestId() }) }),
};

export interface SessionPayload {
  thread: CodexThread;
  goal: Goal | null;
  runtime: import("@codex-web/shared-types").ThreadRuntime;
  settings: { model: string | null; reasoning: string | null; accessMode: import("@codex-web/shared-types").AccessMode };
}

export type { Goal };

export type CodexThread = SessionThread;

export type CodexTurn = SessionTurn;
export type CodexItem = SessionItem;

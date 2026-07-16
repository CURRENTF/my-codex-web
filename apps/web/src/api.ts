import type { BootstrapPayload, Preferences, Project, SessionSummary } from "@codex-web/shared-types";

let csrfToken = "";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method) && csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = response.status === 204 ? undefined : (isJson ? await response.json() : await response.text());
  if (!response.ok) throw new ApiError((body as { message?: string; error?: string } | undefined)?.message ?? (body as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`, response.status, body);
  return body as T;
}

export async function bootstrap(): Promise<BootstrapPayload> {
  const payload = await api<BootstrapPayload>("/api/bootstrap");
  csrfToken = payload.csrfToken;
  return payload;
}

export const endpoints = {
  projects: () => api<Project[]>("/api/projects"),
  sessions: (search = "", sortDirection: "asc" | "desc" = "desc") => api<SessionSummary[]>(`/api/sessions?sortDirection=${sortDirection}&search=${encodeURIComponent(search)}`),
  session: (threadId: string) => api<SessionPayload>(`/api/sessions/${threadId}`),
  preferences: (changes: Partial<Preferences>) => api<Preferences>("/api/preferences", { method: "PATCH", body: JSON.stringify(changes) }),
};

export interface SessionPayload {
  thread: CodexThread;
  goal: Goal | null;
  runtime: import("@codex-web/shared-types").ThreadRuntime;
  settings: { model: string | null; reasoning: string | null; accessMode: import("@codex-web/shared-types").AccessMode };
}

export interface Goal {
  threadId: string; objective: string; status: string; tokenBudget: number | null;
  tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number;
}

export interface CodexThread {
  id: string; preview: string; name: string | null; cwd: string; createdAt: number; updatedAt: number;
  forkedFromId: string | null; turns: CodexTurn[];
}

export interface CodexTurn {
  id: string; status: "completed" | "interrupted" | "failed" | "inProgress";
  items: CodexItem[]; startedAt: number | null; completedAt: number | null; durationMs: number | null;
}

export type CodexItem =
  | { type: "userMessage"; id: string; content: Array<{ type: string; text?: string; path?: string }> }
  | { type: "agentMessage"; id: string; text: string; phase?: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "plan"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; cwd: string; status: string; aggregatedOutput: string | null; exitCode: number | null; durationMs: number | null }
  | { type: "fileChange"; id: string; changes: Array<{ path: string; kind: string; diff?: string }>; status: string }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string; durationMs: number | null };

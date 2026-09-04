import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { RuntimeState, SessionSummary } from "@codex-web/shared-types";

function listOptions(queryKey: QueryKey): { search: string; sortDirection: "asc" | "desc" } {
  return {
    search: typeof queryKey[1] === "string" ? queryKey[1].trim().toLocaleLowerCase() : "",
    sortDirection: queryKey[2] === "asc" ? "asc" : "desc",
  };
}

function matchesSearch(summary: SessionSummary, search: string): boolean {
  return !search || `${summary.title}\n${summary.preview}`.toLocaleLowerCase().includes(search);
}

function sorted(summaries: SessionSummary[], sortDirection: "asc" | "desc"): SessionSummary[] {
  const direction = sortDirection === "asc" ? 1 : -1;
  return summaries.sort((left, right) => Number(right.pinned) - Number(left.pinned) || direction * (left.updatedAt - right.updatedAt));
}

function updateSessionLists(client: QueryClient, update: (current: SessionSummary[], queryKey: QueryKey) => SessionSummary[]): void {
  for (const [queryKey, current] of client.getQueriesData<SessionSummary[]>({ queryKey: ["sessions"] })) {
    if (!current) continue;
    client.setQueryData(queryKey, update(current, queryKey));
  }
}

export function upsertCachedSessionSummary(client: QueryClient, summary: SessionSummary): void {
  updateSessionLists(client, (current, queryKey) => {
    const { search, sortDirection } = listOptions(queryKey);
    const withoutCurrent = current.filter((candidate) => candidate.threadId !== summary.threadId);
    return sorted(matchesSearch(summary, search) ? [...withoutCurrent, summary] : withoutCurrent, sortDirection);
  });
}

export function patchCachedSessionSummary(client: QueryClient, threadId: string, patch: Partial<SessionSummary>): void {
  const existing = client.getQueriesData<SessionSummary[]>({ queryKey: ["sessions"] })
    .flatMap(([, current]) => current ?? [])
    .find((candidate) => candidate.threadId === threadId);
  if (!existing) return;
  const updated = { ...existing, ...patch, threadId };
  updateSessionLists(client, (current, queryKey) => {
    const { search, sortDirection } = listOptions(queryKey);
    const withoutCurrent = current.filter((candidate) => candidate.threadId !== threadId);
    return sorted(matchesSearch(updated, search) ? [...withoutCurrent, updated] : withoutCurrent, sortDirection);
  });
}

export function removeCachedSessionSummary(client: QueryClient, threadId: string): void {
  updateSessionLists(client, (current) => current.filter((candidate) => candidate.threadId !== threadId));
}

interface SummaryEventPayload {
  reason?: string;
  name?: string | null;
  pinned?: boolean;
  summary?: SessionSummary;
}

export function applyCachedSessionSummaryEvent(
  client: QueryClient,
  threadId: string,
  payload: SummaryEventPayload,
  runtimeState: RuntimeState | undefined,
  emittedAt: number,
): void {
  if (payload.summary) {
    upsertCachedSessionSummary(client, payload.summary);
    return;
  }
  if (payload.reason?.startsWith("archived")) {
    removeCachedSessionSummary(client, threadId);
    return;
  }
  const patch: Partial<SessionSummary> = {};
  if (payload.reason === "renamed" && payload.name !== null && payload.name !== undefined) patch.title = payload.name;
  if (payload.reason === "goal-updated" || payload.reason === "goal-loaded") patch.hasGoal = true;
  if (payload.reason === "goal-cleared") patch.hasGoal = false;
  if (payload.reason === "pin-updated" && typeof payload.pinned === "boolean") patch.pinned = payload.pinned;
  if (payload.reason === "turn-started" || payload.reason === "turn-completed") {
    patch.updatedAt = emittedAt;
    if (runtimeState) patch.runtimeState = runtimeState;
  }
  if (Object.keys(patch).length) patchCachedSessionSummary(client, threadId, patch);
}

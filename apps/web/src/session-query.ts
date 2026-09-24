import type { QueryClient } from "@tanstack/react-query";
import type { SessionSummary } from "@codex-web/shared-types";
import { reconcileAgentMessageHistory } from "@codex-web/shared-types";
import { api, ApiError, type SessionPayload } from "./api";
import { mergeSessionSnapshot } from "./live-session";
import { patchCachedSessionSummary } from "./session-summary-cache";
import { readSessionHistory, reconstructSession, removeSessionHistory, writeSessionHistory, type SessionSync } from "./session-history-cache";

export async function fetchMergedSession(
  client: QueryClient,
  threadId: string,
  signal?: AbortSignal,
): Promise<SessionPayload> {
  const key = ["session", threadId];
  // Persisted snapshots remain separate from live query updates so the token always
  // identifies exactly the prefix supplied during reconstruction.
  const cached = await readSessionHistory(threadId);
  signal?.throwIfAborted();
  if (!client.getQueryData(key) && cached) client.setQueryData(key, cached.payload, { updatedAt: cached.touchedAt });
  const baseline = client.getQueryData<SessionPayload>(key);
  const params = new URLSearchParams({ sync: "1" });
  if (cached) {
    params.set("prefixCount", String(cached.sync.prefixCount));
    params.set("prefixHash", cached.sync.prefixHash);
  }
  try {
    const response = await api<SessionPayload & { sync?: SessionSync }>(`/api/sessions/${threadId}?${params}`, { signal, cache: "no-store" });
    signal?.throwIfAborted();
    const incoming = response.sync ? reconstructSession(response as SessionPayload & { sync: SessionSync }, cached) : response;
    // Reading history can recover a completion missed while disconnected. Keep
    // sidebar activity in sync without overwriting a newer live notification.
    const summaries = client.getQueriesData<SessionSummary[]>({ queryKey: ["sessions"] })
      .flatMap(([, rows]) => rows ?? []).filter((row) => row.threadId === threadId);
    const activityAt = incoming.thread.updatedAt * 1_000;
    if (summaries.length && summaries.every((row) => activityAt > row.updatedAt)) {
      patchCachedSessionSummary(client, threadId, { updatedAt: activityAt });
    }
    if (response.sync) void writeSessionHistory(threadId, incoming, response.sync);
    const current = client.getQueryData<SessionPayload>(key);
    // Preserve concurrent events and live turns, including terminal notifications
    // ahead of a stale in-progress snapshot. Stable history remains authoritative.
    if (!current) return incoming;
    const previousTurns = new Map(baseline?.thread.turns.map((turn) => [turn.id, turn]));
    const incomingTurns = new Map(incoming.thread.turns.map((turn) => [turn.id, turn]));
    const changedTurns = current.thread.turns.filter((turn) => previousTurns.get(turn.id) !== turn
      || (incomingTurns.has(turn.id) && (turn.status === "inProgress" || incomingTurns.get(turn.id)?.status === "inProgress")));
    if (!changedTurns.length) return incoming;
    const reconciledTurns = changedTurns.map((turn) => {
      const history = incomingTurns.get(turn.id);
      return history ? { ...turn, items: reconcileAgentMessageHistory(history.items, turn.items) } : turn;
    });
    return mergeSessionSnapshot(incoming, { ...incoming, thread: { ...incoming.thread, turns: reconciledTurns } });
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) void removeSessionHistory(threadId);
    throw error;
  }
}

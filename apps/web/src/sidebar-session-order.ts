import type { RuntimeState, SessionSummary } from "@codex-web/shared-types";

export function sortSidebarSessions(
  sessions: readonly SessionSummary[],
  runtimes: Readonly<Record<string, { state: RuntimeState } | undefined>>,
  sortDirection: "asc" | "desc",
): SessionSummary[] {
  const active = (session: SessionSummary) => {
    const state = runtimes[session.threadId]?.state ?? session.runtimeState;
    return state === "running" || state === "waitingForInput";
  };
  const direction = sortDirection === "asc" ? 1 : -1;
  return [...sessions].sort((left, right) => {
    const pinnedOrder = Number(right.pinned) - Number(left.pinned);
    if (pinnedOrder) return pinnedOrder;
    const leftActive = active(left);
    const rightActive = active(right);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    // Activity keeps changing during a Turn; creation time is stable across
    // streaming updates, polling Turns, refetches, and page reloads.
    return (leftActive ? right.createdAt - left.createdAt : direction * (left.updatedAt - right.updatedAt))
      || left.threadId.localeCompare(right.threadId);
  });
}

import type { RuntimeState, SessionTurn } from "@codex-web/shared-types";

export interface QueuedTurnBarrier {
  clientRequestId: string;
  previousLatestTurnId: string | null;
  turnId?: string;
}

export interface QueuedTurnObservation {
  runtimeState: RuntimeState;
  activeTurnId?: string;
  latestTurnId: string | null;
  latestTurnStatus: SessionTurn["status"] | null;
}

export function isQueuedTimelineSettled(
  waitingTurnId: string | null,
  observation: Pick<QueuedTurnObservation, "latestTurnId" | "latestTurnStatus">,
): boolean {
  const latestTurnIsTerminal = observation.latestTurnId !== null
    && observation.latestTurnStatus !== null
    && observation.latestTurnStatus !== "inProgress";
  if (waitingTurnId) return latestTurnIsTerminal && observation.latestTurnId === waitingTurnId;
  return observation.latestTurnStatus !== "inProgress";
}

export function advanceQueuedTurnBarrier(
  barrier: QueuedTurnBarrier,
  observation: QueuedTurnObservation,
): QueuedTurnBarrier | null {
  if (observation.runtimeState === "disconnected") return null;

  const observedTurnId = barrier.turnId
    ?? (observation.activeTurnId && observation.activeTurnId !== barrier.previousLatestTurnId
      ? observation.activeTurnId
      : observation.latestTurnId && observation.latestTurnId !== barrier.previousLatestTurnId
        ? observation.latestTurnId
        : undefined);
  if (!observedTurnId) return barrier;

  const latestTurnIsTerminal = observation.latestTurnId !== null
    && observation.latestTurnStatus !== null
    && observation.latestTurnStatus !== "inProgress";
  if (observation.latestTurnId === observedTurnId && latestTurnIsTerminal) return null;
  if (observation.latestTurnId !== barrier.previousLatestTurnId && latestTurnIsTerminal) return null;
  return observedTurnId === barrier.turnId ? barrier : { ...barrier, turnId: observedTurnId };
}

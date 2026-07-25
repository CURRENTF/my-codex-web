export function expectedSteerTurnId(
  rememberedTurnId: string | null,
  running: boolean,
  activeTurnId?: string,
): string | null {
  return rememberedTurnId ?? (running && activeTurnId ? activeTurnId : null);
}

export function apiErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("body" in error)) return null;
  const body = error.body;
  if (typeof body !== "object" || body === null || !("error" in body)) return null;
  return typeof body.error === "string" ? body.error : null;
}

export function isTurnFinishedConflict(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && error.status === 409
    && apiErrorCode(error) === "turn_finished";
}

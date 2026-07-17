export function expectedSteerTurnId(
  rememberedTurnId: string | null,
  running: boolean,
  activeTurnId?: string,
): string | null {
  return rememberedTurnId ?? (running && activeTurnId ? activeTurnId : null);
}

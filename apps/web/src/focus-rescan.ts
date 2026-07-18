export const FOCUS_RESCAN_INTERVAL_MS = 60_000;

export function shouldRunFocusRescan(input: {
  now: number;
  lastScanAt: number;
  modalFocusSuppressed: boolean;
}): boolean {
  return !input.modalFocusSuppressed && input.now - input.lastScanAt >= FOCUS_RESCAN_INTERVAL_MS;
}

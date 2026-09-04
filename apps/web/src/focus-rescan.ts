export const FOCUS_RESCAN_INTERVAL_MS = 60_000;

export function shouldRunFocusRescan(input: {
  now: number;
  lastScanAt: number;
}): boolean {
  return input.now - input.lastScanAt >= FOCUS_RESCAN_INTERVAL_MS;
}

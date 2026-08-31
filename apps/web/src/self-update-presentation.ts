import type { SelfUpdateStatus } from "@codex-web/shared-types";

export const UPDATE_SUCCESS_INDICATOR_MS = 30 * 60_000;

export function isUpdateSuccessState(state: SelfUpdateStatus["state"]): boolean {
  return state === "succeeded" || state === "upToDate";
}

export function shouldShowUpdateSuccessIndicator(
  status: Pick<SelfUpdateStatus, "state" | "finishedAt">,
  now = Date.now(),
): boolean {
  if (!isUpdateSuccessState(status.state) || status.finishedAt === null) return false;
  const age = now - status.finishedAt;
  return age >= 0 && age < UPDATE_SUCCESS_INDICATOR_MS;
}

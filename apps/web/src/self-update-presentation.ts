import type { SelfUpdateStatus } from "@codex-web/shared-types";

export const UPDATE_RESULT_INDICATOR_MS = 30 * 60_000;

export function isUpdateResultState(state: SelfUpdateStatus["state"]): boolean {
  return state === "succeeded" || state === "upToDate" || state === "failed";
}

export function shouldShowUpdateResultIndicator(
  status: Pick<SelfUpdateStatus, "state" | "finishedAt">,
  now = Date.now(),
): boolean {
  if (!isUpdateResultState(status.state) || status.finishedAt === null) return false;
  const age = now - status.finishedAt;
  return age >= 0 && age < UPDATE_RESULT_INDICATOR_MS;
}

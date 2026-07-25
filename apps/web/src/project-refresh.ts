import { apiErrorCode } from "./composer-intent";

export async function refreshProjectAvailability(
  invalidate: (queryKey: readonly unknown[]) => Promise<unknown>,
): Promise<void> {
  await Promise.all([
    invalidate(["projects"]),
    invalidate(["sessions"]),
  ]);
}

export async function refreshProjectAvailabilityAfterError(
  error: unknown,
  invalidate: (queryKey: readonly unknown[]) => Promise<unknown>,
): Promise<boolean> {
  if (apiErrorCode(error) !== "project_unavailable") return false;
  await refreshProjectAvailability(invalidate);
  return true;
}
